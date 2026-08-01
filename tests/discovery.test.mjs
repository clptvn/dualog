// Model-discovery parsers, tested against committed fixtures.
//
// Every fixture here came off a real machine or a read of the real source, and
// the assertions are written against ground truth rather than against the
// parser's own behavior:
//
//   codex-models-cache.json   redacted copy of ~/.codex/models_cache.json
//                             (client 0.146.0). The seven-model order below is
//                             the order the live `/model` picker shows.
//   ollama-*.json             real responses from localhost:11434, trimmed of
//                             the megabytes of license/modelfile/tensor noise.
//                             The no-tools variant is synthetic, in the real
//                             shape, for the capability gate.
//   grok-models-cache.json    envelope and field names from the grok source
//                             (grok is NOT installed here); ids limited to ones
//                             confirmed to exist. Timestamps are fixed and the
//                             tests inject `now`, so freshness is deterministic.
//   opencode-models.txt       hand-written stdout in the documented format,
//                             including the verified multi-slash id.
//   openrouter-models.json    hand-written trim of OpenRouter's documented
//                             variant: no top-level `object`, plus total_count.
//   claude-list-models.jsonl  the exact stdout line from a real `list_models`
//                             control request on this machine, request_id
//                             replaced and nothing else. The -explicit-false
//                             variant is that same line with haiku's
//                             `supportsEffort: false` stated outright -- the
//                             real row omits the field entirely, and both
//                             encodings have to mean "no efforts".

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCodexCache,
  parseGrokCache,
  parseOpencodeModels,
  parseOpenAIModels,
  parseOllamaShow,
  parseClaudeListModels,
  buildModelsUrl,
  isLocalBaseUrl,
  fetchOpenAIModels,
  createDiscoveryCache,
  discoveryTtlMs,
  GROK_CACHE_TTL_MS,
} from "../src/adapters/discovery.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/discovery/", import.meta.url));
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf-8");
const readJson = (name) => JSON.parse(readFixture(name));

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

// This is the picker, verified against the live CLI. If this test breaks, the
// cache changed or the filter/sort rule did -- either way a human must look.
const CODEX_PICKER_ORDER = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

test("the codex parser reproduces the /model picker exactly", () => {
  const models = parseCodexCache(readJson("codex-models-cache.json"));
  assert.deepEqual(models.map((m) => m.id), CODEX_PICKER_ORDER);
});

test("codex-auto-review is excluded: the CLI hides it from its own user", () => {
  const raw = readJson("codex-models-cache.json");
  // It is present in the cache -- the fixture would not prove anything if the
  // slug had simply been dropped during redaction.
  assert.ok(raw.models.some((m) => m.slug === "codex-auto-review" && m.visibility === "hide"));

  const models = parseCodexCache(raw);
  assert.equal(models.find((m) => m.id === "codex-auto-review"), undefined);
});

test("efforts are per-model: sol and terra have ultra, 5.5 does not", () => {
  const byId = new Map(parseCodexCache(readJson("codex-models-cache.json")).map((m) => [m.id, m]));

  assert.ok(byId.get("gpt-5.6-sol").efforts.includes("ultra"));
  assert.ok(byId.get("gpt-5.6-terra").efforts.includes("ultra"));
  assert.ok(!byId.get("gpt-5.6-luna").efforts.includes("ultra"));
  assert.ok(!byId.get("gpt-5.5").efforts.includes("ultra"));

  // 5.5 stops at xhigh -- it has neither max nor ultra. A flat per-adapter
  // effort list is wrong in both directions, which is the bug this replaces.
  assert.deepEqual(byId.get("gpt-5.5").efforts, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(byId.get("gpt-5.6-sol").efforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
});

test("codex defaults and context windows come through per model", () => {
  const byId = new Map(parseCodexCache(readJson("codex-models-cache.json")).map((m) => [m.id, m]));

  assert.equal(byId.get("gpt-5.6-sol").defaultEffort, "low");
  assert.equal(byId.get("gpt-5.6-terra").defaultEffort, "medium");
  // Spark is the odd one: it defaults to high and has a much smaller window.
  assert.equal(byId.get("gpt-5.3-codex-spark").defaultEffort, "high");
  assert.equal(byId.get("gpt-5.3-codex-spark").context, 128000);
  assert.equal(byId.get("gpt-5.6-sol").context, 272000);

  // Every declared default is inside that model's own effort set.
  for (const model of byId.values()) {
    assert.ok(
      model.efforts.includes(model.defaultEffort),
      `${model.id} defaults to ${model.defaultEffort}, which is not in [${model.efforts}]`
    );
  }
});

test("gpt-5.3-codex is gone from the cache and so from the parse", () => {
  const models = parseCodexCache(readJson("codex-models-cache.json"));
  assert.equal(models.find((m) => m.id === "gpt-5.3-codex"), undefined);
});

test("a model with no priority sorts last instead of scrambling the order", () => {
  // NaN in a comparator leaves V8's sort in an arbitrary order, which would
  // make the picker order non-deterministic rather than merely wrong.
  const models = parseCodexCache({
    models: [
      { slug: "no-priority", visibility: "list" },
      { slug: "second", visibility: "list", priority: 9 },
      { slug: "first", visibility: "list", priority: 1 },
    ],
  });
  assert.deepEqual(models.map((m) => m.id), ["first", "second", "no-priority"]);
});

test("a malformed codex cache yields no models rather than throwing", () => {
  for (const input of [null, undefined, {}, { models: "nope" }, { models: [null, 7] }, []]) {
    assert.deepEqual(parseCodexCache(input), []);
  }
});

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

const GROK_ORIGIN = "https://api.x.ai/v1/models";
const grokFixture = () => readJson("grok-models-cache.json");
const grokFetchedMs = () => Date.parse(grokFixture().fetched_at);

test("a fresh grok cache with a matching origin is usable", () => {
  const result = parseGrokCache(grokFixture(), {
    originUrl: GROK_ORIGIN,
    now: grokFetchedMs() + 100_000,
  });

  assert.equal(result.stale, false);
  assert.equal(result.originMismatch, false);
  assert.deepEqual(result.models.map((m) => m.id), ["grok-4.5", "grok-4.3"]);
});

test("grok-4.5 accepts only high/medium/low -- the canonical set is too wide", () => {
  const { models } = parseGrokCache(grokFixture(), { now: grokFetchedMs() });
  const grok45 = models.find((m) => m.id === "grok-4.5");

  assert.deepEqual(grok45.efforts, ["high", "medium", "low"]);
  assert.ok(!grok45.efforts.includes("xhigh"));
  assert.ok(!grok45.efforts.includes("max"));
  assert.equal(grok45.defaultEffort, "high");
});

test("a stale grok cache is reported as stale, not silently used", () => {
  const result = parseGrokCache(grokFixture(), {
    originUrl: GROK_ORIGIN,
    now: grokFetchedMs() + GROK_CACHE_TTL_MS + 1,
  });

  assert.equal(result.stale, true);
  assert.equal(result.ageMs, GROK_CACHE_TTL_MS + 1);
  // The models are still returned: the caller decides whether a stale answer
  // beats no answer. What it must not do is decide without being told.
  assert.equal(result.models.length, 2);
});

test("a cache with no usable fetched_at counts as stale", () => {
  // We cannot prove freshness, and assuming it is how a cache written against
  // a backend the user has since left gets served as current.
  for (const fetched_at of [undefined, null, "", "not a date"]) {
    const result = parseGrokCache({ ...grokFixture(), fetched_at }, { now: Date.now() });
    assert.equal(result.stale, true);
  }
});

test("an origin mismatch is reported: the cache describes another backend", () => {
  const result = parseGrokCache(grokFixture(), {
    originUrl: "http://localhost:8080/v1/models",
    now: grokFetchedMs(),
  });

  assert.equal(result.originMismatch, true);
  assert.equal(result.origin, GROK_ORIGIN);
  assert.equal(result.stale, false); // fresh, and still not usable for this backend
});

test("a trailing slash is not a different backend", () => {
  const result = parseGrokCache(grokFixture(), {
    originUrl: `${GROK_ORIGIN}/`,
    now: grokFetchedMs(),
  });
  assert.equal(result.originMismatch, false);
});

test("with no expected origin we cannot judge, so we do not claim a mismatch", () => {
  const result = parseGrokCache(grokFixture(), { now: grokFetchedMs() });
  assert.equal(result.originMismatch, false);
});

test("a grok model that does not support effort reports an empty effort set", () => {
  const { models } = parseGrokCache(
    {
      fetched_at: new Date().toISOString(),
      models: { "some-model": { supports_reasoning_effort: false, reasoning_effort: "high" } },
    },
    { now: Date.now() }
  );

  assert.deepEqual(models[0].efforts, []);
  // No default either: an effort the model cannot take is not a default.
  assert.equal(models[0].defaultEffort, null);
});

test("a supported model with no server menu falls back to grok's own menu", () => {
  const { models } = parseGrokCache(
    {
      fetched_at: new Date().toISOString(),
      models: { "some-model": { supports_reasoning_effort: true, reasoning_effort: "high" } },
    },
    { now: Date.now() }
  );
  assert.deepEqual(models[0].efforts, ["xhigh", "high", "medium", "low"]);
});

test("a malformed grok cache yields no models rather than throwing", () => {
  for (const input of [null, undefined, {}, { models: 7 }, { models: [] }]) {
    const result = parseGrokCache(input, { now: Date.now() });
    assert.deepEqual(result.models, []);
    assert.equal(result.stale, true);
  }
});

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

test("an opencode model id containing slashes splits on the FIRST slash only", () => {
  const models = parseOpencodeModels(readFixture("opencode-models.txt"));
  const gemma = models.find((m) => m.full === "lmstudio/google/gemma-3n-e4b");

  assert.equal(gemma.provider, "lmstudio");
  assert.equal(gemma.id, "google/gemma-3n-e4b");

  // Same rule, the common case: OpenRouter-style vendor-prefixed ids.
  const llama = models.find((m) => m.full.startsWith("openrouter/"));
  assert.equal(llama.provider, "openrouter");
  assert.equal(llama.id, "meta-llama/llama-3.3-70b-instruct");
});

test("opencode parsing skips blank lines and keeps everything else", () => {
  const models = parseOpencodeModels(readFixture("opencode-models.txt"));
  assert.deepEqual(models.map((m) => m.full), [
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.6-sol",
    "lmstudio/google/gemma-3n-e4b",
    "ollama/qwen3:32b",
    "openrouter/meta-llama/llama-3.3-70b-instruct",
  ]);
});

test("opencode lines that are not provider/model pairs are dropped", () => {
  assert.deepEqual(
    parseOpencodeModels("no-slash-here\n/leading\ntrailing/\n  openai/gpt-5.5  \n"),
    [{ provider: "openai", id: "gpt-5.5", full: "openai/gpt-5.5" }]
  );
  assert.deepEqual(parseOpencodeModels(""), []);
  assert.deepEqual(parseOpencodeModels(null), []);
});

// ---------------------------------------------------------------------------
// OpenAI-compatible bodies
// ---------------------------------------------------------------------------

test("the ollama /v1/models body parses to bare ids, tag included", () => {
  const models = parseOpenAIModels(readJson("ollama-v1-models.json"));
  assert.deepEqual(models, [{ id: "pentester:latest" }, { id: "qwen3:32b" }]);
});

test("OpenRouter's variant parses even without a top-level `object`", () => {
  // There is no compatibility handshake in this ecosystem: data[].id IS the
  // probe, so validating on the `object: "list"` marker would reject a working
  // endpoint.
  const models = parseOpenAIModels(readJson("openrouter-models.json"));
  assert.deepEqual(models, [
    { id: "anthropic/claude-opus-5" },
    { id: "meta-llama/llama-3.3-70b-instruct" },
  ]);
});

test("an empty data[] is an empty list, and a non-list is null", () => {
  // The distinction the caller turns into two different messages.
  assert.deepEqual(parseOpenAIModels({ object: "list", data: [] }), []);

  for (const body of [null, undefined, "text", {}, { data: {} }, { data: [{ name: "x" }] }]) {
    assert.equal(parseOpenAIModels(body), null);
  }
});

// ---------------------------------------------------------------------------
// Ollama /api/show
// ---------------------------------------------------------------------------

test("ollama capabilities gate the sidecar protocol", () => {
  const show = parseOllamaShow(readJson("ollama-api-show.json"));

  assert.deepEqual(show.capabilities, ["completion", "tools", "thinking"]);
  assert.equal(show.supportsTools, true);
  assert.equal(show.supportsThinking, true);
});

test("a model without `tools` cannot complete a turn and is reported as such", () => {
  const show = parseOllamaShow(readJson("ollama-api-show-no-tools.json"));
  assert.equal(show.supportsTools, false);
  assert.deepEqual(show.capabilities, ["embedding"]);
});

test("context length is read through general.architecture, never hardcoded", () => {
  // qwen3 -> qwen3.context_length; nomic-bert -> nomic-bert.context_length.
  // A hardcoded "qwen3." prefix returns null for the second one, which is the
  // failure this test exists to catch.
  const qwen = parseOllamaShow(readJson("ollama-api-show.json"));
  assert.equal(qwen.architecture, "qwen3");
  assert.equal(qwen.contextLength, 40960);

  const nomic = parseOllamaShow(readJson("ollama-api-show-no-tools.json"));
  assert.equal(nomic.architecture, "nomic-bert");
  assert.equal(nomic.contextLength, 2048);
});

test("a malformed /api/show body degrades instead of throwing", () => {
  for (const input of [null, undefined, {}, { capabilities: "tools" }, { model_info: 3 }]) {
    const show = parseOllamaShow(input);
    assert.deepEqual(show.capabilities, []);
    assert.equal(show.supportsTools, false);
    assert.equal(show.contextLength, null);
  }
});

// ---------------------------------------------------------------------------
// Claude Code -- list_models control response
// ---------------------------------------------------------------------------

// The exact stdout line, captured from a real spawn on this machine. Only the
// request_id was replaced. Five rows, four of them ALIASES.
const CLAUDE_LINE = readFixture("claude-list-models.jsonl").trim();

test("aliases and their resolved ids both survive", () => {
  const models = parseClaudeListModels(CLAUDE_LINE);

  // `value` is what --model takes, so `value` is the id. Four of these five are
  // aliases that appear in no static manifest -- closing that gap is the entire
  // reason this strategy exists, so normalizing them away would defeat it.
  assert.deepEqual(
    models.map((m) => m.id),
    ["default", "opus[1m]", "claude-fable-5[1m]", "sonnet", "haiku"]
  );

  // The concrete id is kept BESIDE the id, never instead of it: `default` and
  // `opus[1m]` resolve to the same model and are still two selectable names.
  assert.equal(models[0].resolvedModel, "claude-opus-5[1m]");
  assert.equal(models[1].resolvedModel, "claude-opus-5[1m]");
  assert.equal(models[3].resolvedModel, "claude-sonnet-5");
  for (const model of models) assert.equal(typeof model.resolvedModel, "string");
});

test("the payload is nested twice, and one level up is not a model list", () => {
  // The regression this pins: `response.models` is undefined, and the level
  // above it is the control envelope. Reading it finds the envelope's own keys
  // and looks like a model list with every field missing.
  const message = JSON.parse(CLAUDE_LINE);
  assert.equal(message.response.models, undefined);
  assert.ok(Array.isArray(message.response.response.models));
  assert.equal(parseClaudeListModels(CLAUDE_LINE).length, 5);
});

test("effort menus survive, and a model with no efforts reports none", () => {
  const models = parseClaudeListModels(CLAUDE_LINE);
  const byId = Object.fromEntries(models.map((m) => [m.id, m]));

  assert.deepEqual(byId["default"].efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(byId["sonnet"].efforts, ["low", "medium", "high", "xhigh", "max"]);

  // GROUND TRUTH, and not what the shape suggests: the real haiku row carries
  // NEITHER `supportsEffort` NOR `supportedEffortLevels` -- it simply omits
  // both. A parser gated on `supportsEffort === false` never fires here.
  const haikuRow = JSON.parse(CLAUDE_LINE).response.response.models.at(-1);
  assert.equal(haikuRow.value, "haiku");
  assert.equal("supportsEffort" in haikuRow, false);
  assert.equal("supportedEffortLevels" in haikuRow, false);

  // `[]` is a fact -- this model takes no --effort at all -- and matches what
  // the static manifest already says about haiku.
  assert.deepEqual(byId["haiku"].efforts, []);
});

test("an explicit supportsEffort:false reports no efforts too", () => {
  // Same real line with the boolean stated outright, which is the other shape
  // the field has been seen in. Both encodings must land on the same answer.
  const models = parseClaudeListModels(readFixture("claude-list-models-explicit-false.jsonl").trim());
  assert.deepEqual(models.find((m) => m.id === "haiku").efforts, []);
});

test("a line that is not the answer returns null, so the caller keeps reading", () => {
  // Every other event in the stream reaches this parser too.
  const notTheAnswer = [
    "",
    "   ",
    "not json at all",
    "{",
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    JSON.stringify({ type: "control_request", request: { subtype: "list_models" } }),
    // A control_response for some other request: right type, no models.
    JSON.stringify({ type: "control_response", response: { subtype: "success", response: {} } }),
    JSON.stringify({ type: "control_response", response: { models: ["one-level-too-high"] } }),
    null,
    undefined,
    42,
    {},
  ];
  for (const line of notTheAnswer) {
    assert.equal(parseClaudeListModels(line), null, JSON.stringify(line));
  }
});

test("an answer carrying no models is empty, which is not the same as null", () => {
  // null means "keep reading"; [] means "the CLI answered and named nothing".
  const empty = JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: "x", response: { models: [] } },
  });
  assert.deepEqual(parseClaudeListModels(empty), []);
});

test("rows with no usable id are dropped rather than emitted as junk", () => {
  const mixed = JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      response: {
        models: [
          { value: "sonnet", supportedEffortLevels: ["low", 7, "high"] },
          { value: "" },
          { resolvedModel: "claude-opus-5" },
          null,
          "sonnet",
        ],
      },
    },
  });
  const models = parseClaudeListModels(mixed);
  assert.deepEqual(models, [{ id: "sonnet", efforts: ["low", "high"] }]);
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

test("buildModelsUrl never produces /v1/v1/models", () => {
  const bases = [
    "http://localhost:11434",
    "http://localhost:11434/",
    "http://localhost:11434///",
    "http://localhost:11434/v1",
    "http://localhost:11434/v1/",
    "https://example.test/api/v1",
    "https://example.test/openai/v1",
    "https://openrouter.ai/api/v1",
  ];
  for (const base of bases) {
    for (const url of buildModelsUrl(base)) {
      assert.ok(!url.includes("/v1/v1/"), `${base} produced ${url}`);
    }
  }
});

test("a base already carrying /v1 is not given a second one", () => {
  // Ollama answers 404 "page not found" on /v1/v1/models, so appending blindly
  // turns a correctly configured endpoint into a discovery failure.
  assert.deepEqual(buildModelsUrl("http://localhost:11434/v1"), [
    "http://localhost:11434/v1/models",
  ]);
  assert.deepEqual(buildModelsUrl("https://openrouter.ai/api/v1/"), [
    "https://openrouter.ai/api/v1/models",
  ]);
});

test("a bare base gets both shapes tried, versioned first", () => {
  assert.deepEqual(buildModelsUrl("http://localhost:11434"), [
    "http://localhost:11434/v1/models",
    "http://localhost:11434/models",
  ]);
});

test("a base that is already the models URL is used as given", () => {
  assert.deepEqual(buildModelsUrl("http://localhost:11434/v1/models"), [
    "http://localhost:11434/v1/models",
  ]);
});

test("an unusable base URL yields no candidates rather than an exception", () => {
  for (const base of ["", "   ", "/", null, undefined, 42]) {
    assert.deepEqual(buildModelsUrl(base), []);
  }
});

test("locality only decides the timeout", () => {
  for (const base of ["http://localhost:11434", "http://127.0.0.1:1234", "http://192.168.1.9:11434"]) {
    assert.equal(isLocalBaseUrl(base), true, base);
  }
  for (const base of ["https://openrouter.ai/api/v1", "https://api.x.ai/v1", "not a url"]) {
    assert.equal(isLocalBaseUrl(base), false, base);
  }
});

// ---------------------------------------------------------------------------
// fetchOpenAIModels -- every failure mode is classified, none throw
// ---------------------------------------------------------------------------

/** A minimal Response stand-in; exercises the `.text()` read path. */
function fakeResponse({ status = 200, contentType = "application/json", body = "", contentLength }) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Map();
  if (contentType) headers.set("content-type", contentType);
  headers.set("content-length", contentLength ?? String(Buffer.byteLength(text)));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => text,
  };
}

/** Records every URL requested so retry policy is observable. */
function recordingFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(url);
    return responder(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const MODEL_LIST = { object: "list", data: [{ id: "qwen3:32b" }] };

test("a working endpoint returns models and the URL that answered", async () => {
  const fetchImpl = recordingFetch(() => fakeResponse({ body: MODEL_LIST }));
  const result = await fetchOpenAIModels("http://localhost:11434", { fetchImpl });

  assert.equal(result.error, null);
  assert.deepEqual(result.models, [{ id: "qwen3:32b" }]);
  assert.equal(result.source, "http://localhost:11434/v1/models");
  assert.equal(fetchImpl.calls.length, 1);
});

test("connection refused is `unreachable` and names the base URL", async () => {
  const fetchImpl = recordingFetch(() => {
    const err = new TypeError("fetch failed");
    err.cause = { code: "ECONNREFUSED" };
    throw err;
  });
  const result = await fetchOpenAIModels("http://localhost:9999", { fetchImpl });

  assert.equal(result.error.code, "unreachable");
  assert.match(result.error.message, /localhost:9999/);
  assert.match(result.error.message, /ECONNREFUSED/);
  assert.equal(result.models, null);
  // One retry, and no point trying the other URL shape on a dead host.
  assert.equal(fetchImpl.calls.length, 2);
});

test("a refused connection surfaces its code through the AggregateError", async () => {
  // Node's real shape for a refused connection: TypeError "fetch failed" whose
  // cause is an AggregateError -- one entry per resolved address -- so the
  // useful code is two levels down. Reporting "fetch failed" instead sends the
  // user nowhere.
  const fetchImpl = recordingFetch(() => {
    const err = new TypeError("fetch failed");
    const aggregate = new AggregateError(
      [Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
      ""
    );
    aggregate.code = "ECONNREFUSED";
    err.cause = aggregate;
    throw err;
  });
  const result = await fetchOpenAIModels("http://localhost:59999", { fetchImpl });
  assert.match(result.error.message, /ECONNREFUSED/);
});

test("a transport failure with no code still reports something actionable", async () => {
  // e.g. an unsafe port, which undici rejects with only "bad port".
  const fetchImpl = recordingFetch(() => {
    const err = new TypeError("fetch failed");
    err.cause = new Error("bad port");
    throw err;
  });
  const result = await fetchOpenAIModels("http://localhost:1", { fetchImpl });

  assert.equal(result.error.code, "unreachable");
  assert.match(result.error.message, /bad port/);
});

test("a DNS failure is also unreachable, not a crash", async () => {
  const fetchImpl = recordingFetch(() => {
    const err = new TypeError("fetch failed");
    err.cause = { code: "ENOTFOUND" };
    throw err;
  });
  const result = await fetchOpenAIModels("http://no-such-host.invalid", { fetchImpl });
  assert.equal(result.error.code, "unreachable");
});

test("a timeout is unreachable and says how long we waited", async () => {
  const fetchImpl = recordingFetch(() => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  });
  const result = await fetchOpenAIModels("http://localhost:11434", {
    fetchImpl,
    timeoutMs: 3000,
  });

  assert.equal(result.error.code, "unreachable");
  assert.match(result.error.message, /3000ms/);
});

test("reachable-but-empty is NOT the same failure as unreachable", async () => {
  const fetchImpl = recordingFetch(() => fakeResponse({ body: { object: "list", data: [] } }));
  const result = await fetchOpenAIModels("http://localhost:11434", { fetchImpl });

  assert.equal(result.error.code, "no_models");
  assert.match(result.error.message, /zero models/);
  // The list is known to be empty, which is different from unknown.
  assert.deepEqual(result.models, []);
  assert.equal(result.source, "http://localhost:11434/v1/models");
});

test("401 and 403 are reported as needing a key", async () => {
  for (const status of [401, 403]) {
    const fetchImpl = recordingFetch(() => fakeResponse({ status, body: { error: "nope" } }));
    const result = await fetchOpenAIModels("https://api.example.test/v1", { fetchImpl });

    assert.equal(result.error.code, "needs_key");
    assert.match(result.error.message, new RegExp(String(status)));
    // A key problem is not a URL-shape problem: do not try the other shape.
    assert.equal(fetchImpl.calls.length, 1);
  }
});

test("a 404 on the first shape falls through to the second, once", async () => {
  const fetchImpl = recordingFetch((url) =>
    url.endsWith("/v1/models")
      ? fakeResponse({ status: 404, contentType: "text/plain", body: "404 page not found" })
      : fakeResponse({ body: MODEL_LIST })
  );
  const result = await fetchOpenAIModels("http://localhost:11434", { fetchImpl });

  assert.equal(result.error, null);
  assert.equal(result.source, "http://localhost:11434/models");
  assert.deepEqual(fetchImpl.calls, [
    "http://localhost:11434/v1/models",
    "http://localhost:11434/models",
  ]);
});

test("404 on every shape is reported, and stops", async () => {
  const fetchImpl = recordingFetch(() => fakeResponse({ status: 404, body: "" }));
  const result = await fetchOpenAIModels("http://localhost:11434", { fetchImpl });

  assert.equal(result.error.code, "not_found");
  assert.equal(fetchImpl.calls.length, 2);
});

test("Ollama's text/plain root is caught before parsing, not after", async () => {
  // GET http://localhost:11434/ returns 200 text/plain "Ollama is running".
  // Parsing first would report a JSON syntax error and send the user to debug
  // their JSON instead of their URL.
  const fetchImpl = recordingFetch(() =>
    fakeResponse({ contentType: "text/plain; charset=utf-8", body: "Ollama is running" })
  );
  const result = await fetchOpenAIModels("http://localhost:11434", { fetchImpl });

  assert.equal(result.error.code, "not_openai_compatible");
  assert.match(result.error.message, /text\/plain/);
  assert.match(result.error.message, /Ollama is running/);
  assert.equal(result.models, null);
});

test("an HTML login page is not OpenAI-compatible", async () => {
  const fetchImpl = recordingFetch(() =>
    fakeResponse({
      contentType: "text/html",
      body: "<!doctype html><html><body>Sign in to continue</body></html>",
    })
  );
  const result = await fetchOpenAIModels("https://proxy.example.test", { fetchImpl });

  assert.equal(result.error.code, "not_openai_compatible");
  assert.match(result.error.message, /text\/html/);
});

test("JSON that is not a model list is not OpenAI-compatible either", async () => {
  const fetchImpl = recordingFetch(() => fakeResponse({ body: { message: "hello" } }));
  const result = await fetchOpenAIModels("https://api.example.test/v1", { fetchImpl });

  assert.equal(result.error.code, "not_openai_compatible");
  assert.match(result.error.message, /data\[\]\.id/);
});

test("a JSON content-type with a broken body is classified, not thrown", async () => {
  const fetchImpl = recordingFetch(() => fakeResponse({ body: "{not json" }));
  const result = await fetchOpenAIModels("https://api.example.test/v1", { fetchImpl });

  assert.equal(result.error.code, "not_openai_compatible");
});

test("a body over the 2MB cap is refused by content-length", async () => {
  const fetchImpl = recordingFetch(() =>
    fakeResponse({ body: MODEL_LIST, contentLength: String(3 * 1024 * 1024) })
  );
  const result = await fetchOpenAIModels("https://api.example.test/v1", { fetchImpl });

  assert.equal(result.error.code, "body_too_large");
});

test("a streamed body with no content-length is still capped", async () => {
  // The reason the read is streamed at all: a misconfigured URL pointed at
  // something enormous must be cut off, not buffered in full and then measured.
  const chunk = new Uint8Array(64 * 1024);
  let sent = 0;
  const fetchImpl = recordingFetch(() => ({
    status: 200,
    ok: true,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent > 4 * 1024 * 1024) return { done: true, value: undefined };
          sent += chunk.byteLength;
          return { done: false, value: chunk };
        },
        cancel: async () => {},
      }),
    },
  }));

  const result = await fetchOpenAIModels("https://api.example.test/v1", { fetchImpl });
  assert.equal(result.error.code, "body_too_large");
  // Cut off well before the 4MB the fake would have produced.
  assert.ok(sent <= 2 * 1024 * 1024 + chunk.byteLength);
});

test("an unusable base URL is classified rather than crashing discovery", async () => {
  const result = await fetchOpenAIModels("", { fetchImpl: recordingFetch(() => fakeResponse({})) });
  assert.equal(result.error.code, "invalid_base_url");
  assert.equal(result.models, null);
});

test("an unexpected HTTP status is classified", async () => {
  const fetchImpl = recordingFetch(() => fakeResponse({ status: 500, body: "" }));
  const result = await fetchOpenAIModels("https://api.example.test/v1", { fetchImpl });
  assert.equal(result.error.code, "bad_status");
  assert.match(result.error.message, /500/);
});

test("an API key is sent as a bearer token when one is given", async () => {
  let headers = null;
  const fetchImpl = async (_url, init) => {
    headers = init.headers;
    return fakeResponse({ body: MODEL_LIST });
  };
  await fetchOpenAIModels("https://api.example.test/v1", { fetchImpl, apiKey: "sk-test" });

  assert.equal(headers.Authorization, "Bearer sk-test");
  assert.equal(headers.Accept, "application/json");
});

test("no fetch implementation is a classified failure, not a TypeError", async () => {
  const result = await fetchOpenAIModels("http://localhost:11434", { fetchImpl: null });
  assert.equal(result.error.code, "unreachable");
});

// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------

test("per-source TTLs match what each source can promise", () => {
  // Reading Codex's cache is a ~1ms file read the CLI keeps current, so a
  // cache in front of it can only serve something the user just changed.
  assert.equal(discoveryTtlMs("local-cache", "codex"), 0);
  // Grok's own cache expires in 300s; ours must not outlive it.
  assert.equal(discoveryTtlMs("local-cache", "grok"), GROK_CACHE_TTL_MS);
  assert.equal(discoveryTtlMs("cli-command", "opencode"), 60_000);
  // Same tier as cli-command: it boots the whole CLI to answer one request.
  assert.equal(discoveryTtlMs("sdk-control", "claude"), 60_000);
  assert.equal(discoveryTtlMs("http-openai", "qwen"), 60_000);
  assert.equal(discoveryTtlMs("catalog", "models.dev"), 24 * 60 * 60 * 1000);
  assert.equal(discoveryTtlMs("static", "claude"), 0);
  assert.equal(discoveryTtlMs("no-such-strategy", "x"), 0);
});

test("a zero-TTL source stores nothing at all", () => {
  const cache = createDiscoveryCache();
  cache.set("local-cache", "codex", ["gpt-5.6-sol"]);

  assert.equal(cache.size, 0);
  assert.equal(cache.get("local-cache", "codex"), undefined);
});

test("entries live for their TTL and are dropped after it", () => {
  let clock = 1_000_000;
  const cache = createDiscoveryCache({ now: () => clock });

  cache.set("cli-command", "opencode", ["anthropic/claude-opus-5"]);
  assert.deepEqual(cache.get("cli-command", "opencode"), ["anthropic/claude-opus-5"]);

  clock += 59_000;
  assert.deepEqual(cache.get("cli-command", "opencode"), ["anthropic/claude-opus-5"]);

  clock += 2_000;
  assert.equal(cache.get("cli-command", "opencode"), undefined);
  assert.equal(cache.size, 0, "an expired entry is evicted, not merely hidden");
});

test("the cache key is (strategy, adapterId), not either alone", () => {
  let clock = 0;
  const cache = createDiscoveryCache({ now: () => clock });

  cache.set("http-openai", "qwen", ["a"]);
  cache.set("http-openai", "goose", ["b"]);
  cache.set("cli-command", "qwen", ["c"]);

  assert.deepEqual(cache.get("http-openai", "qwen"), ["a"]);
  assert.deepEqual(cache.get("http-openai", "goose"), ["b"]);
  assert.deepEqual(cache.get("cli-command", "qwen"), ["c"]);

  cache.delete("http-openai", "qwen");
  assert.equal(cache.get("http-openai", "qwen"), undefined);
  assert.deepEqual(cache.get("cli-command", "qwen"), ["c"]);

  cache.clear();
  assert.equal(cache.size, 0);
});
