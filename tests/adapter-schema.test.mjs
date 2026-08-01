// Manifest validation.
//
// These are the checks that make a manifest reviewable for a CLI nobody here
// can run. Each one encodes a way an adapter can be internally incoherent in a
// manner that would otherwise surface as a confusing runtime hang rather than a
// load-time error.

import test from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "../src/adapters/schema.mjs";

/** A minimal manifest that validates; each test perturbs one thing. */
function baseManifest(overrides = {}) {
  return {
    id: "fake",
    displayName: "Fake",
    binary: { default: "fake" },
    engines: { default: "headless", allowed: ["headless"] },
    capabilities: {
      modelFlag: true,
      reasoningEffort: false,
      toolProfiles: "none",
      addDir: false,
      writesFiles: true,
      tuiDrivable: "no",
    },
    mcp: { strategy: "none" },
    promptDelivery: { headless: "argv" },
    argv: { headless: [{ args: ["run", "{{initialPrompt}}"] }] },
    completion: { sidecar: "always", stdoutTrustworthy: false },
    ...overrides,
  };
}

test("the base fixture validates", () => {
  const parsed = parseManifest(baseManifest(), "/fixtures/fake.json");
  assert.equal(parsed.id, "fake");
  assert.deepEqual(parsed.__sources, ["/fixtures/fake.json"]);
});

test("validation errors name the source file", () => {
  assert.throws(
    () => parseManifest(baseManifest({ id: "Not Valid" }), "/fixtures/bad.json"),
    /Invalid adapter manifest at \/fixtures\/bad\.json/
  );
});

test("unknown top-level keys are rejected rather than silently ignored", () => {
  // A typo'd field that is quietly dropped is the worst failure mode for a
  // config format: the author believes it took effect.
  assert.throws(
    () => parseManifest(baseManifest({ reasoningEfforts_: ["high"] }), "/f.json"),
    /Invalid adapter manifest/
  );
});

test("default engine must be in the allowed list", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          engines: { default: "tmux-interactive", allowed: ["headless"] },
        }),
        "/f.json"
      ),
    /engines\.default "tmux-interactive" is not in engines\.allowed/
  );
});

test("an allowed engine with no argv is rejected", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          engines: { default: "headless", allowed: ["headless", "tmux-interactive"] },
          promptDelivery: { headless: "argv", "tmux-interactive": "tui-paste" },
          tui: { readyAny: ["> "] },
          capabilities: { ...baseManifest().capabilities, tuiDrivable: "yes" },
        }),
        "/f.json"
      ),
    /argv\.tmux-interactive is empty/
  );
});

test("a tmux-drivable adapter with no ready markers is rejected", () => {
  // Without a ready marker the driver can never decide when to send the prompt,
  // so this would hang until the readiness timeout on every single turn.
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          engines: { default: "tmux-interactive", allowed: ["tmux-interactive"] },
          promptDelivery: { "tmux-interactive": "tui-paste" },
          argv: { "tmux-interactive": [{ args: ["go"] }] },
          capabilities: { ...baseManifest().capabilities, tuiDrivable: "yes" },
        }),
        "/f.json"
      ),
    /declares no ready markers/
  );
});

test("tuiDrivable:no contradicts allowing the tmux engine", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          engines: { default: "tmux-interactive", allowed: ["tmux-interactive"] },
          promptDelivery: { "tmux-interactive": "tui-paste" },
          argv: { "tmux-interactive": [{ args: ["go"] }] },
          tui: { readyAny: ["> "] },
        }),
        "/f.json"
      ),
    /tuiDrivable is "no" but engines\.allowed includes tmux-interactive/
  );
});

test("a partner that cannot write files cannot rely on sidecar completion", () => {
  // This is the silent-failure class: several CLIs deny write tools by default
  // in headless mode, so the model reports success and no sidecar appears.
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          capabilities: { ...baseManifest().capabilities, writesFiles: false },
        }),
        "/f.json"
      ),
    /can never signal completion/
  );
});

test("a partner that cannot write files needs trustworthy stdout", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          capabilities: { ...baseManifest().capabilities, writesFiles: false },
          completion: { sidecar: "never", stdoutTrustworthy: false },
        }),
        "/f.json"
      ),
    /no completion signal at all/
  );
});

test("reasoning-effort capability and value-set must agree, both directions", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          capabilities: { ...baseManifest().capabilities, reasoningEffort: true },
        }),
        "/f.json"
      ),
    /reasoningEffort is true but reasoningEfforts is empty/
  );

  assert.throws(
    () => parseManifest(baseManifest({ reasoningEfforts: ["high"] }), "/f.json"),
    /reasoningEfforts is non-empty but capabilities\.reasoningEffort is false/
  );
});

test("models accept both the bare-string and the per-model object form", () => {
  // Backward compatibility is the point: every manifest written before efforts
  // were per-model is a plain array of ids, and must keep validating unchanged.
  const parsed = parseManifest(
    baseManifest({
      capabilities: { ...baseManifest().capabilities, reasoningEffort: true },
      reasoningEfforts: ["low", "high", "max"],
      models: [
        "plain-id",
        { id: "detailed", efforts: ["low", "high"], defaultEffort: "high", context: 272000 },
        { id: "no-effort-at-all", efforts: [] },
      ],
    }),
    "/f.json"
  );
  assert.equal(parsed.models[0], "plain-id");
  assert.deepEqual(parsed.models[2], { id: "no-effort-at-all", efforts: [] });
});

test("a model's defaultEffort must be one that model itself accepts", () => {
  // The inversion case in miniature: `max` being valid somewhere on the adapter
  // says nothing about whether this model takes it.
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          capabilities: { ...baseManifest().capabilities, reasoningEffort: true },
          reasoningEfforts: ["low", "high", "xhigh"],
          models: [{ id: "m", efforts: ["low", "high"], defaultEffort: "xhigh" }],
        }),
        "/f.json"
      ),
    /defaultEffort "xhigh", which is not in its own efforts \[low, high\]/
  );
});

test("an alias must resolve to a model that is actually declared", () => {
  assert.throws(
    () => parseManifest(baseManifest({ modelAliases: { "gpt-5.6": "gpt-5.6-sol" } }), "/f.json"),
    /modelAliases\["gpt-5\.6"\] points at "gpt-5\.6-sol", which is not a declared model/
  );
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ models: [{ id: "m", aliasOf: "ghost" }] }),
        "/f.json"
      ),
    /alias of "ghost", which is not a declared model/
  );
});

test("an effort alias must resolve to an effort the CLI actually parses", () => {
  // An alias is a translation, so pointing it at a value the CLI does not take
  // turns a name that would have failed here into one that fails at the vendor.
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          capabilities: { ...baseManifest().capabilities, reasoningEffort: true },
          reasoningEfforts: ["low", "high"],
          effortAliases: { xhigh: "max" },
        }),
        "/f.json"
      ),
    /effortAliases\["xhigh"\] maps to "max", which is not in reasoningEfforts \[low, high\]/
  );
});

test("an effort alias may not shadow an effort the adapter already accepts", () => {
  // Otherwise a value the CLI does take is silently redirected to another one.
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          capabilities: { ...baseManifest().capabilities, reasoningEffort: true },
          reasoningEfforts: ["low", "high", "max"],
          effortAliases: { high: "max" },
        }),
        "/f.json"
      ),
    /effortAliases\["high"\] shadows "high"/
  );
});

test("settings-file effort delivery requires an isolated config dir", () => {
  // There is nowhere else to write it: without isolation the only target is the
  // user's own settings file, which one turn would then edit permanently.
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          capabilities: { ...baseManifest().capabilities, reasoningEffort: true },
          reasoningEfforts: ["high"],
          effortDelivery: "settings-file",
        }),
        "/f.json"
      ),
    /no session-owned config directory to write the setting into/
  );
});

test("a flags-based tool profile must define its default profile", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          capabilities: { ...baseManifest().capabilities, toolProfiles: "flags" },
          defaultToolProfile: "read",
          toolProfiles: { implementation: { allowedTools: "Write" } },
        }),
        "/f.json"
      ),
    /defaultToolProfile "read" has no entry in toolProfiles/
  );
});

test("the shipped built-in manifests satisfy every invariant", async () => {
  const { listAdapters, resetRegistry } = await import("../src/adapters/registry.mjs");
  resetRegistry();
  // Loading is itself the assertion: parseManifest throws on any violation.
  const adapters = listAdapters({ env: { XDG_CONFIG_HOME: "/nonexistent", XDG_CONFIG_DIRS: "" } });
  assert.ok(adapters.length >= 2);
  resetRegistry();
});
