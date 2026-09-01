import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  createWindowsTreeTerminationRecorder,
  terminateActiveHeadlessTurnsAndWait,
  terminateWindowsProcessTree,
  waitForExit,
} from "../src/engines/headless.mjs";
import {
  bootIdentity,
  probeLeaseConsumer,
  proveLeaseReleasable,
} from "../src/runtime-lease.mjs";

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.kill = () => {
    throw new Error("native Windows cancellation must not kill only the wrapper");
  };
  return child;
}

test("Windows tree termination invokes taskkill with an exact validated pid and no shell", () => {
  const calls = [];
  const result = terminateWindowsProcessTree(4242, {
    execFileSyncFn(command, args, options) {
      calls.push({ command, args, options });
    },
  });

  assert.deepEqual(result, { status: "succeeded", attempted: true, reason: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "taskkill.exe");
  assert.deepEqual(calls[0].args, ["/PID", "4242", "/T", "/F"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal("shell" in calls[0].options, false, "taskkill must never receive a shell command");
});

test("malformed or injectable pids never reach taskkill", () => {
  let calls = 0;
  const execFileSyncFn = () => {
    calls += 1;
  };

  for (const pid of [null, undefined, 0, -1, 1.5, NaN, Infinity, "42", "42 & calc.exe", 2 ** 32]) {
    const result = terminateWindowsProcessTree(pid, { execFileSyncFn });
    assert.equal(result.status, "failed", `pid ${String(pid)} must fail closed`);
    assert.equal(result.attempted, false, `pid ${String(pid)} must not execute taskkill`);
  }
  assert.equal(calls, 0);
});

test("a Windows headless timeout synchronously terminates the full tree", async () => {
  const child = fakeChild(7301);
  const calls = [];
  const statuses = [];

  const exit = await waitForExit(child, {
    timeoutMs: 5,
    endSignalPath: null,
    platform: "win32",
    terminateWindowsTreeFn(pid) {
      calls.push(pid);
      return { status: "succeeded", attempted: true, reason: null };
    },
    onWindowsTreeTermination(status) {
      statuses.push(status);
    },
  });

  assert.equal(exit.kind, "timeout");
  assert.equal(exit.termination.status, "succeeded");
  assert.deepEqual(calls, [7301]);
  assert.deepEqual(statuses, ["pending", "succeeded"]);
});

test("a Windows end_dialog cancellation synchronously terminates the full tree", async () => {
  const child = fakeChild(7302);
  const calls = [];
  const statuses = [];

  const exit = await waitForExit(child, {
    timeoutMs: null,
    endSignalPath: "C:\\dualog\\end-signal",
    cancelPollMs: 1,
    pathExistsFn: () => true,
    platform: "win32",
    terminateWindowsTreeFn(pid) {
      calls.push(pid);
      return { status: "succeeded", attempted: true, reason: null };
    },
    onWindowsTreeTermination(status) {
      statuses.push(status);
    },
  });

  assert.equal(exit.kind, "cancelled");
  assert.equal(exit.termination.status, "succeeded");
  assert.deepEqual(calls, [7302]);
  assert.deepEqual(statuses, ["pending", "succeeded"]);
});

test("taskkill failure remains indeterminate after the cmd wrapper exits", async () => {
  const child = fakeChild(7303);
  const statuses = [];
  const exit = await waitForExit(child, {
    timeoutMs: 5,
    endSignalPath: null,
    platform: "win32",
    terminateWindowsTreeFn: () => ({
      status: "failed",
      attempted: true,
      reason: "access denied",
    }),
    onWindowsTreeTermination(status) {
      statuses.push(status);
    },
  });

  assert.equal(exit.termination.status, "failed");
  assert.deepEqual(statuses, ["pending", "failed"]);

  const verdict = probeLeaseConsumer(
    {
      kind: "headless",
      pid: child.pid,
      pgid: null,
      started_at: null,
      windows_tree_termination: exit.termination.status,
    },
    {
      platform: "win32",
      probeRecordedProcessFn: () => "absent",
      probeGroupFn: () => {
        throw new Error("Windows must not pretend it has a POSIX process group");
      },
    }
  );

  assert.equal(verdict, "unknown", "a failed tree kill must retain the runtime lease");
});

test("runner shutdown persists a failed Windows tree kill before it exits", async () => {
  const child = fakeChild(7304);
  const lifecycle = { retainLease: false, retentionReason: null };
  const transitions = [];
  const recorder = createWindowsTreeTerminationRecorder({
    platform: "win32",
    lease: { id: "lease-1" },
    consumer: { kind: "headless", pid: child.pid, pgid: null },
    lifecycle,
    transitionLeaseFn(lease, state, update) {
      transitions.push({ lease, state, update });
    },
  });

  const count = await terminateActiveHeadlessTurnsAndWait({
    children: [child],
    platform: "win32",
    terminateWindowsTreeFn: () => ({
      status: "failed",
      attempted: true,
      reason: "access denied",
    }),
    recordWindowsTreeTerminationFn(_child, status, reason) {
      assert.equal(_child, child);
      recorder(status, reason);
    },
  });

  assert.equal(count, 1);
  assert.deepEqual(
    transitions.map((entry) => entry.update.consumer.windows_tree_termination),
    ["pending", "failed"],
    "the signal-handler path must durably mark uncertainty before and after taskkill"
  );
  assert.equal(lifecycle.retainLease, true);
  assert.match(lifecycle.retentionReason, /access denied/);

  const persistedConsumer = transitions.at(-1).update.consumer;
  assert.equal(
    probeLeaseConsumer(persistedConsumer, {
      platform: "win32",
      probeRecordedProcessFn: () => "absent",
    }),
    "unknown",
    "a later sweep must retain after the wrapper disappears"
  );
});

test("an interrupted pending Windows tree kill also retains the lease", () => {
  const verdict = probeLeaseConsumer(
    {
      kind: "headless",
      pid: 7305,
      windows_tree_termination: "pending",
    },
    {
      platform: "win32",
      probeRecordedProcessFn: () => "absent",
    }
  );
  assert.equal(verdict, "unknown");
});

test("a failed termination-status write falls back to the conservative running record", () => {
  const lifecycle = { retainLease: false, retentionReason: null };
  const persistedConsumer = {
    kind: "headless",
    pid: 7306,
    windows_tree_termination: "running",
  };
  const recorder = createWindowsTreeTerminationRecorder({
    platform: "win32",
    lease: { id: "lease-io-failure" },
    consumer: persistedConsumer,
    lifecycle,
    transitionLeaseFn() {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    },
  });

  recorder("pending");
  assert.equal(lifecycle.retainLease, true);
  assert.match(lifecycle.retentionReason, /could not be recorded/);
  assert.equal(
    probeLeaseConsumer(persistedConsumer, {
      platform: "win32",
      probeRecordedProcessFn: () => "absent",
    }),
    "unknown",
    "the baseline record must not authorize cleanup when the stronger status could not be written"
  );
});

test("a natural Windows wrapper exit remains compatible with normal lease cleanup", () => {
  assert.equal(
    probeLeaseConsumer(
      {
        kind: "headless",
        pid: 7307,
        windows_tree_termination: "wrapper-exit-observed",
      },
      {
        platform: "win32",
        probeRecordedProcessFn: () => "absent",
      }
    ),
    "absent"
  );
});

test("a retained failed Windows tree kill self-heals after a proven reboot", (t) => {
  const currentBoot = bootIdentity();
  if (!currentBoot?.precise) {
    t.skip("this platform has no precise boot identity");
    return;
  }

  const verdict = proveLeaseReleasable({
    state: "active",
    boot: { ...currentBoot, id: `${currentBoot.id}-previous` },
    consumer: {
      kind: "headless",
      pid: 2 ** 22,
      pgid: null,
      windows_tree_termination: "failed",
    },
  });
  assert.equal(verdict.removable, true, verdict.reason);
});
