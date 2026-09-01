import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { runExecFile } from "../src/tmux-runtime.mjs";

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.unrefCalls = 0;
  child.kill = (signal) => child.killCalls.push(signal);
  child.unref = () => { child.unrefCalls++; };
  return child;
}

test("native Windows tmux timeout tree-kills the exact wrapper pid", async () => {
  const child = fakeChild(7319);
  const terminations = [];
  // Production intentionally unrefs its timeout. Keep the test process alive
  // independently so the fake child cannot make node:test end the case early.
  const keepAlive = setTimeout(() => {}, 100);
  const result = await runExecFile("C:\\tools\\tmux.cmd", ["-V"], {
    platform: "win32",
    crossSpawnFn: (command, args, options) => {
      assert.equal(command, "C:\\tools\\tmux.cmd");
      assert.deepEqual(args, ["-V"]);
      assert.equal(options.windowsHide, true);
      return child;
    },
    terminateTreeFn: (pid) => {
      terminations.push(pid);
      return { status: "succeeded", attempted: true };
    },
    timeoutMs: 5,
    maxBuffer: 64,
  });
  clearTimeout(keepAlive);

  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /timed out after 5ms/);
  assert.deepEqual(terminations, [7319]);
  assert.deepEqual(child.killCalls, [], "wrapper-only kill must never be used");
});

test("native Windows tmux output is byte-bounded and terminates the tree once", async () => {
  const child = fakeChild(8801);
  const terminations = [];
  const pending = runExecFile("tmux.cmd", ["capture-pane"], {
    platform: "win32",
    crossSpawnFn: () => child,
    terminateTreeFn: (pid) => {
      terminations.push(pid);
      return { status: "succeeded", attempted: true };
    },
    timeoutMs: 1000,
    maxBuffer: 64,
  });
  child.stdout.write(Buffer.alloc(65, 0x31));
  child.stdout.write(Buffer.from("ignored"));

  const result = await pending;
  assert.equal(result.exitCode, 125);
  assert.equal(Buffer.byteLength(result.stdout), 64);
  assert.match(result.stderr, /exceeded/);
  assert.ok(Buffer.byteLength(result.stderr) <= 64);
  assert.deepEqual(terminations, [8801]);
});

test("tree-kill failure is reported without expanding the output bound", async () => {
  const child = fakeChild(9902);
  const pending = runExecFile("tmux.cmd", ["list-sessions"], {
    platform: "win32",
    crossSpawnFn: () => child,
    terminateTreeFn: (pid) => {
      assert.equal(child.stdout.destroyed, false);
      assert.equal(child.stderr.destroyed, false);
      assert.equal(child.unrefCalls, 0, "taskkill must run while the wrapper is attached");
      return {
        status: "failed",
        attempted: true,
        reason: `taskkill failed for ${pid}`,
      };
    },
    timeoutMs: 1000,
    maxBuffer: 96,
  });
  child.stderr.write(Buffer.alloc(97, 0x78));

  const result = await pending;
  assert.equal(result.exitCode, 125);
  assert.match(result.stderr, /taskkill failed for 9902/);
  assert.ok(Buffer.byteLength(result.stderr) <= 96);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefCalls, 1);
});

test("multibyte output remains within the byte limit at a UTF-8 boundary", async () => {
  const child = fakeChild(4404);
  const pending = runExecFile("tmux.cmd", ["capture-pane"], {
    platform: "win32",
    crossSpawnFn: () => child,
    terminateTreeFn: () => ({ status: "succeeded", attempted: true }),
    timeoutMs: 1000,
    maxBuffer: 4,
  });
  child.stdout.write("€€");

  const result = await pending;
  assert.equal(result.exitCode, 125);
  assert.ok(Buffer.byteLength(result.stdout) <= 4);
  assert.ok(Buffer.byteLength(result.stderr) <= 4);
  assert.doesNotMatch(result.stdout, /�/);
});
