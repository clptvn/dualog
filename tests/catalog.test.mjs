// models.dev enrichment.
//
// The fixture is a real slice of https://models.dev/api.json, captured with the
// parser's own fields preserved verbatim. It is chosen to carry every case that
// matters:
//
//   openai/gpt-5.3-codex          RETIRED, and models.dev still lists it with no
//                                 `status` field at all -- i.e. as active. This
//                                 is the currency bug, live. It is the reason
//                                 enrichment may never contribute a model id.
//   anthropic/claude-sonnet-4-6   the verified truth: max, and NO xhigh.
//   llmgateway/claude-sonnet-4-6  the SAME id under another provider, wrongly
//                                 granting xhigh. Provider-blind matching would
//                                 reintroduce the exact inversion bug.
//   abacus/claude-sonnet-4-6      reasoning_options: [] on a model that plainly
//                                 has efforts -- silence, not a claim of none.
//   302ai/claude-sonnet-4-6       toggle + budget_tokens, no effort option.
//   anyapi/cohere/command-r-...   a model id containing a slash of its own.
//   openai/gpt-4.1-nano           an explicitly deprecated model.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseCatalog,
  enrich,
  loadCatalog,
  catalogKey,
  splitCatalogKey,
  memoryCache,
  catalogCachePath,
  CATALOG_URL,
  CATALOG_TTL_MS,
} from "../src/adapters/catalog.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/catalog/", import.meta.url));
const CATALOG = JSON.parse(fs.readFileSync(path.join(FIXTURES, "models-dev-slice.json"), "utf-8"));
const { index } = parseCatalog(CATALOG);

const NOW = Date.parse("2026-08-01T12:00:00Z");

// --- keys ------------------------------------------------------------------

test("a model id containing slashes is indexed under the first slash only", () => {
  // Splitting on every slash yields provider "anyapi", model "cohere", and a
  // model that does not exist. 3,190 catalog ids have this shape.
  const key = "anyapi/cohere/command-r-plus-08-2024";
  assert.deepEqual(splitCatalogKey(key), {
    provider: "anyapi",
    id: "cohere/command-r-plus-08-2024",
  });
  assert.equal(catalogKey("anyapi", "cohere/command-r-plus-08-2024"), key);
  assert.ok(index.has(key), "the multi-slash id is not in the index");
  assert.equal(index.get(key).id, "cohere/command-r-plus-08-2024");
});

test("malformed keys are rejected rather than half-parsed", () => {
  for (const bad of ["", "no-slash", "/leading", "trailing/", null, 42]) {
    assert.equal(splitCatalogKey(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

// --- parsing ---------------------------------------------------------------

test("effort values are extracted, and only from effort-typed options", () => {
  assert.deepEqual(index.get("anthropic/claude-sonnet-4-6").efforts, [
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.deepEqual(index.get("xai/grok-4.5").efforts, ["low", "medium", "high"]);

  // toggle + budget_tokens carry no effort levels, so we learn nothing.
  assert.equal(index.get("302ai/claude-sonnet-4-6").efforts, undefined);

  // An empty reasoning_options is silence too. Asserting [] here would be
  // claiming the model takes no effort, which for this model is false.
  assert.equal(index.get("abacus/claude-sonnet-4-6").efforts, undefined);
});

test("the catalog reproduces the max-but-not-xhigh inversion", () => {
  // The case the whole per-model matrix exists for.
  const sonnet = index.get("anthropic/claude-sonnet-4-6").efforts;
  assert.ok(sonnet.includes("max"));
  assert.ok(!sonnet.includes("xhigh"), "anthropic must not grant sonnet-4-6 xhigh");

  const opus = index.get("anthropic/claude-opus-4-6").efforts;
  assert.ok(opus.includes("max"));
  assert.ok(!opus.includes("xhigh"));
});

test("absent status means active, never deprecated", () => {
  // The inverse would mark the entire healthy catalog as retired.
  const active = index.get("anthropic/claude-sonnet-4-6");
  assert.equal(active.status, undefined);
  assert.equal(active.deprecated, undefined);

  const deprecated = index.get("openai/gpt-4.1-nano");
  assert.equal(deprecated.deprecated, true);
});

test("context and tool_call are carried through", () => {
  const entry = index.get("openai/gpt-5.6-sol");
  assert.equal(typeof entry.context, "number");
  assert.ok(entry.context > 0);
  assert.equal(entry.toolCall, true);
});

test("malformed catalogs yield an empty index instead of throwing", () => {
  for (const bad of [null, undefined, [], "nope", 42, { openai: null }, { openai: { models: [] } }]) {
    const result = parseCatalog(bad);
    assert.equal(result.index.size, 0, `threw or indexed on ${JSON.stringify(bad)}`);
  }
});

// --- enrichment: the two rules ---------------------------------------------

test("enrichment fills efforts for a model that had none", () => {
  const discovered = [{ id: "claude-sonnet-4-6" }];
  const { models, filled, notices } = enrich(discovered, { index, provider: "anthropic" });

  assert.equal(filled, 1);
  assert.deepEqual(notices, []);
  assert.deepEqual(models[0].efforts, ["low", "medium", "high", "max"]);
  assert.equal(models[0].id, "claude-sonnet-4-6");
  // The input is not mutated: callers may hold the primary source's own array.
  assert.equal(discovered[0].efforts, undefined);
});

test("enrichment never overrides efforts that came from a CLI cache", () => {
  // Codex's cache says `ultra`; models.dev cannot know about it, because it is
  // a CLI orchestration feature layered above the model. The primary source
  // wins, whole -- not merged, not extended.
  const fromCache = [
    { id: "gpt-5.6-sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
  ];
  const { models, filled } = enrich(fromCache, { index, provider: "openai" });

  assert.deepEqual(models[0].efforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.ok(models[0].efforts.includes("ultra"), "the CLI-only level was lost");
  assert.ok(!models[0].efforts.includes("none"), "a catalog-only level was injected");
  assert.equal(models[0].defaultEffort, "low");
  // context was missing, so filling it is still allowed.
  assert.equal(filled, 1);
  assert.equal(typeof models[0].context, "number");
});

test("an empty effort list is a claim, not a gap, and is left alone", () => {
  // `[]` means "this model accepts no effort at all" everywhere else in this
  // codebase. Overwriting it would be a downgrade dressed up as a fill.
  const { models } = enrich([{ id: "claude-sonnet-4-6", efforts: [] }], {
    index,
    provider: "anthropic",
  });
  assert.deepEqual(models[0].efforts, []);
});

test("a models.dev-only id never appears in the output", () => {
  // gpt-5.3-codex is retired and absent from the Codex cache, yet models.dev
  // still lists it as active. Enrichment must not be able to resurrect it.
  assert.ok(index.has("openai/gpt-5.3-codex"), "the fixture should still carry the retired id");

  const discovered = [{ id: "gpt-5.6-sol" }, { id: "gpt-5.5" }];
  const { models } = enrich(discovered, { index, provider: "openai" });

  assert.equal(models.length, discovered.length);
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-5.6-sol", "gpt-5.5"]
  );
  assert.ok(!models.some((m) => m.id === "gpt-5.3-codex"));
});

test("enrichment cannot add, drop, or rename an id, whatever the catalog says", () => {
  // The structural guarantee, asserted over the whole fixture: enrichment is a
  // positional map, so ids can only ever pass through unchanged.
  const discovered = [
    { id: "claude-sonnet-4-6" },
    { id: "not-in-any-catalog" },
    { id: "cohere/command-r-plus-08-2024" },
    { id: "gpt-5.6-sol" },
  ];
  const before = discovered.map((m) => m.id);
  const { models } = enrich(discovered, { index, provider: "anthropic" });

  assert.deepEqual(models.map((m) => m.id), before);
  assert.equal(models.length, before.length);
});

// --- enrichment: the provider is part of the key ---------------------------

test("the provider decides the answer, and the wrong one would reintroduce the bug", () => {
  // Same model id, two providers, two different truths. 2 of the 17 providers
  // carrying claude-sonnet-4-6 wrongly grant xhigh; llmgateway is one.
  const correct = enrich([{ id: "claude-sonnet-4-6" }], { index, provider: "anthropic" });
  const wrong = enrich([{ id: "claude-sonnet-4-6" }], { index, provider: "llmgateway" });

  assert.ok(!correct.models[0].efforts.includes("xhigh"));
  assert.ok(wrong.models[0].efforts.includes("xhigh"));
  assert.notDeepEqual(correct.models[0].efforts, wrong.models[0].efforts);
});

test("a model with no provider is skipped and counted, never guessed at", () => {
  const { models, filled, notices } = enrich([{ id: "claude-sonnet-4-6" }], { index });

  assert.equal(filled, 0);
  assert.equal(models[0].efforts, undefined, "matched an id without knowing the provider");
  assert.equal(notices[0].code, "enrich_no_provider");
  assert.match(notices[0].message, /different effort sets under different providers/);
});

test("a per-model provider beats the fallback, which is what opencode needs", () => {
  // `opencode models` lists provider/model, so every model carries its own.
  const { models } = enrich(
    [
      { id: "claude-sonnet-4-6", provider: "anthropic" },
      { id: "claude-sonnet-4-6", provider: "llmgateway" },
    ],
    { index, provider: "openai" }
  );

  assert.ok(!models[0].efforts.includes("xhigh"));
  assert.ok(models[1].efforts.includes("xhigh"));
});

test("models absent from the catalog are reported, not silently dropped", () => {
  const { models, notices } = enrich([{ id: "some-local-gguf" }], { index, provider: "ollama" });
  assert.equal(models.length, 1);
  assert.equal(notices[0].code, "enrich_not_in_catalog");
});

test("enrichment survives junk input", () => {
  for (const bad of [null, undefined, "nope", 42, {}]) {
    const result = enrich(bad, { index, provider: "anthropic" });
    assert.deepEqual(result.models, []);
  }
  const mixed = enrich([null, { id: "" }, { noId: true }, { id: "claude-sonnet-4-6" }], {
    index,
    provider: "anthropic",
  });
  assert.equal(mixed.models.length, 4);
  assert.deepEqual(mixed.models[3].efforts, ["low", "medium", "high", "max"]);
});

// --- loading ---------------------------------------------------------------

function jsonResponse(body, { status = 200, contentType = "application/json" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => JSON.stringify(body),
  };
}

test("a fresh cache is served without touching the network", () => {
  return loadCatalog({
    now: NOW,
    cache: memoryCache({ data: CATALOG, fetchedAt: new Date(NOW - 60_000).toISOString() }),
    fetchImpl: () => assert.fail("a fresh cache must not hit the network"),
  }).then((result) => {
    assert.equal(result.stale, false);
    assert.ok(result.index.size > 0);
    assert.deepEqual(result.notices, []);
  });
});

test("an expired cache is refetched and rewritten", async () => {
  let fetched = 0;
  const cache = memoryCache({ data: {}, fetchedAt: new Date(NOW - CATALOG_TTL_MS - 1000).toISOString() });

  const result = await loadCatalog({
    now: NOW,
    cache,
    fetchImpl: async (url) => {
      assert.equal(url, CATALOG_URL);
      fetched++;
      return jsonResponse(CATALOG);
    },
  });

  assert.equal(fetched, 1);
  assert.equal(result.stale, false);
  assert.equal(result.source, CATALOG_URL);
  assert.ok(result.index.has("anthropic/claude-sonnet-4-6"));
  // Rewritten, so the next call inside the TTL is free.
  assert.equal(cache.read().fetchedAt, new Date(NOW).toISOString());
});

test("a JSON body with no models never evicts the last known-good cache", async () => {
  // A captive portal, an auth error body, or a proxy returning {} is valid JSON
  // that parses to an empty index. Caching it would evict a usable catalog and
  // then serve "no models" as fresh and authoritative for the whole TTL --
  // which looks like an answer rather than the network failure it stands in for.
  const goodFetchedAt = new Date(NOW - CATALOG_TTL_MS - 1000).toISOString();

  for (const junk of [{}, { openai: {} }, { openai: { models: {} } }]) {
    const cache = memoryCache({ data: CATALOG, fetchedAt: goodFetchedAt });

    const result = await loadCatalog({
      now: NOW,
      cache,
      fetchImpl: async () => jsonResponse(junk),
    });

    // The good catalog is still on disk, untouched.
    assert.deepEqual(cache.read().data, CATALOG);
    assert.equal(cache.read().fetchedAt, goodFetchedAt);

    // And it is what gets served, flagged as stale rather than as an empty truth.
    assert.ok(result.index.has("anthropic/claude-sonnet-4-6"));
    assert.equal(result.stale, true);
    assert.ok(
      result.notices.some((n) => n.code === "catalog_unusable"),
      `expected a catalog_unusable notice for ${JSON.stringify(junk)}`
    );
  }
});

test("refresh bypasses a cache that is still fresh", async () => {
  let fetched = 0;
  await loadCatalog({
    now: NOW,
    refresh: true,
    cache: memoryCache({ data: CATALOG, fetchedAt: new Date(NOW).toISOString() }),
    fetchImpl: async () => {
      fetched++;
      return jsonResponse(CATALOG);
    },
  });
  assert.equal(fetched, 1);
});

test("offline with a stale cache serves the stale catalog rather than nothing", async () => {
  // Effort levels barely move, so a day-old catalog is still overwhelmingly
  // right. This is the opposite call from Grok's 300s cache, deliberately.
  const result = await loadCatalog({
    now: NOW,
    cache: memoryCache({ data: CATALOG, fetchedAt: new Date(NOW - CATALOG_TTL_MS * 3).toISOString() }),
    fetchImpl: async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    },
  });

  assert.equal(result.stale, true);
  assert.ok(result.index.size > 0, "a stale catalog is better than no catalog");
  assert.equal(result.notices[0].code, "catalog_unreachable");
  assert.match(result.notices[0].message, /ENOTFOUND/);
  assert.equal(result.notices[1].code, "catalog_stale");
});

test("offline with no cache degrades to an empty index and never throws", async () => {
  const result = await loadCatalog({
    now: NOW,
    cache: memoryCache(null),
    fetchImpl: async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
  });

  assert.equal(result.index.size, 0);
  assert.equal(result.notices[0].code, "catalog_unreachable");

  // An empty index still enriches cleanly -- it just fills nothing.
  const { models, filled } = enrich([{ id: "claude-sonnet-4-6" }], {
    index: result.index,
    provider: "anthropic",
  });
  assert.equal(filled, 0);
  assert.equal(models.length, 1);
});

test("a captive portal answering HTML is named as such, not as a JSON error", async () => {
  const result = await loadCatalog({
    now: NOW,
    cache: memoryCache(null),
    fetchImpl: async () => jsonResponse("<html>login</html>", { contentType: "text/html" }),
  });
  assert.equal(result.notices[0].code, "catalog_not_json");
  assert.match(result.notices[0].message, /text\/html/);
});

test("malformed JSON and bad statuses each get their own code", async () => {
  const badJson = await loadCatalog({
    now: NOW,
    cache: memoryCache(null),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => "{ not json",
    }),
  });
  assert.equal(badJson.notices[0].code, "catalog_unparseable");

  const badStatus = await loadCatalog({
    now: NOW,
    cache: memoryCache(null),
    fetchImpl: async () => jsonResponse({}, { status: 503 }),
  });
  assert.equal(badStatus.notices[0].code, "catalog_bad_status");
  assert.match(badStatus.notices[0].message, /503/);
});

test("an unwritable cache costs the cache, not the answer", async () => {
  const result = await loadCatalog({
    now: NOW,
    cache: {
      describe: () => "broken",
      read: () => null,
      write: () => {
        throw new Error("EROFS: read-only file system");
      },
    },
    fetchImpl: async () => jsonResponse(CATALOG),
  });

  assert.ok(result.index.size > 0, "a failed cache write must not lose the fetched catalog");
  assert.equal(result.notices[0].code, "catalog_cache_unwritable");
});

test("an unreadable cache is a miss, not a crash", async () => {
  const result = await loadCatalog({
    now: NOW,
    cache: {
      describe: () => "broken",
      read: () => {
        throw new Error("EACCES");
      },
      write: () => {},
    },
    fetchImpl: async () => jsonResponse(CATALOG),
  });
  assert.ok(result.index.size > 0);
});

test("the cache lives in the app's own directory, not a session's", () => {
  const cachePath = catalogCachePath("/Users/fixture");
  assert.equal(cachePath, path.join("/Users/fixture", ".dualog", "cache", "models-dev.json"));
  assert.ok(!cachePath.includes("sessions"), "the catalog is global, not per-session");
});
