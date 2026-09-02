import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  createWindowsTreeTerminationRecorder,
  terminateActiveHeadlessTurnsAndWait,
  terminateWindowsProcessTree,
  waitForExit,
} from "../src/engines/headless.mjs";
import { processStartTime } from "../src/process-probe.mjs";
import { readProcessCommandLine } from "../src/runner-lifecycle.mjs";
import { resolveWindowsSystem32Executable } from "../src/windows-process-tree.mjs";
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

function encodeWindowsCommandLine(value) {
  return Buffer.from(value, "utf-8").toString("base64");
}

test("Windows tree termination invokes taskkill with an exact validated pid and no shell", () => {
  const calls = [];
  const result = terminateWindowsProcessTree(4242, {
    env: { SystemRoot: "C:\\Windows" },
    execFileSyncFn(command, args, options) {
      calls.push({ command, args, options });
    },
  });

  assert.deepEqual(result, { status: "succeeded", attempted: true, reason: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(calls[0].args, ["/PID", "4242", "/T", "/F"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false, "taskkill must never receive a shell command");
  assert.equal(calls[0].options.timeout, 15000);
  assert.equal(calls[0].options.maxBuffer, 4096);
});

test("Windows system executables require a validated drive-absolute SystemRoot", () => {
  assert.equal(
    resolveWindowsSystem32Executable("taskkill.exe", {
      env: { SystemRoot: "D:\\WinNT" },
    }),
    "D:\\WinNT\\System32\\taskkill.exe"
  );
  assert.equal(
    resolveWindowsSystem32Executable("cmd.exe", {
      env: { SystemRoot: "c:\\WINDOWS\\" },
    }),
    "c:\\WINDOWS\\System32\\cmd.exe"
  );
  assert.equal(
    resolveWindowsSystem32Executable("wsl.exe", {
      env: { SystemRoot: "D:/WinNT/" },
    }),
    "D:\\WinNT\\System32\\wsl.exe"
  );

  for (const systemRoot of [
    undefined,
    "Windows",
    "\\\\server\\Windows",
    "C:\\Windows\\..\\Temp",
    "C:\\Users\\test\\Windows",
    "C:\\Temp",
    "C:\\Windows.old",
    '"C:\\Windows"',
    'C:\\Windows"',
    "C:\\Windows:evil",
  ]) {
    assert.equal(
      resolveWindowsSystem32Executable("taskkill.exe", {
        env: systemRoot === undefined ? {} : { SystemRoot: systemRoot },
      }),
      null,
      `SystemRoot ${String(systemRoot)} must fail closed`
    );
  }
  assert.equal(
    resolveWindowsSystem32Executable("..\\taskkill.exe", {
      env: { SystemRoot: "C:\\Windows" },
    }),
    null
  );
  assert.equal(
    resolveWindowsSystem32Executable("powershell.exe", {
      env: { SystemRoot: "C:\\Windows" },
      subdirectories: [".."],
    }),
    null
  );
});

test("Windows process identity reuses the trusted resolver and never executes invalid roots", () => {
  const calls = [];
  const startedAt = processStartTime(4242, {
    platform: "win32",
    env: {
      SystemRoot: "D:\\WinNT",
      PATH: "C:\\attacker",
      dualog_internal_process_probe_pid: "9999",
    },
    execFileSyncFn(command, args, options) {
      calls.push({ command, args, options });
      return "638923456789012345";
    },
  });
  assert.equal(startedAt, "638923456789012345");
  assert.equal(
    calls[0].command,
    "D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  assert.equal(calls[0].options.env.DUALOG_INTERNAL_PROCESS_PROBE_PID, "4242");
  assert.equal(
    Object.keys(calls[0].options.env).filter(
      (key) => key.toLocaleLowerCase("en-US") === "dualog_internal_process_probe_pid"
    ).length,
    1
  );

  for (const systemRoot of [
    "C:\\Users\\test\\Windows",
    "C:\\Windows\\..\\Temp",
    '"C:\\Windows"',
    "C:\\Windows:payload",
  ]) {
    let executions = 0;
    assert.equal(
      processStartTime(4242, {
        platform: "win32",
        env: { SystemRoot: systemRoot },
        execFileSyncFn: () => {
          executions += 1;
          return "638923456789012345";
        },
      }),
      null
    );
    assert.equal(executions, 0, `${systemRoot} must never reach PowerShell`);
  }
});

test("Windows command-line probing uses fixed trusted PowerShell and CIM argv", () => {
  const calls = [];
  const commandLine = '"C:\\Program Files\\nodejs\\node.exe" runner.mjs';
  const output = readProcessCommandLine(4242, {
    platform: "win32",
    env: {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\attacker",
      dualog_internal_command_line_pid: "9999",
    },
    execFileSyncFn(command, args, options) {
      calls.push({ command, args, options });
      return encodeWindowsCommandLine(commandLine);
    },
  });

  assert.equal(output, commandLine);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  );
  assert.deepEqual(calls[0].args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  const script = calls[0].args[4];
  assert.match(script, /\$PSHOME/u);
  assert.match(script, /CimCmdlets\.psd1/u);
  assert.match(script, /Microsoft\.PowerShell\.Core\\Import-Module/u);
  assert.match(script, /CimCmdlets\\Get-CimInstance/u);
  assert.match(script, /Encoding\]::UTF8\.GetBytes/u);
  assert.match(script, /Convert\]::ToBase64String/u);
  assert.doesNotMatch(script, /4242/u, "the pid must not be interpolated into PowerShell");
  assert.equal(calls[0].options.env.DUALOG_INTERNAL_COMMAND_LINE_PID, "4242");
  assert.equal(
    Object.keys(calls[0].options.env).filter(
      (key) => key.toLowerCase() === "dualog_internal_command_line_pid"
    ).length,
    1,
    "differently-cased inherited values must not win Windows env sorting"
  );
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.encoding, "ascii");
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.maxBuffer, 128 * 1024);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "ignore"]);
});

test("Windows command-line probing preserves non-ASCII runner and session paths", () => {
  const commandLine = [
    '"C:\\Users\\Zoë 李\\dualog\\src\\pr-review-runner.mjs"',
    '"C:\\会話\\セッション 🚀"',
    "--runner-token=unicode-identity",
  ].join(" ");

  assert.equal(
    readProcessCommandLine(4242, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      execFileSyncFn: () => encodeWindowsCommandLine(commandLine),
    }),
    commandLine
  );
});

test("Windows command-line probing fails closed on malformed Base64 or UTF-8", () => {
  const malformed = [
    "not base64!",
    "QQ", // missing required padding
    "ZE==", // non-canonical padding bits
    "IA==\n", // helper output must be one exact ASCII token
    "AA==", // decoded NUL is not a command line identity
    Buffer.from([0xc3, 0x28]).toString("base64"), // invalid UTF-8
  ];

  for (const encoded of malformed) {
    assert.equal(
      readProcessCommandLine(4242, {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        execFileSyncFn: () => encoded,
      }),
      "",
      `malformed helper output ${JSON.stringify(encoded)} must fail closed`
    );
  }
});

test("invalid Windows command-line probes never execute PowerShell", () => {
  let calls = 0;
  const execFileSyncFn = () => {
    calls += 1;
    return "";
  };
  for (const pid of [0, -1, 1.5, "42", "42; calc.exe", 2 ** 32]) {
    assert.equal(
      readProcessCommandLine(pid, {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        execFileSyncFn,
      }),
      ""
    );
  }
  assert.equal(
    readProcessCommandLine(4242, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows\\..\\Temp" },
      execFileSyncFn,
    }),
    ""
  );
  assert.equal(calls, 0);
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
