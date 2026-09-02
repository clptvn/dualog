import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

import { findBinary, probeVersion } from "../src/adapters/negotiate.mjs";
import { spawnHeadlessPartner } from "../src/engines/headless.mjs";
import {
  createDiscoveryCache,
  discoveryProcessImplementations,
  execFileViaCrossSpawn,
  resolveDiscovery,
} from "../src/adapters/discovery.mjs";

const WINDOWS_ENV = Object.freeze({
  SystemRoot: "C:\\Windows",
  ComSpec: "C:\\attacker\\cmd.exe",
});
const SYSTEM_CMD = "C:\\Windows\\System32\\cmd.exe";

function fakeSpawn(calls, { stdout = "", stderr = "", code = 0 } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 4100 + calls.length;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code, null);
    });
    return child;
  };
}

function pendingSpawn(calls, { pid = 5150, onSpawn = null } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = pid;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      throw new Error("native Windows probes must not kill only the .cmd wrapper");
    };
    child.unrefCalls = 0;
    child.unref = () => {
      child.unrefCalls += 1;
    };
    onSpawn?.(child);
    return child;
  };
}

test("native Windows pins the trusted PATH shim outside the reviewed project", () => {
  const projectLocal = "C:\\reviewed\\repo\\claude.cmd";
  const trusted = "C:\\Program Files\\Claude Code\\claude.cmd";
  const attempted = [];
  const env = {
    SystemRoot: "C:\\Windows",
    Path: `"C:\\reviewed\\repo";.;"relative tools";C:drive-relative;\\root-relative;"C:\\Program Files\\Claude Code"`,
    Pathext: ".CMD",
  };
  const resolved = findBinary("claude.cmd", env, {
    platform: "win32",
    excludedRoots: ["C:\\reviewed\\repo"],
    realpathSync: (candidate) => candidate,
    accessSync(candidate) {
      attempted.push(candidate);
      // Model both files as executable. The reviewed cwd candidate must never
      // even be consulted; only the absolute PATH directory is authority.
      if (candidate === projectLocal || candidate === trusted) return;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });

  assert.equal(resolved, trusted);
  assert.deepEqual(attempted, [trusted]);
  assert.equal(
    findBinary(projectLocal, env, {
      platform: "win32",
      excludedRoots: ["C:\\reviewed\\repo"],
      realpathSync: (candidate) => candidate,
      accessSync: () => assert.fail("an explicit reviewed-project command must be rejected before access"),
    }),
    null
  );

  const calls = [];
  spawnHeadlessPartner(
    resolved,
    ["--version"],
    { cwd: "C:\\reviewed\\repo", env },
    {
      platform: "win32",
      systemEnv: env,
      spawnImpl: fakeSpawn(calls),
    }
  );
  assert.equal(calls[0].command, trusted);
  assert.notEqual(calls[0].command, projectLocal);
});

test("runtime Windows spawns scope one exact System32 ComSpec without changing argv", () => {
  const binary = "C:\\Program Files\\Claude & Codex\\claude.cmd";
  const args = ["--model", "value & still one argv"];
  const previousAmbient = Object.entries(process.env).filter(
    ([key]) => key.toLocaleLowerCase("en-US") === "comspec"
  );

  for (const env of [
    { SystemRoot: "C:\\Windows" },
    {
      SystemRoot: "C:\\Windows",
      COMSPEC: "C:\\attacker\\cmd.exe",
      comspec: "C:\\second-attacker\\cmd.exe",
    },
  ]) {
    const calls = [];
    const expectedChild = { pid: 4040 };
    const child = spawnHeadlessPartner(
      binary,
      args,
      { env, stdio: ["pipe", "pipe", "pipe"] },
      {
        platform: "win32",
        systemEnv: env,
        spawnImpl(command, receivedArgs, options) {
          assert.equal(process.env.comspec, SYSTEM_CMD);
          calls.push({ command, args: receivedArgs, options });
          return expectedChild;
        },
      }
    );

    assert.equal(child, expectedChild);
    assert.equal(calls[0].command, binary);
    assert.equal(calls[0].args, args, "the explicit argv array must reach cross-spawn intact");
    assert.equal(calls[0].options.env.ComSpec, SYSTEM_CMD);
    assert.equal(
      Object.keys(calls[0].options.env).filter(
        (key) => key.toLocaleLowerCase("en-US") === "comspec"
      ).length,
      1
    );
    assert.deepEqual(
      Object.entries(process.env).filter(
        ([key]) => key.toLocaleLowerCase("en-US") === "comspec"
      ),
      previousAmbient,
      "the synchronous cross-spawn guard must restore the parent environment"
    );
  }
});

test("the real Windows cross-spawn parser selects the exact System32 cmd.exe", () => {
  const preload = fileURLToPath(
    new URL("./helpers/fake-win32-platform.cjs", import.meta.url)
  );
  const helperUrl = new URL(
    "../src/windows-process-tree.mjs",
    import.meta.url
  ).href;
  const command = "C:\\Program Files\\Claude & Codex\\claude.cmd";
  const args = ["--model", "value & still one argv"];
  const script = `
    import { createRequire } from "node:module";
    import { spawnWithTrustedWindowsComSpec } from ${JSON.stringify(helperUrl)};

    const require = createRequire(import.meta.url);
    const crossSpawn = require("cross-spawn");
    const systemEnv = { SystemRoot: "C:\\\\Windows" };
    process.env.comspec = "C:\\\\attacker\\\\cmd.exe";
    const command = ${JSON.stringify(command)};
    const args = ${JSON.stringify(args)};
    const result = spawnWithTrustedWindowsComSpec(
      (receivedCommand, receivedArgs, receivedOptions) => ({
        ambientComSpec: process.env.comspec,
        parsed: crossSpawn._parse(receivedCommand, receivedArgs, {
          ...receivedOptions,
          forceShell: true,
        }),
      }),
      command,
      args,
      { env: systemEnv },
      { platform: "win32", env: systemEnv }
    );
    process.stdout.write(JSON.stringify(result));
  `;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ["--require", preload, "--input-type=module", "--eval", script],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf-8",
      }
    )
  );

  assert.equal(result.ambientComSpec, SYSTEM_CMD);
  assert.equal(result.parsed.command, SYSTEM_CMD);
  assert.deepEqual(result.parsed.original, { command, args });
  assert.deepEqual(result.parsed.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(result.parsed.options.env.ComSpec, SYSTEM_CMD);
  assert.match(result.parsed.args[3], /Program\^ Files/u);
  assert.match(result.parsed.args[3], /\^&/u);
});

test("runtime Windows spawns fail before cross-spawn when SystemRoot is untrusted", () => {
  let calls = 0;
  assert.throws(
    () =>
      spawnHeadlessPartner(
        "C:\\Program Files\\Claude\\claude.cmd",
        ["--version"],
        { env: { SystemRoot: "C:\\Users\\test\\Windows" } },
        {
          platform: "win32",
          systemEnv: { SystemRoot: "C:\\Users\\test\\Windows" },
          spawnImpl() {
            calls += 1;
          },
        }
      ),
    /trusted top-level Windows System32 directory for cmd\.exe/u
  );
  assert.equal(calls, 0);
});

test("runtime POSIX spawns preserve the original command, argv, and options", () => {
  const command = "/opt/Claude & Codex/claude.cmd";
  const args = ["--version", "one & argv"];
  const options = { env: { PATH: "/usr/bin" }, cwd: "/tmp/project with spaces" };
  let call;
  const child = spawnHeadlessPartner(command, args, options, {
    platform: "darwin",
    systemEnv: {},
    spawnImpl(...received) {
      call = received;
      return { pid: 5050 };
    },
  });
  assert.equal(child.pid, 5050);
  assert.equal(call[0], command);
  assert.equal(call[1], args);
  assert.equal(call[2], options);
});

test("native Windows version probing launches a .cmd shim through cross-spawn", async () => {
  const calls = [];
  const binary = "C:\\Users\\Test & Co\\bin\\claude.cmd";
  const version = await probeVersion(binary, ["--version"], 1000, {
    platform: "win32",
    env: WINDOWS_ENV,
    spawnImpl: fakeSpawn(calls, { stdout: "Claude Code 9.9.9\r\n" }),
    execFileImpl() {
      throw new Error("raw execFile must not be used for native Windows shims");
    },
  });

  assert.equal(version, "Claude Code 9.9.9");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, binary);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.equal("shell" in calls[0].options, false);
});

test("native Windows discovery keeps .cmd paths and arguments as separate argv", async () => {
  const calls = [];
  const binary = "C:\\Program Files\\Codex & Claude\\codex.cmd";
  const implementations = discoveryProcessImplementations({
    platform: "win32",
    env: WINDOWS_ENV,
    crossSpawnImpl: fakeSpawn(calls, { stdout: "model-a\r\nmodel-b\r\n" }),
  });

  assert.equal(
    implementations.spawnImpl instanceof Function,
    true,
    "SDK-control discovery must receive the cross-spawn implementation"
  );
  const result = await new Promise((resolve) => {
    implementations.execFileImpl(
      binary,
      ["models", "--format", "plain & safe"],
      { encoding: "utf-8", timeout: 1000, windowsHide: true },
      (error, stdout, stderr) => resolve({ error, stdout, stderr })
    );
  });

  assert.equal(result.error, null);
  assert.equal(result.stdout, "model-a\r\nmodel-b\r\n");
  assert.equal(result.stderr, "");
  assert.equal(calls[0].command, binary);
  assert.deepEqual(calls[0].args, ["models", "--format", "plain & safe"]);
  assert.equal("shell" in calls[0].options, false);
});

test("cross-spawn exec adapter preserves nonzero output for discovery diagnostics", async () => {
  const calls = [];
  const result = await new Promise((resolve) => {
    execFileViaCrossSpawn(
      "C:\\bin\\claude.cmd",
      ["--sdk-url"],
      { encoding: "utf-8", timeout: 1000 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      {
        platform: "win32",
        env: WINDOWS_ENV,
        spawnImpl: fakeSpawn(calls, { stderr: "not logged in\r\n", code: 1 }),
      }
    );
  });
  assert.equal(result.error?.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "not logged in\r\n");
});

test("Windows discovery timeout tree-kills the exact wrapper pid before callback", async () => {
  const calls = [];
  const events = [];
  let spawnedChild = null;
  const result = await new Promise((resolve) => {
    execFileViaCrossSpawn(
      "C:\\Program Files\\Claude & Co\\claude.cmd",
      ["models", "safe & separate"],
      { encoding: "utf-8", timeout: 5 },
      (error, stdout, stderr) => {
        events.push("callback");
        resolve({ error, stdout, stderr });
      },
      {
        platform: "win32",
        env: WINDOWS_ENV,
        spawnImpl: pendingSpawn(calls, {
          pid: 5151,
          onSpawn(child) {
            spawnedChild = child;
          },
        }),
        terminateWindowsTreeFn(pid) {
          assert.equal(spawnedChild?.stdout.destroyed, false);
          assert.equal(spawnedChild?.stderr.destroyed, false);
          assert.equal(spawnedChild?.unrefCalls, 0);
          events.push(`tree:${pid}`);
          return { status: "succeeded", attempted: true, reason: null };
        },
      }
    );
  });

  assert.equal(result.error?.killed, true);
  assert.match(result.error?.message, /timed out after 5ms/u);
  assert.deepEqual(events, ["tree:5151", "callback"]);
  assert.deepEqual(calls[0].args, ["models", "safe & separate"]);
  assert.equal(spawnedChild?.stdout.destroyed, true);
  assert.equal(spawnedChild?.stderr.destroyed, true);
  assert.equal(spawnedChild?.unrefCalls, 1);
});

test("Windows discovery maxBuffer is byte-bounded and tree-kills once", async () => {
  const calls = [];
  const events = [];
  const result = await new Promise((resolve) => {
    execFileViaCrossSpawn(
      "C:\\bin\\claude.cmd",
      ["models"],
      { encoding: "utf-8", timeout: 1000, maxBuffer: 4 },
      (error, stdout, stderr) => {
        events.push("callback");
        resolve({ error, stdout, stderr });
      },
      {
        platform: "win32",
        env: WINDOWS_ENV,
        spawnImpl: pendingSpawn(calls, {
          pid: 5152,
          onSpawn(child) {
            queueMicrotask(() => {
              child.stdout.write("ééé"); // six UTF-8 bytes
              child.emit("close", 0, null); // late close must not callback twice
            });
          },
        }),
        terminateWindowsTreeFn(pid) {
          events.push(`tree:${pid}`);
          return { status: "succeeded", attempted: true, reason: null };
        },
      }
    );
  });

  assert.equal(result.error?.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  assert.equal(result.error?.stream, "stdout");
  assert.equal(result.stdout, "éé", "the callback receives at most maxBuffer bytes");
  assert.deepEqual(events, ["tree:5152", "callback"]);
});

test("Windows discovery accepts output exactly at maxBuffer without terminating", async () => {
  const trees = [];
  const result = await new Promise((resolve) => {
    execFileViaCrossSpawn(
      "C:\\bin\\claude.cmd",
      ["models"],
      { encoding: "utf-8", timeout: 1000, maxBuffer: 4 },
      (error, stdout) => resolve({ error, stdout }),
      {
        platform: "win32",
        env: WINDOWS_ENV,
        spawnImpl: pendingSpawn([], {
          pid: 5154,
          onSpawn(child) {
            queueMicrotask(() => {
              child.stdout.write("1234");
              child.emit("close", 0, null);
            });
          },
        }),
        terminateWindowsTreeFn(pid) {
          trees.push(pid);
          return { status: "succeeded", attempted: true, reason: null };
        },
      }
    );
  });

  assert.equal(result.error, null);
  assert.equal(result.stdout, "1234");
  assert.deepEqual(trees, []);
});

test("a Windows tree-kill failure is retained in the probe diagnostic", async () => {
  const result = await new Promise((resolve) => {
    execFileViaCrossSpawn(
      "C:\\bin\\claude.cmd",
      ["models"],
      { encoding: "utf-8", timeout: 5 },
      (error) => resolve(error),
      {
        platform: "win32",
        env: WINDOWS_ENV,
        spawnImpl: pendingSpawn([], { pid: 5153 }),
        terminateWindowsTreeFn() {
          return {
            status: "failed",
            attempted: true,
            reason: "taskkill access denied",
          };
        },
      }
    );
  });

  assert.equal(result.termination.status, "failed");
  assert.match(result.message, /taskkill access denied/u);
});

test("Windows version timeout and overflow terminate the whole .cmd tree", async () => {
  for (const scenario of ["timeout", "overflow"]) {
    const trees = [];
    let spawnedChild = null;
    const version = await probeVersion("C:\\bin\\codex.cmd", ["--version"], 5, {
      platform: "win32",
      env: WINDOWS_ENV,
      spawnImpl: pendingSpawn([], {
        pid: scenario === "timeout" ? 5160 : 5161,
        onSpawn(child) {
          spawnedChild = child;
          if (scenario === "overflow") {
            queueMicrotask(() => child.stdout.write(Buffer.alloc(64 * 1024 + 1, 0x78)));
          }
        },
      }),
      terminateWindowsTreeFn(pid) {
        assert.equal(spawnedChild?.stdout.destroyed, false, scenario);
        assert.equal(spawnedChild?.stderr.destroyed, false, scenario);
        assert.equal(spawnedChild?.unrefCalls, 0, scenario);
        trees.push(pid);
        return { status: "succeeded", attempted: true, reason: null };
      },
    });

    assert.equal(version, null, scenario);
    assert.deepEqual(trees, [scenario === "timeout" ? 5160 : 5161], scenario);
    assert.equal(spawnedChild?.stdout.destroyed, true, scenario);
    assert.equal(spawnedChild?.stderr.destroyed, true, scenario);
    assert.equal(spawnedChild?.unrefCalls, 1, scenario);
  }
});

const SDK_ADAPTER = {
  id: "windows-sdk-fixture",
  displayName: "Windows SDK fixture",
  binary: { default: "C:\\bin\\claude.cmd", versionArgs: ["--version"] },
  engines: { default: "headless", allowed: ["headless"] },
  models: [{ id: "fallback-model", efforts: [] }],
  modelAliases: {},
  discovery: {
    strategy: "sdk-control",
    format: "claude-list-models",
    timeoutMs: 5,
  },
  __sources: ["windows-sdk-fixture.json"],
};
const CONTROL_LINE = `${JSON.stringify({
  type: "control_response",
  response: {
    response: {
      models: [{ value: "live-model", supportedEffortLevels: ["high"] }],
    },
  },
})}\n`;

test("Windows SDK-control early answer tree-kills before returning the catalog", async () => {
  const events = [];
  let spawnedChild = null;
  const result = await resolveDiscovery(SDK_ADAPTER, {
    platform: "win32",
    env: WINDOWS_ENV,
    engine: "headless",
    enrich: false,
    refresh: true,
    cache: createDiscoveryCache(),
    spawnImpl: pendingSpawn([], {
      pid: 5170,
      onSpawn(child) {
        spawnedChild = child;
        queueMicrotask(() => child.stdout.write(CONTROL_LINE));
      },
    }),
    terminateWindowsTreeFn(pid) {
      assert.equal(spawnedChild?.stdout.destroyed, false);
      assert.equal(spawnedChild?.stderr.destroyed, false);
      assert.equal(spawnedChild?.unrefCalls, 0);
      events.push(`tree:${pid}`);
      return { status: "succeeded", attempted: true, reason: null };
    },
  });

  events.push("resolved");
  assert.equal(result.strategy, "sdk-control");
  assert.deepEqual(result.models.map((model) => model.id), ["live-model"]);
  assert.deepEqual(events, ["tree:5170", "resolved"]);
  assert.equal(spawnedChild?.stdout.destroyed, true);
  assert.equal(spawnedChild?.stderr.destroyed, true);
  assert.equal(spawnedChild?.unrefCalls, 1);
});

test("Windows SDK-control timeout tree-kills and degrades with an exact notice", async () => {
  const trees = [];
  const result = await resolveDiscovery(SDK_ADAPTER, {
    platform: "win32",
    env: WINDOWS_ENV,
    engine: "headless",
    enrich: false,
    refresh: true,
    cache: createDiscoveryCache(),
    spawnImpl: pendingSpawn([], { pid: 5171 }),
    terminateWindowsTreeFn(pid) {
      trees.push(pid);
      return { status: "succeeded", attempted: true, reason: null };
    },
  });

  assert.deepEqual(trees, [5171]);
  assert.equal(result.strategy, "static");
  assert.equal(result.notices[0].code, "control_timeout");
  assert.match(result.notices[0].message, /within 5ms/u);
});

test("Windows SDK-control bounds total newline chatter and tree-kills", async () => {
  const trees = [];
  const result = await resolveDiscovery(SDK_ADAPTER, {
    platform: "win32",
    env: WINDOWS_ENV,
    engine: "headless",
    enrich: false,
    refresh: true,
    cache: createDiscoveryCache(),
    spawnImpl: pendingSpawn([], {
      pid: 5172,
      onSpawn(child) {
        queueMicrotask(() =>
          child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 0x0a))
        );
      },
    }),
    terminateWindowsTreeFn(pid) {
      trees.push(pid);
      return { status: "succeeded", attempted: true, reason: null };
    },
  });

  assert.deepEqual(trees, [5172]);
  assert.equal(result.strategy, "static");
  assert.equal(result.notices[0].code, "control_output_limit");
  assert.match(result.notices[0].message, /streamed more than 4194304 bytes/u);
});

test("maxBuffer-truncated CLI output never masquerades as a valid model list", async () => {
  const trees = [];
  const cliAdapter = {
    ...SDK_ADAPTER,
    id: "windows-cli-fixture",
    models: [{ id: "fallback-only", efforts: [] }],
    discovery: {
      strategy: "cli-command",
      format: "opencode-models",
      args: ["models"],
      timeoutMs: 1000,
    },
  };
  const result = await resolveDiscovery(cliAdapter, {
    platform: "win32",
    env: WINDOWS_ENV,
    engine: "headless",
    enrich: false,
    refresh: true,
    cache: createDiscoveryCache(),
    execFileImpl(command, args, options, callback) {
      return execFileViaCrossSpawn(command, args, options, callback, {
        platform: "win32",
        env: WINDOWS_ENV,
        spawnImpl: pendingSpawn([], {
          pid: 5173,
          onSpawn(child) {
            queueMicrotask(() => {
              child.stdout.write("provider/looks-valid\n");
              child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 0x78));
            });
          },
        }),
        terminateWindowsTreeFn(pid) {
          trees.push(pid);
          return { status: "succeeded", attempted: true, reason: null };
        },
      });
    },
  });

  assert.deepEqual(trees, [5173]);
  assert.equal(result.strategy, "static");
  assert.deepEqual(result.models.map((model) => model.id), ["fallback-only"]);
  assert.equal(result.notices[0].code, "command_failed");
  assert.match(result.notices[0].message, /exceeded the 4194304-byte discovery limit/u);
});
