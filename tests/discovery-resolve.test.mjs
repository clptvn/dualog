// The discovery resolver: manifest config in, model list out.
//
// The parsers are tested in discovery.test.mjs against the same fixtures. What
// is tested HERE is the dispatch and the failure behavior, which is where the
// design commitments live:
//
//   1. Discovery never throws and never blocks a spawn. Every failure degrades
//      to the adapter's static list carrying a notice that says what was tried.
//   2. "Unreachable" and "reachable but empty" stay distinct all the way out.
//   3. {{configHome}} resolves to the USER'S config dir, never the per-session
//      isolated copy -- which never contains a models cache, so pointing there
//      would silently fall back forever.
//
// All I/O is injected, so none of this needs a CLI installed or a network.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveDiscovery as resolveDiscoveryRaw,
  createDiscoveryCache,
  ensureModelCapability,
  CODEX_CACHE_TTL_MS,
} from "../src/adapters/discovery.mjs";
import { parseCatalog } from "../src/adapters/catalog.mjs";
import { getAdapter, resetRegistry } from "../src/adapters/registry.mjs";
import { negotiate } from "../src/adapters/negotiate.mjs";

/**
 * Enrichment off by default, so these tests stay hermetic.
 *
 * A model list with missing efforts -- which is every opencode, qwen and goose
 * result -- would otherwise trigger a real 3.3MB models.dev fetch. Enrichment
 * has its own section at the bottom, where it is driven from a fixture.
 */
const resolveDiscovery = (adapter, options = {}) =>
  resolveDiscoveryRaw(adapter, { enrich: false, ...options });

const FIXTURES = fileURLToPath(new URL("./fixtures/discovery/", import.meta.url));
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf-8");

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
resetRegistry();
const registryOptions = {
  cwd: REPO_ROOT,
  env: { XDG_CONFIG_HOME: "/nonexistent", XDG_CONFIG_DIRS: "" },
};
const adapter = (id) => getAdapter(id, registryOptions);

/** A readFile double that serves fixtures from an explicit path map. */
function fileMap(entries) {
  return (filePath) =>
    filePath in entries
      ? { text: entries[filePath], error: null }
      : { text: null, error: "no such file" };
}

const HOME = "/Users/fixture";
const NOW = Date.parse("2026-08-01T12:00:00Z");

// --- codex: local cache ----------------------------------------------------

test("codex discovery reads the user's real config home, not the session copy", async () => {
  // The isolated CODEX_HOME is a throwaway seeded with auth only. If the path
  // ever resolves there, this returns the static list instead of the cache.
  const seen = [];
  const result = await resolveDiscovery(adapter("codex"), {
    env: {},
    home: HOME,
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: (filePath) => {
      seen.push(filePath);
      return { text: readFixture("codex-models-cache.json"), error: null };
    },
  });

  assert.deepEqual(seen, [`${HOME}/.codex/models_cache.json`]);
  assert.equal(result.strategy, "local-cache");
  assert.equal(result.source, `${HOME}/.codex/models_cache.json`);
  assert.equal(result.stale, false);
  assert.deepEqual(result.notices, []);

  // The picker order, and codex-auto-review filtered out.
  assert.deepEqual(
    result.models.map((m) => m.id),
    [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]
  );
});

test("codex discovery honors $CODEX_HOME from OUR environment", async () => {
  const seen = [];
  await resolveDiscovery(adapter("codex"), {
    env: { CODEX_HOME: "/custom/codex" },
    home: HOME,
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: (filePath) => {
      seen.push(filePath);
      return { text: readFixture("codex-models-cache.json"), error: null };
    },
  });
  assert.deepEqual(seen, ["/custom/codex/models_cache.json"]);
});

test("a codex cache that cannot prove its freshness is flagged, not asserted", async () => {
  // The cache is a live account catalog and list_models uses it as grounds to
  // call an id invalid. "Assume fresh" is therefore the wrong default: an
  // unprovable timestamp has to degrade to a hint.
  const raw = JSON.parse(readFixture("codex-models-cache.json"));

  const resolveWith = async (fetched_at) =>
    resolveDiscovery(adapter("codex"), {
      env: {},
      home: HOME,
      now: NOW,
      cache: createDiscoveryCache(),
      readFile: () => ({ text: JSON.stringify({ ...raw, fetched_at }), error: null }),
    });

  const fresh = await resolveWith(new Date(NOW - 60_000).toISOString());
  assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.notices, []);

  // Older than the TTL.
  const old = await resolveWith(new Date(NOW - CODEX_CACHE_TTL_MS - 60_000).toISOString());
  assert.equal(old.stale, true);
  assert.equal(old.notices[0].code, "cache_stale");
  assert.ok(old.models.length > 0, "a stale cache still answers, it is just flagged");

  // Absent, unparseable, and future-dated all fail to prove freshness.
  for (const fetched_at of [undefined, null, "", "not a date", new Date(NOW + 3_600_000).toISOString()]) {
    const result = await resolveWith(fetched_at);
    assert.equal(result.stale, true, `fetched_at ${JSON.stringify(fetched_at)} should not read as fresh`);
    assert.equal(result.notices[0].code, "cache_stale");
  }
});

test("a missing codex cache degrades to the static list and names the path", async () => {
  const result = await resolveDiscovery(adapter("codex"), {
    env: {},
    home: HOME,
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: fileMap({}),
  });

  assert.equal(result.strategy, "static");
  assert.ok(result.models.length > 0, "fell back to nothing at all");
  assert.equal(result.notices[0].code, "cache_unreadable");
  assert.match(result.notices[0].message, /\.codex\/models_cache\.json.*no such file/);
});

test("a corrupt cache is reported as unparseable, not as missing", async () => {
  const result = await resolveDiscovery(adapter("codex"), {
    env: {},
    home: HOME,
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: () => ({ text: "{ not json", error: null }),
  });
  assert.equal(result.strategy, "static");
  assert.equal(result.notices[0].code, "cache_unparseable");
});

// --- grok: TTL and origin --------------------------------------------------

const GROK_PATH = `${HOME}/.grok/models_cache.json`;

test("a fresh grok cache answers, a stale one answers but is flagged", async () => {
  const raw = JSON.parse(readFixture("grok-models-cache.json"));
  const fresh = { ...raw, fetched_at: new Date(NOW - 60_000).toISOString() };
  const stale = { ...raw, fetched_at: new Date(NOW - 3_600_000).toISOString() };

  const freshResult = await resolveDiscovery(adapter("grok"), {
    env: {},
    home: HOME,
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: fileMap({ [GROK_PATH]: JSON.stringify(fresh) }),
  });
  assert.equal(freshResult.strategy, "local-cache");
  assert.equal(freshResult.stale, false);
  assert.deepEqual(freshResult.notices, []);

  const staleResult = await resolveDiscovery(adapter("grok"), {
    env: {},
    home: HOME,
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: fileMap({ [GROK_PATH]: JSON.stringify(stale) }),
  });
  // Still answered: a stale cache is a hint, not grounds to reject a model.
  assert.equal(staleResult.strategy, "local-cache");
  assert.equal(staleResult.stale, true);
  assert.ok(staleResult.models.length > 0);
  assert.equal(staleResult.notices[0].code, "cache_stale");
});

test("a grok cache written against another backend is refused outright", async () => {
  const raw = JSON.parse(readFixture("grok-models-cache.json"));
  const cache = { ...raw, fetched_at: new Date(NOW - 1000).toISOString(), origin: "https://api.x.ai/v1/models" };

  const result = await resolveDiscovery(adapter("grok"), {
    env: { GROK_MODELS_BASE_URL: "http://localhost:8080/v1" },
    home: HOME,
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: fileMap({ [GROK_PATH]: JSON.stringify(cache) }),
  });

  // Being confidently wrong about someone else's catalog is worse than not
  // answering, so this falls back rather than serving it.
  assert.equal(result.strategy, "static");
  assert.equal(result.notices[0].code, "origin_mismatch");
  assert.match(result.notices[0].message, /localhost:8080\/v1\/models/);
});

// --- opencode: cli-command -------------------------------------------------

test("opencode discovery keeps the full provider/model id", async () => {
  const result = await resolveDiscovery(adapter("opencode"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runCommand: async ({ command, args }) => {
      assert.equal(command, "opencode");
      assert.deepEqual(args, ["models"]);
      return { stdout: readFixture("opencode-models.txt"), error: null };
    },
  });

  assert.equal(result.strategy, "cli-command");
  assert.equal(result.source, "opencode models");
  // --model takes the whole string, and a model id may itself contain slashes.
  assert.ok(result.models.some((m) => m.id === "lmstudio/google/gemma-3n-e4b"));
  for (const model of result.models) assert.ok(model.id.length > 0);
});

test("a command that cannot run degrades; a command that lists nothing does not", async () => {
  const failed = await resolveDiscovery(adapter("opencode"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runCommand: async () => ({ stdout: "", error: "not installed" }),
  });
  assert.equal(failed.strategy, "static");
  assert.equal(failed.notices[0].code, "command_failed");

  const empty = await resolveDiscovery(adapter("opencode"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runCommand: async () => ({ stdout: "\n", error: null }),
  });
  // Opposite diagnosis: the CLI ran fine and has no providers configured.
  assert.equal(empty.strategy, "cli-command");
  assert.deepEqual(empty.models, []);
  assert.equal(empty.notices[0].code, "discovery_empty");
});

// --- qwen / goose: http-openai ---------------------------------------------

test("with no base URL configured, http discovery says so instead of probing", async () => {
  let probed = false;
  const result = await resolveDiscovery(adapter("qwen"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    fetchModels: async () => {
      probed = true;
      return { models: [], source: null, error: null };
    },
    fetchShow: async () => null,
  });

  assert.equal(probed, false, "probed a guessed address");
  assert.equal(result.strategy, "static");
  assert.equal(result.notices[0].code, "no_base_url");
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["qwen3-coder-plus", "qwen3-coder-flash"]
  );
});

test("unreachable and reachable-but-empty are not the same outcome", async () => {
  const unreachable = await resolveDiscovery(adapter("goose"), {
    env: { OPENAI_HOST: "http://localhost:9999" },
    now: NOW,
    cache: createDiscoveryCache(),
    fetchModels: async () => ({
      models: null,
      source: null,
      error: { code: "unreachable", message: "http://localhost:9999 is unreachable (ECONNREFUSED)" },
    }),
    fetchShow: async () => null,
  });
  assert.equal(unreachable.strategy, "static", "an unreachable server must not be believed");
  assert.equal(unreachable.notices[0].code, "unreachable");

  const empty = await resolveDiscovery(adapter("goose"), {
    env: { OPENAI_HOST: "http://localhost:11434" },
    now: NOW,
    cache: createDiscoveryCache(),
    fetchModels: async () => ({
      models: [],
      source: "http://localhost:11434/v1/models",
      error: { code: "no_models", message: "reachable but reports zero models" },
    }),
    fetchShow: async () => null,
  });
  // The server is fine and has nothing pulled: that IS the answer.
  assert.equal(empty.strategy, "http-openai");
  assert.deepEqual(empty.models, []);
  assert.equal(empty.notices[0].code, "no_models");
});

test("a live endpoint's model list is returned with its answering URL", async () => {
  const body = JSON.parse(readFixture("ollama-v1-models.json"));
  const result = await resolveDiscovery(adapter("goose"), {
    env: { OLLAMA_HOST: "http://localhost:11434" },
    now: NOW,
    cache: createDiscoveryCache(),
    fetchModels: async (baseUrl, opts) => {
      assert.equal(baseUrl, "http://localhost:11434");
      assert.equal(opts.apiKey, null);
      return {
        models: body.data.map((entry) => ({ id: entry.id })),
        source: "http://localhost:11434/v1/models",
        error: null,
      };
    },
    fetchShow: async () => null,
  });

  assert.equal(result.strategy, "http-openai");
  assert.equal(result.source, "http://localhost:11434/v1/models");
  assert.ok(result.models.length > 0);
  assert.deepEqual(result.notices, []);
});

// --- ollama tool-capability gate -------------------------------------------

test("a locally served model without tools is rejected before it can hang", async () => {
  // The end-to-end path the parser was written for: /v1/models returns names
  // only, /api/show says whether each can call a tool, and a model that cannot
  // is refused at preflight rather than left to produce prose forever.
  const withTools = JSON.parse(readFixture("ollama-api-show.json"));
  const withoutTools = JSON.parse(readFixture("ollama-api-show-no-tools.json"));

  const discovered = await resolveDiscovery(adapter("goose"), {
    env: { OLLAMA_HOST: "http://localhost:11434" },
    now: NOW,
    cache: createDiscoveryCache(),
    fetchModels: async () => ({
      models: [{ id: "qwen3:8b" }, { id: "nomic-embed-text" }],
      source: "http://localhost:11434/v1/models",
      error: null,
    }),
    fetchShow: async (_baseUrl, modelId) =>
      modelId === "qwen3:8b" ? withTools : withoutTools,
  });

  const byId = new Map(discovered.models.map((m) => [m.id, m]));
  assert.equal(byId.get("qwen3:8b").supportsTools, true);
  assert.equal(byId.get("nomic-embed-text").supportsTools, false);
  assert.ok(discovered.notices.some((n) => n.code === "models_without_tools"));

  const goose = adapter("goose");
  assert.equal(goose.completion.sidecar, "always", "precondition for this gate");

  // The tool-less model cannot start...
  const blocked = negotiate(goose, {
    engine: goose.engines.default,
    toolProfile: "read",
    model: "nomic-embed-text",
    requireBinary: false,
    discoveredModels: discovered,
  });
  assert.equal(blocked.errors.length, 1);
  assert.equal(blocked.errors[0].code, "model_cannot_call_tools");

  // ...while the one that can call tools is unaffected.
  const allowed = negotiate(goose, {
    engine: goose.engines.default,
    toolProfile: "read",
    model: "qwen3:8b",
    requireBinary: false,
    discoveredModels: discovered,
  });
  assert.deepEqual(allowed.errors, []);
});

test("an unprobeable server leaves capability unknown, and unknown never rejects", async () => {
  // A non-Ollama OpenAI-compatible host 404s /api/show. That is the common
  // case, and absence of evidence about tools must not read as evidence of
  // their absence -- otherwise every such server becomes unusable.
  for (const showResponse of [null, {}, { capabilities: "tools" }]) {
    const discovered = await resolveDiscovery(adapter("goose"), {
      env: { OLLAMA_HOST: "http://localhost:11434" },
      now: NOW,
      cache: createDiscoveryCache(),
      fetchModels: async () => ({
        models: [{ id: "some-model" }],
        source: "http://localhost:11434/v1/models",
        error: null,
      }),
      fetchShow: async () => showResponse,
    });

    assert.equal(
      discovered.models[0].supportsTools,
      undefined,
      `${JSON.stringify(showResponse)} should leave capability unknown`
    );

    const result = negotiate(adapter("goose"), {
      engine: "tmux-interactive",
      toolProfile: "read",
      model: "some-model",
      requireBinary: false,
      discoveredModels: discovered,
    });
    assert.ok(
      !result.errors.some((e) => e.code === "model_cannot_call_tools"),
      "an unknown capability must never reject"
    );
  }
});

test("the selected model is probed even when it sits past the listing cap", async () => {
  // The listing probe is bounded so a large library does not become dozens of
  // requests. A bounded LISTING is fine; a bounded GATE is not -- selecting the
  // 33rd model would skip the tool check entirely and produce exactly the
  // hanging turn the gate exists to prevent.
  const withoutTools = JSON.parse(readFixture("ollama-api-show-no-tools.json"));
  const manyModels = Array.from({ length: 40 }, (_, i) => ({ id: `model-${i}` }));
  const target = "model-39";

  let listingProbes = 0;
  const discovered = await resolveDiscovery(adapter("goose"), {
    env: { OLLAMA_HOST: "http://localhost:11434" },
    now: NOW,
    cache: createDiscoveryCache(),
    fetchModels: async () => ({
      models: manyModels,
      source: "http://localhost:11434/v1/models",
      error: null,
    }),
    fetchShow: async () => {
      listingProbes += 1;
      return null; // listing probe learns nothing
    },
  });

  assert.equal(listingProbes, 32, "listing probe stays bounded");
  assert.ok(discovered.notices.some((n) => n.code === "capability_probe_truncated"));
  assert.equal(
    discovered.models.find((m) => m.id === target).supportsTools,
    undefined,
    "precondition: the listing probe never reached this model"
  );

  // Preflight probes the one model that matters, wherever it sits.
  const patched = await ensureModelCapability(adapter("goose"), discovered, target, {
    env: { OLLAMA_HOST: "http://localhost:11434" },
    fetchShow: async (_baseUrl, id) => (id === target ? withoutTools : null),
  });

  assert.equal(patched.models.find((m) => m.id === target).supportsTools, false);

  const result = negotiate(adapter("goose"), {
    engine: "tmux-interactive",
    toolProfile: "read",
    model: target,
    requireBinary: false,
    discoveredModels: patched,
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "model_cannot_call_tools");
});

test("discovered per-model efforts decide validity, not just the manifest", async () => {
  // opencode declares NO models, so a manifest-only check has nothing to check
  // against and falls back to the adapter-wide union -- the widest possible set,
  // which rejects nothing. The live catalog is what actually knows.
  const oc = adapter("opencode");
  assert.deepEqual(oc.models, [], "precondition: no manifest models");
  assert.ok(oc.reasoningEfforts.includes("minimal"), "precondition: adapter-wide allows minimal");

  const discovered = {
    strategy: "cli-command",
    stale: false,
    source: "opencode models (live)",
    models: [{ id: "anthropic/claude-sonnet-4-6", efforts: ["low", "medium", "high", "max"] }],
  };

  const rejected = negotiate(oc, {
    engine: oc.engines.default,
    toolProfile: "read",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "minimal",
    requireBinary: false,
    discoveredModels: discovered,
  });
  assert.equal(rejected.errors.length, 1);
  assert.equal(rejected.errors[0].code, "effort_unsupported_by_model");
  assert.match(rejected.errors[0].message, /opencode models \(live\)/, "cites the deciding source");

  const accepted = negotiate(oc, {
    engine: oc.engines.default,
    toolProfile: "read",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: "max",
    requireBinary: false,
    discoveredModels: discovered,
  });
  assert.deepEqual(accepted.errors, []);
});

test("a discovery result carrying no effort data does not erase the manifest's", () => {
  // Discovery is preferred, not blindly trusted: an entry with no `efforts` must
  // fall back to what the manifest knows rather than widening to the union.
  const claude = adapter("claude");
  const discovered = {
    strategy: "sdk-control",
    stale: false,
    source: "claude list_models (live)",
    models: [{ id: "claude-sonnet-4-6" }], // no efforts field
  };

  const result = negotiate(claude, {
    engine: "tmux-interactive",
    toolProfile: "read",
    model: "claude-sonnet-4-6",
    reasoningEffort: "xhigh",
    requireBinary: false,
    discoveredModels: discovered,
  });
  assert.equal(result.errors.length, 1, "manifest still knows sonnet-4-6 has no xhigh");
  assert.equal(result.errors[0].code, "effort_unsupported_by_model");
});

// --- static adapters and the never-throws guarantee -------------------------

test("an adapter with no source attempts nothing and reports nothing", async () => {
  // Cursor is the pure case: no local cache, no listing command whose output
  // anyone here has captured. It must not invent an attempt, and must not
  // report a failure it never had.
  const result = await resolveDiscovery(adapter("cursor"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: () => assert.fail("cursor must not read a file"),
    runCommand: async () => assert.fail("cursor must not spawn a process"),
    fetchModels: async () => assert.fail("cursor must not make a request"),
    runControl: async () => assert.fail("cursor must not make a control request"),
  });

  assert.equal(result.strategy, "static");
  assert.equal(result.stale, false);
  assert.deepEqual(result.notices, []);
});

// --- claude: sdk-control ---------------------------------------------------

// The real captured stdout line. The parser is tested against it in
// discovery.test.mjs; what is tested here is the wiring and the spawn argv.
const CLAUDE_LINE = readFixture("claude-list-models.jsonl").trim();

test("claude discovery returns the CLI's own aliases, which no manifest lists", async () => {
  const result = await resolveDiscovery(adapter("claude"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runControl: async ({ command, request }) => {
      assert.equal(command, "claude");
      assert.deepEqual(request, { subtype: "list_models" });
      return { line: CLAUDE_LINE, error: null };
    },
  });

  assert.equal(result.strategy, "sdk-control");
  assert.equal(result.stale, false);
  assert.deepEqual(result.notices, []);
  assert.equal(result.fetchedAt, new Date(NOW).toISOString());

  // `default`, `opus[1m]`, `sonnet` and `haiku` are valid --model values that
  // appear in no static manifest. Discovery exists to close exactly that gap.
  const ids = result.models.map((m) => m.id);
  for (const alias of ["default", "opus[1m]", "sonnet", "haiku"]) {
    assert.ok(ids.includes(alias), `${alias} is selectable but was not discovered`);
  }
  assert.equal(result.models.find((m) => m.id === "sonnet").resolvedModel, "claude-sonnet-5");
  assert.deepEqual(result.models.find((m) => m.id === "haiku").efforts, []);
});

test("a discovery spawn asks a question and must not cause anything", async () => {
  // Each of these flags encodes an observed side effect, not a preference:
  // without --bare the probe fires the USER'S hooks, and without an empty
  // strict MCP config it can boot the user's MCP servers -- which, in this
  // repo, means booting our own dialog server from inside a discovery call.
  let seen = null;
  await resolveDiscovery(adapter("claude"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runControl: async (options) => {
      seen = options;
      return { line: CLAUDE_LINE, error: null };
    },
  });

  assert.ok(seen.args.includes("--bare"), "discovery must not run the user's hooks");
  assert.ok(seen.args.includes("--strict-mcp-config"), "discovery must not load user MCP servers");

  const mcpConfig = seen.args[seen.args.indexOf("--mcp-config") + 1];
  assert.deepEqual(JSON.parse(mcpConfig), { mcpServers: {} });

  // The stream-json control channel itself: without all three the CLI either
  // will not read a control request or will not emit a parseable answer.
  for (const flag of ["--input-format", "--output-format", "--verbose", "-p"]) {
    assert.ok(seen.args.includes(flag), `${flag} is required for the control channel`);
  }
  assert.equal(seen.timeoutMs, 15000);
});

test("not installed, timed out, and answered-with-nothing stay three answers", async () => {
  const degrade = async (result) =>
    resolveDiscovery(adapter("claude"), {
      env: {},
      now: NOW,
      cache: createDiscoveryCache(),
      runControl: async () => result,
    });

  // Distinct because they send you to three different places: install the CLI,
  // look at why it hung, look at whether you are signed in.
  const missing = await degrade({
    line: null,
    error: { code: "cli_not_found", message: "`claude` is not installed or not on PATH" },
  });
  assert.equal(missing.notices[0].code, "cli_not_found");

  const timedOut = await degrade({
    line: null,
    error: { code: "control_timeout", message: "did not answer within 15000ms" },
  });
  assert.equal(timedOut.notices[0].code, "control_timeout");

  const empty = await degrade({
    line: JSON.stringify({
      type: "control_response",
      response: { subtype: "success", response: { models: [] } },
    }),
    error: null,
  });
  assert.equal(empty.notices[0].code, "discovery_empty");

  // All three fall back, and the fallback is the full static table -- a listing
  // that failed must never narrow what the user is allowed to spawn.
  for (const result of [missing, timedOut, empty]) {
    assert.equal(result.strategy, "static");
    assert.ok(result.models.some((m) => m.id === "claude-opus-5"));
  }
});

test("a control response in an unexpected shape degrades instead of throwing", async () => {
  const result = await resolveDiscovery(adapter("claude"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    // One level too high: the shape the parser exists to reject.
    runControl: async () => ({
      line: JSON.stringify({ type: "control_response", response: { models: [] } }),
      error: null,
    }),
  });

  assert.equal(result.strategy, "static");
  assert.equal(result.notices[0].code, "unexpected_response");
  assert.ok(result.models.length > 0);
});

test("claude falls back to its static table, inversion intact, when the CLI cannot answer", async () => {
  // Claude discovers via an SDK control request. When that cannot answer -- not
  // installed, not signed in, timed out -- the static table is still the
  // answer, and it is the table that carries the max-but-not-xhigh inversion.
  const result = await resolveDiscovery(adapter("claude"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runControl: async () => ({
      line: null,
      error: { code: "cli_not_found", message: "`claude` is not installed or not on PATH" },
    }),
  });

  assert.equal(result.strategy, "static");
  assert.equal(result.notices[0].code, "cli_not_found");

  const sonnet = result.models.find((m) => m.id === "claude-sonnet-4-6");
  assert.deepEqual(sonnet.efforts, ["low", "medium", "high", "max"]);
});

test("an I/O layer that throws still yields a usable answer", async () => {
  const result = await resolveDiscovery(adapter("codex"), {
    env: {},
    home: HOME,
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: () => {
      throw new Error("disk on fire");
    },
  });

  assert.equal(result.strategy, "static");
  assert.equal(result.notices[0].code, "discovery_failed");
  assert.match(result.notices[0].message, /disk on fire/);
  assert.ok(result.models.length > 0);
});

test("every built-in adapter resolves without throwing, whatever the machine", async () => {
  const { listAdapters } = await import("../src/adapters/registry.mjs");
  for (const built of listAdapters(registryOptions)) {
    const result = await resolveDiscovery(built, {
      env: {},
      home: HOME,
      now: NOW,
      cache: createDiscoveryCache(),
      readFile: fileMap({}),
      runCommand: async () => ({ stdout: "", error: "not installed" }),
      fetchModels: async () => ({ models: null, source: null, error: { code: "unreachable", message: "no" } }),
      // Doubled rather than left to the default: the real one would spawn a
      // CLI that IS installed on this machine, and a test suite must not start
      // a partner process as a side effect of asking what models exist.
      runControl: async () => ({ line: null, error: { code: "cli_not_found", message: "not installed" } }),
    });
    assert.ok(Array.isArray(result.models), `${built.id} returned no model array`);
    assert.ok(Array.isArray(result.notices), `${built.id} returned no notices`);
    for (const item of result.notices) {
      assert.ok(item.code && item.message, `${built.id} emitted a notice with no code or message`);
    }
  }
});

// --- catalog enrichment ----------------------------------------------------
//
// The gap this closes: `parseOpencodeModels` returns {provider, id, full} and
// `parseOpenAIModels` returns {id}. Neither carries effort data, and opencode
// and goose have empty static lists. So per-model effort enforcement -- the
// point of all of this -- could not reach opencode, qwen or goose at all.
// Enrichment is the only thing that can fill it in.

const CATALOG_FIXTURE = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL("./fixtures/catalog/models-dev-slice.json", import.meta.url)),
    "utf-8"
  )
);
const CATALOG_INDEX = parseCatalog(CATALOG_FIXTURE).index;

/** A loadCatalog double: the real index, no network. */
const catalogFromFixture = async () => ({
  index: CATALOG_INDEX,
  source: "fixture",
  fetchedAt: new Date(NOW).toISOString(),
  stale: false,
  notices: [],
});

test("an opencode model with no efforts comes out with efforts from the catalog", async () => {
  // THE case this feature exists for. `opencode models` gives ids and nothing
  // else; without enrichment nothing downstream can validate an effort against
  // the model it was asked for.
  const result = await resolveDiscoveryRaw(adapter("opencode"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runCommand: async () => ({ stdout: "anthropic/claude-sonnet-4-6\n", error: null }),
    loadCatalogImpl: catalogFromFixture,
  });

  assert.equal(result.strategy, "cli-command");
  const model = result.models.find((m) => m.id === "anthropic/claude-sonnet-4-6");
  assert.ok(model, "the discovered id must survive enrichment unchanged");

  // Filled from models.dev -- and it is the correct set, with no xhigh.
  assert.deepEqual(model.efforts, ["low", "medium", "high", "max"]);
  assert.ok(result.notices.some((n) => n.code === "catalog_enriched"));
});

test("opencode ids are looked up as-is, not prefixed with the provider twice", async () => {
  // The id is already `provider/model`. Building a key from the provider AND
  // the id would ask for "anthropic/anthropic/claude-sonnet-4-6" and miss every
  // single time -- a silent, total failure of enrichment for this adapter.
  const result = await resolveDiscoveryRaw(adapter("opencode"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runCommand: async () => ({ stdout: "anthropic/claude-sonnet-4-6\n", error: null }),
    loadCatalogImpl: catalogFromFixture,
  });
  assert.ok(result.models[0].efforts, "the double-prefix bug is back");
});

test("enrichment never overrides what a CLI cache already said", async () => {
  // Codex's cache carries `ultra`, which models.dev cannot know about because
  // it is a CLI orchestration feature, not a model capability.
  let fetched = false;
  const result = await resolveDiscoveryRaw(adapter("codex"), {
    env: {},
    home: HOME,
    now: NOW,
    cache: createDiscoveryCache(),
    readFile: () => ({ text: readFixture("codex-models-cache.json"), error: null }),
    loadCatalogImpl: async () => {
      fetched = true;
      return catalogFromFixture();
    },
  });

  const sol = result.models.find((m) => m.id === "gpt-5.6-sol");
  assert.ok(sol.efforts.includes("ultra"), "the CLI-only effort was overwritten");
  assert.ok(!sol.efforts.includes("none"), "a catalog-only effort was injected");

  // And the catalog was never even fetched: every model already had efforts,
  // so there was nothing to gain. No gaps, no network.
  assert.equal(fetched, false, "fetched the catalog with nothing to fill");
});

test("enrichment cannot introduce a model id, however stale the catalog", async () => {
  // openai/gpt-5.3-codex is retired and still listed by models.dev as active.
  // It must not be able to appear in a discovery result.
  const result = await resolveDiscoveryRaw(adapter("opencode"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runCommand: async () => ({ stdout: "openai/gpt-5.6-sol\n", error: null }),
    loadCatalogImpl: catalogFromFixture,
  });

  assert.deepEqual(
    result.models.map((m) => m.id),
    ["openai/gpt-5.6-sol"]
  );
  assert.ok(!result.models.some((m) => m.id.includes("gpt-5.3-codex")));
});

test("a catalog that cannot be loaded leaves the models untouched", async () => {
  const result = await resolveDiscoveryRaw(adapter("opencode"), {
    env: {},
    now: NOW,
    cache: createDiscoveryCache(),
    runCommand: async () => ({ stdout: "anthropic/claude-sonnet-4-6\n", error: null }),
    loadCatalogImpl: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, "anthropic/claude-sonnet-4-6");
  assert.equal(result.models[0].efforts, undefined);
  assert.ok(result.notices.some((n) => n.code === "catalog_unavailable"));
});

test("a bare id with no provider hint is left alone rather than guessed at", async () => {
  // qwen returns bare ids and has no unambiguous first-party provider in
  // models.dev, so its manifest sets no catalogProvider. Guessing would be a
  // coin flip between the right effort set and a reseller's wrong one.
  const result = await resolveDiscoveryRaw(adapter("qwen"), {
    env: { OPENAI_BASE_URL: "http://localhost:11434" },
    now: NOW,
    cache: createDiscoveryCache(),
    fetchModels: async () => ({
      models: [{ id: "claude-sonnet-4-6" }],
      source: "http://localhost:11434/v1/models",
      error: null,
    }),
    loadCatalogImpl: catalogFromFixture,
  });

  assert.equal(result.models[0].efforts, undefined, "matched without knowing the provider");
  assert.ok(result.notices.some((n) => n.code === "enrich_no_provider"));
});

test("the catalog strategy annotates the manifest list without becoming one", async () => {
  // `catalog` takes its IDS from the manifest. It must never read as a live
  // list, or it would become grounds to reject models -- against a catalog
  // that still lists retired ids and lags real ones.
  const { parseManifest } = await import("../src/adapters/schema.mjs");
  const { isEnumerable } = await import("../src/adapters/schema.mjs");
  const manifest = parseManifest(
    {
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
      models: ["claude-sonnet-4-6"],
      discovery: { strategy: "catalog", catalogProvider: "anthropic" },
      mcp: { strategy: "none" },
      promptDelivery: { headless: "argv" },
      argv: { headless: [{ args: ["run"] }] },
      completion: { sidecar: "always", stdoutTrustworthy: false },
    },
    "/f.json"
  );

  const result = await resolveDiscoveryRaw(manifest, {
    now: NOW,
    cache: createDiscoveryCache(),
    loadCatalogImpl: catalogFromFixture,
  });

  assert.deepEqual(result.models.map((m) => m.id), ["claude-sonnet-4-6"]);
  assert.deepEqual(result.models[0].efforts, ["low", "medium", "high", "max"]);
  assert.equal(result.strategy, "static", "a catalog result must not read as live");
  assert.equal(isEnumerable(result), false, "the catalog became a rejection list");
});

test("strategy none does no I/O at all, enrichment included", async () => {
  const { parseManifest } = await import("../src/adapters/schema.mjs");
  const manifest = parseManifest(
    {
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
      models: ["claude-sonnet-4-6"],
      discovery: { strategy: "none" },
      mcp: { strategy: "none" },
      promptDelivery: { headless: "argv" },
      argv: { headless: [{ args: ["run"] }] },
      completion: { sidecar: "always", stdoutTrustworthy: false },
    },
    "/f.json"
  );

  const result = await resolveDiscoveryRaw(manifest, {
    now: NOW,
    cache: createDiscoveryCache(),
    loadCatalogImpl: async () => assert.fail("`none` must not load the catalog"),
  });
  assert.equal(result.models[0].efforts, undefined);
});

// --- schema coherence ------------------------------------------------------

test("a {{configHome}} path without config isolation is rejected at load", async () => {
  // Lives here rather than in adapter-schema.test.mjs because it is a fact
  // about the discovery field specifically. The failure it prevents is the
  // quiet kind: an unresolvable path is not an error at runtime, it is a
  // permanent silent fallback to the static list.
  const { parseManifest } = await import("../src/adapters/schema.mjs");
  const manifest = {
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
    argv: { headless: [{ args: ["run"] }] },
    completion: { sidecar: "always", stdoutTrustworthy: false },
    discovery: {
      strategy: "local-cache",
      format: "codex-cache",
      path: "{{configHome}}/models_cache.json",
    },
  };

  assert.throws(
    () => parseManifest(manifest, "/f.json"),
    /discovery\.path uses \{\{configHome\}\} but configIsolation is null/
  );

  // The same manifest with isolation declared is fine.
  const withIsolation = {
    ...manifest,
    configIsolation: { env: "FAKE_HOME", dir: "{{sessionDir}}/fake", seedFromFallback: "{{home}}/.fake" },
  };
  assert.equal(parseManifest(withIsolation, "/f.json").discovery.format, "codex-cache");
});

// --- caching ---------------------------------------------------------------

test("a successful live lookup is cached; a fallback never is", async () => {
  const cache = createDiscoveryCache();
  let calls = 0;
  const run = () =>
    resolveDiscovery(adapter("opencode"), {
      env: {},
      now: NOW,
      cache,
      runCommand: async () => {
        calls++;
        return { stdout: readFixture("opencode-models.txt"), error: null };
      },
    });

  await run();
  await run();
  assert.equal(calls, 1, "cli-command should be spawned once inside its TTL");

  // refresh bypasses the cache, which is what a "refresh" flag must mean.
  await resolveDiscovery(adapter("opencode"), {
    env: {},
    now: NOW,
    cache,
    refresh: true,
    runCommand: async () => {
      calls++;
      return { stdout: readFixture("opencode-models.txt"), error: null };
    },
  });
  assert.equal(calls, 2);

  const failCache = createDiscoveryCache();
  let failures = 0;
  for (let i = 0; i < 2; i++) {
    await resolveDiscovery(adapter("opencode"), {
      env: {},
      now: NOW,
      cache: failCache,
      runCommand: async () => {
        failures++;
        return { stdout: "", error: "not installed" };
      },
    });
  }
  // A pinned failure would outlive the condition that caused it.
  assert.equal(failures, 2, "a failed lookup must not be cached");
});
