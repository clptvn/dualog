// Runner identity: does isSessionRunnerAlive() recognize its own runner?
//
// The predicate proves a PID really belongs to this session by matching the
// runner script's path against the live process's command line. That mapping
// lived in a two-branch ternary, so adding a THIRD session type silently sent it
// to the dialog default: every `pr_review` session matched a script it was not
// running, reported a perfectly healthy runner as dead from birth, and took the
// whole follow-up phase down with it -- send_message refusing to write,
// wait_for_partner_response returning `runner_exited` before the first pass
// finished, end_dialog skipping its SIGTERM.
//
// None of the existing suites caught it. The panel integration test appends host
// messages straight to conversation.jsonl instead of going through send_message,
// and the start-response contract test only runs panels whose passes fail fast,
// so neither ever asked this question for a live pr_review runner. That is the
// gap this file closes: one case per session type, against a real process
// spawned with the exact argv shape its start tool uses.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  RUNNER_SCRIPT_BY_SESSION_TYPE,
  buildRunnerTokenArg,
  isSessionRunnerAlive,
  probeSessionRunner,
} from "../src/runner-lifecycle.mjs";

const SRC_DIR = path.resolve(fileURLToPath(new URL("../src", import.meta.url)));
const TOKEN = "identity-token-0123456789";

// Every session type, with the script that type's start tool actually spawns.
// A new runner belongs here on the day it is added; an entry missing from this
// table is the exact shape of the defect above.
const RUNNERS = [
  { type: "dialog", script: "dialog-runner.mjs" },
  { type: "review", script: "review-runner.mjs" },
  { type: "pr_review", script: "pr-review-runner.mjs" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A live process wearing a runner's argv.
 *
 * It runs `node -e 'setInterval(...)'` rather than the real runner: the
 * predicate reads nothing but the command line, and booting an actual runner
 * would drag in a partner CLI, a session tree, and a 24-hour idle timer. The
 * argv shape is what is under test, so the argv shape is what is reproduced --
 * script path, session dir, then the token flag.
 */
async function spawnRunnerLookalike(t, scriptPath, sessionDir) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "setInterval(() => {}, 1000)",
      scriptPath,
      sessionDir,
      buildRunnerTokenArg(TOKEN),
    ],
    { stdio: "ignore" }
  );
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  // `ps` has to be able to see it before the assertion means anything.
  await sleep(300);
  return child;
}

function makeSession(t, type) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dualog-identity-${type}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const { type, script } of RUNNERS) {
  test(`a live ${type} runner is recognized as alive`, async (t) => {
    const sessionDir = makeSession(t, type);
    const child = await spawnRunnerLookalike(
      t,
      path.join(SRC_DIR, script),
      sessionDir
    );

    const status = {
      type,
      runner_pid: child.pid,
      runner_token: TOKEN,
      runner_state: "running",
    };

    assert.equal(
      isSessionRunnerAlive(status, sessionDir),
      true,
      `a running ${script} was not recognized for session type "${type}" — ` +
        `every tool that gates on runner liveness is broken for this type`
    );

    // The tri-state probe walks the same pid → command line → table → token
    // chain in a second function body, so it can drift from isSessionRunnerAlive
    // exactly the way the old ternary drifted from reality. Asserted together,
    // per type, or this file would be preventing recurrence of the round-1 bug
    // in one function while the other quietly reintroduced it.
    assert.equal(
      probeSessionRunner(status, sessionDir),
      "alive",
      `probeSessionRunner disagrees with isSessionRunnerAlive for "${type}"`
    );
  });
}

test("the probe distinguishes a proven death from an unreadable process", async (t) => {
  // The distinction get_pr_review_report needs and isSessionRunnerAlive cannot
  // express. Folding both into `false` calls a healthy panel dead wherever `ps`
  // is unavailable; folding both into "unknown" erases a proven death -- which
  // is the case the field exists for, since watchRunnerExit only fires inside
  // the server process that spawned the runner, so a SIGKILL, an OOM kill or a
  // server restart leaves `runner_state: "running"` behind a corpse.
  const sessionDir = makeSession(t, "probe");
  const child = await spawnRunnerLookalike(
    t,
    path.join(SRC_DIR, "pr-review-runner.mjs"),
    sessionDir
  );
  const status = { type: "pr_review", runner_pid: child.pid, runner_token: TOKEN };

  assert.equal(probeSessionRunner(status, sessionDir), "alive");

  // A dead pid whose status.json still claims it is running.
  child.kill("SIGKILL");
  await sleep(500);
  assert.equal(
    probeSessionRunner({ ...status, runner_state: "running" }, sessionDir),
    "dead",
    "a proven death must not be reported as indeterminate"
  );

  // A live process that is not this session's runner is also a proven death,
  // not an unknown.
  const stranger = await spawnRunnerLookalike(
    t,
    path.join(SRC_DIR, "dialog-runner.mjs"),
    sessionDir
  );
  assert.equal(
    probeSessionRunner({ ...status, runner_pid: stranger.pid }, sessionDir),
    "dead"
  );
});

test("a runner belonging to a different session type is not recognized", async (t) => {
  // The other half of the contract. Mapping every type onto one script would
  // satisfy the cases above while destroying the identity check that stops a
  // recycled PID from being mistaken for this session's runner.
  const sessionDir = makeSession(t, "crosstalk");
  const child = await spawnRunnerLookalike(
    t,
    path.join(SRC_DIR, "dialog-runner.mjs"),
    sessionDir
  );

  assert.equal(
    isSessionRunnerAlive(
      { type: "pr_review", runner_pid: child.pid, runner_token: TOKEN },
      sessionDir
    ),
    false,
    "a dialog runner satisfied a pr_review session's liveness check"
  );
});

test("a session recorded before types existed still resolves to the dialog runner", async (t) => {
  const sessionDir = makeSession(t, "untyped");
  const child = await spawnRunnerLookalike(
    t,
    path.join(SRC_DIR, "dialog-runner.mjs"),
    sessionDir
  );

  assert.equal(
    isSessionRunnerAlive(
      { runner_pid: child.pid, runner_token: TOKEN },
      sessionDir
    ),
    true,
    "the default must keep covering sessions written before status.type existed"
  );
});

test("every session type the server can write has a runner mapping", () => {
  // Reads the real tool definitions rather than a list maintained here, so a
  // fourth session type cannot be added without either appearing in RUNNERS or
  // failing this case.
  const server = fs.readFileSync(path.join(SRC_DIR, "dialog-server.mjs"), "utf-8");
  // Anchored to the status-object literal, not to any `type:` key. A bare scan
  // also matches the `type: "text"` of every MCP content block in the file.
  const written = new Set(
    [...server.matchAll(/const status = \{[\s\S]{0,600}?\n\s*type:\s*"([a-z_]+)"/gu)].map(
      (m) => m[1]
    )
  );
  // Both guards matter. The count check catches a rotted regex that silently
  // matches nothing; the window is generous because a status literal that puts
  // `type:` further down would otherwise be skipped and this case would still
  // pass on the count alone — a scan that misses the very type it exists to
  // catch, while looking healthy.
  assert.ok(written.size > 0, "the status-object scan matched nothing — the regex has rotted");
  assert.ok(
    written.size >= 2,
    `the scan found only ${[...written]} — the server writes more session types than that`
  );
  // start_dialog writes no `type` at all; dialog is the documented default.
  written.add("dialog");

  // Asserted against the REAL table, not this file's copy of it. Checking the
  // local RUNNERS list instead is what let an earlier version of this case pass
  // while the shipped table was missing the entry entirely -- it proved the test
  // knew about the type, which is not the fact anyone needs.
  for (const type of written) {
    assert.ok(
      Object.hasOwn(RUNNER_SCRIPT_BY_SESSION_TYPE, type),
      `session type "${type}" is written to status.json but is absent from ` +
        `RUNNER_SCRIPT_BY_SESSION_TYPE — isSessionRunnerAlive will silently fall ` +
        `back to the dialog runner and report its runner dead forever`
    );
  }

  // And the live cases below have to cover every mapping, or a new runner can be
  // added to the table without anything ever spawning one to check it.
  const exercised = new Set(RUNNERS.map((r) => r.type));
  for (const type of Object.keys(RUNNER_SCRIPT_BY_SESSION_TYPE)) {
    assert.ok(exercised.has(type), `runner type "${type}" has no live-process case in this file`);
  }
  for (const { type, script } of RUNNERS) {
    assert.equal(
      RUNNER_SCRIPT_BY_SESSION_TYPE[type],
      script,
      `this file expects "${type}" to run ${script}, which is not what the table says`
    );
  }
});
