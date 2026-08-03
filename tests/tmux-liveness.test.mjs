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
} from "../src/tmux-runtime.mjs";
import { killTmuxServer } from "./helpers/tmux.mjs";

const SOCKET = `dualog-liveness-${process.pid}`;

/** A stand-in tmux that exits how the case needs, ignoring its arguments. */
function fakeTmux(t, { exitCode = 0, stderr = "", stdout = "" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-faketmux-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "tmux");
  fs.writeFileSync(
    file,
    `#!/bin/sh\n` +
      (stdout ? `printf '%s\\n' ${JSON.stringify(stdout)}\n` : "") +
      (stderr ? `printf '%s\\n' ${JSON.stringify(stderr)} >&2\n` : "") +
      `exit ${exitCode}\n`
  );
  fs.chmodSync(file, 0o755);
  return file;
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

for (const { label, stub, expected } of PROBE_CASES) {
  test(`async and sync probes agree: ${label}`, async (t) => {
    withTmuxBinary(t, fakeTmux(t, stub));
    assert.equal(await probeTmuxSession("dlg-x"), expected);
    assert.equal(probeTmuxSessionSync("dlg-x"), expected);
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

test("an unusable session name is never reported as absent", async (t) => {
  // `absent` from this function authorizes deletion. A name we cannot even ask
  // about must not produce it.
  withTmuxBinary(t, fakeTmux(t, { exitCode: 0 }));
  for (const name of ["", null, undefined, 42, "has:colon", "has\0null"]) {
    assert.equal(await probeTmuxSession(name), "unknown", String(name));
    assert.equal(probeTmuxSessionSync(name), "unknown", String(name));
  }
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
  );

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
