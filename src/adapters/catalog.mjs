// models.dev as an ENRICHMENT layer.
//
// This module answers one question and refuses the other. It may say "here is
// what efforts this model accepts"; it may never say "here is a model you can
// use". That split is the entire safety argument, and it follows from what
// models.dev is actually good and bad at:
//
//   GOOD -- effort levels. Diffed against the live Codex CLI cache across all
//           seven models it agrees everywhere, and it reproduces the Claude
//           binary exactly, including the claude-sonnet-4-6 / claude-opus-4-6
//           "max but not xhigh" inversion. The two systematic deltas are both
//           explicable: `ultra` is a Codex CLI orchestration feature layered
//           above the model, and `none` is offered by the API but not by the
//           picker. Neither is models.dev being wrong about the model.
//
//   BAD  -- currency. It still lists openai/gpt-5.3-codex with no `status`
//           field at all -- i.e. as active -- months after retirement.
//           Verified against the live endpoint while writing this.
//
// Currency is a claim about EXISTENCE. So: annotate, never introduce. A model
// id can only ever come from a source that reflects reality (a CLI's own cache,
// its listing command, a live endpoint, or a hand-verified manifest), and this
// file is only allowed to hang extra fields on ids those sources already
// returned. That makes the one failure mode structurally unreachable while the
// data we want flows through.
//
// THE PROVIDER IS PART OF THE KEY, and it is not optional. The same model id
// carries DIFFERENT effort sets under different providers: claude-sonnet-4-6
// appears under 17 of them, and 2 wrongly grant it `xhigh` -- precisely the
// inversion this project exists to have fixed. Matching a bare model id against
// whichever provider happens to have it would reintroduce that bug by
// coin-flip. When the provider is unknown we skip the model and say so.
//
// Everything here is pure except `loadCatalog`, which takes its fetch and its
// cache as injectable options so the parsing and merging can be tested against
// a committed fixture with no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";

/**
 * The full catalog. NOT `models.json`, despite it being 15x smaller.
 *
 * Checked, because the size difference is tempting: models.json carries 279
 * entries and ZERO `reasoning_options` -- only a bare `reasoning: true`
 * boolean. api.json carries 5,935 models, 3,837 with reasoning_options, 1,669
 * of them effort-typed. The small file cannot answer the only question we are
 * here to ask.
 */
export const CATALOG_URL = "https://models.dev/api.json";

/** A published dataset; it does not change within a session, let alone a turn. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Generous next to discovery's 8s: this is a ~3.3MB body, and enrichment is
 * never on the critical path of spawning a partner.
 */
export const CATALOG_TIMEOUT_MS = 20_000;

/** The catalog is ~3.3MB and grows. Past this it is not the catalog. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Build the index key for a provider and model.
 *
 * Never reassemble a key by splitting on every slash: 3,190 of the catalog's
 * model ids contain a slash of their own (`anyapi/cohere/command-r-plus-08-2024`
 * is real), so the model id is everything after the FIRST one.
 */
export function catalogKey(provider, modelId) {
  return `${provider}/${modelId}`;
}

/**
 * Split `provider/model` on the FIRST slash only.
 *
 * Splitting on every slash gives provider "anyapi" and model "cohere", and a
 * model id that does not exist. Splitting on the last gives provider
 * "anyapi/cohere". Only the first slash is a delimiter; the rest is data.
 */
export function splitCatalogKey(key) {
  if (typeof key !== "string") return null;
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Index the catalog by `provider/model`.
 *
 * Malformed input yields an empty index rather than throwing: enrichment that
 * cannot run is a missing annotation, and a missing annotation must never be
 * the reason a turn fails.
 */
export function parseCatalog(json) {
  const index = new Map();
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { index, providers: 0, models: 0 };
  }

  let providers = 0;
  let models = 0;

  for (const [providerId, provider] of Object.entries(json)) {
    if (!providerId || !provider || typeof provider !== "object") continue;
    const catalogModels = provider.models;
    if (!catalogModels || typeof catalogModels !== "object" || Array.isArray(catalogModels)) {
      continue;
    }
    providers++;
    for (const [modelId, model] of Object.entries(catalogModels)) {
      if (!modelId || !model || typeof model !== "object") continue;
      models++;
      index.set(catalogKey(providerId, modelId), toEntry(providerId, modelId, model));
    }
  }

  return { index, providers, models };
}

function toEntry(providerId, modelId, model) {
  const entry = { id: modelId, provider: providerId };

  const efforts = effortValues(model.reasoning_options);
  if (efforts) entry.efforts = efforts;

  if (typeof model.tool_call === "boolean") entry.toolCall = model.tool_call;

  const context = model.limit?.context;
  if (typeof context === "number" && Number.isFinite(context) && context > 0) {
    entry.context = context;
  }

  // `status` is ABSENT on active models, so absence must never read as
  // deprecated -- that would mark the entire healthy catalog as retired. Only
  // an explicit "deprecated" means it; "beta" and "alpha" are kept as-is
  // because they say something different.
  if (typeof model.status === "string" && model.status) {
    entry.status = model.status;
    entry.deprecated = model.status === "deprecated";
  }

  return entry;
}

/**
 * The discrete effort values, or null when the catalog does not say.
 *
 * Returns null rather than [] whenever there is no effort-typed option --
 * including when `reasoning_options` is present but holds only `toggle` or
 * `budget_tokens`, and when it is an empty array.
 *
 * DO NOT "SIMPLIFY" THIS INTO `?? []`. The asymmetry is deliberate, and it is
 * the kind that reads as an oversight to anyone skimming:
 *
 *   null / absent -> we do not know what this model accepts
 *   []            -> this model accepts no effort at all
 *
 * Those are different claims, and `[]` is a positive one everywhere else in
 * this codebase -- enforcement reads it as "asking for any effort here is an
 * error". Defaulting the unknown case to it would manufacture that claim out of
 * silence. ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE, and there is a
 * counterexample rather than only a principle: abacus publishes
 * `reasoning_options: []` for claude-sonnet-4-6, a model that demonstrably does
 * have efforts. Collapsing the two would take one reseller's incomplete data
 * and turn it into "this model cannot reason at all".
 */
function effortValues(options) {
  if (!Array.isArray(options)) return null;
  const effort = options.find(
    (option) =>
      option &&
      option.type === "effort" &&
      Array.isArray(option.values) &&
      option.values.length > 0
  );
  if (!effort) return null;

  const values = effort.values.filter((value) => typeof value === "string" && value);
  return values.length ? values : null;
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/**
 * Annotate a discovered model list from the catalog.
 *
 * Two rules, both load-bearing:
 *
 *   NEVER INTRODUCES AN ID. The output is a positional `map` of the input, so
 *   it has the same length and the same ids in the same order, and `id` is only
 *   ever copied from the input model. A retired model that models.dev still
 *   lists as active cannot reach the caller, because there is no code path by
 *   which a catalog entry becomes an output element.
 *
 *   ONLY FILLS WHAT IS MISSING. A primary source always wins, because it knows
 *   things the catalog cannot: a CLI's own cache reflects what THAT CLI
 *   exposes, including additions (Codex's `ultra`) and withholdings (the picker
 *   not offering `none`). `undefined` means missing; `[]` does not -- an empty
 *   effort list is a positive claim that the model takes no effort, and
 *   overwriting it would be a downgrade, not a fill.
 *
 * The provider comes from the model itself when the primary source knew it
 * (opencode lists `provider/model`, so it always does), otherwise from the
 * `provider` option. With neither, the model is passed through untouched and
 * counted -- never matched by scanning for any provider that happens to carry
 * the id, which would be a coin-flip between correct and wrong effort sets.
 */
/**
 * The `provider/model` key to look one model up under, or null when we cannot
 * know it.
 *
 * `catalogId` exists for sources whose ids are ALREADY provider-qualified.
 * `opencode models` prints exactly that shape, and its id is what `--model`
 * takes, so the id IS the key; building one from the provider as well would ask
 * for "anthropic/anthropic/claude-sonnet-4-6" and miss every time.
 *
 * Returning null rather than falling back to a bare id is the safety rule in
 * miniature: an unqualified lookup would have to pick a provider, and picking
 * wrong yields a plausible, confidently incorrect effort set.
 */
function lookupKey(model, providerFallback) {
  if (typeof model.catalogId === "string" && model.catalogId) return model.catalogId;
  const provider = model.provider ?? providerFallback;
  return provider ? catalogKey(provider, model.id) : null;
}

export function enrich(models, options = {}) {
  const { index = new Map(), provider = null } = options;
  const list = Array.isArray(models) ? models : [];

  let filled = 0;
  let missingProvider = 0;
  let notInCatalog = 0;

  const enriched = list.map((model) => {
    if (!model || typeof model !== "object" || typeof model.id !== "string" || !model.id) {
      return model;
    }

    const key = lookupKey(model, provider);
    if (!key) {
      missingProvider++;
      return model;
    }

    const entry = index.get(key);
    if (!entry) {
      notInCatalog++;
      return model;
    }

    // Spread first so every field the primary source set is already in place;
    // below only ever writes keys that are still undefined.
    const out = { ...model };
    let touched = false;

    if (out.efforts === undefined && entry.efforts) {
      out.efforts = [...entry.efforts];
      touched = true;
    }
    if (out.context === undefined && entry.context !== undefined) {
      out.context = entry.context;
      touched = true;
    }
    if (out.toolCall === undefined && entry.toolCall !== undefined) {
      out.toolCall = entry.toolCall;
      touched = true;
    }
    if (out.deprecated === undefined && entry.deprecated !== undefined) {
      out.deprecated = entry.deprecated;
      touched = true;
    }

    if (!touched) return model;
    filled++;
    return out;
  });

  const notices = [];
  if (missingProvider > 0) {
    notices.push({
      code: "enrich_no_provider",
      message:
        `${missingProvider} of ${list.length} models had no provider, so they were left ` +
        `unenriched rather than matched by guesswork: the same model id carries different ` +
        `effort sets under different providers`,
    });
  }
  if (notInCatalog > 0) {
    notices.push({
      code: "enrich_not_in_catalog",
      message: `${notInCatalog} of ${list.length} models were not found in the catalog`,
    });
  }

  return { models: enriched, filled, notices };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Where the cached catalog lives: the app's own dir, never a session's. */
export function catalogCachePath(home = os.homedir()) {
  return path.join(home, ".dualog", "cache", "models-dev.json");
}

/**
 * Load the catalog, from disk when fresh and from the network otherwise.
 * NEVER THROWS.
 *
 * Returns `{ index, source, fetchedAt, stale, notices }`. On total failure the
 * index is empty and a notice explains why -- enrichment simply does not happen
 * that turn, which is a strictly smaller loss than the alternative.
 *
 * A STALE CATALOG BEATS NO CATALOG, and this is deliberately the OPPOSITE call
 * from the Grok cache in discovery.mjs. Do not unify the two on the grounds
 * that they are "both caches" -- they cache different KINDS of fact:
 *
 *   Grok's models_cache.json  a live ACCOUNT catalog. It changes under you when
 *                             the backend or your access changes, so a stale
 *                             copy can be confidently wrong about what exists.
 *                             300s TTL, and staleness disqualifies it from
 *                             being grounds to reject a model.
 *
 *   models.dev                MODEL facts -- which efforts a model accepts.
 *                             These barely move, so a 25-hour-old copy is still
 *                             overwhelmingly right, and it only ever annotates
 *                             ids some other source already vouched for.
 *
 * So: expired Grok cache -> stop trusting it. Expired catalog -> keep using it
 * and say so, because the alternative is dropping annotations entirely because
 * a laptop is offline.
 */
export async function loadCatalog(options = {}) {
  const {
    url = CATALOG_URL,
    ttlMs = CATALOG_TTL_MS,
    now = Date.now(),
    refresh = false,
    timeoutMs = CATALOG_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    cache = fileCache(catalogCachePath()),
  } = options;

  const notices = [];

  let cached = null;
  try {
    cached = cache.read();
  } catch {
    // An unreadable cache is a cache miss, not a failure.
    cached = null;
  }

  const ageMs = cached?.fetchedAt ? now - Date.parse(cached.fetchedAt) : null;
  const fresh =
    cached && ageMs !== null && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlMs;

  if (fresh && !refresh) {
    const parsed = parseCatalog(cached.data);
    return {
      index: parsed.index,
      source: cache.describe?.() ?? "cache",
      fetchedAt: cached.fetchedAt,
      stale: false,
      notices,
    };
  }

  const fetched = await fetchCatalog(url, { timeoutMs, fetchImpl });

  if (fetched.data) {
    // Parse and check the shape BEFORE caching. "Valid JSON" is not the same as
    // "the catalog": a captive portal, an auth error body, or a proxy returning
    // {} all parse cleanly and index to nothing. Writing one would evict the
    // last known-good copy and then serve an empty catalog as fresh and
    // authoritative for the whole TTL -- worse than the network error it stands
    // in for, because nothing about it looks like a failure.
    const parsed = parseCatalog(fetched.data);

    if (parsed.models > 0) {
      const fetchedAt = new Date(now).toISOString();
      try {
        cache.write(fetched.data, fetchedAt);
      } catch {
        // A read-only or full disk costs us the cache, not the answer.
        notices.push({
          code: "catalog_cache_unwritable",
          message: "the catalog was fetched but could not be cached; it will be refetched",
        });
      }
      return { index: parsed.index, source: url, fetchedAt, stale: false, notices };
    }

    notices.push({
      code: "catalog_unusable",
      message:
        `${url} returned JSON with no providers or models; ` +
        `keeping the previously cached catalog rather than replacing it`,
    });
  } else {
    notices.push({ code: fetched.error.code, message: fetched.error.message });
  }

  // Fall back to whatever is on disk, however old.
  if (cached?.data) {
    const parsed = parseCatalog(cached.data);
    notices.push({
      code: "catalog_stale",
      message:
        `serving a catalog cached at ${cached.fetchedAt ?? "an unknown time"}; ` +
        `effort data barely changes, so it is still worth using`,
    });
    return {
      index: parsed.index,
      source: cache.describe?.() ?? "cache",
      fetchedAt: cached.fetchedAt ?? null,
      stale: true,
      notices,
    };
  }

  return { index: new Map(), source: null, fetchedAt: null, stale: true, notices };
}

/** Fetch and parse the catalog body. Never throws; classifies every failure. */
async function fetchCatalog(url, { timeoutMs, fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    return { data: null, error: { code: "catalog_unreachable", message: "no fetch implementation available" } };
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
  } catch (err) {
    const name = err?.name ?? "";
    const detail =
      name === "TimeoutError" || name === "AbortError"
        ? `did not answer within ${timeoutMs}ms`
        : (err?.cause?.code ?? err?.cause?.message ?? err?.message ?? "unreachable");
    return {
      data: null,
      error: { code: "catalog_unreachable", message: `${url} ${detail}` },
    };
  }

  if (!response.ok) {
    return {
      data: null,
      error: { code: "catalog_bad_status", message: `${url} returned HTTP ${response.status}` },
    };
  }

  // Before parsing, not after: a captive portal or proxy answers 200 with HTML,
  // and JSON.parse would blame the syntax instead of the network.
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType && !/\bjson\b/i.test(contentType)) {
    return {
      data: null,
      error: {
        code: "catalog_not_json",
        message: `${url} answered with content-type "${contentType.split(";")[0]}", not JSON`,
      },
    };
  }

  const read = await readCappedText(response);
  if (read.tooLarge) {
    return {
      data: null,
      error: {
        code: "catalog_too_large",
        message: `${url} returned more than ${MAX_BODY_BYTES} bytes; refusing to parse it`,
      },
    };
  }

  try {
    return { data: JSON.parse(read.text), error: null };
  } catch {
    return {
      data: null,
      error: { code: "catalog_unparseable", message: `${url} did not return valid JSON` },
    };
  }
}

async function readCappedText(response, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true, text: "" };

  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await response.text();
    return text.length > maxBytes ? { tooLarge: true, text: "" } : { tooLarge: false, text };
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength ?? value.length ?? 0;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true, text: "" };
    }
    chunks.push(Buffer.from(value));
  }
  return { tooLarge: false, text: Buffer.concat(chunks).toString("utf-8") };
}

/**
 * A disk cache holding our own envelope rather than the raw body.
 *
 * The envelope carries the fetch time, so freshness never depends on file
 * mtime -- which a backup restore, a `git checkout` or a container image build
 * would silently reset.
 */
export function fileCache(cachePath) {
  return {
    describe: () => cachePath,

    read() {
      const raw = fs.readFileSync(cachePath, "utf-8");
      const envelope = JSON.parse(raw);
      if (!envelope || typeof envelope !== "object" || !envelope.data) return null;
      return { data: envelope.data, fetchedAt: envelope.fetchedAt ?? null };
    },

    write(data, fetchedAt) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      // Write-then-rename: a process killed mid-write must not leave a
      // half-written catalog that reads as corrupt on every later run.
      const temporary = `${cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ url: CATALOG_URL, fetchedAt, data }));
      fs.renameSync(temporary, cachePath);
    },
  };
}

/** An in-memory cache double, for tests and for callers that must not touch disk. */
export function memoryCache(initial = null) {
  let stored = initial;
  return {
    describe: () => "memory",
    read: () => stored,
    write: (data, fetchedAt) => {
      stored = { data, fetchedAt };
    },
  };
}
