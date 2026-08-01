// The SIGKILL gap for headless partner turns.
//
// A tmux turn is recoverable after a runner dies because its pane is recorded in
// current_terminal.json and terminateCurrentPartnerTerminal can still reach it.
// A headless child has no such handle, so when a runner is SIGKILLed -- no
// signal handler runs -- the child is left with nothing pointing at it. The
// per-turn headless-child.json record is what closes that gap, and this file
// covers both halves of using it: reaping a real orphan, and refusing to signal
// a PID that has been recycled.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { execFileSync } from "node:child_process";

import {
  reapOrphanedHeadlessChildren,
  terminateActiveHeadlessTurnsAndWait,
} from "../src/engines/headless.mjs";
import { isProcessAlive } from "../src/shared.mjs";

/** The same identity the production record stores: PID plus OS start time. */
function startTimeOf(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function makeSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-headless-orphan-"));
  return dir;
}

function writeRecord(sessionDir, turnId, record) {
  const turnDir = path.join(sessionDir, "turns", turnId);
  fs.mkdirSync(turnDir, { recursive: true });
  fs.writeFileSync(
    path.join(turnDir, "headless-child.json"),
    JSON.stringify(record, null, 2)
  );
  return path.join(turnDir, "headless-child.json");
}

async function waitForExit(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("an orphaned headless child is terminated and its record cleared", async (t) => {
  const sessionDir = makeSession();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));

  // Stand in for a partner CLI the runner never got to reap. Detached so it
  // leads its own group, exactly as runHeadlessTurn spawns one.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* already reaped by the code under test */
    }
  });

  const startTime = startTimeOf(child.pid);
  if (!startTime) {
    t.skip("this environment does not permit reading process start times");
    return;
  }

  const recordPath = writeRecord(sessionDir, "turn-1", {
    pid: child.pid,
    pgid: child.pid,
    command: process.execPath,
    start_time: startTime,
    started_at: new Date().toISOString(),
  });

  assert.equal(isProcessAlive(child.pid), true, "precondition: the orphan is running");

  const signalled = await reapOrphanedHeadlessChildren(sessionDir);
  assert.equal(signalled, 1);

  assert.equal(
    await waitForExit(child.pid),
    true,
    "the orphaned child should be gone after the sweep"
  );
  assert.equal(fs.existsSync(recordPath), false, "the record should be cleared");
});

test("a recycled PID is forgotten, never signalled", async (t) => {
  // The whole hazard: a stale record has had time for its PID to be reused, and
  // killing whatever now owns that number would be far worse than leaking. The
  // repo already applies this rule to runner liveness; it has to hold here too.
  const sessionDir = makeSession();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));

  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      process.kill(bystander.pid, "SIGKILL");
    } catch {
      /* nothing to do */
    }
  });

  // The realistic hazard, not a strawman: the record names the SAME executable
  // this process is running -- "node", "opencode", whatever the partner CLI is.
  // Matching on the command alone would authorize killing it. Only the start
  // time distinguishes the recycled PID from the original process.
  const recordPath = writeRecord(sessionDir, "turn-1", {
    pid: bystander.pid,
    pgid: bystander.pid,
    command: process.execPath,
    start_time: "Thu Jan  1 00:00:00 2020", // a PID from a previous era
    started_at: new Date(0).toISOString(),
  });

  const signalled = await reapOrphanedHeadlessChildren(sessionDir);
  assert.equal(signalled, 0, "must not signal a process it cannot identify");

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    isProcessAlive(bystander.pid),
    true,
    "the unrelated process must still be running"
  );

  // What happens to the RECORD depends on whether identity was decidable, and
  // both outcomes are correct behavior rather than one being a fallback.
  //
  // With `ps` available the start times disagree, identity is "no", and the
  // record describes nothing worth keeping. Where `ps` is denied -- a sandboxed
  // partner running this suite is the case that matters -- identity is
  // "unknown", and the record must be RETAINED so a later sweep in a less
  // restricted context can still act on it. Asserting deletion unconditionally
  // made this test fail in exactly the environment the production code was
  // changed to handle safely.
  if (startTimeOf(bystander.pid)) {
    assert.equal(fs.existsSync(recordPath), false, "a decidable mismatch clears the record");
  } else {
    assert.equal(
      fs.existsSync(recordPath),
      true,
      "an undecidable identity must retain the breadcrumb, not discard it"
    );
    const retained = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    assert.equal(retained.reap_attempts, 1, "the attempt should be recorded for a later retry");
  }
});

test("a record with no matching process is cleared without incident", async (t) => {
  const sessionDir = makeSession();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));

  // A PID that is almost certainly dead, plus a malformed record.
  const deadRecord = writeRecord(sessionDir, "turn-1", {
    pid: 2 ** 22,
    command: process.execPath,
  });
  const junkDir = path.join(sessionDir, "turns", "turn-2");
  fs.mkdirSync(junkDir, { recursive: true });
  fs.writeFileSync(path.join(junkDir, "headless-child.json"), "not json");

  assert.equal(await reapOrphanedHeadlessChildren(sessionDir), 0);
  assert.equal(fs.existsSync(deadRecord), false);
});

test("a session that never ran a headless turn sweeps to zero", async (t) => {
  const sessionDir = makeSession();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));

  // No turns directory at all.
  assert.equal(await reapOrphanedHeadlessChildren(sessionDir), 0);

  // A turns directory with ordinary turns and no child records.
  fs.mkdirSync(path.join(sessionDir, "turns", "turn-1"), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "turns", "turn-1", "result.md"), "done");
  assert.equal(await reapOrphanedHeadlessChildren(sessionDir), 0);
});

test("graceful shutdown escalates to SIGKILL instead of scheduling it", async (t) => {
  // terminateActiveHeadlessTurns() sets a 2s timer for SIGKILL, which is correct
  // only if the caller sticks around. A signal handler calls process.exit()
  // immediately after, taking the timer with it -- so a CLI that ignores SIGTERM
  // outlives the runner that owned it. The awaiting variant must escalate itself.
  const stubborn = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { detached: true, stdio: "ignore" }
  );
  t.after(() => {
    try {
      process.kill(stubborn.pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  });

  // Give the child time to install its SIGTERM trap.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(isProcessAlive(stubborn.pid), true);

  const started = Date.now();
  const signalled = await terminateActiveHeadlessTurnsAndWait({
    graceMs: 400,
    pollMs: 25,
    children: [stubborn],
  });
  assert.equal(signalled, 1);

  assert.equal(
    await waitForExit(stubborn.pid, 3000),
    true,
    "a SIGTERM-ignoring child must still be gone when the call returns"
  );
  assert.ok(Date.now() - started < 3000, "escalation should not wait on the 2s fire-and-forget timer");
});

test("a stubborn leaderless descendant is escalated and only then forgotten", async (t) => {
  // The failure mode the cooperative single-process test cannot reach: the
  // leader is GONE (so classification must come from the group) and the
  // survivor IGNORES SIGTERM (so the record must not be dropped until KILL has
  // actually worked). Signalling, scheduling an unref'd KILL, and unlinking
  // immediately left this process alive and permanently unfindable.
  const sessionDir = makeSession();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));

  const launcher = spawn(
    process.execPath,
    [
      "-e",
      "const{spawn}=require('child_process');" +
        "const k=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:['ignore','pipe','ignore']});" +
        "k.stdout.on('data',()=>{});console.log('KID'+k.pid);setTimeout(()=>process.exit(0),150);",
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] }
  );

  let kid = null;
  launcher.stdout.on("data", (chunk) => {
    const m = /KID(\d+)/.exec(String(chunk));
    if (m) kid = Number(m[1]);
  });

  const startTime = startTimeOf(launcher.pid);
  const recordPath = writeRecord(sessionDir, "turn-1", {
    pid: launcher.pid,
    pgid: launcher.pid,
    command: process.execPath,
    start_time: startTime,
    started_at: new Date().toISOString(),
  });

  // Wait for the launcher to exit, leaving its stubborn child behind.
  for (let i = 0; i < 60 && (isProcessAlive(launcher.pid) || kid === null); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  t.after(() => {
    try {
      process.kill(kid, "SIGKILL");
    } catch {
      /* already reaped */
    }
  });

  assert.equal(isProcessAlive(launcher.pid), false, "precondition: the leader is gone");
  assert.equal(isProcessAlive(kid), true, "precondition: the descendant survives it");

  const signalled = await reapOrphanedHeadlessChildren(sessionDir, { graceMs: 400, pollMs: 25 });

  if (!startTime) {
    // `ps` denied: ownership is undecidable, so the safe answer is to keep the
    // breadcrumb rather than signal or discard it.
    assert.equal(signalled, 0);
    assert.equal(fs.existsSync(recordPath), true, "an undecidable record is retained");
    return;
  }

  assert.equal(signalled, 1, "a leaderless group must still be recognized as ours");
  assert.equal(
    isProcessAlive(kid),
    false,
    "a SIGTERM-ignoring descendant must be escalated to SIGKILL before the call returns"
  );
  assert.equal(
    fs.existsSync(recordPath),
    false,
    "the record goes only once the group is proven dead"
  );
});
