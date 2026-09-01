// The start-to-runner handoff for allow_unknown_model.
//
// The flag is decided once, at the start call, against a live catalog. The turn
// then validates the same model again in a DIFFERENT PROCESS -- the runner --
// which has no memory of that decision unless it is carried across. Exposing the
// parameter without threading it produced the worst version of this: the start
// call accepts an absent id, creates a session, and the very first turn rejects
// it as unknown_model.
//
// These tests pin the contract at each hop rather than only the endpoints,
// because a break anywhere in the chain reproduces that bug.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAdapter, resetRegistry } from "../src/adapters/registry.mjs";
import { negotiate } from "../src/adapters/negotiate.mjs";
import { buildInvocationFromAdapter } from "../src/adapters/argv.mjs";
import { managedSession } from "./helpers/session.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, "src/dialog-server.mjs"), "utf-8");
const DIALOG_RUNNER_SRC = fs.readFileSync(path.join(REPO_ROOT, "src/dialog-runner.mjs"), "utf-8");
const REVIEW_RUNNER_SRC = fs.readFileSync(path.join(REPO_ROOT, "src/review-runner.mjs"), "utf-8");
const PR_REVIEW_RUNNER_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "src/pr-review-runner.mjs"),
  "utf-8"
);
const INVOCATION_SRC = fs.readFileSync(path.join(REPO_ROOT, "src/partner-invocation.mjs"), "utf-8");
const HEADLESS_SRC = fs.readFileSync(path.join(REPO_ROOT, "src/engines/headless.mjs"), "utf-8");

resetRegistry();
const adapter = (id) =>
  getAdapter(id, { cwd: REPO_ROOT, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_CONFIG_DIRS: "" } });

// NEVER pass the repo as sessionDir. buildInvocationFromAdapter() prepares the
// adapter's config isolation directory, and for codex that means creating
// `<sessionDir>/codex-home` and SEEDING IT WITH THE REAL ~/.codex/auth.json.
// An earlier version of this file used REPO_ROOT and quietly deposited live
// credentials in the working tree on every run -- one `git add -A` away from
// being committed.
const { home: SESSION_HOME, dir: SESSION_DIR, scratchDir: SCRATCH_DIR } = managedSession("handoff");
process.on("exit", () => fs.rmSync(SESSION_HOME, { recursive: true, force: true }));

/** A live, enumerable catalog that does NOT contain the requested id. */
const CATALOG_WITHOUT = {
  strategy: "local-cache",
  stale: false,
  source: "a live catalog",
  models: [{ id: "gpt-5.6-sol", efforts: ["low", "medium", "high"] }],
};

test("without the flag, an absent id is rejected against a live catalog", () => {
  const result = negotiate(adapter("codex"), {
    engine: "tmux-interactive",
    toolProfile: "read",
    model: "some-unlisted-model",
    requireBinary: false,
    discoveredModels: CATALOG_WITHOUT,
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "unknown_model");
});

test("with the flag, the same call is allowed through", () => {
  const result = negotiate(adapter("codex"), {
    engine: "tmux-interactive",
    toolProfile: "read",
    model: "some-unlisted-model",
    requireBinary: false,
    discoveredModels: CATALOG_WITHOUT,
    allowUnknownModel: true,
  });
  assert.deepEqual(result.errors, []);
});

test("the argv builder honors the flag too -- the turn is where it must survive", () => {
  // This is the hop that actually failed: preflight said yes, the turn said no.
  const build = (allowUnknownModel) =>
    buildInvocationFromAdapter(adapter("codex"), {
      partnerCommand: "codex",
      projectPath: REPO_ROOT,
      sessionDir: SESSION_DIR,
    scratchDir: SCRATCH_DIR,
      sessionName: "x",
      model: "some-unlisted-model",
      discoveredModels: CATALOG_WITHOUT,
      allowUnknownModel,
    });

  const refused = build(false).notices.filter((n) => n.severity === "error");
  assert.equal(refused.length, 1, "a turn without the flag still refuses");
  assert.equal(refused[0].code, "unknown_model");

  const allowed = build(true).notices.filter((n) => n.severity === "error");
  assert.deepEqual(allowed, [], "a turn with the flag proceeds, matching preflight");
});

test("every hop between the start call and the turn carries the flag", () => {
  // A source-level contract check. The runner is a separate process, so this
  // chain cannot be exercised in-process without spawning a partner CLI -- but
  // a break at any link reproduces the accept-then-reject bug, and each link is
  // cheap to assert.
  assert.match(SERVER_SRC, /allow_unknown_model: z/, "both start tools expose the parameter");
  assert.match(
    SERVER_SRC,
    /allow_unknown_model: allow_unknown_model === true/,
    "the decision is persisted into status.json"
  );
  assert.match(
    SERVER_SRC,
    /"--allow-unknown-model"/,
    "and passed to the spawned runner"
  );

  for (const [name, src] of [
    ["dialog-runner", DIALOG_RUNNER_SRC],
    ["review-runner", REVIEW_RUNNER_SRC],
    ["pr-review-runner", PR_REVIEW_RUNNER_SRC],
  ]) {
    assert.match(src, /--allow-unknown-model/, `${name} reads the flag`);
    assert.match(src, /allowUnknownModel: ALLOW_UNKNOWN_MODEL/, `${name} forwards it to the turn`);
  }

  assert.match(INVOCATION_SRC, /allowUnknownModel = false,/, "runPartnerCommand accepts it");
  assert.match(INVOCATION_SRC, /allowUnknownModel,\n\s*\}\);/, "and passes it to the argv builder");
  assert.match(HEADLESS_SRC, /allowUnknownModel = false,/, "the headless engine accepts it");
  assert.match(HEADLESS_SRC, /allowUnknownModel,/, "and passes it on");
});
