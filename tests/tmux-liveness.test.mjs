// Three-valued tmux liveness.
//
// The whole point of this module is that "tmux said no" and "tmux did not
// answer" are different facts. Collapsing them is not a cosmetic problem: the
// same `false` was read by a turn-length poll loop as "the partner's pane
// exited" (aborting a live turn on one unlucky 10-second timeout) and by the
// credential sweep as "cannot tell" (retaining forever). Every case here pins
// one of those two directions.
//
// The stubs matter as much as the assertions. These are the exact strings tmux
// 3.5a prints, captured from a real binary -- an invented message would let a
// wrong classifier pass.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  analyzeTerminalActivity,
  classifyTmuxProbeFailure,
  isTmuxSessionAlive,
  probeTmuxSession,
  probeTmuxSessionSync,
  startTmuxSession,
  terminateTmuxSession,
} from "../src/tmux-runtime.mjs";
import { probeProcess } from "../src/process-probe.mjs";
import { killTmuxServer } from "./helpers/tmux.mjs";
import { writeNodeCommand } from "./helpers/node-command.mjs";

const SOCKET = `dualog-liveness-${process.pid}`;
const SIMULATED_WINDOWS_SOCKET = `${SOCKET}-win32`;

function executableTmux(t, name, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dualog-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "calls.jsonl");
  const command = writeNodeCommand(
    dir,
    name,
    `import fs from "node:fs";\n` +
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      source
  );
  return { command, dir, log };
}

function readTmuxCalls(log) {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A trusted direct-executable route whose process boundary is injected below. */
function simulatedWindowsTmuxRoute() {
  const command = "C:\\dualog-tests\\tmux.exe";
  return {
    transport: "local",
    command,
    distro: null,
    tmuxBinary: command,
    tmuxSocketName: SIMULATED_WINDOWS_SOCKET,
  };
}

function tmuxResult({ exitCode = 0, stdout = "", stderr = "" } = {}) {
  return { exitCode, stdout, stderr };
}

/** Semantic tmux double: no shell/package shim participates in these tests. */
function scriptedTmux({
  panePid = "4242",
  paneId = "%0",
  panePidError = null,
  paneIdError = null,
} = {}) {
  const calls = [];
  const runTmuxFn = async (args, options = {}) => {
    calls.push({ args: [...args], options });
    if (args[0] === "display-message" && args.at(-1) === "#{pane_pid}") {
      if (panePidError) throw panePidError;
      return tmuxResult({ stdout: `${panePid}\n` });
    }
    if (args[0] === "display-message" && args.at(-1) === "#{pane_id}") {
      if (paneIdError) throw paneIdError;
      return tmuxResult({ stdout: `${paneId}\n` });
    }
    return tmuxResult();
  };
  return { calls, runTmuxFn };
}

function withTmuxBinary(t, binary) {
  const previous = process.env.DUALOG_TMUX_BINARY;
  process.env.DUALOG_TMUX_BINARY = binary;
  t.after(() => {
    if (previous === undefined) delete process.env.DUALOG_TMUX_BINARY;
    else process.env.DUALOG_TMUX_BINARY = previous;
  });
}

function realTmuxAvailable() {
  return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
}

// --- what a failed probe proves ---------------------------------------------

test("real tmux failure messages are classified as absence or ignorance", () => {
  const absent = [
    // has-session, server up, no such session
    "can't find session: dlg-x",
    // older phrasing kept in the pattern
    "session not found: dlg-x",
    // server exited, socket still on disk
    "no server running on /private/tmp/tmux-501/dualog",
    // THE SHIPPED BUG: this is what tmux 3.5a prints when the socket was never
    // created -- the ordinary state of a machine that has not run tmux since
    // boot. The previous pattern (`no such file or directory.*tmux`) required
    // "tmux" to appear AFTER the errno text, which it never does, so this read
    // as `unknown` and the credential sweep retained every such session
    // permanently.
    "error connecting to /private/tmp/tmux-501/dualog (No such file or directory)",
    // a stale socket whose server is gone
    "error connecting to /private/tmp/tmux-501/dualog (Connection refused)",
  ];
  for (const stderr of absent) {
    assert.equal(classifyTmuxProbeFailure({ stderr }), "absent", stderr);
  }

  const unknown = [
    // Deliberately NOT absence: a socket we may not open is one somebody else's
    // server is very likely still listening on.
    "error connecting to /private/tmp/tmux-501/dualog (Permission denied)",
    // tmux is not installed, or not where we looked. Not evidence a pane died.
    "spawn tmux ENOENT",
    // killed by our own timeout: no message at all
    "",
    "some phrasing a future tmux invents",
  ];
  for (const stderr of unknown) {
    assert.equal(classifyTmuxProbeFailure({ stderr }), "unknown", stderr);
  }
});

// --- the two probes must never disagree --------------------------------------

const PROBE_CASES = [
  { label: "session exists", stub: { exitCode: 0 }, expected: "alive" },
  {
    label: "server says no such session",
    stub: { exitCode: 1, stderr: "can't find session: dlg-x" },
    expected: "absent",
  },
  {
    label: "no server listening",
    stub: {
      exitCode: 1,
      stderr: "error connecting to /private/tmp/tmux-501/dualog (No such file or directory)",
    },
    expected: "absent",
  },
  {
    label: "socket not ours to open",
    stub: { exitCode: 1, stderr: "error connecting to /x (Permission denied)" },
    expected: "unknown",
  },
];

for (const [caseIndex, { label, stub, expected }] of PROBE_CASES.entries()) {
  test(`async and sync probes agree: ${label}`, async (t) => {
    if (process.platform === "win32") {
      // Native Windows rejects .cmd/.bat control shims because a timed-out
      // synchronous probe cannot prove their descendants stopped. Exercise the
      // same routing and classification contract without creating such a shim.
      const route = simulatedWindowsTmuxRoute();
      let asyncCalls = 0;
      const asyncVerdict = await probeTmuxSession(
        "dlg-x",
        { tmuxRoute: route },
        {
          runTmuxFn: async (args, options) => {
            asyncCalls++;
            assert.deepEqual(args, ["has-session", "-t", "=dlg-x"]);
            assert.equal(options.allowFailure, true);
            assert.deepEqual(options.route, route);
            return tmuxResult(stub);
          },
        }
      );

      let syncCalls = 0;
      const syncVerdict = probeTmuxSessionSync("dlg-x", {
        route,
        platform: "win32",
        spawnSyncFn: (command, args, options) => {
          syncCalls++;
          assert.equal(command, route.command);
          assert.deepEqual(args, [
            "-f",
            "/dev/null",
            "-L",
            SIMULATED_WINDOWS_SOCKET,
            "has-session",
            "-t",
            "=dlg-x",
          ]);
          assert.equal(options.windowsHide, true);
          return {
            status: stub.exitCode,
            stdout: stub.stdout ?? "",
            stderr: stub.stderr ?? "",
          };
        },
      });

      assert.equal(asyncCalls, 1, "the async verdict must come from the injected probe");
      assert.equal(syncCalls, 1, "the sync verdict must come from the injected probe");
      assert.equal(asyncVerdict, expected);
      assert.equal(syncVerdict, expected);
      return;
    }

    // POSIX keeps an executable-backed boundary test. Both probes must route
    // through the configured binary/socket, preserve argv, and classify the
    // actual child process's exit code and stderr identically.
    const fixture = executableTmux(
      t,
      `probe-${caseIndex}`,
      `${stub.stdout ? `process.stdout.write(${JSON.stringify(`${stub.stdout}\n`)});\n` : ""}` +
        `${stub.stderr ? `process.stderr.write(${JSON.stringify(`${stub.stderr}\n`)});\n` : ""}` +
        `process.exit(${stub.exitCode});\n`
    );
    const socket = `${SOCKET}-probe-${caseIndex}`;
    const previousSocket = process.env.DUALOG_TMUX_SOCKET;
    process.env.DUALOG_TMUX_SOCKET = socket;
    t.after(() => {
      if (previousSocket === undefined) delete process.env.DUALOG_TMUX_SOCKET;
      else process.env.DUALOG_TMUX_SOCKET = previousSocket;
    });
    withTmuxBinary(t, fixture.command);

    assert.equal(await probeTmuxSession("dlg-x"), expected);
    assert.equal(probeTmuxSessionSync("dlg-x"), expected);
    assert.deepEqual(readTmuxCalls(fixture.log), [
      ["-f", "/dev/null", "-L", socket, "has-session", "-t", "=dlg-x"],
      ["-f", "/dev/null", "-L", socket, "has-session", "-t", "=dlg-x"],
    ]);
  });
}

test("a tmux binary that will not spawn is ignorance, not absence", async (t) => {
  // The sweep's contract depends on this exact verdict: a machine where tmux is
  // missing or misconfigured must not conclude that every preserved pane died
  // and start deleting the homes underneath them.
  withTmuxBinary(t, path.join(os.tmpdir(), "dualog-no-such-tmux-binary"));
  assert.equal(await probeTmuxSession("dlg-x"), "unknown");
  assert.equal(probeTmuxSessionSync("dlg-x"), "unknown");
  assert.equal(await isTmuxSessionAlive("dlg-x"), false);
});

test("unusable tmux configuration is ignorance, not absence", async (t) => {
  // tmuxBinary() and tmuxSocketName() reject nonsense by throwing, which lands
  // in the probes' catch. A misconfigured runtime is a question we failed to
  // ask; answering "absent" would hand the sweep a deletion licence on the
  // strength of a typo in an environment variable.
  const saved = {
    binary: process.env.DUALOG_TMUX_BINARY,
    socket: process.env.DUALOG_TMUX_SOCKET,
  };
  t.after(() => {
    for (const [key, value] of [
      ["DUALOG_TMUX_BINARY", saved.binary],
      ["DUALOG_TMUX_SOCKET", saved.socket],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  process.env.DUALOG_TMUX_BINARY = "   ";
  assert.equal(await probeTmuxSession("dlg-x"), "unknown");
  assert.equal(probeTmuxSessionSync("dlg-x"), "unknown");

  process.env.DUALOG_TMUX_BINARY = "tmux";
  process.env.DUALOG_TMUX_SOCKET = "not/a/name";
  assert.equal(await probeTmuxSession("dlg-x"), "unknown");
  assert.equal(probeTmuxSessionSync("dlg-x"), "unknown");
});

test("an unusable session name is never reported as absent", async () => {
  // `absent` from this function authorizes deletion. A name we cannot even ask
  // about must not produce it or reach either process boundary. The explicit
  // counters make that true even when tmux is missing and on native Windows.
  let asyncCalls = 0;
  let syncCalls = 0;
  const runTmuxFn = async () => {
    asyncCalls++;
    throw new Error("invalid session name reached async tmux execution");
  };
  const spawnSyncFn = () => {
    syncCalls++;
    throw new Error("invalid session name reached sync tmux execution");
  };
  for (const name of ["", null, undefined, 42, "has:colon", "has\0null"]) {
    assert.equal(
      await probeTmuxSession(name, null, { runTmuxFn }),
      "unknown",
      String(name)
    );
    assert.equal(
      probeTmuxSessionSync(name, { spawnSyncFn }),
      "unknown",
      String(name)
    );
  }
  assert.equal(asyncCalls, 0, "invalid names must be rejected before async execution");
  assert.equal(syncCalls, 0, "invalid names must be rejected before sync execution");
});

// --- exactness, against a real server ----------------------------------------

test("a session name is matched exactly, not as a prefix", async (t) => {
  if (!realTmuxAvailable()) {
    t.skip("tmux is not installed");
    return;
  }
  const previousSocket = process.env.DUALOG_TMUX_SOCKET;
  process.env.DUALOG_TMUX_SOCKET = SOCKET;
  delete process.env.DUALOG_TMUX_BINARY;
  t.after(() => {
    killTmuxServer(SOCKET);
    if (previousSocket === undefined) delete process.env.DUALOG_TMUX_SOCKET;
    else process.env.DUALOG_TMUX_SOCKET = previousSocket;
  });

  const name = `dualog-exact-${process.pid}`;
  const created = spawnSync(
    "tmux",
    ["-f", "/dev/null", "-L", SOCKET, "new-session", "-d", "-s", name, "sleep 60"],
    { encoding: "utf-8" }
  );
  assert.equal(created.status, 0, created.stderr);

  assert.equal(await probeTmuxSession(name), "alive");
  assert.equal(probeTmuxSessionSync(name), "alive");

  // tmux resolves a bare `-t` target as a prefix or fnmatch pattern, so without
  // the `=` prefix this name reports the OTHER session as alive -- which would
  // make a dead pane look permanently running and hang a turn forever.
  const prefix = name.slice(0, -3);
  assert.equal(await probeTmuxSession(prefix), "absent");
  assert.equal(probeTmuxSessionSync(prefix), "absent");
});

// --- the turn loops, pinned at the source ------------------------------------

test("nothing that can end a turn uses the two-valued predicate", () => {
  // Driving a real turn to the point where tmux stops answering, and proving it
  // keeps waiting, needs a live pane plus a mid-flight break of the tmux binary
  // -- so this pins the property structurally instead, as this suite already
  // does for hook fail-open and env containment.
  //
  // Three sites in this module throw PartnerTerminalFailureError("terminal_exited")
  // and each is a whole turn's worth of work. `isTmuxSessionAlive()` returns
  // false for a ten-second exec timeout exactly as it does for a closed pane, so
  // a single unlucky call used to abort a healthy turn -- most likely in
  // waitForSidecarCompletion, which polls for the entire duration of one.
  const src = fs.readFileSync(
    new URL("../src/partner-invocation.mjs", import.meta.url),
    "utf-8"
  ).replace(/\r\n?/gu, "\n");

  assert.doesNotMatch(
    src,
    /isTmuxSessionAlive/,
    "partner-invocation must decide liveness with probeTmuxSession(), not the boolean predicate"
  );

  const terminalExited = src.match(/"terminal_exited"/g) || [];
  assert.equal(terminalExited.length, 3, "the three turn-ending sites are still the only ones");

  // Every liveness read in this module must resolve to a comparison against
  // "absent" -- either inline, or via the named `liveness` binding that the
  // sidecar loop tests for absence and then reports on.
  const reads = src
    .split("\n")
    .filter((line) => line.includes("probeTmuxSession("));
  assert.equal(reads.length, 4, "one status read plus three turn-ending guards");
  for (const read of reads) {
    assert.match(
      read,
      /"absent"|const liveness = /,
      `a liveness read that does not test for proven absence: ${read.trim()}`
    );
  }
  assert.match(
    src,
    /if \(liveness === "absent"\) \{/,
    "the sidecar loop ends the turn only on a proven absence"
  );
});

// --- the pane's process, against a real server --------------------------------

test("native tmux keeps /bin/sh -lc while WSL uses its interactive login shell", async (t) => {
  if (process.platform === "win32") {
    const local = scriptedTmux();
    await startTmuxSession(
      {
        sessionName: "dualog-native-shell-contract",
        cwd: process.cwd(),
        command: "printf",
        args: ["hello world"],
        env: {},
        route: simulatedWindowsTmuxRoute(),
      },
      { runTmuxFn: local.runTmuxFn }
    );
    let creation = local.calls.find(({ args }) => args[0] === "new-session");
    assert.ok(creation, "the native route must create a tmux session");
    let payload = creation.args.at(-1);
    assert.match(payload, /\/bin\/sh -lc/u);
    assert.doesNotMatch(payload, /-lic/u);

    const wsl = scriptedTmux();
    const wslRoute = {
      transport: "wsl",
      command: "C:\\Windows\\System32\\wsl.exe",
      distro: "Ubuntu",
      tmuxBinary: "tmux",
      tmuxSocketName: SIMULATED_WINDOWS_SOCKET,
      loginShell: "/bin/bash",
    };
    await startTmuxSession(
      {
        sessionName: "dualog-wsl-shell-contract",
        cwd: "/mnt/c/repo",
        command: "claude",
        args: ["--version"],
        env: {},
        route: wslRoute,
      },
      { runTmuxFn: wsl.runTmuxFn }
    );
    creation = wsl.calls.find(({ args }) => args[0] === "new-session");
    assert.ok(creation, "the WSL route must create a tmux session");
    payload = creation.args.at(-1);
    assert.match(payload, /'\/bin\/bash' -lic/u);
    return;
  }

  const fixture = executableTmux(
    t,
    "tmux-boundary",
    `const tmuxArgs = process.argv.slice(2);\n` +
      `if (tmuxArgs.at(-1) === "#{pane_pid}") process.stdout.write("4242\\n");\n` +
      `else if (tmuxArgs.at(-1) === "#{pane_id}") process.stdout.write("%0\\n");\n`
  );
  const socket = `${SOCKET}-shell-payload`;
  const localRoute = {
    transport: "local",
    command: fixture.command,
    distro: null,
    tmuxBinary: fixture.command,
    tmuxSocketName: socket,
  };
  await startTmuxSession({
    sessionName: "dualog-native-shell-contract",
    cwd: fixture.dir,
    command: "printf",
    args: ["hello world"],
    env: {},
    route: localRoute,
  });
  let creation = readTmuxCalls(fixture.log).find((args) => args.includes("new-session"));
  assert.ok(creation, "the native route must cross the executable boundary");
  let payload = creation.at(-1);
  assert.deepEqual(creation.slice(0, -1), [
    "-f",
    "/dev/null",
    "-L",
    socket,
    "new-session",
    "-d",
    "-s",
    "dualog-native-shell-contract",
    "-c",
    fixture.dir,
  ]);
  assert.match(payload, /\/bin\/sh -lc/u);
  assert.doesNotMatch(payload, /-lic/u);
  assert.match(payload, /hello world/u);

  fs.writeFileSync(fixture.log, "");
  const wslRoute = {
    transport: "wsl",
    command: fixture.command,
    distro: "Ubuntu",
    tmuxBinary: "tmux",
    tmuxSocketName: socket,
    loginShell: "/bin/bash",
  };
  await startTmuxSession({
    sessionName: "dualog-wsl-shell-contract",
    cwd: "/mnt/c/repo",
    command: "claude",
    args: ["--version"],
    env: {},
    route: wslRoute,
  });
  creation = readTmuxCalls(fixture.log).find((args) => args.includes("new-session"));
  assert.ok(creation, "the WSL route must cross the executable boundary");
  payload = creation.at(-1);
  assert.deepEqual(creation.slice(0, -1), [
    "--distribution",
    "Ubuntu",
    "--exec",
    "tmux",
    "-f",
    "/dev/null",
    "-L",
    socket,
    "new-session",
    "-d",
    "-s",
    "dualog-wsl-shell-contract",
    "-c",
    "/mnt/c/repo",
  ]);
  assert.match(payload, /'\/bin\/bash' -lic/u);
  assert.match(payload, /--version/u);
});

test("a started session reports the process running in its pane", async (t) => {
  if (!realTmuxAvailable()) {
    t.skip("tmux is not installed");
    return;
  }
  const socket = `${SOCKET}-panepid`;
  const previousSocket = process.env.DUALOG_TMUX_SOCKET;
  process.env.DUALOG_TMUX_SOCKET = socket;
  delete process.env.DUALOG_TMUX_BINARY;

  const handle = await startTmuxSession({
    sessionName: `dualog-panepid-${process.pid}`,
    cwd: process.cwd(),
    command: "sleep",
    args: ["60"],
    env: {},
  });
  t.after(() => {
    killTmuxServer(socket);
    if (previousSocket === undefined) delete process.env.DUALOG_TMUX_SOCKET;
    else process.env.DUALOG_TMUX_SOCKET = previousSocket;
  });

  // The credential lease's release decision reads this: a closed pane is not an
  // exited process, so without a pid there is nothing to check the difference
  // against and cleanup falls back to trusting the session alone.
  assert.ok(Number.isSafeInteger(handle.panePid) && handle.panePid > 0, "pane_pid must be captured");
  assert.equal(probeProcess(handle.panePid), "alive", "and must name a process that exists");

  await terminateTmuxSession(handle);
  assert.equal(await probeTmuxSession(handle.sessionName), "absent");
});

test("a pane whose process could not be read is marked, not left ambiguous", async (t) => {
  // `panePid: null` from a FAILED query and `panePid` absent from an old record
  // look identical downstream, so the failure has to say so. Without the marker,
  // a live pane we could not identify is judged on its session name alone --
  // which is what let a partner outlive its pane and lose its home.
  let handle;
  if (process.platform === "win32") {
    const tmux = scriptedTmux({ panePidError: new Error("cannot read pane_pid") });
    handle = await startTmuxSession(
      {
        sessionName: "dualog-nopid",
        cwd: process.cwd(),
        command: "irrelevant",
        args: [],
        env: {},
        route: simulatedWindowsTmuxRoute(),
      },
      { runTmuxFn: tmux.runTmuxFn }
    );
  } else {
    const fixture = executableTmux(
      t,
      "tmux-nopid",
      `const tmuxArgs = process.argv.slice(2);\n` +
        `if (tmuxArgs.at(-1) === "#{pane_pid}") {\n` +
        `  process.stderr.write("cannot read pane_pid\\n");\n` +
        `  process.exit(19);\n` +
        `}\n` +
        `if (tmuxArgs.at(-1) === "#{pane_id}") process.stdout.write("%0\\n");\n`
    );
    withTmuxBinary(t, fixture.command);
    handle = await startTmuxSession({
      sessionName: "dualog-nopid",
      cwd: fixture.dir,
      command: "irrelevant",
      args: [],
      env: {},
    });
    assert.ok(
      readTmuxCalls(fixture.log).some((args) => args.at(-1) === "#{pane_pid}"),
      "the failed pane_pid query must cross the production executable boundary"
    );
  }
  assert.equal(handle.panePid, null);
  assert.equal(handle.panePidUnavailable, true, "a failed capture must be recorded as such");
});

test("a spawn that fails after the pane exists still yields the pane's process", async (t) => {
  // The pane is created by `new-session`; everything after it is fallible setup.
  // If one of those queries fails, the pane is LIVE and the caller is about to
  // release a credential lease -- so the identity has to survive the failure,
  // and it has to be captured before the fallible part rather than after it.
  let invoke;
  let readCalls;
  let productionBoundary = false;
  if (process.platform === "win32") {
    // A native-Windows semantic double avoids the intentionally rejected .cmd
    // launcher while still pinning pane identity and cleanup ordering.
    const tmux = scriptedTmux({ paneIdError: new Error("pane_id query failed") });
    invoke = () =>
      startTmuxSession(
        {
          sessionName: "dualog-spawnfail",
          cwd: process.cwd(),
          command: "irrelevant",
          args: [],
          env: {},
          route: simulatedWindowsTmuxRoute(),
        },
        { runTmuxFn: tmux.runTmuxFn }
      );
    readCalls = () => tmux.calls.map(({ args }) => args);
  } else {
    // POSIX must traverse the real runTmux -> runExecFile boundary. A nonzero
    // pane_id result therefore proves production rejection and the subsequent
    // kill-session cleanup, instead of merely testing an injected throw.
    const fixture = executableTmux(
      t,
      "tmux-spawnfail",
      `const tmuxArgs = process.argv.slice(2);\n` +
        `if (tmuxArgs.at(-1) === "#{pane_pid}") process.stdout.write("4242\\n");\n` +
        `else if (tmuxArgs.at(-1) === "#{pane_id}") {\n` +
        `  process.stderr.write("pane_id query failed\\n");\n` +
        `  process.exit(23);\n` +
        `}\n`
    );
    withTmuxBinary(t, fixture.command);
    invoke = () =>
      startTmuxSession({
        sessionName: "dualog-spawnfail",
        cwd: fixture.dir,
        command: "irrelevant",
        args: [],
        env: {},
      });
    readCalls = () => readTmuxCalls(fixture.log);
    productionBoundary = true;
  }

  await assert.rejects(
    invoke,
    (err) => {
      assert.equal(err.panePid, 4242, "the pane's process must come out with the failure");
      assert.equal(err.sessionName, "dualog-spawnfail");
      if (productionBoundary) {
        assert.match(
          err.message,
          /tmux display-message .*#\{pane_id\} failed with exit 23: pane_id query failed/u,
          "the production runTmux rejection must carry the real child exit and stderr"
        );
      }
      return true;
    }
  );
  const calls = readCalls();
  const panePidIndex = calls.findIndex((args) => args.at(-1) === "#{pane_pid}");
  const paneIdIndex = calls.findIndex((args) => args.at(-1) === "#{pane_id}");
  const cleanupIndex = calls.findIndex(
    (args) => args.includes("kill-session") && args.at(-1) === "=dualog-spawnfail"
  );
  assert.ok(panePidIndex >= 0 && panePidIndex < paneIdIndex, "pane_pid must be captured first");
  assert.ok(
    cleanupIndex > paneIdIndex,
    "a failed pane_id query must clean up the already-created session"
  );
});

// --- what the classifier tells a driver --------------------------------------

test("unprovable liveness is not reported as a dead pane", () => {
  const busy = "· Thinking… (12.3k tokens · 45s)";

  const gone = analyzeTerminalActivity(busy, "codex", { liveness: "absent" });
  assert.equal(gone.state, "not_running");
  assert.equal(gone.confidence, "high");

  // The same screen with liveness we could not establish must NOT come back as
  // "not_running": a driver reads that as the turn having died.
  const unsure = analyzeTerminalActivity(busy, "codex", { liveness: "unknown" });
  assert.notEqual(unsure.state, "not_running");
  assert.equal(unsure.confidence, "low");
  assert.match(unsure.summary, /could not confirm/i);

  const live = analyzeTerminalActivity(busy, "codex", { liveness: "alive" });
  assert.equal(live.state, "thinking");
  assert.equal(live.confidence, "high");
});

test("an empty capture only reads as not_running when the pane is proven gone", () => {
  assert.equal(
    analyzeTerminalActivity("", "codex", { liveness: "absent" }).state,
    "not_running"
  );
  assert.equal(
    analyzeTerminalActivity("", "codex", { liveness: "unknown" }).state,
    "unknown"
  );
  assert.equal(
    analyzeTerminalActivity("", "codex", { liveness: "alive" }).state,
    "unknown"
  );
});

test("the boolean alive option still means what it always did", () => {
  // Callers outside this change pass { alive: true|false }; both keep working.
  assert.equal(analyzeTerminalActivity("", "codex", { alive: false }).state, "not_running");
  assert.equal(analyzeTerminalActivity("", "codex", { alive: true }).state, "unknown");
  assert.equal(analyzeTerminalActivity("", "codex", {}).state, "unknown");
});
