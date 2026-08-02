// Per-model enforcement, and the two effort channels that are not argv.
//
// The cases here are the ones where an adapter-wide effort list gives the wrong
// answer. `xhigh` is valid for the claude adapter and invalid for
// claude-sonnet-4-6; `ultra` is valid for codex and invalid for gpt-5.5. Claude
// never says so -- it clamps to `high` in silence -- which is why the check has
// to happen before the spawn or not at all.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listAdapters, resetRegistry } from "../src/adapters/registry.mjs";
import { buildInvocationFromAdapter, resolveContext } from "../src/adapters/argv.mjs";
import { negotiate } from "../src/adapters/negotiate.mjs";
import { isEnumerable, modelIds, resolveModelEntry } from "../src/adapters/schema.mjs";
import { resolveDiscovery } from "../src/adapters/discovery.mjs";
import { managedSession } from "./helpers/session.mjs";

// This file asserts against the machine's REAL codex model cache in one
// case, so the HOME redirect must not quietly move that cache out of reach
// and turn a live assertion into a silent skip.
const { home: ROOT, dir: SESSION_DIR } = managedSession("enforcement", {
  keepAdapterSeeds: [{ env: "CODEX_HOME", dir: ".codex" }],
});

// Seed directories the isolation step reads from, so nothing here can reach the
// developer's real credentials.
const SEED_HOME = path.join(ROOT, "seed");
fs.mkdirSync(SEED_HOME, { recursive: true });
process.env.QWEN_HOME = SEED_HOME;

process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

resetRegistry();
const ADAPTERS = listAdapters({
  env: { XDG_CONFIG_HOME: path.join(ROOT, "xdg"), XDG_CONFIG_DIRS: "" },
});
const adapterFor = (id) => {
  const adapter = ADAPTERS.find((a) => a.id === id);
  assert.ok(adapter, `the ${id} adapter is missing`);
  return adapter;
};

function check(id, options) {
  return negotiate(adapterFor(id), {
    engine: adapterFor(id).engines.default,
    requireBinary: false,
    sessionDir: SESSION_DIR,
    projectPath: "/fixture/project",
    ...options,
  });
}

const codeOf = (entries) => entries.map((e) => e.code);

// --- The inversion --------------------------------------------------------

test("xhigh is rejected for claude-sonnet-4-6 while max is accepted", () => {
  const rejected = check("claude", {
    model: "claude-sonnet-4-6",
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(codeOf(rejected.errors), ["effort_unsupported_by_model"]);
  assert.match(rejected.errors[0].message, /claude-sonnet-4-6/);
  assert.match(rejected.errors[0].message, /low, medium, high, max/);
  // The whole point of the check: Claude does not fail, it downgrades quietly,
  // so the message has to say what would otherwise have happened.
  assert.match(
    rejected.errors[0].message,
    /Claude would silently run this at `high`\./
  );
  assert.match(rejected.errors[0].source, /claude-code\.json/);

  const accepted = check("claude", {
    model: "claude-sonnet-4-6",
    reasoningEffort: "max",
  });
  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.resolution.reasoningEffort, "max");
});

test("an effort rejected for one model is still valid for another", () => {
  // Same adapter, same effort, opposite verdict -- which is the fact an
  // adapter-level effort list cannot express.
  const ok = check("claude", { model: "claude-opus-5", reasoningEffort: "xhigh" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.resolution.reasoningEffort, "xhigh");
});

test("a model that accepts no effort at all says so plainly", () => {
  const result = check("claude", {
    model: "claude-haiku-4-5",
    reasoningEffort: "low",
  });
  assert.deepEqual(codeOf(result.errors), ["effort_unsupported_by_model"]);
  assert.match(
    result.errors[0].message,
    /claude-haiku-4-5" accepts no reasoning effort at all/
  );
  assert.equal(result.resolution.reasoningEffort, null);
});

// --- Codex: ultra ---------------------------------------------------------

test("ultra is rejected for gpt-5.5 and accepted for gpt-5.6-sol", () => {
  const rejected = check("codex", { model: "gpt-5.5", reasoningEffort: "ultra" });
  assert.deepEqual(codeOf(rejected.errors), ["effort_unsupported_by_model"]);
  assert.match(rejected.errors[0].message, /gpt-5\.5.*low, medium, high, xhigh/);
  // Codex does reject bad efforts itself, so there is no silent-clamp warning.
  assert.ok(!rejected.errors[0].message.includes("silently"));

  const accepted = check("codex", {
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  });
  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.resolution.reasoningEffort, "ultra");
});

test("the gpt-5.6 alias resolves to gpt-5.6-sol and inherits ultra", () => {
  const resolved = resolveModelEntry(adapterFor("codex"), "gpt-5.6");
  assert.equal(resolved.known, true);
  assert.equal(resolved.canonicalId, "gpt-5.6-sol");

  const result = check("codex", { model: "gpt-5.6", reasoningEffort: "ultra" });
  assert.deepEqual(result.errors, []);
  assert.equal(result.resolution.modelId, "gpt-5.6-sol");

  // The alias is a name the CLI itself accepts, so argv must carry what was
  // asked for rather than a silently substituted id.
  const { args } = buildInvocationFromAdapter(adapterFor("codex"), {
    projectPath: "/fixture/project",
    sessionDir: SESSION_DIR,
    sessionName: "fixture",
    model: "gpt-5.6",
    reasoningEffort: "ultra",
  });
  assert.ok(args.includes("gpt-5.6"), "argv should pass the alias through");
  assert.ok(!args.includes("gpt-5.6-sol"));

  // An alias is not a catalog entry, so an effort the target rejects is still
  // rejected through the alias.
  const viaLuna = check("codex", { model: "gpt-5.6-luna", reasoningEffort: "ultra" });
  assert.deepEqual(codeOf(viaLuna.errors), ["effort_unsupported_by_model"]);
});

// --- Unknown models -------------------------------------------------------

// A LIVE discovery result, shaped as discovery.mjs returns one. Only a list
// that actually answered -- non-static, non-stale, non-empty -- establishes
// what a CLI can route to, and only that may reject an id.
const CATALOG = {
  models: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }],
  source: "/fixture/.codex/models_cache.json",
  strategy: "local-cache",
  fetchedAt: "2026-07-31T00:00:00Z",
  stale: false,
  notices: [],
};

test("an unknown model is an error only against a live catalog", () => {
  const result = check("codex", {
    model: "gpt-5.9-imaginary",
    discoveredModels: CATALOG,
  });
  assert.deepEqual(codeOf(result.errors), ["unknown_model"]);

  const [error] = result.errors;
  assert.match(error.message, /gpt-5\.6-sol/, "valid ids must be listed");
  assert.match(error.message, /Aliases: gpt-5\.6/);
  assert.match(
    error.message,
    /models_cache\.json/,
    "the source named must be where the ids came from"
  );
  assert.match(error.source, /codex\.json/, "the manifest is still attributed");
});

test("the catalog, not the manifest, decides what is routable", () => {
  // gpt-5.5 is declared in the manifest but absent from this catalog. The
  // catalog came from the CLI itself, so it wins.
  const result = check("codex", { model: "gpt-5.5", discoveredModels: CATALOG });
  assert.deepEqual(codeOf(result.errors), ["unknown_model"]);

  // An alias is never a catalog entry, so it must resolve to its target first.
  const viaAlias = check("codex", { model: "gpt-5.6", discoveredModels: CATALOG });
  assert.deepEqual(viaAlias.errors, []);
  assert.equal(viaAlias.resolution.modelVerifiedAgainst, CATALOG.source);
});

test("allowUnknownModel turns the error into an informational notice", () => {
  const result = check("codex", {
    model: "gpt-5.9-imaginary",
    discoveredModels: CATALOG,
    allowUnknownModel: true,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.filter((w) => w.code.startsWith("unknown_model")),
    [],
    "an explicitly allowed model should not also warn"
  );
  assert.ok(
    result.notices.some((n) => n.code === "unknown_model_allowed"),
    "the override should still be recorded"
  );
  // The model is passed through, not dropped -- overriding the check would be
  // pointless otherwise.
  assert.equal(result.resolution.model, "gpt-5.9-imaginary");
});

test("a hand-maintained model list never rejects, only warns", () => {
  // The case this rule exists for: claude-sonnet-4-5 is a real model Claude
  // Code accepts and is simply absent from our table. Rejecting against a list
  // we maintain by hand would block working models and make the escape hatch
  // mandatory for ordinary work.
  const claude = adapterFor("claude");
  assert.ok(claude.models.length > 0, "claude declares a static list");
  assert.ok(
    !modelIds(claude).includes("claude-sonnet-4-5"),
    "the fixture depends on this id being absent from our table"
  );

  // Declaring a discovery strategy is not running one, so this holds whether or
  // not the manifest has one: without a fetched catalog, nothing may block.
  const result = check("claude", { model: "claude-sonnet-4-5" });
  assert.deepEqual(result.errors, [], "a real model must not be blocked");
  assert.ok(result.warnings.some((w) => w.code === "unknown_model"));
  assert.equal(result.resolution.model, "claude-sonnet-4-5");
});

test("an adapter with no discovery source says so in the warning", () => {
  // Built from cursor rather than asserting on it: which manifests carry a
  // discovery block is another stage's business, and this test is about the
  // message an adapter without one produces.
  const undiscoverable = { ...adapterFor("cursor"), discovery: undefined };
  const result = negotiate(undiscoverable, {
    engine: undiscoverable.engines.default,
    requireBinary: false,
    sessionDir: SESSION_DIR,
    projectPath: "/fixture/project",
    model: "gpt-5-high",
  });

  assert.deepEqual(result.errors, []);
  const warning = result.warnings.find((w) => w.code === "unknown_model");
  assert.ok(warning);
  assert.match(warning.message, /no discovery source/);
});

test("claude's short aliases are not rejected", () => {
  // `default`, `opus`, `sonnet` and `haiku` are all valid --model values that
  // appear nowhere in our static table. They are the concrete cost of treating
  // a hand-maintained list as authoritative.
  for (const alias of ["default", "opus", "sonnet", "haiku"]) {
    const result = check("claude", { model: alias });
    assert.deepEqual(
      codeOf(result.errors),
      [],
      `"${alias}" is a valid model and must not be blocked`
    );
    assert.equal(result.resolution.model, alias, "it must still be passed through");
  }
});

test("a degraded discovery result never rejects, even when it carries ids", async () => {
  // Run against the real resolveDiscovery rather than a hand-made fixture, so
  // this tracks the contract discovery.mjs actually emits. Whichever adapters
  // degrade on this machine are the sample; grok and qwen are the interesting
  // ones when they appear, because their fallback carries ids and is still not
  // grounds to reject anything.
  const degraded = [];
  for (const adapter of ADAPTERS) {
    if (!adapter.capabilities.modelFlag) continue;
    // enrich:false keeps this hermetic. This test is about the rejection gate,
    // not about metadata, and any adapter whose models lack efforts would
    // otherwise pull the 3.3MB models.dev catalog over the network.
    const discovered = await resolveDiscovery(adapter, { refresh: true, enrich: false });
    if (discovered.strategy !== "static") continue;
    degraded.push(adapter.id);

    const result = check(adapter.id, {
      model: "definitely-not-a-real-model",
      discoveredModels: discovered,
    });
    assert.deepEqual(
      codeOf(result.errors),
      [],
      `${adapter.id} rejected a model against a degraded fallback carrying ` +
        `${discovered.models.length} ids`
    );
    const warning = result.warnings.find((w) => w.code === "unknown_model");
    assert.ok(warning, `${adapter.id} should still warn`);
    assert.match(warning.message, /fell back to its declared list/);
  }

  assert.ok(
    degraded.length > 0,
    "every adapter discovered live here, so the degraded path went untested"
  );
});

test("a live catalog does reject an id it does not contain", async (t) => {
  // The other half: enforcement must actually engage when the list is real.
  // Skipped rather than failed where the CLI is absent -- this asserts against
  // whatever cache is genuinely on the machine.
  const codex = adapterFor("codex");
  const discovered = await resolveDiscovery(codex, { refresh: true, enrich: false });
  if (!isEnumerable(discovered)) {
    t.skip(`codex discovery is not live here (strategy: ${discovered.strategy})`);
    return;
  }

  const rejected = check("codex", {
    model: "gpt-5.9-imaginary",
    discoveredModels: discovered,
  });
  assert.deepEqual(codeOf(rejected.errors), ["unknown_model"]);
  assert.match(rejected.errors[0].message, /models_cache\.json/);

  // And an id the live cache does carry passes clean.
  const accepted = check("codex", {
    model: discovered.models[0].id,
    discoveredModels: discovered,
  });
  assert.deepEqual(codeOf(accepted.errors), []);
});

test("an empty discovery answer cannot rule anything out", () => {
  // opencode and goose declare discovery and no static models. A reachable but
  // empty answer must not become "every model is invalid".
  const result = check("opencode", {
    model: "anthropic/claude-sonnet-4-5",
    discoveredModels: {
      models: [],
      source: "opencode models",
      strategy: "cli-command",
      fetchedAt: "2026-07-31T00:00:00Z",
      stale: false,
      notices: [],
    },
  });
  assert.deepEqual(codeOf(result.errors), []);
  assert.match(
    result.warnings.find((w) => w.code === "unknown_model").message,
    /returned no models/
  );
});

test("a stale cache warns rather than rejects", () => {
  // The model may simply be newer than the cache -- which is the common case
  // right after a vendor ships one.
  const result = check("grok", {
    model: "grok-5",
    discoveredModels: {
      models: [{ id: "grok-4.5" }, { id: "grok-build" }],
      source: "/fixture/.grok/models_cache.json",
      strategy: "local-cache",
      fetchedAt: "2026-07-30T00:00:00Z",
      stale: true,
      notices: [{ code: "cache_stale", message: "cache is older than its TTL" }],
    },
  });
  assert.deepEqual(codeOf(result.errors), []);
  assert.match(
    result.warnings.find((w) => w.code === "unknown_model").message,
    /is stale .*may simply be newer than the cache/
  );
});

test("a manifest passed where a discovery result belongs cannot reject", () => {
  // The unsafe direction has to be unreachable by construction: isEnumerable
  // takes a result, and a manifest fails every clause of it.
  assert.equal(isEnumerable(adapterFor("codex")), false);
  const result = check("codex", {
    model: "gpt-5.9-imaginary",
    discoveredModels: adapterFor("codex"),
  });
  assert.deepEqual(codeOf(result.errors), []);
});

test("no adapter rejects an unknown model without a catalog in hand", () => {
  // Several manifests now declare a discovery strategy, but declaring one is
  // not running it. Until a caller passes the result in, nothing may block.
  for (const adapter of ADAPTERS) {
    if (!adapter.capabilities.modelFlag) continue;
    const result = negotiate(adapter, {
      engine: adapter.engines.default,
      requireBinary: false,
      sessionDir: SESSION_DIR,
      projectPath: "/fixture/project",
      model: "some-model-nobody-declared",
    });
    assert.deepEqual(
      codeOf(result.errors),
      [],
      `${adapter.id} rejected a model with no catalog to reject it against`
    );
  }
});

test("a known model produces no model finding at all", () => {
  const result = check("codex", { model: "gpt-5.4-mini" });
  assert.deepEqual(codeOf(result.errors), []);
  assert.deepEqual(
    result.warnings.filter((w) => w.code.startsWith("unknown_model")),
    []
  );
});

// --- Defaults -------------------------------------------------------------

test("a model's own default effort is reported but never restated in argv", () => {
  const result = check("codex", { model: "gpt-5.6-sol" });
  const notice = result.notices.find((n) => n.code === "default_effort_applied");
  assert.ok(notice, "the applied default should be recorded");
  assert.equal(notice.applied, "low");
  assert.equal(result.resolution.effectiveEffort, "low");
  // Nothing was requested, so nothing was dropped: a default is not a warning.
  assert.deepEqual(result.warnings, []);

  // Omitting the flag is exactly what makes the CLI apply that default, so
  // adding it would change the command line without changing the turn.
  const { args } = buildInvocationFromAdapter(adapterFor("codex"), {
    projectPath: "/fixture/project",
    sessionDir: SESSION_DIR,
    sessionName: "fixture",
    model: "gpt-5.6-sol",
  });
  assert.ok(!args.some((a) => a.includes("model_reasoning_effort")));
});

test("a requested effort wins over the model default", () => {
  const result = check("codex", { model: "gpt-5.6-sol", reasoningEffort: "high" });
  assert.ok(!result.notices.some((n) => n.code === "default_effort_applied"));
  assert.equal(result.resolution.effectiveEffort, "high");
});

// --- Effort delivery: env (goose) ----------------------------------------

test("goose's thinking-effort variable appears only when an effort is set", () => {
  const goose = adapterFor("goose");

  const without = buildInvocationFromAdapter(goose, {
    projectPath: "/fixture/project",
    sessionDir: SESSION_DIR,
    initialPrompt: "hi",
  });
  assert.equal(without.env.GOOSE_MODE, "auto", "static entries still resolve");
  assert.ok(
    !("GOOSE_THINKING_EFFORT" in without.env),
    "an unset effort must drop the entry, not render it empty"
  );

  const with_ = buildInvocationFromAdapter(goose, {
    projectPath: "/fixture/project",
    sessionDir: SESSION_DIR,
    initialPrompt: "hi",
    reasoningEffort: "high",
  });
  assert.equal(with_.env.GOOSE_THINKING_EFFORT, "high");
});

test("goose maps xhigh onto max rather than rejecting it", () => {
  // goose's vocabulary is off|low|medium|high|max. A caller should not have to
  // know that, and should not be told its effort was unsupported when a plain
  // translation exists.
  const invocation = buildInvocationFromAdapter(adapterFor("goose"), {
    projectPath: "/fixture/project",
    sessionDir: SESSION_DIR,
    initialPrompt: "hi",
    reasoningEffort: "xhigh",
  });
  assert.equal(invocation.env.GOOSE_THINKING_EFFORT, "max");

  const result = check("goose", { reasoningEffort: "xhigh" });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings.filter((w) => w.code === "dropped_reasoning_effort"),
    []
  );
  assert.ok(result.notices.some((n) => n.code === "effort_alias_applied"));
});

test("an env template referencing an unknown key is still fatal", () => {
  // Dropping an unset value is "not this turn". A key the context never had is
  // a typo, and quietly ignoring it is how an author comes to believe a setting
  // took effect.
  const goose = adapterFor("goose");
  const broken = { ...goose, env: { X: "{{noSuchKey}}" } };
  assert.throws(
    () =>
      buildInvocationFromAdapter(broken, {
        projectPath: "/fixture/project",
        sessionDir: SESSION_DIR,
        initialPrompt: "hi",
      }),
    /not a known context value/
  );
});

// --- Effort delivery: settings file (qwen) -------------------------------

function qwenSettings(sessionDir) {
  return path.join(sessionDir, "qwen-home", "settings.json");
}

function runQwen(sessionDir, reasoningEffort) {
  return buildInvocationFromAdapter(adapterFor("qwen"), {
    projectPath: "/fixture/project",
    sessionDir,
    initialPrompt: "hi",
    reasoningEffort,
  });
}

// Each case needs its own session, and it must be a session the containment
// assertion recognizes: a direct child of the sessions root under this file's
// throwaway HOME, named like a real session id.
function freshSession(name) {
  const dir = path.join(ROOT, ".dualog", "sessions", `dialog-${name}-0000`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("qwen's effort is written into the isolated settings file", () => {
  // qwen has no flag and no env var for effort, so this file is the only
  // channel that exists.
  const dir = freshSession("qwen-write");
  const result = runQwen(dir, "high");

  assert.ok(!result.args.includes("high"), "qwen exposes no effort flag");
  assert.equal(result.effortSettingsPath, qwenSettings(dir));

  const written = JSON.parse(fs.readFileSync(qwenSettings(dir), "utf-8"));
  assert.deepEqual(written, { model: { reasoningEffort: "high" } });
});

test("qwen's settings write merges with a seeded file rather than clobbering it", () => {
  const dir = freshSession("qwen-merge");
  const settingsPath = qwenSettings(dir);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      selectedAuthType: "oauth-personal",
      model: { name: "qwen3-coder-plus", maxSessionTurns: 40 },
      theme: "Default",
    })
  );

  runQwen(dir, "max");

  const merged = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  assert.equal(merged.selectedAuthType, "oauth-personal", "sibling keys survive");
  assert.equal(merged.theme, "Default");
  assert.equal(merged.model.name, "qwen3-coder-plus", "sibling model keys survive");
  assert.equal(merged.model.maxSessionTurns, 40);
  assert.equal(merged.model.reasoningEffort, "max");
});

test("qwen writes no settings file when no effort was requested", () => {
  const dir = freshSession("qwen-none");
  const result = runQwen(dir, null);
  assert.equal(result.effortSettingsPath, null);
  assert.equal(fs.existsSync(qwenSettings(dir)), false);
});

test("a seeded settings file that is not JSON is refused, not overwritten", () => {
  const dir = freshSession("qwen-corrupt");
  const settingsPath = qwenSettings(dir);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, "{ not json");

  assert.throws(() => runQwen(dir, "high"), /is not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath, "utf-8"), "{ not json");
});

// --- Consistency between the two entry points -----------------------------

test("negotiate and the argv builder never disagree about a turn", () => {
  // They share one normalization pass. If that ever forks, a preflight check
  // would bless a turn the builder then silently changes.
  const options = {
    model: "claude-sonnet-4-6",
    reasoningEffort: "xhigh",
    toolProfile: "read",
  };
  const negotiated = check("claude", options);
  const { notices } = resolveContext(adapterFor("claude"), {
    projectPath: "/fixture/project",
    sessionDir: SESSION_DIR,
    ...options,
  });

  // negotiate contributes findings of its own (binary, isolation, MCP), so the
  // claim is containment: every option-level notice reaches it verbatim, with
  // the severity decided where the fact was established.
  const findings = [
    ...negotiated.errors.map((e) => ({ ...e, severity: "error" })),
    ...negotiated.warnings.map((w) => ({ ...w, severity: "warning" })),
  ];
  for (const notice of notices) {
    const match = findings.find((f) => f.message === notice.message);
    if (notice.severity === "info") {
      assert.equal(match, undefined, `info notice ${notice.code} should not be a finding`);
      continue;
    }
    assert.ok(match, `notice ${notice.code} never reached negotiate`);
    assert.equal(match.severity, notice.severity);
    assert.equal(match.code, notice.code);
  }
  assert.ok(
    notices.some((n) => n.code === "effort_unsupported_by_model"),
    "the fixture should produce at least one option-level notice"
  );
});

test("every finding names its manifest, whatever its severity", () => {
  const result = check("claude", {
    // An error (this model rejects xhigh), a warning (no such profile), and an
    // adapter-level warning, all in one turn.
    model: "claude-sonnet-4-6",
    reasoningEffort: "xhigh",
    toolProfile: "nonsense",
  });
  assert.ok(result.errors.length > 0);
  assert.ok(result.warnings.length > 0);
  for (const finding of [...result.errors, ...result.warnings]) {
    assert.ok(finding.source, `${finding.code} has no source`);
    assert.ok(finding.message, `${finding.code} has no message`);
    assert.ok(finding.code, "a finding with no code cannot be handled");
  }
});
