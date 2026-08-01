// Golden argv snapshots.
//
// This file is the regression proof for the adapter-registry refactor. It
// captures the exact command, argv, and env that the current per-agent
// buildInvocation produces across the full input matrix. When argv construction
// moves into data-driven adapter manifests, these snapshots must not move.
//
// Regenerate deliberately with:  node --test --test-update-snapshots tests/argv-snapshots.test.mjs
// A diff here means partner CLI invocation changed. That is either the point of
// your change, or a bug -- never noise.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { clearRecursionSentinel } from "./helpers/sentinel.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// The snapshots record env including the recursion sentinel, which is derived
// by incrementing whatever DUALOG_DEPTH this process inherited. Running the
// suite from inside a dualog partner would otherwise rewrite every snapshot to
// depth 2 -- a diff about the runner, not about argv construction.
clearRecursionSentinel();

// Point CODEX_HOME at a throwaway dir before importing: buildInvocation copies
// auth.json out of it, and we must not touch the developer's real credentials.
const FIXTURE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "argv-snapshot-home-"));
fs.mkdirSync(path.join(FIXTURE_HOME, ".codex"), { recursive: true });
fs.writeFileSync(
  path.join(FIXTURE_HOME, ".codex", "auth.json"),
  JSON.stringify({ fixture: true })
);
process.env.CODEX_HOME = path.join(FIXTURE_HOME, ".codex");

const { buildInvocation } = await import("../src/partner-invocation.mjs");

const PROJECT_PATH = "/fixture/project";
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "argv-snapshot-session-"));
const SESSION_NAME = "ccd-dialog-1700000000000-abcd1234-turn";
const BOOTSTRAP = "Read the prompt file at:\n/fixture/session/turns/t1/prompt.md";

process.on("exit", () => {
  fs.rmSync(FIXTURE_HOME, { recursive: true, force: true });
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
});

// Absolute temp paths differ every run. Replace them with stable tokens so the
// snapshot captures argv *shape and ordering*, which is what we care about.
function stabilize(value) {
  return JSON.parse(
    JSON.stringify(value)
      .split(SESSION_DIR)
      .join("<SESSION_DIR>")
      .split(FIXTURE_HOME)
      .join("<HOME>")
  );
}

function invoke(overrides) {
  const result = buildInvocation({
    partnerCommand: overrides.partnerAgent === "claude" ? "claude" : "codex",
    projectPath: PROJECT_PATH,
    sessionDir: SESSION_DIR,
    sessionName: SESSION_NAME,
    model: null,
    reasoningEffort: null,
    toolProfile: "read",
    initialPrompt: null,
    ...overrides,
  });
  return stabilize({
    command: result.command,
    args: result.args,
    env: result.env ?? null,
    usesInitialPrompt: result.usesInitialPrompt ?? false,
  });
}

// The matrix below is deliberately exhaustive over the axes that actually
// change argv. Each case is snapshotted independently so a regression names the
// exact combination that broke.
const CASES = [
  // --- Claude partner ---------------------------------------------------
  ["claude / read profile / no model / no effort", { partnerAgent: "claude" }],
  [
    "claude / implementation profile",
    { partnerAgent: "claude", toolProfile: "implementation" },
  ],
  [
    "claude / model only",
    { partnerAgent: "claude", model: "claude-opus-4-8[1m]" },
  ],
  [
    "claude / valid effort",
    { partnerAgent: "claude", reasoningEffort: "xhigh" },
  ],
  [
    "claude / effort valid for codex but not claude is dropped",
    { partnerAgent: "claude", reasoningEffort: "ultra" },
  ],
  [
    "claude / model and effort together",
    {
      partnerAgent: "claude",
      model: "claude-fable-5",
      reasoningEffort: "high",
      toolProfile: "implementation",
    },
  ],
  [
    "claude / unknown tool profile falls back to read",
    { partnerAgent: "claude", toolProfile: "nonsense" },
  ],

  // --- Codex partner ----------------------------------------------------
  ["codex / read profile / no model / no effort", { partnerAgent: "codex" }],
  [
    "codex / implementation profile does not change argv",
    { partnerAgent: "codex", toolProfile: "implementation" },
  ],
  ["codex / model only", { partnerAgent: "codex", model: "gpt-5.6-sol" }],
  ["codex / valid effort", { partnerAgent: "codex", reasoningEffort: "ultra" }],
  [
    "codex / effort not in the codex set is dropped",
    { partnerAgent: "codex", reasoningEffort: "bogus" },
  ],
  [
    "codex / initial prompt is appended as a positional",
    { partnerAgent: "codex", initialPrompt: BOOTSTRAP },
  ],
  [
    "codex / model, effort, and initial prompt together",
    {
      partnerAgent: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      initialPrompt: BOOTSTRAP,
    },
  ],

  // --- Agent normalization ----------------------------------------------
  [
    "unknown agent normalizes to codex",
    { partnerAgent: "definitely-not-a-real-agent" },
  ],
];

for (const [name, overrides] of CASES) {
  test(`argv: ${name}`, (t) => {
    t.assert.snapshot(invoke(overrides));
  });
}

// Properties that must hold for every adapter, present and future. These are
// the invariants the snapshots alone would not catch.
test("no invocation leaks a raw prompt into argv unless it is the positional", () => {
  for (const [name, overrides] of CASES) {
    const { args } = invoke(overrides);
    const positional = overrides.initialPrompt;
    for (const arg of args) {
      if (positional && arg === positional) continue;
      assert.ok(
        !String(arg).includes("Read the prompt file at:"),
        `${name}: bootstrap text appeared in a non-positional argv entry`
      );
    }
  }
});

test("every partner invocation carries the recursion sentinel", () => {
  for (const [name, overrides] of CASES) {
    const { env } = invoke(overrides);
    assert.equal(env?.DUALOG_ROLE, "partner", `${name}: missing DUALOG_ROLE`);
    assert.equal(env?.DUALOG_DEPTH, "1", `${name}: missing DUALOG_DEPTH`);
  }
});

test("argv entries are all strings -- no undefined or null slipping through", () => {
  for (const [name, overrides] of CASES) {
    const { command, args } = invoke(overrides);
    assert.equal(typeof command, "string", `${name}: command is not a string`);
    for (const [i, arg] of args.entries()) {
      assert.equal(typeof arg, "string", `${name}: args[${i}] is ${typeof arg}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Equivalence gate.
//
// This is the safety argument for the whole adapter refactor: the data-driven
// builder must reproduce the hand-written per-agent builder exactly, for every
// case above. If this passes, swapping the call site is behavior-preserving.
// ---------------------------------------------------------------------------

const { buildInvocationFromAdapter } = await import("../src/adapters/argv.mjs");
const { getAdapter, resetRegistry } = await import("../src/adapters/registry.mjs");

// Isolate from any user- or project-level adapter overrides on this machine:
// the equivalence claim is about the built-in manifests only.
resetRegistry();
const registryOptions = {
  cwd: REPO_ROOT,
  env: { XDG_CONFIG_HOME: path.join(FIXTURE_HOME, "xdg"), XDG_CONFIG_DIRS: "" },
};

function invokeViaAdapter(overrides) {
  const requested = overrides.partnerAgent ?? "codex";
  // Mirrors normalizeAgent's fallback: an unrecognized agent becomes codex.
  const id = ["claude", "codex"].includes(requested) ? requested : "codex";
  const adapter = getAdapter(id, registryOptions);

  const result = buildInvocationFromAdapter(adapter, {
    partnerCommand: requested === "claude" ? "claude" : "codex",
    projectPath: PROJECT_PATH,
    sessionDir: SESSION_DIR,
    sessionName: SESSION_NAME,
    model: overrides.model ?? null,
    reasoningEffort: overrides.reasoningEffort ?? null,
    toolProfile: overrides.toolProfile ?? "read",
    initialPrompt: overrides.initialPrompt ?? null,
  });

  return stabilize({
    command: result.command,
    args: result.args,
    env: result.env ?? null,
    usesInitialPrompt: result.usesInitialPrompt ?? false,
  });
}

for (const [name, overrides] of CASES) {
  test(`adapter matches hand-written builder: ${name}`, () => {
    assert.deepEqual(
      invokeViaAdapter(overrides),
      invoke(overrides),
      `data-driven argv diverged from the hand-written builder for: ${name}`
    );
  });
}

test("every built-in adapter validates and records its source file", async () => {
  const { listAdapters } = await import("../src/adapters/registry.mjs");
  const adapters = listAdapters(registryOptions);

  assert.ok(adapters.length >= 2, "expected at least the claude and codex adapters");
  for (const adapter of adapters) {
    assert.ok(adapter.__sources?.length, `${adapter.id} recorded no source file`);
    for (const source of adapter.__sources) {
      assert.ok(
        fs.existsSync(source),
        `${adapter.id} names a source that does not exist: ${source}`
      );
    }
  }

  // Adding an adapter is expected; losing one silently is not.
  for (const required of ["claude", "codex"]) {
    assert.ok(
      adapters.some((a) => a.id === required),
      `built-in adapter "${required}" disappeared`
    );
  }
});

test("an unknown agent id fails with the available ids listed", async () => {
  const { getAdapter } = await import("../src/adapters/registry.mjs");
  assert.throws(
    () => getAdapter("nope", registryOptions),
    /Unknown agent "nope"\. Available: .*claude.*codex/
  );
});

test("requesting an engine the adapter disallows fails at build time", async () => {
  const adapter = getAdapter("codex", registryOptions);
  assert.throws(
    () =>
      buildInvocationFromAdapter(adapter, {
        engine: "headless",
        projectPath: PROJECT_PATH,
        sessionDir: SESSION_DIR,
        sessionName: SESSION_NAME,
      }),
    // Must name the manifest file: a wrong engine in a user-supplied adapter is
    // otherwise very hard to trace back to its source.
    /does not allow engine "headless".*codex\.json/s
  );
});
