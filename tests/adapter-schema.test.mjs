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

// --- settings vs relocations -------------------------------------------------
//
// One field used to hold both, which forced the runtime to guess which kind
// each entry was from the rendered value -- a guess that cannot work, because
// goose's legitimate `auto` and an attacker's `pwned-config` are the same shape.
// The manifest now says which it means. These pin the rules that make the
// declaration trustworthy, at load time, where the author can act on them.

const isolationBase = {
  env: "FAKE_HOME",
  dir: "{{sessionDir}}/fake-home",
};

test("a settings map may not carry a location-named variable", () => {
  for (const key of ["XDG_DATA_HOME", "FAKE_OTHER_HOME", "FAKE_DIR", "FAKE_PATH", "FAKE_ROOT", "HOME"]) {
    assert.throws(
      () => parseManifest(baseManifest({ env: { [key]: "1" } }), "/f.json"),
      new RegExp(`env\\.${key} names a filesystem location`),
      `${key} must be refused in env`
    );
    assert.throws(
      () =>
        parseManifest(
          baseManifest({ configIsolation: { ...isolationBase, extraEnv: { [key]: "1" } } }),
          "/f.json"
        ),
      /names a filesystem location/,
      `${key} must be refused in configIsolation.extraEnv`
    );
  }
});

test("known location variables are refused even when their suffix reads as a toggle", () => {
  // FOUND IN REVIEW. `_CONFIG` was excluded outright so that
  // OPENCODE_DISABLE_PROJECT_CONFIG (a boolean) would validate -- which let
  // KUBECONFIG and DOCKER_CONFIG through, both of which name directories a
  // partner resolves relative to its own working directory when given a bare
  // value. The ambiguous suffixes now default to "location" and the real
  // toggles are named explicitly.
  for (const key of ["KUBECONFIG", "DOCKER_CONFIG", "GIT_DIR", "GNUPGHOME", "CARGO_HOME", "AWS_CONFIG_FILE"]) {
    assert.throws(
      () => parseManifest(baseManifest({ env: { [key]: "pwned-config" } }), "/f.json"),
      /names a filesystem location/,
      `${key} must be refused in a settings map`
    );
  }

  // The suffix rule has to stand on its own, not lean on the explicit list: an
  // adapter for a CLI nobody here has run will use names nobody has listed.
  for (const key of ["MYCLI_DATA", "MYCLI_CACHE", "MYCLI_CONFIG", "MYCLI_FILE"]) {
    assert.throws(
      () => parseManifest(baseManifest({ env: { [key]: "pwned-config" } }), "/f.json"),
      /names a filesystem location/,
      `${key} must be caught by the suffix rule, with no list entry to rely on`
    );
  }

  // The counterweight: the real toggle that forced the original exclusion must
  // still validate, or the rule is unshippable.
  assert.doesNotThrow(() =>
    parseManifest(baseManifest({ env: { OPENCODE_DISABLE_PROJECT_CONFIG: "1" } }), "/f.json")
  );
});

test("a settings map may not carry a location-shaped value", () => {
  for (const value of [
    // `{{scratchDir}}` was MISSING from this check for one release, and it was
    // the worst possible omission: it is the variable every relocation is built
    // from, so a settings entry under an unrecognised name could carry
    // "{{scratchDir}}/../../../outside" past validation and reach the partner
    // uncontained. Introduced by adding scratchDir to the invocation context
    // without revisiting the location list.
    "{{scratchDir}}/data",
    "{{scratchDir}}/../../../outside",
    "{{sessionDir}}/data",
    "{{home}}/x",
    "{{projectPath}}/x",
    "/etc",
    "~/x",
    "./rel",
    "../up",
  ]) {
    assert.throws(
      () => parseManifest(baseManifest({ env: { FAKE_SETTING: value } }), "/f.json"),
      /describes a filesystem location/,
      `${value} must be refused`
    );
  }
});

test("path shapes and variable names are not assumed to be POSIX or upper-case", () => {
  // A manifest is DATA and can come from anywhere, so the heuristic cannot
  // assume the platform it was written for. Two concrete gaps: the value check
  // recognised only POSIX shapes, and the name check was case-sensitive -- but
  // environment variable names are case-INSENSITIVE on Windows, so `Path` is
  // `PATH` there and slipped through under a different spelling.
  for (const value of ["C:\\outside", "c:/outside", "..\\outside", ".\\rel", "\\\\server\\share", "\\rooted"]) {
    assert.throws(
      () => parseManifest(baseManifest({ env: { FAKE_SETTING: value } }), "/f.json"),
      /describes a filesystem location/,
      `${value} must be refused`
    );
  }

  for (const key of ["Path", "path", "Home", "Xdg_Data_Home", "kubeconfig"]) {
    assert.throws(
      () => parseManifest(baseManifest({ env: { [key]: "1" } }), "/f.json"),
      /names a filesystem location/,
      `${key} must be refused whatever its case`
    );
  }

  // And the counterweight, so widening the rule did not swallow real settings.
  assert.doesNotThrow(() =>
    parseManifest(
      baseManifest({ env: { GOOSE_MODE: "auto", FAKE_URL: "https://example.com/v1" } }),
      "/f.json"
    )
  );
});

test("the settings every built-in actually declares still validate", () => {
  // The counterweight. A rule that rejected these would have made the split
  // unshippable, and each of these is a real entry from a real manifest.
  const real = {
    GOOSE_MODE: "auto",
    GOOSE_THINKING_EFFORT: "{{reasoningEffort}}",
    GOOSE_DISABLE_KEYRING: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_FOLDER_TRUST: "0",
    GROK_DISABLE_AUTOUPDATER: "1",
  };
  const parsed = parseManifest(baseManifest({ env: real }), "/f.json");
  assert.deepEqual(parsed.env, real);

  // A URL contains slashes and is not a location.
  assert.doesNotThrow(() =>
    parseManifest(baseManifest({ env: { FAKE_BASE_URL: "https://example.com/v1" } }), "/f.json")
  );
});

test("every location in the invocation context is classified", async () => {
  // THIS CLASS OF BUG HAS HAPPENED TWICE. `scratchDir` was added to the context
  // by the lease work and `mcpConfigPath` by MCP suppression, and neither was
  // added to the location list -- so a settings entry built from either rendered
  // to a real path outside the lease and was handed to the partner uncontained.
  //
  // Restating the list by hand is what failed. This walks the LIVE context and
  // requires every key to be classified one way or the other, so the next key
  // added fails here until someone decides which it is.
  const { resolveContext } = await import("../src/adapters/argv.mjs");
  const { LOCATION_CONTEXT_KEYS } = await import("../src/adapters/schema.mjs");

  // Values that are not filesystem locations. Anything not here must be.
  const NOT_LOCATIONS = new Set([
    "sessionName",
    "model",
    "reasoningEffort",
    "reasoningEffortJson",
    "initialPrompt",
    "toolProfile",
    "toolProfileAllowedTools",
    "toolProfileDisallowedTools",
  ]);

  const { ctx } = resolveContext(parseManifest(baseManifest(), "/f.json"), {
    projectPath: "/fixture/project",
    sessionDir: "/fixture/session",
    scratchDir: "/fixture/lease",
  });

  const classified = new Set([...LOCATION_CONTEXT_KEYS, ...NOT_LOCATIONS]);
  const unclassified = Object.keys(ctx).filter((key) => !classified.has(key));
  assert.deepEqual(
    unclassified,
    [],
    `unclassified invocation context keys: ${unclassified.join(", ")}. ` +
      "Add each to LOCATION_CONTEXT_KEYS in schema.mjs if it names a file or " +
      "directory, or to NOT_LOCATIONS here if it does not."
  );

  // And `isolatedDir`, which prepareConfigIsolation adds later, is covered too.
  assert.ok(LOCATION_CONTEXT_KEYS.includes("isolatedDir"));
});

test("a variable cannot be both a relocation and a setting", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          configIsolation: {
            ...isolationBase,
            dirs: { FAKE_DATA_DIR: "{{sessionDir}}/data" },
            extraEnv: { FAKE_DATA_DIR: "1" },
          },
        }),
        "/f.json"
      ),
    /is also declared in configIsolation\.extraEnv/
  );
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ env: { FAKE_SETTING: "1" }, dirs: { FAKE_SETTING: "{{sessionDir}}/d" } }),
        "/f.json"
      ),
    /is also declared in/
  );

  // FOUND IN REVIEW. The pairwise checks covered dirs-vs-extraEnv and
  // dirs-vs-env but NOT top-level dirs against configIsolation.extraEnv -- and
  // because staticEnv merged before isolationEnv, the contained relocation was
  // silently replaced by the uncontained setting. Demonstrated end to end: the
  // partner received "pwned-config", a bare relative path it resolves against
  // its own working directory, despite the manifest declaring a relocation.
  // The name is deliberately one the path-variable backstop does NOT recognise,
  // since that is the case where nothing else would catch it.
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          dirs: { FOO: "{{sessionDir}}/data" },
          configIsolation: { ...isolationBase, extraEnv: { FOO: "pwned-config" } },
        }),
        "/f.json"
      ),
    /is also declared in/,
    "a key in top-level dirs and configIsolation.extraEnv must be refused"
  );

  // The remaining pairs, so this is an ALL-PAIRS rule rather than the two that
  // happened to be written first.
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          env: { FOO: "1" },
          configIsolation: { ...isolationBase, dirs: { FOO: "{{sessionDir}}/d" } },
        }),
        "/f.json"
      ),
    /is also declared in/
  );
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          env: { FOO: "1" },
          configIsolation: { ...isolationBase, extraEnv: { FOO: "2" } },
        }),
        "/f.json"
      ),
    /is also declared in/
  );
});

test("collisions are detected case-insensitively, as Windows resolves them", () => {
  // Environment names are case-insensitive on Windows, so `FOO` in one map and
  // `foo` in another are ONE variable there -- and they passed validation as
  // two, producing an overlay whose effective value was no longer guaranteed to
  // be the contained relocation.
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ dirs: { FOO: "{{sessionDir}}/data" }, env: { foo: "1" } }),
        "/f.json"
      ),
    /is also declared in/,
    "dirs.FOO and env.foo are the same variable on Windows"
  );
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          configIsolation: { ...isolationBase, extraEnv: { fake_home: "pwned-config" } },
        }),
        "/f.json"
      ),
    /may not redefine FAKE_HOME|names a filesystem location/,
    "a differently-cased spelling of the isolation variable must be refused"
  );
});

test("neither map may redefine the isolation variable", () => {
  for (const field of ["dirs", "extraEnv"]) {
    assert.throws(
      () =>
        parseManifest(
          baseManifest({
            configIsolation: { ...isolationBase, [field]: { FAKE_HOME: "{{sessionDir}}/other" } },
          }),
          "/f.json"
        ),
      new RegExp(`configIsolation\\.${field} may not redefine FAKE_HOME`),
      field
    );
  }
});

test("a declared relocation is accepted, wherever it points", () => {
  // The schema's job is to record the AUTHOR'S INTENT; containment is proven at
  // spawn against the real session directory, which the schema cannot see. So a
  // dirs entry parses here even when it would be refused at runtime -- see
  // platform-contract for the boundary that refuses it.
  const parsed = parseManifest(
    baseManifest({
      configIsolation: { ...isolationBase, dirs: { XDG_DATA_HOME: "{{sessionDir}}/fake-data" } },
      dirs: { FAKE_CACHE_DIR: "{{sessionDir}}/fake-cache" },
    }),
    "/f.json"
  );
  assert.equal(parsed.configIsolation.dirs.XDG_DATA_HOME, "{{sessionDir}}/fake-data");
  assert.equal(parsed.dirs.FAKE_CACHE_DIR, "{{sessionDir}}/fake-cache");
});

test("the shipped built-in manifests satisfy every invariant", async () => {
  const { listAdapters, resetRegistry } = await import("../src/adapters/registry.mjs");
  resetRegistry();
  // Loading is itself the assertion: parseManifest throws on any violation.
  const adapters = listAdapters({ env: { XDG_CONFIG_HOME: "/nonexistent", XDG_CONFIG_DIRS: "" } });
  assert.ok(adapters.length >= 2);
  resetRegistry();
});
