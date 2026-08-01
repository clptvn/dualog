// The start-vs-exit race on status.json.
//
// markSessionRunnerStarted() (parent, after spawn) and markSessionRunnerExited()
// (child, on its way out) are two independent whole-file writes against the same
// document. Re-reading before writing narrows the window but cannot close it:
// the child can land `exited` between the parent's read and its rename, and
// last-writer-wins then loses the exit -- leaving a session that claims to be
// running behind a PID that is already gone, which is the state that makes a
// session look alive forever.
//
// watchRunnerExit() closes it with the one event that is unambiguously last.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  markSessionRunnerStarted,
  markSessionRunnerExited,
  watchRunnerExit,
} from "../src/runner-lifecycle.mjs";

const TOKEN = "test-token-abc123";

function makeSession(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "status.json"),
    JSON.stringify(
      {
        session_id: "s1",
        type: "review",
        runner_token: TOKEN,
        runner_pid: null,
        runner_state: "starting",
        ...overrides,
      },
      null,
      2
    )
  );
  return dir;
}

const readStatus = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf-8"));

test("an exit already on disk is never promoted back to running", (t) => {
  const sessionDir = makeSession(t);

  // The child got there first.
  markSessionRunnerExited(sessionDir, { runnerToken: TOKEN, reason: "fatal_error", pid: 4242 });
  assert.equal(readStatus(sessionDir).runner_state, "exited");

  const promoted = markSessionRunnerStarted(sessionDir, { runnerToken: TOKEN, pid: 4242 });
  assert.equal(promoted, false, "must refuse to resurrect a finished session");
  assert.equal(readStatus(sessionDir).runner_state, "exited");
  assert.equal(readStatus(sessionDir).runner_pid, null);
});

test("a lost update is corrected by the exit event", (t) => {
  const sessionDir = makeSession(t);

  // The interleaving that re-reading cannot prevent: the child records its exit,
  // and the parent's already-in-flight "running" write lands on top of it.
  const fakeChild = new EventEmitter();
  fakeChild.pid = 4242;
  watchRunnerExit(fakeChild, sessionDir, { runnerToken: TOKEN });

  markSessionRunnerExited(sessionDir, { runnerToken: TOKEN, reason: "fatal_error", pid: 4242 });
  // Simulate the racing write winning: force the file back to "running".
  fs.writeFileSync(
    path.join(sessionDir, "status.json"),
    JSON.stringify(
      { session_id: "s1", type: "review", runner_token: TOKEN, runner_pid: 4242, runner_state: "running" },
      null,
      2
    )
  );
  assert.equal(readStatus(sessionDir).runner_state, "running", "precondition: exit was lost");

  // The process is gone; the event says so, and that is unambiguously last.
  fakeChild.emit("exit", 1, null);

  const after = readStatus(sessionDir);
  assert.equal(after.runner_state, "exited", "the exit event must re-assert the truth");
  assert.equal(after.runner_pid, null);
  assert.equal(after.last_runner_pid, 4242);
});

test("a spawn that never starts does not strand the session at 'starting'", (t) => {
  const sessionDir = makeSession(t);

  const fakeChild = new EventEmitter();
  fakeChild.pid = undefined;
  watchRunnerExit(fakeChild, sessionDir, { runnerToken: TOKEN });

  fakeChild.emit("error", new Error("spawn ENOENT"));

  assert.equal(readStatus(sessionDir).runner_state, "exited");
  assert.equal(readStatus(sessionDir).runner_exit_reason, "spawn_failed");
});

test("another session's runner cannot record an exit here", (t) => {
  const sessionDir = makeSession(t, { runner_pid: 1111, runner_state: "running" });

  // Wrong token.
  assert.equal(
    markSessionRunnerExited(sessionDir, { runnerToken: "someone-else", pid: 1111 }),
    false
  );
  // Right token, wrong pid.
  assert.equal(
    markSessionRunnerExited(sessionDir, { runnerToken: TOKEN, pid: 9999 }),
    false
  );
  assert.equal(readStatus(sessionDir).runner_state, "running");

  // Right token, right pid.
  assert.equal(markSessionRunnerExited(sessionDir, { runnerToken: TOKEN, pid: 1111 }), true);
  assert.equal(readStatus(sessionDir).runner_state, "exited");
});

test("a real child's exit is recorded end to end", async (t) => {
  const sessionDir = makeSession(t);

  const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
  markSessionRunnerStarted(sessionDir, { runnerToken: TOKEN, pid: child.pid });
  watchRunnerExit(child, sessionDir, { runnerToken: TOKEN });

  assert.equal(readStatus(sessionDir).runner_state, "running");

  await new Promise((resolve) => child.once("close", resolve));
  // Let the exit handler run.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = readStatus(sessionDir);
  assert.equal(after.runner_state, "exited");
  assert.equal(after.runner_exit_code, 3);
  assert.equal(after.last_runner_pid, child.pid);
});

test("the watcher never overwrites the runner's own, more specific exit reason", (t) => {
  // The runner names why it stopped -- idle_shutdown, partner_terminal_failure,
  // fatal_error, SIGTERM -- and that is strictly more informative than anything
  // observable from outside, where all we know is "the process ended".
  // Reasserting unconditionally replaced idle_shutdown with a generic
  // runner_exited and made production status disagree with what the
  // direct-runner integration tests assert.
  for (const reason of ["idle_shutdown", "partner_terminal_failure", "fatal_error", "SIGTERM"]) {
    const sessionDir = makeSession(t);
    markSessionRunnerExited(sessionDir, { runnerToken: TOKEN, reason, pid: 4242 });

    const fakeChild = new EventEmitter();
    fakeChild.pid = 4242;
    watchRunnerExit(fakeChild, sessionDir, { runnerToken: TOKEN });
    fakeChild.emit("exit", 0, null);

    assert.equal(
      readStatus(sessionDir).runner_exit_reason,
      reason,
      `${reason} must survive the exit event`
    );
  }
});
