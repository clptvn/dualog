// Runtime model discovery.
//
// Three tiers exist and must not be conflated: what a CLI could EVER route to
// (a public catalog), what YOU can select (the CLI's own account-scoped cache),
// and what is physically installed (a local inference server). Only the middle
// tier answers "what can I use", so every parser here targets a source the CLI
// itself maintains -- never a third-party catalog standing in for one.
//
// Everything below is a pure function over bytes we already have, except
// `fetchOpenAIModels` and `resolveDiscovery`. That split is deliberate: the
// parsers are the part that encodes hard-won knowledge about real output, so
// they are the part that has to be unit-testable against committed fixtures
// with no network and no CLI installed. The two impure functions take their I/O
// as injectable options for the same reason.
//
// Governing rule for the whole module: DISCOVERY FAILURE IS NEVER FATAL. A
// caller that cannot discover falls back to the adapter's static model list
// with a notice. Nothing here throws on bad input, and "unreachable" is always
// reported distinctly from "reachable but empty" -- those two mean opposite
// things (a wrong URL vs. a server with no models pulled) and collapsing them
// sends the user to debug the wrong end.

import fs from "node:fs";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import crossSpawn from "cross-spawn";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import { modelEntries } from "./schema.mjs";
import { loadCatalog, enrich } from "./catalog.mjs";
import { findBinary } from "./negotiate.mjs";
import {
  resolveWslLoginShell,
  resolveWslPartnerExecutable,
  resolveWslRouteDistro,
  tmuxRoute,
} from "../tmux-runtime.mjs";
import {
  DEFAULT_WSL_LOGIN_SHELL,
  wslLoginShellArgs,
} from "../wsl-shell.mjs";
import {
  spawnWithTrustedWindowsComSpec,
  terminateWindowsProcessTree,
} from "../windows-process-tree.mjs";
// Imported rather than restated: the recursion sentinel is a safety mechanism,
// and a second copy of it here is a second copy that can drift out of step with
// the one every partner spawn uses.
import { partnerSentinelEnv } from "./env.mjs";

const DEFAULT_EXECFILE_MAX_BUFFER = 1024 * 1024;

/**
 * Stop one probe without ever routing an untrusted pid through a shell.
 * Exported so the native-Windows contract can be tested on every CI host.
 */
export function terminateDiscoveryProcess(
  child,
  {
    platform = process.platform,
    signal = "SIGTERM",
    terminateWindowsTreeFn = terminateWindowsProcessTree,
  } = {}
) {
  if (platform === "win32") {
    return terminateWindowsTreeFn(child?.pid);
  }
  try {
    child?.kill(signal);
    return { status: "succeeded", attempted: true, reason: null };
  } catch (err) {
    return {
      status: "failed",
      attempted: true,
      reason: err?.message ?? "could not signal probe process",
    };
  }
}

/** Callback-compatible, maxBuffer-bounded execFile adapter for `.cmd`. */
export function execFileViaCrossSpawn(
  command,
  args,
  options,
  callback,
  {
    spawnImpl = crossSpawn,
    platform = process.platform,
    env = options?.env ?? process.env,
    terminateWindowsTreeFn = terminateWindowsProcessTree,
  } = {}
) {
  let child;
  try {
    const spawnOptions = {
      env: options?.env,
      windowsHide: options?.windowsHide,
      stdio: ["ignore", "pipe", "pipe"],
    };
    child = spawnWithTrustedWindowsComSpec(
      spawnImpl,
      command,
      args,
      spawnOptions,
      { platform, env }
    );
  } catch (err) {
    queueMicrotask(() => callback(err, "", ""));
    return null;
  }

  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let timer = null;
  const encoding =
    typeof options?.encoding === "string" && Buffer.isEncoding(options.encoding)
      ? options.encoding
      : "utf-8";
  const outputText = (chunks) => Buffer.concat(chunks).toString(encoding);
  const finish = (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(err, outputText(stdoutChunks), outputText(stderrChunks));
  };
  const maxBuffer =
    options?.maxBuffer === Infinity
      ? Infinity
      : Number.isFinite(options?.maxBuffer)
        ? Math.max(0, options.maxBuffer)
        : DEFAULT_EXECFILE_MAX_BUFFER;
  const failAndTerminate = (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Keep the wrapper and its pipes live while taskkill walks the tree. If we
    // detach first, cmd.exe can exit and reparent the vendor CLI before /T has
    // enumerated its descendants.
    const termination = terminateDiscoveryProcess(child, {
      platform,
      signal: options?.killSignal ?? "SIGTERM",
      terminateWindowsTreeFn,
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream?.destroy(); } catch {}
    }
    try { child.unref?.(); } catch {}
    err.termination = termination;
    if (termination?.status === "failed" && termination.reason) {
      err.message += `; ${termination.reason}`;
    }
    callback(err, outputText(stdoutChunks), outputText(stderrChunks));
  };
  const capture = (streamName, chunk) => {
    if (settled) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
    const previous = streamName === "stdout" ? stdoutBytes : stderrBytes;
    const chunks = streamName === "stdout" ? stdoutChunks : stderrChunks;
    if (previous + bytes.length > maxBuffer) {
      const available = Math.max(0, maxBuffer - previous);
      if (available > 0) chunks.push(bytes.subarray(0, available));
      if (streamName === "stdout") stdoutBytes += available;
      else stderrBytes += available;
      const err = Object.assign(
        new RangeError(`${streamName} maxBuffer length exceeded`),
        {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          stream: streamName,
          killed: true,
        }
      );
      failAndTerminate(err);
      return;
    }
    if (streamName === "stdout") {
      stdoutBytes += bytes.length;
      stdoutChunks.push(bytes);
    } else {
      stderrBytes += bytes.length;
      stderrChunks.push(bytes);
    }
  };
  child.stdout.on("data", (chunk) => capture("stdout", chunk));
  child.stderr.on("data", (chunk) => capture("stderr", chunk));
  child.once("error", (err) => finish(err));
  child.once("close", (code, signal) => {
    if (code === 0) return finish(null);
    const err = Object.assign(new Error(`process exited with code ${code}`), {
      code,
      signal,
      killed: false,
    });
    finish(err);
  });
  if (Number.isFinite(options?.timeout) && options.timeout > 0) {
    timer = setTimeout(() => {
      const err = Object.assign(new Error(`process timed out after ${options.timeout}ms`), {
        killed: true,
        signal: options?.killSignal ?? "SIGTERM",
      });
      failAndTerminate(err);
    }, options.timeout);
  }
  return child;
}

export function discoveryProcessImplementations({
  platform = process.platform,
  env = process.env,
  execFileImpl = null,
  spawnImpl = null,
  crossSpawnImpl = crossSpawn,
  terminateWindowsTreeFn = terminateWindowsProcessTree,
} = {}) {
  return {
    execFileImpl:
      execFileImpl ??
      (platform === "win32"
        ? (command, args, options, callback) =>
            execFileViaCrossSpawn(command, args, options, callback, {
              spawnImpl: crossSpawnImpl,
              platform,
              env,
              terminateWindowsTreeFn,
            })
        : execFile),
    spawnImpl: spawnImpl ?? (platform === "win32" ? crossSpawnImpl : spawn),
  };
}

// ---------------------------------------------------------------------------
// Codex -- $CODEX_HOME/models_cache.json
// ---------------------------------------------------------------------------

/**
 * Parse the Codex CLI's own model cache into our discovery shape.
 *
 * `filter(visibility === "list").sort(by priority)` reproduces the `/model`
 * picker exactly -- verified against the live picker on client 0.146.0. The
 * visibility filter is not cosmetic: `codex-auto-review` is a real, selectable
 * slug marked `visibility: "hide"` because it is an internal review agent, and
 * offering it as a dialog partner would be offering something the CLI itself
 * hides from its user.
 *
 * Order matters because it is the order the human sees in the picker, so it is
 * the order any "did you mean" or listing output should reproduce.
 *
 * Malformed input yields `[]` rather than throwing -- the caller's fallback to
 * the static list is a better outcome than a crashed tool call.
 */
export function parseCodexCache(json) {
  const models = json?.models;
  if (!Array.isArray(models)) return [];

  return models
    .filter((m) => m && typeof m === "object" && m.visibility === "list")
    .slice()
    // A missing priority sorts last instead of poisoning the comparator with
    // NaN, which in V8 leaves the array in an arbitrary order.
    .sort((a, b) => numberOr(a.priority, Infinity) - numberOr(b.priority, Infinity))
    .map((m) => ({
      id: String(m.slug),
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels
            .map((level) => level?.effort)
            .filter((effort) => typeof effort === "string")
        : [],
      defaultEffort:
        typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : null,
      context: numberOr(m.context_window, null),
    }))
    .filter((m) => m.id && m.id !== "undefined");
}

// ---------------------------------------------------------------------------
// Grok -- $GROK_HOME/models_cache.json
// ---------------------------------------------------------------------------

/**
 * Upstream's own TTL for this cache. Ours must not be longer than theirs.
 *
 * Deliberately NOT the same policy as the models.dev catalog in catalog.mjs,
 * which keeps serving an expired copy. The two are not comparable just because
 * both are caches: this one holds a live ACCOUNT catalog that changes under you
 * when the backend or your access does, so an expired copy can be confidently
 * wrong about what exists -- and it is used as grounds to REJECT a model. The
 * catalog holds model facts that barely move and only ever annotates ids
 * something else already vouched for. Expired here means stop trusting it;
 * expired there means keep using it and say so.
 */
export const GROK_CACHE_TTL_MS = 300_000;

/**
 * Codex refreshes its own cache on its own schedule rather than against a short
 * upstream TTL, so ours is deliberately generous where Grok's is tight. It is
 * still bounded: this is a live ACCOUNT catalog, and it is used as grounds to
 * REJECT a model, so a copy that predates an offline stretch or a CLI upgrade
 * can be confidently wrong about what exists.
 */
export const CODEX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Grok's fallback effort menu, used when the entry says efforts are supported
 * but the server sent no menu with it. Mirrors the CLI's own fallback so we
 * offer the same set it would.
 */
const GROK_FALLBACK_EFFORTS = ["xhigh", "high", "medium", "low"];

/**
 * Parse the Grok CLI's model cache.
 *
 * Two rejection conditions the caller must be told about rather than silently
 * absorb:
 *
 *   stale          -- upstream refreshes this every 300s, far shorter than
 *                     Codex's. A cache older than that is a fast path that
 *                     missed, and the caller should fall back to `grok models`
 *                     rather than answer from it.
 *   originMismatch -- the envelope records the models-list URL it was written
 *                     against. Pointing the CLI at a different backend
 *                     (GROK_MODELS_BASE_URL) makes the existing cache describe
 *                     someone else's catalog. Reusing it would be confidently
 *                     wrong, which is worse than not answering.
 *
 * We report both instead of deciding, because the right response differs by
 * caller: a listing tool can show a stale cache with a warning, while a
 * validation path must not reject a model on the word of one.
 */
export function parseGrokCache(json, { originUrl = null, now = Date.now() } = {}) {
  const entries = grokModelEntries(json?.models);

  const models = entries.map(([id, entry]) => {
    const supports = entry?.supports_reasoning_effort !== false;
    const menu = Array.isArray(entry?.reasoning_efforts)
      ? entry.reasoning_efforts.filter((e) => typeof e === "string")
      : [];
    return {
      id,
      // `reasoning_efforts` is what the source calls the source of truth, so a
      // server that sends one overrides any canonical list we might hold. The
      // canonical set is wider than any single model accepts -- grok-4.5 takes
      // only high/medium/low -- so trusting the wide list is over-permissive.
      efforts: supports ? (menu.length ? menu : [...GROK_FALLBACK_EFFORTS]) : [],
      defaultEffort:
        supports && typeof entry?.reasoning_effort === "string" ? entry.reasoning_effort : null,
      // Field name unverified against a real cache (grok is not installed
      // here); read it if present, never invent it.
      context: numberOr(entry?.context_window, null),
    };
  });

  const fetchedAt = typeof json?.fetched_at === "string" ? json.fetched_at : null;
  const fetchedMs = fetchedAt ? Date.parse(fetchedAt) : NaN;
  const ageMs = Number.isFinite(fetchedMs) ? now - fetchedMs : null;

  return {
    models,
    fetchedAt,
    ageMs,
    // An unparseable or absent timestamp counts as stale: we cannot prove the
    // cache is fresh, and "assume fresh" is the failure that serves a catalog
    // from a backend the user switched away from an hour ago.
    stale: ageMs === null || ageMs > GROK_CACHE_TTL_MS || ageMs < 0,
    origin: typeof json?.origin === "string" ? json.origin : null,
    originMismatch: originUrl ? normalizeOrigin(json?.origin) !== normalizeOrigin(originUrl) : false,
  };
}

/**
 * The envelope declares `models` as an IndexMap, which serializes to a JSON
 * object keyed by model id. An array is tolerated only so a future format
 * change degrades to "fewer fields" instead of "zero models".
 */
function grokModelEntries(models) {
  if (Array.isArray(models)) {
    return models
      .filter((m) => m && typeof m === "object")
      .map((m) => [String(m.id ?? m.slug ?? ""), m])
      .filter(([id]) => id);
  }
  if (models && typeof models === "object") {
    return Object.entries(models).filter(([id, entry]) => id && entry && typeof entry === "object");
  }
  return [];
}

/** A trailing slash is not a different backend. Anything else is. */
function normalizeOrigin(url) {
  return typeof url === "string" ? url.trim().replace(/\/+$/, "") : null;
}

// ---------------------------------------------------------------------------
// opencode -- `opencode models`
// ---------------------------------------------------------------------------

/**
 * Parse `opencode models` stdout: one `provider/model` per line, not JSON.
 *
 * SPLIT ON THE FIRST SLASH ONLY. Model ids routinely contain slashes of their
 * own -- `lmstudio/google/gemma-3n-e4b` is a real line, and OpenRouter-style
 * ids like `meta-llama/llama-3.3-70b-instruct` are the norm. Splitting on every
 * slash yields provider "lmstudio", model "google", and a model id that does
 * not exist; splitting on the last yields provider "lmstudio/google". Only the
 * first slash is a delimiter, and every slash after it is data.
 *
 * The list is credential-filtered by opencode itself, which is exactly what
 * makes it the "available" tier rather than a catalog.
 */
export function parseOpencodeModels(stdout) {
  if (typeof stdout !== "string") return [];

  const out = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const slash = line.indexOf("/");
    // A line with no slash is not a provider/model pair -- a status or header
    // line, say. Skipping beats emitting an entry with an empty provider.
    if (slash <= 0 || slash === line.length - 1) continue;

    out.push({
      provider: line.slice(0, slash),
      id: line.slice(slash + 1),
      full: line,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible /v1/models
// ---------------------------------------------------------------------------

/**
 * Parse an OpenAI-compatible model list body.
 *
 * Returns `null` when the body is not a model list at all, and `[]` when it is
 * a well-formed list with nothing in it. Callers depend on that distinction:
 * `null` means "this endpoint is not what you think it is", `[]` means "right
 * endpoint, no models pulled yet".
 *
 * Validated structurally rather than by the `object: "list"` marker, because
 * OpenRouter omits the top-level `object` and adds `total_count`/`links`. There
 * is no compatibility handshake in this ecosystem; a JSON body with `data[].id`
 * IS the de-facto probe.
 */
export function parseOpenAIModels(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.data)) return null;
  if (body.data.length === 0) return [];
  if (typeof body.data[0]?.id !== "string") return null;

  return body.data
    .filter((entry) => entry && typeof entry.id === "string" && entry.id)
    .map((entry) => ({ id: entry.id }));
}

// ---------------------------------------------------------------------------
// Ollama -- POST /api/show
// ---------------------------------------------------------------------------

/**
 * Parse Ollama's `POST /api/show` body for the two facts we need.
 *
 * `supportsTools` is a hard precondition, not a nicety: the sidecar completion
 * protocol requires the partner to write `result.md` / `done.json`, and a model
 * without the `tools` capability cannot call a tool to do it. It will produce
 * prose and never signal completion, so the turn presents as a hang. Rejecting
 * at preflight with that reason is the whole point of reading this endpoint --
 * `/v1/models` returns names only and cannot tell us.
 *
 * The context-length key is ARCHITECTURE-PREFIXED. Read
 * `model_info["general.architecture"]` first and build the key from it; a
 * hardcoded `"qwen3.context_length"` silently returns null for every model that
 * is not qwen3, which is most of them.
 */
export function parseOllamaShow(json) {
  const capabilities = Array.isArray(json?.capabilities)
    ? json.capabilities.filter((c) => typeof c === "string")
    : [];

  const modelInfo = json?.model_info && typeof json.model_info === "object" ? json.model_info : {};
  const architecture =
    typeof modelInfo["general.architecture"] === "string"
      ? modelInfo["general.architecture"]
      : null;

  return {
    capabilities,
    supportsTools: capabilities.includes("tools"),
    supportsThinking: capabilities.includes("thinking"),
    architecture,
    contextLength: architecture ? numberOr(modelInfo[`${architecture}.context_length`], null) : null,
  };
}

// ---------------------------------------------------------------------------
// Claude Code -- the SDK control protocol over stream-json stdio
// ---------------------------------------------------------------------------

/**
 * Parse one stdout line of `claude --output-format stream-json`, looking for
 * the answer to a `list_models` control request.
 *
 * THE PAYLOAD IS NESTED TWICE: `line.response.response.models`. The outer
 * `response` is the control-protocol envelope (subtype, request_id); the inner
 * one is the request's own return value. Reading `line.response.models`
 * produces the envelope's own keys and looks, convincingly, like a model list
 * in which every field happens to be missing. Verified the hard way against a
 * real probe on a real account.
 *
 * Returns `null` for any line that is not that answer -- every other event in
 * the stream (`system`, `assistant`, and, before `--bare`, `hook_started`)
 * reaches this function too -- and `[]` for an answer that genuinely carries no
 * models. The caller depends on the difference: `null` means "keep reading",
 * `[]` means "the CLI answered and named nothing".
 *
 * Never throws: a truncated or non-JSON line is just a line that is not the
 * answer.
 */
export function parseClaudeListModels(line) {
  const message = typeof line === "string" ? parseJsonOrNull(line) : line;
  if (!message || typeof message !== "object") return null;
  if (message.type !== "control_response") return null;

  const models = message.response?.response?.models;
  if (!Array.isArray(models)) return null;

  return models
    .filter((row) => row && typeof row === "object" && typeof row.value === "string" && row.value)
    .map((row) => ({
      // `value` is what --model takes, so `value` is the id -- even when it is
      // an alias like "default", "opus[1m]" or "sonnet" that appears in no
      // static manifest. Closing exactly that gap is why this strategy exists,
      // so an alias must survive as an id rather than being normalized away.
      id: row.value,
      // The concrete id the alias points at, kept BESIDE the id and never in
      // place of it: two aliases can resolve to one model, and collapsing them
      // would drop selectable names on the floor.
      ...(typeof row.resolvedModel === "string" && row.resolvedModel
        ? { resolvedModel: row.resolvedModel }
        : {}),
      ...claudeRowEfforts(row),
    }));
}

/**
 * Efforts for one row: the menu, or `[]` for a model that takes no effort.
 *
 * KEY OFF THE LEVELS, NOT OFF `supportsEffort`. In real output the boolean is
 * advisory and unreliable in one direction: every effort-capable row sets it to
 * `true`, but the haiku row does not set it to `false` -- it OMITS both the
 * boolean and the levels array. Gating on `supportsEffort === false` therefore
 * never fires, and haiku would come back with its efforts merely unstated.
 *
 * `[]` here is a fact, not a gap. A row with no levels is the CLI saying this
 * model takes no `--effort` at all -- the same thing the static manifest says
 * about haiku -- so there is no third "unknown" case for this source to report.
 */
function claudeRowEfforts(row) {
  const levels = Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels : [];
  return { efforts: levels.filter((level) => typeof level === "string") };
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/**
 * Candidate model-list URLs for a base URL, most likely first.
 *
 * NEVER blindly append `/v1`. Users configure base URLs both ways -- with and
 * without the version segment -- and Ollama returns a 404 "page not found" on
 * `/v1/v1/models` (verified). Appending unconditionally therefore turns a
 * correctly configured endpoint into a hard discovery failure.
 *
 * Returning candidates rather than one URL keeps the retry policy in the
 * caller, where the 404-means-try-the-other-shape rule lives.
 */
/**
 * The `/api/show` endpoint that sits alongside an Ollama OpenAI-compatible
 * base URL. Ollama serves the OpenAI surface under `/v1` and its native API at
 * the root, so the `/v1` suffix has to come off.
 */
export function buildOllamaShowUrl(baseUrl) {
  if (typeof baseUrl !== "string") return null;
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return null;
  const root = base.replace(/\/(v1|api\/v1)$/, "").replace(/\/models$/, "").replace(/\/v1$/, "");
  return `${root}/api/show`;
}

/**
 * Ask Ollama what one model can do. NEVER THROWS; returns null on any failure,
 * which the caller reads as "capability unknown" rather than as "no tools".
 */
export async function fetchOllamaShow(baseUrl, modelId, options = {}) {
  const {
    timeoutMs = isLocalBaseUrl(baseUrl) ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options;

  const url = buildOllamaShowUrl(baseUrl);
  if (!url || typeof fetchImpl !== "function") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: controller.signal,
    });
    if (!response?.ok) return null;

    // Capped exactly like the /v1/models reader, and for a sharper reason here:
    // these probes run concurrently, so an unbounded response.json() multiplies
    // by the number of models in flight. /api/show also carries the model's
    // license, modelfile, and tensor metadata, which is megabytes on real
    // models -- the fixtures in this repo are trimmed precisely because the raw
    // bodies are huge.
    const read = await readCappedText(response);
    if (read.tooLarge) return null;

    try {
      return JSON.parse(read.text);
    } catch {
      return null;
    }
  } catch {
    // Not Ollama, not reachable, or not JSON. All mean "unknown".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function buildModelsUrl(baseUrl) {
  if (typeof baseUrl !== "string") return [];
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return [];

  // Someone who pasted the full list URL has already told us the answer.
  if (/\/models$/.test(base)) return [base];
  if (/\/(v1|api\/v1)$/.test(base)) return [`${base}/models`];
  return [`${base}/v1/models`, `${base}/models`];
}

/**
 * Is this base URL on this machine or this LAN?
 *
 * Only used to pick a timeout. A local inference server that has not answered
 * in 3s is not going to; a remote one legitimately takes longer, and cutting it
 * off at 3s would report a working endpoint as unreachable.
 */
export function isLocalBaseUrl(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTTP discovery
// ---------------------------------------------------------------------------

/** Timeouts verified as adequate against local Ollama and remote OpenRouter. */
export const LOCAL_TIMEOUT_MS = 3000;
export const REMOTE_TIMEOUT_MS = 8000;

/** A model list is tens of KB. Anything past this is not one. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Enough of a wrong-endpoint body to identify it in a message, no more. */
const SNIPPET_CHARS = 120;

/**
 * Fetch and parse an OpenAI-compatible model list. NEVER THROWS.
 *
 * Returns `{ models, source, error }`:
 *   models -- the model list, `[]` for a reachable endpoint with none, or
 *             `null` when we never got a usable list.
 *   source -- the URL that actually answered, or null.
 *   error  -- null on success, else `{ code, message }` with one of:
 *
 *     unreachable            connection refused / DNS failure / timeout. The
 *                            message names the base URL, because the base URL
 *                            is nearly always what is wrong.
 *     no_models              200 with an empty `data[]`. NOT the same failure:
 *                            the server is fine and has nothing pulled.
 *     needs_key              401/403.
 *     not_found              404 on every candidate URL shape.
 *     not_openai_compatible  answered, but not with a model list -- Ollama's
 *                            root returns text/plain "Ollama is running", and a
 *                            proxy or SSO wall returns an HTML login page. Both
 *                            are 200s, so status alone cannot catch them; the
 *                            content-type check has to happen BEFORE parsing or
 *                            the user gets a JSON syntax error pointing at
 *                            "Ollama" instead of at their URL.
 *     body_too_large         over the 2MB cap.
 *     bad_status             any other HTTP status.
 *     invalid_base_url       nothing usable to build a URL from.
 */
export async function fetchOpenAIModels(baseUrl, options = {}) {
  const {
    apiKey = null,
    timeoutMs = isLocalBaseUrl(baseUrl) ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = options;

  const candidates = buildModelsUrl(baseUrl);
  if (candidates.length === 0) {
    return {
      models: null,
      source: null,
      error: {
        code: "invalid_base_url",
        message: `"${baseUrl}" is not a usable base URL for model discovery`,
      },
    };
  }
  if (typeof fetchImpl !== "function") {
    return {
      models: null,
      source: null,
      error: { code: "unreachable", message: "no fetch implementation available" },
    };
  }

  // One retry, total, and only for a transient network failure. Discovery runs
  // on the path to spawning a partner; a retry storm here is felt as the tool
  // call hanging.
  let transientRetries = 1;
  let lastError = null;

  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    const attempt = await attemptModelFetch(url, { apiKey, timeoutMs, fetchImpl, baseUrl });

    if (attempt.models) {
      return {
        models: attempt.models,
        source: url,
        error: attempt.models.length
          ? null
          : {
              code: "no_models",
              message:
                `${url} is reachable but reports zero models. ` +
                `The server is running; nothing is loaded on it.`,
            },
      };
    }

    lastError = attempt.error;

    if (attempt.error.code === "unreachable" && transientRetries > 0) {
      transientRetries--;
      i--; // same URL, one more time
      continue;
    }
    // A 404 means this URL shape is wrong, not that the server is. The other
    // shape is the whole reason we build candidates.
    if (attempt.error.code === "not_found") continue;

    // 401, a login page, a 2MB body: trying the other shape cannot help.
    break;
  }

  return { models: null, source: null, error: lastError };
}

async function attemptModelFetch(url, { apiKey, timeoutMs, fetchImpl, baseUrl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        // Local servers ignore this; LiteLLM gates on it. Sending it always is
        // cheaper than knowing which is which.
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
  } catch (err) {
    return { models: null, error: classifyNetworkError(err, baseUrl, timeoutMs) };
  }

  const status = response.status;
  if (status === 401 || status === 403) {
    return {
      models: null,
      error: {
        code: "needs_key",
        message: `${url} returned ${status}: this endpoint needs an API key`,
      },
    };
  }
  if (status === 404) {
    return { models: null, error: { code: "not_found", message: `${url} returned 404` } };
  }
  if (!response.ok) {
    return {
      models: null,
      error: { code: "bad_status", message: `${url} returned HTTP ${status}` },
    };
  }

  // BEFORE parsing, not after. See the doc comment on fetchOpenAIModels.
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType && !/\bjson\b/i.test(contentType)) {
    const snippet = await readSnippet(response);
    return {
      models: null,
      error: {
        code: "not_openai_compatible",
        message:
          `${url} answered with content-type "${contentType.split(";")[0]}", not JSON` +
          (snippet ? ` -- starts with: ${JSON.stringify(snippet)}` : "") +
          `. This is not an OpenAI-compatible model list.`,
      },
    };
  }

  const read = await readCappedText(response);
  if (read.tooLarge) {
    return {
      models: null,
      error: {
        code: "body_too_large",
        message: `${url} returned more than ${MAX_BODY_BYTES} bytes; refusing to parse it`,
      },
    };
  }

  let body;
  try {
    body = JSON.parse(read.text);
  } catch {
    return {
      models: null,
      error: {
        code: "not_openai_compatible",
        message:
          `${url} did not return JSON` +
          (read.text ? ` -- starts with: ${JSON.stringify(read.text.slice(0, SNIPPET_CHARS))}` : ""),
      },
    };
  }

  const models = parseOpenAIModels(body);
  if (models === null) {
    return {
      models: null,
      error: {
        code: "not_openai_compatible",
        message: `${url} returned JSON with no "data[].id" array; this is not a model list`,
      },
    };
  }
  return { models, error: null };
}

function classifyNetworkError(err, baseUrl, timeoutMs) {
  const name = err?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") {
    return {
      code: "unreachable",
      message: `${baseUrl} did not answer within ${timeoutMs}ms`,
    };
  }

  // Node's fetch reports every transport failure as a bare TypeError "fetch
  // failed" and hides the useful part on `cause`. A refused connection arrives
  // as an AggregateError (one entry per resolved address) that still carries
  // `code`; a DNS failure carries it directly. Some causes -- an unsafe port,
  // say -- carry no code at all and only a message, which is still far more
  // actionable than "fetch failed".
  const cause = err?.cause;
  const code = cause?.code ?? err?.code ?? cause?.errors?.[0]?.code ?? "";
  const detail = code || cause?.message || err?.message || "";

  return {
    code: "unreachable",
    message: `${baseUrl} is unreachable` + (detail ? ` (${detail})` : ""),
  };
}

/** First few characters of a body, for identifying a wrong endpoint. */
async function readSnippet(response) {
  try {
    const read = await readCappedText(response);
    return read.text.slice(0, SNIPPET_CHARS).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * Read a response body with a hard byte cap.
 *
 * Streamed rather than `.text()` so that a misconfigured URL pointed at
 * something enormous is cut off at the cap instead of buffered in full first.
 */
async function readCappedText(response, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true, text: "" };

  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    // Test doubles and older shims hand back a plain object with .text().
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

// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------

/**
 * Per-source TTLs, in ms, keyed by strategy.
 *
 * These are not one number because the sources do not decay alike:
 *
 *   local-cache  0 by default. Reading Codex's cache is a ~1ms file read that
 *                the CLI itself keeps current, so a cache in front of it buys
 *                nothing and can only serve a model list the user just changed.
 *   cli-command  60s. Spawning a process is the expensive one -- `grok models`
 *                boots a full agent shell to answer.
 *   sdk-control  60s. Same tier and for the same reason: it boots the whole
 *                Claude Code CLI to answer one control request.
 *   http-openai  60s. Cheap but not free, and a model pulled 30s ago showing up
 *                a minute late is an acceptable trade for not probing on every
 *                turn.
 *   catalog      24h. models.dev is a published dataset; it does not change
 *                within a session.
 */
const TTL_BY_STRATEGY = {
  "local-cache": 0,
  "cli-command": 60_000,
  "sdk-control": 60_000,
  "http-openai": 60_000,
  catalog: 24 * 60 * 60 * 1000,
  static: 0,
};

/**
 * Per-adapter overrides.
 *
 * Grok is the one local cache worth caching, and only because we must not
 * outlive upstream's own 300s TTL -- caching it for longer would re-serve a
 * cache the CLI has already decided is expired.
 */
const TTL_OVERRIDES = {
  "local-cache:grok": GROK_CACHE_TTL_MS,
};

/** TTL for one (strategy, adapterId) pair. 0 means "do not cache". */
export function discoveryTtlMs(strategy, adapterId) {
  const override = TTL_OVERRIDES[`${strategy}:${adapterId}`];
  if (override !== undefined) return override;
  return TTL_BY_STRATEGY[strategy] ?? 0;
}

/**
 * A discovery cache keyed by (strategy, adapterId).
 *
 * Built by a factory rather than exposed as module state so tests can hold
 * their own instance with an injected clock. The module-level `discoveryCache`
 * is the one real callers share.
 */
export function createDiscoveryCache({ now = () => Date.now() } = {}) {
  const store = new Map();
  const keyOf = (strategy, adapterId) => `${strategy}:${adapterId}`;

  return {
    /** Cached value, or undefined on miss/expiry. Expired entries are dropped. */
    get(strategy, adapterId) {
      const key = keyOf(strategy, adapterId);
      const hit = store.get(key);
      if (!hit) return undefined;
      if (now() >= hit.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },

    /**
     * Store a value under this source's TTL. A zero TTL stores nothing at all
     * rather than storing something already expired, so a no-cache source can
     * never leak memory.
     */
    set(strategy, adapterId, value, { ttlMs = discoveryTtlMs(strategy, adapterId) } = {}) {
      if (!(ttlMs > 0)) return value;
      store.set(keyOf(strategy, adapterId), { value, expiresAt: now() + ttlMs });
      return value;
    },

    delete(strategy, adapterId) {
      return store.delete(keyOf(strategy, adapterId));
    },

    clear() {
      store.clear();
    },

    get size() {
      return store.size;
    },
  };
}

/** The shared cache. `refresh: true` on a discovery call should bypass it. */
export const discoveryCache = createDiscoveryCache();

// ---------------------------------------------------------------------------
// Resolution -- the single entry point
// ---------------------------------------------------------------------------

/**
 * Where process-backed discovery must run to describe the selected partner.
 *
 * Native Windows is the one split-host case: this Node server runs on Windows,
 * while the default interactive Claude/Codex partner runs in WSL with tmux.
 * Reading the Windows Codex cache or spawning a Windows `claude` there reports
 * on a different installation -- commonly no installation at all. Mirror the
 * same engine preference order used by resolveEngine(), then use tmuxRoute() to
 * select WSL only for an interactive partner. Every other platform and every
 * headless partner retain the existing local I/O path.
 */
function discoveryRuntimeRoute(
  adapter,
  { env, platform, engine, strategy, tmuxRouteFn }
) {
  // Static/catalog/http discovery does not execute or inspect a partner-local
  // process. Avoid even resolving WSL for those paths.
  if (!["local-cache", "cli-command", "sdk-control"].includes(strategy)) {
    return { transport: "local" };
  }
  if (platform !== "win32") return { transport: "local" };

  const preferred = env?.DUALOG_STRATEGY;
  const selectedEngine =
    engine ??
    (preferred && adapter?.engines?.allowed?.includes(preferred)
      ? preferred
      : adapter?.engines?.default);
  if (selectedEngine !== "tmux-interactive") return { transport: "local" };

  return tmuxRouteFn({ env, platform });
}

/** Keep process-backed catalogs scoped to the exact command and namespace. */
function discoveryCacheAdapterId(adapterId, route, partnerCommand = null) {
  const namespace =
    route?.transport === "wsl"
      ? `${adapterId}@wsl:${route.distro || "default"}`
      : adapterId;
  if (!partnerCommand) return namespace;
  const encoded = Buffer.from(partnerCommand, "utf-8").toString("base64url");
  return `${namespace}@command:${encoded}`;
}

/**
 * Discover the models one adapter can currently reach.
 *
 * NEVER THROWS and never rejects. Every failure degrades to the adapter's
 * static list carrying a notice that names what was tried and why it did not
 * answer, because a partner that could have been spawned must not be blocked by
 * a listing that failed.
 *
 * Returns `{ models, source, strategy, fetchedAt, stale, notices }`, where
 * `strategy` is what actually answered -- "static" whenever we fell back, so a
 * caller never has to infer it from an empty notice list.
 *
 * The distinction the plan insists on is preserved end to end: a source that
 * could not be reached falls back to the static list, while a source that
 * answered with nothing returns `models: []`. Those mean opposite things. The
 * first is "ask someone else", the second is "the server is fine and has
 * nothing on it", and collapsing them sends the user to debug the wrong end.
 *
 * All I/O is injectable (`readFile`, `runCommand`, `fetchModels`, `now`) so the
 * dispatch logic is testable against fixtures with no CLI installed.
 */
export async function resolveDiscovery(adapter, options = {}) {
  const {
    env = process.env,
    home = os.homedir(),
    platform = process.platform,
    engine = null,
    partnerCommand = null,
    projectPath = process.cwd(),
    now = Date.now(),
    refresh = false,
    cache = discoveryCache,
    readFile = defaultReadFile,
    readWslFile = defaultReadWslFile,
    runCommand = defaultRunCommand,
    runControl = defaultRunControlRequest,
    fetchModels = fetchOpenAIModels,
    fetchShow = fetchOllamaShow,
    tmuxRouteFn = tmuxRoute,
    resolveWslRouteDistroFn = resolveWslRouteDistro,
    resolveWslLoginShellFn = resolveWslLoginShell,
    resolveWslPartnerExecutableFn = resolveWslPartnerExecutable,
    execFileImpl = null,
    spawnImpl = null,
    terminateWindowsTreeFn = terminateWindowsProcessTree,
    findBinaryFn = findBinary,
  } = options;

  const config = adapter?.discovery ?? null;
  const strategy = config?.strategy ?? "static";
  let processPartnerCommand = ["cli-command", "sdk-control"].includes(strategy)
    ? partnerCommand
    : null;
  const processImplementations = discoveryProcessImplementations({
    platform,
    env,
    execFileImpl,
    spawnImpl,
    terminateWindowsTreeFn,
  });

  // `none` is the only setting that guarantees no I/O whatsoever, enrichment
  // included. Everything else may still annotate from the catalog below.
  if (strategy === "none") return staticResult(adapter);

  let route;
  try {
    route = discoveryRuntimeRoute(adapter, {
      env,
      platform,
      engine,
      strategy,
      tmuxRouteFn,
    });
  } catch (err) {
    let result = staticResult(adapter, [
      notice(
        "discovery_failed",
        `discovery route for "${adapter.id}" could not be resolved: ${err?.message ?? err}`
      ),
    ]);
    result = await applyCatalogEnrichment(result, adapter, config, {
      now,
      refresh,
      options,
    });
    return result;
  }

  if (route?.transport === "wsl") {
    try {
      // Standalone status/discovery calls may not arrive with the runtime
      // context's already-pinned route. Resolve the default exactly once
      // before selecting a shell or touching partner-owned caches so those
      // operations cannot straddle a default-distro change.
      route = await resolveWslRouteDistroFn(route);
    } catch (err) {
      let result = staticResult(adapter, [
        notice(
          "discovery_failed",
          `WSL distribution for "${adapter.id}" could not be resolved: ${err?.message ?? err}`
        ),
      ]);
      result = await applyCatalogEnrichment(result, adapter, config, {
        now,
        refresh,
        options,
      });
      return result;
    }
    let loginShell = DEFAULT_WSL_LOGIN_SHELL;
    try {
      loginShell = await resolveWslLoginShellFn(route);
    } catch {}
    route = {
      ...route,
      loginShell,
    };
  }

  if (["cli-command", "sdk-control"].includes(strategy)) {
    const requestedCommand =
      processPartnerCommand ?? config.command ?? adapter.binary.default;
    if (route?.transport === "wsl") {
      try {
        processPartnerCommand = await resolveWslPartnerExecutableFn(requestedCommand, {
          projectPath: projectPath || process.cwd(),
          route,
          resolveWslLoginShellFn,
        });
      } catch (err) {
        let result = staticResult(adapter, [
          notice(
            "command_failed",
            `discovery command ${JSON.stringify(requestedCommand)} was not trusted in WSL: ${err?.message ?? err}`
          ),
        ]);
        result = await applyCatalogEnrichment(result, adapter, config, {
          now,
          refresh,
          options,
        });
        return result;
      }
      if (!processPartnerCommand) {
        let result = staticResult(adapter, [
          notice(
            "command_failed",
            `discovery command ${JSON.stringify(requestedCommand)} was not found in the selected WSL distribution`
          ),
        ]);
        result = await applyCatalogEnrichment(result, adapter, config, {
          now,
          refresh,
          options,
        });
        return result;
      }
    } else {
      const usingInjectedProcessIo =
        strategy === "cli-command"
          ? runCommand !== defaultRunCommand || execFileImpl !== null
          : runControl !== defaultRunControlRequest || spawnImpl !== null;
      processPartnerCommand =
        usingInjectedProcessIo && partnerCommand == null
          ? requestedCommand
          : findBinaryFn(requestedCommand, env, {
              platform,
              excludedRoots: [projectPath || process.cwd()],
            });
      if (!processPartnerCommand) {
        let result = staticResult(adapter, [
          notice(
            "command_failed",
            `discovery command ${JSON.stringify(requestedCommand)} was not found on an absolute PATH entry`
          ),
        ]);
        result = await applyCatalogEnrichment(result, adapter, config, {
          now,
          refresh,
          options,
        });
        return result;
      }
    }
  }

  const cacheAdapterId = discoveryCacheAdapterId(
    adapter.id,
    route,
    processPartnerCommand
  );
  if (!refresh) {
    const hit = cache.get(strategy, cacheAdapterId);
    if (hit) return hit;
  }

  let result;
  try {
    const context = {
      env,
      home,
      now,
      route,
      readFile,
      readWslFile,
      runCommand,
      runControl,
      fetchModels,
      fetchShow,
      execFileImpl: processImplementations.execFileImpl,
      spawnImpl: processImplementations.spawnImpl,
      platform,
      terminateWindowsTreeFn,
      partnerCommand: processPartnerCommand,
    };
    if (strategy === "local-cache") result = await resolveLocalCache(adapter, config, context);
    else if (strategy === "cli-command") result = await resolveCliCommand(adapter, config, context);
    else if (strategy === "sdk-control") result = await resolveSdkControl(adapter, config, context);
    else if (strategy === "http-openai") result = await resolveHttpOpenAI(adapter, config, context);
    // `static` and `catalog` both take their IDS from the manifest. The only
    // difference is that `catalog` says out loud that the metadata is expected
    // to come from enrichment.
    else if (strategy === "static" || strategy === "catalog") result = staticResult(adapter);
    else result = staticResult(adapter, [notice("unknown_strategy", `discovery strategy "${strategy}" has no resolver`)]);
  } catch (err) {
    // The strategies above are written not to throw. This is the backstop for
    // the one that someday will: an unhandled discovery error must not take
    // down the tool call that merely wanted to list models.
    result = staticResult(adapter, [
      notice("discovery_failed", `discovery for "${adapter.id}" threw: ${err?.message ?? err}`),
    ]);
  }

  result = await applyCatalogEnrichment(result, adapter, config, { now, refresh, options });

  // Never cache a fallback or a cache we already know is stale -- both would
  // pin a bad answer in place for the whole TTL, and the fallback is free to
  // recompute anyway.
  if (result.strategy !== "static" && !result.stale) {
    cache.set(strategy, cacheAdapterId, result, {
      ttlMs: discoveryTtlMs(strategy, adapter.id),
    });
  }
  return result;
}

/**
 * Annotate whatever the primary source returned from models.dev.
 *
 * Runs AFTER the primary source, and only ever fills fields it left blank. The
 * ordering is the whole point: a CLI's own cache reflects what THAT CLI
 * exposes, including deltas the catalog cannot know -- Codex adds `ultra`
 * (an orchestration feature layered above the model) and withholds `none`
 * (which the API accepts but the picker does not offer). The catalog is right
 * about the model and wrong about the CLI, so it never overwrites.
 *
 * THE FETCH IS DEMAND-DRIVEN. If every model already carries efforts, there is
 * nothing to gain and the catalog is not fetched at all -- which is the normal
 * case for codex, grok and claude, whose sources are complete. It fires for
 * opencode, qwen and goose, whose sources return ids with no effort data
 * whatsoever, and which are therefore the adapters per-model effort
 * enforcement could not otherwise reach.
 *
 * Never throws, never blocks: a catalog that cannot be loaded leaves the models
 * exactly as the primary source returned them.
 */
async function applyCatalogEnrichment(result, adapter, config, { now, refresh, options }) {
  // `enrich: false` opts out entirely; `loadCatalogImpl` / `enrichImpl` are the
  // injection seams tests use to keep this pass out of the way, or to drive it
  // without a network. Kept as separate options rather than one overloaded one.
  if (options.enrich === false) return result;
  if (!Array.isArray(result.models) || result.models.length === 0) return result;

  // Demand-driven: no gaps, no fetch.
  const hasGap = result.models.some(
    (model) => model && typeof model === "object" && model.efforts === undefined
  );
  if (!hasGap) return result;

  const loadCatalogImpl = options.loadCatalogImpl ?? loadCatalog;
  const enrichImpl = options.enrichImpl ?? enrich;

  let catalog;
  try {
    catalog = await loadCatalogImpl({ now, refresh });
  } catch (err) {
    // Enrichment is an annotation. Failing to annotate is never a reason to
    // fail a turn, so this degrades to the unenriched list with a notice.
    return withNotices(result, [
      notice("catalog_unavailable", `models.dev could not be loaded: ${err?.message ?? err}`),
    ]);
  }

  const { models, filled, notices } = enrichImpl(result.models, {
    index: catalog.index,
    provider: config?.catalogProvider ?? null,
  });

  const added = [...(catalog.notices ?? [])];
  // Only report the per-model shortfalls when nothing at all came back, so a
  // partially enriched list is not drowned in notices about the rest.
  if (filled === 0) added.push(...notices);
  if (filled > 0) {
    added.push(
      notice(
        "catalog_enriched",
        `filled missing metadata for ${filled} of ${result.models.length} models from ${catalog.source ?? "models.dev"}`
      )
    );
  }

  return withNotices({ ...result, models }, added);
}

function withNotices(result, added) {
  if (!added.length) return result;
  return { ...result, notices: [...(result.notices ?? []), ...added] };
}

/** The manifest's own list, with the per-model detail schema.mjs normalizes. */
function staticResult(adapter, notices = []) {
  return {
    models: modelEntries(adapter ?? {}).map((entry) => ({
      id: entry.id,
      ...(entry.efforts ? { efforts: entry.efforts } : {}),
      ...(entry.defaultEffort ? { defaultEffort: entry.defaultEffort } : {}),
      ...(entry.context ? { context: entry.context } : {}),
    })),
    source: `manifest:${adapter?.id ?? "unknown"}`,
    strategy: "static",
    fetchedAt: null,
    stale: false,
    notices,
  };
}

function notice(code, message) {
  return { code, message };
}

// --- local-cache -----------------------------------------------------------

async function resolveLocalCache(
  adapter,
  config,
  { env, home, now, route, readFile, readWslFile, execFileImpl }
) {
  let cachePath;
  let read;

  if (route?.transport === "wsl") {
    // Resolve $HOME and adapter-specific config env inside the chosen distro.
    // The native Windows process has a different home and often has no useful
    // CODEX_HOME at all, so rendering first on the host can only target the
    // wrong installation.
    const wslRead = await readWslFile({
      adapter,
      config,
      route,
      env,
      execFileImpl,
    });
    cachePath = wslRead.path || config.path;
    read = wslRead;
  } else {
    cachePath = renderDiscoveryPath(config.path, adapter, env, home);
    read = cachePath ? readFile(cachePath) : null;
  }

  if (!cachePath) {
    return staticResult(adapter, [
      notice(
        "config_home_unresolved",
        `cannot locate the config directory for "${adapter.id}", so ${config.path} cannot be read`
      ),
    ]);
  }

  const source =
    route?.transport === "wsl"
      ? `wsl${route.distro ? `:${route.distro}` : ""}:${cachePath}`
      : cachePath;

  if (!read || read.error) {
    // Missing is the common, benign case: the CLI has never run, or runs under
    // a different home. It is still worth naming the exact path, because that
    // is the one fact that makes a wrong home obvious.
    return staticResult(adapter, [
      notice(
        "cache_unreadable",
        `${source} could not be read (${read?.error ?? "unreadable"})`
      ),
    ]);
  }

  let json;
  try {
    json = JSON.parse(read.text);
  } catch {
    return staticResult(adapter, [
      notice("cache_unparseable", `${cachePath} is not valid JSON`),
    ]);
  }

  if (config.format === "codex-cache") {
    const models = parseCodexCache(json);
    if (models.length === 0) {
      return staticResult(adapter, [
        notice("discovery_empty", `${source} contains no listable models`),
      ]);
    }

    const fetchedAt = typeof json?.fetched_at === "string" ? json.fetched_at : null;
    const fetchedMs = fetchedAt ? Date.parse(fetchedAt) : NaN;
    const ageMs = Number.isFinite(fetchedMs) ? now - fetchedMs : null;
    // Same rule as the Grok cache above, with a longer TTL because Codex
    // refreshes on its own schedule rather than against a short upstream one.
    // What it cannot be is unconditional: an absent, unparseable, or
    // future-dated timestamp proves nothing, and "assume fresh" is exactly what
    // makes list_models describe a months-old cache as current and call an
    // absent model id invalid -- the wrong answer after an offline stretch or a
    // CLI upgrade that added models.
    const stale = ageMs === null || ageMs > CODEX_CACHE_TTL_MS || ageMs < 0;

    return {
      models,
      source,
      strategy: "local-cache",
      fetchedAt,
      stale,
      notices: stale
        ? [
            notice(
              "cache_stale",
              `${source} could not be shown to be fresher than its ` +
                `${CODEX_CACHE_TTL_MS / 3_600_000}h TTL` +
                (fetchedAt ? ` (fetched_at ${fetchedAt})` : " (no usable fetched_at)") +
                `; treat this list as a hint, not as grounds to reject a model`
            ),
          ]
        : [],
    };
  }

  const originUrl = grokOriginUrl(config, env);
  const parsed = parseGrokCache(json, { originUrl, now });

  // A cache written against a different backend describes someone else's
  // catalog. The source treats that as a deliberate miss and so do we: being
  // confidently wrong about which models exist is worse than not answering.
  if (parsed.originMismatch) {
    return staticResult(adapter, [
      notice(
        "origin_mismatch",
        `${source} was written against ${parsed.origin ?? "an unrecorded origin"}, ` +
          `but models are now listed from ${originUrl}; ignoring it`
      ),
    ]);
  }

  if (parsed.models.length === 0) {
    return staticResult(adapter, [
      notice("discovery_empty", `${source} lists no models`),
    ]);
  }

  return {
    models: parsed.models,
    source,
    strategy: "local-cache",
    fetchedAt: parsed.fetchedAt,
    stale: parsed.stale,
    // Returned rather than suppressed: a listing may show a stale cache with a
    // warning, but a validation path must not reject a model on its word.
    notices: parsed.stale
      ? [
          notice(
            "cache_stale",
            `${source} is older than its ${GROK_CACHE_TTL_MS / 1000}s TTL; ` +
              `treat this list as a hint, not as grounds to reject a model`
          ),
        ]
      : [],
  };
}

/**
 * The models-list URL the Grok cache must have been written against.
 *
 * Two env vars, and they are not interchangeable: the list URL overrides only
 * the listing endpoint, while the base URL also reroutes inference and implies
 * `{base}/models`. With neither set there is nothing to compare against, and
 * `null` makes the parser skip the origin check rather than fail it.
 */
function grokOriginUrl(config, env) {
  const listUrl = config.originListUrlEnv ? env[config.originListUrlEnv] : null;
  if (listUrl) return listUrl;
  const baseUrl = config.originBaseUrlEnv ? env[config.originBaseUrlEnv] : null;
  return baseUrl ? `${String(baseUrl).replace(/\/+$/, "")}/models` : null;
}

/**
 * Resolve {{configHome}} / {{home}} in a discovery path.
 *
 * {{configHome}} deliberately resolves the way the SEED directory does, not the
 * way the isolated one does. The isolated dir is a per-session throwaway we
 * create empty and seed with credentials only, so it never holds a models
 * cache; the seed is the user's real config home, which is where the CLI has
 * actually been maintaining one. Reading the wrong one is not an error that
 * announces itself -- it is an empty directory and a permanent silent fallback.
 *
 * Returns null when a placeholder cannot be resolved, so the caller reports it
 * instead of reading a path with a hole in it.
 */
function renderDiscoveryPath(template, adapter, env, home) {
  const configHome = resolveUserConfigHome(adapter, env, home);
  let unresolved = false;

  const rendered = String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = key === "configHome" ? configHome : key === "home" ? home : null;
    if (!value) {
      unresolved = true;
      return "";
    }
    return String(value);
  });

  return unresolved ? null : rendered;
}

/**
 * The user's real config directory for this adapter.
 *
 * Mirrors the seed resolution in env.mjs -- env var first, home-relative
 * fallback second -- rather than importing it, keeping the two modules
 * independent as that file already does for its template renderer.
 */
function resolveUserConfigHome(adapter, env, home) {
  const isolation = adapter?.configIsolation;
  if (!isolation) return null;

  const fromEnv = isolation.seedFromEnv ? env[isolation.seedFromEnv] : null;
  if (fromEnv) return fromEnv;
  if (!isolation.seedFromFallback || !home) return null;
  return isolation.seedFromFallback.replace(/\{\{home\}\}/g, String(home));
}

// --- cli-command -----------------------------------------------------------

async function resolveCliCommand(
  adapter,
  config,
  { env, now, route, runCommand, execFileImpl, partnerCommand }
) {
  const command = partnerCommand ?? config.command ?? adapter.binary.default;
  const label = `${command} ${config.args.join(" ")}`;

  // Run with the USER's environment, not a partner's isolated one: this listing
  // is credential-filtered by the CLI, so it must see the real credentials to
  // report what the user can actually select.
  const run = await runCommand({
    command,
    args: config.args,
    timeoutMs: config.timeoutMs,
    env,
    route,
    execFileImpl,
  });

  if (run.error) {
    return staticResult(adapter, [
      notice("command_failed", `\`${label}\` did not answer (${run.error})`),
    ]);
  }

  const rows = parseOpencodeModels(run.stdout);
  if (rows.length === 0) {
    // Ran fine, listed nothing: no configured providers or no credentials. The
    // opposite diagnosis from a command that failed to run.
    return {
      models: [],
      source: label,
      strategy: "cli-command",
      fetchedAt: new Date(now).toISOString(),
      stale: false,
      notices: [notice("discovery_empty", `\`${label}\` ran but listed no models`)],
    };
  }

  return {
    // The id is the FULL `provider/model` string, because that is what the
    // --model flag takes. The provider is kept beside it as metadata, never as
    // a replacement for it. `catalogId` records that this id is already
    // provider-qualified, so catalog enrichment looks it up as-is instead of
    // prefixing the provider a second time.
    models: rows.map((row) => ({ id: row.full, provider: row.provider, catalogId: row.full })),
    source: label,
    strategy: "cli-command",
    fetchedAt: new Date(now).toISOString(),
    stale: false,
    notices: [],
  };
}

// --- sdk-control -----------------------------------------------------------

/**
 * Hard ceiling on one discovery spawn.
 *
 * Generous because it covers a COLD CLI boot, not a warm round trip, and the
 * cost of being wrong is asymmetric: a timeout degrades to the static list,
 * while a ceiling set below boot time degrades every single time and looks like
 * the feature does not work. We do not wait it out on success -- the answer
 * resolves the moment the line arrives.
 */
export const SDK_CONTROL_TIMEOUT_MS = 15_000;

/**
 * Ask the Claude Code CLI itself which models this account can select.
 *
 * This is the only strategy that reaches something no file or HTTP endpoint
 * knows: the CLI's ALIASES. `default`, `opus`, `sonnet` and `haiku` are valid
 * `--model` values that are in no static manifest and no published catalog, and
 * a user who types one would otherwise be told it does not exist.
 */
async function resolveSdkControl(
  adapter,
  config,
  {
    env,
    now,
    route,
    runControl,
    spawnImpl,
    platform,
    terminateWindowsTreeFn,
    partnerCommand,
  }
) {
  const command = partnerCommand ?? config.command ?? adapter.binary.default;
  const label = `${command} (list_models control request)`;

  const run = await runControl({
    command,
    args: claudeControlArgs(),
    request: { subtype: "list_models" },
    timeoutMs: config.timeoutMs ?? SDK_CONTROL_TIMEOUT_MS,
    env,
    route,
    spawnImpl,
    platform,
    terminateWindowsTreeFn,
  });

  if (run.error) {
    // Distinct codes all the way out: "not installed", "did not answer in time"
    // and "answered with nothing" send you to three different places.
    return staticResult(adapter, [notice(run.error.code, run.error.message)]);
  }

  const models = parseClaudeListModels(run.line);
  if (models === null) {
    return staticResult(adapter, [
      notice("unexpected_response", `${label} returned a control response with no models array`),
    ]);
  }

  if (models.length === 0) {
    // Unlike a local inference server with nothing pulled, a Claude CLI that
    // names zero models is reporting a failure of its own (not signed in, say),
    // not a genuinely empty catalog. The manifest list is the better answer
    // here, so this degrades -- and the notice says which of the two happened.
    return staticResult(adapter, [
      notice("discovery_empty", `${label} answered but listed no models`),
    ]);
  }

  return {
    models,
    source: label,
    strategy: "sdk-control",
    fetchedAt: new Date(now).toISOString(),
    stale: false,
    notices: [],
  };
}

/** No MCP servers at all, passed inline because discovery has no session dir. */
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

/**
 * The argv for a one-shot control request.
 *
 * Every flag past `-p` is there to stop a QUESTION from having SIDE EFFECTS:
 *
 *   --bare               skips hooks, LSP and plugin sync. Without it the probe
 *                        emits hook_started/hook_response -- i.e. discovery
 *                        RUNS THE USER'S HOOKS. Observed, not theorized.
 *   --mcp-config {} +    loads no MCP servers. Without it the CLI may boot the
 *   --strict-mcp-config  user's servers, which for this repo means booting OUR
 *                        dialog server from inside a discovery call.
 *
 * The recursion sentinel in the child env is the belt to that pair's braces: if
 * an MCP server does start anyway, it sees DUALOG_ROLE=partner and serves no
 * tools rather than recursing.
 */
function claudeControlArgs() {
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    // stream-json output is only emitted with --verbose under --print.
    "--verbose",
    "-p",
    "--bare",
    "--mcp-config",
    EMPTY_MCP_CONFIG,
    "--strict-mcp-config",
  ];
}

// --- http-openai -----------------------------------------------------------

async function resolveHttpOpenAI(adapter, config, { env, now, fetchModels, fetchShow }) {
  const baseUrl = firstEnvValue(env, config.baseUrlEnv);
  if (!baseUrl) {
    // Not a failure. Neither of these CLIs serves its built-in catalog over
    // HTTP, so with no endpoint configured there is genuinely nothing to ask,
    // and probing a guessed address would be worse than saying so.
    return staticResult(adapter, [
      notice(
        "no_base_url",
        `no base URL configured for "${adapter.id}" (checked ${config.baseUrlEnv.join(", ")}); ` +
          `nothing to query, using the static list`
      ),
    ]);
  }

  const result = await fetchModels(baseUrl, {
    apiKey: firstEnvValue(env, config.apiKeyEnv) ?? null,
  });

  if (result.models === null) {
    return staticResult(adapter, [
      notice(result.error?.code ?? "unreachable", result.error?.message ?? `${baseUrl} did not answer`),
    ]);
  }

  const notices = result.error ? [notice(result.error.code, result.error.message)] : [];

  const models =
    config.capabilityProbe === "ollama-show"
      ? await probeOllamaCapabilities(result.models, baseUrl, { fetchShow, notices })
      : result.models;

  return {
    models,
    source: result.source ?? baseUrl,
    strategy: "http-openai",
    fetchedAt: new Date(now).toISOString(),
    stale: false,
    // A reachable endpoint with an empty list keeps its own error code, so the
    // caller can say "your server has no models" instead of "your URL is wrong".
    notices,
  };
}

/**
 * Ensure the ONE model about to be used has been capability-probed.
 *
 * The listing probe is bounded (a host with a large library would otherwise turn
 * one call into dozens of requests), and a bound on a *listing* is fine. A bound
 * on a *gate* is not: selecting the 33rd model would skip the check entirely and
 * produce exactly the hanging turn the gate exists to prevent. So the selected
 * model is probed on demand, whatever its position in the list.
 *
 * Returns a discovery result with that one entry annotated, or the input
 * unchanged when there is nothing to probe or nothing to learn. Never throws.
 */
export async function ensureModelCapability(
  adapter,
  discovered,
  modelId,
  { env = process.env, fetchShow = fetchOllamaShow } = {}
) {
  const config = adapter?.discovery ?? null;
  if (config?.capabilityProbe !== "ollama-show") return discovered;
  if (!modelId || !discovered || !Array.isArray(discovered.models)) return discovered;

  const index = discovered.models.findIndex((m) => m.id === modelId);
  if (index === -1) return discovered;
  // Already answered by the listing probe.
  if (discovered.models[index].supportsTools !== undefined) return discovered;

  const baseUrl = firstEnvValue(env, config.baseUrlEnv);
  if (!baseUrl) return discovered;

  let show;
  try {
    show = await fetchShow(baseUrl, modelId);
  } catch {
    return discovered;
  }
  // Same evidence bar as the listing probe: only a real capabilities array
  // counts, because unknown must never reject.
  if (!show || !Array.isArray(show.capabilities)) return discovered;

  const parsed = parseOllamaShow(show);
  const models = discovered.models.slice();
  models[index] = {
    ...models[index],
    supportsTools: parsed.supportsTools,
    capabilities: parsed.capabilities,
    ...(parsed.contextLength != null ? { context: parsed.contextLength } : {}),
  };
  return { ...discovered, models };
}

/**
 * Annotate each discovered id with what `POST /api/show` says it can do.
 *
 * Deliberately best-effort and non-fatal. Three outcomes per model:
 *
 *   probe succeeded, tools present -> supportsTools: true
 *   probe succeeded, tools absent  -> supportsTools: false  (the only rejectable one)
 *   probe failed or 404            -> supportsTools stays undefined
 *
 * The third case is the common one for a non-Ollama OpenAI-compatible server,
 * and it must never turn into a rejection: absence of evidence about tool
 * support is not evidence of its absence.
 */
async function probeOllamaCapabilities(models, baseUrl, { fetchShow, notices }) {
  if (!Array.isArray(models) || models.length === 0) return models;

  // Bounded: this runs on the path to spawning a partner, and a host with a
  // large library would otherwise turn one list call into dozens of requests.
  const probeLimit = 32;
  const targets = models.slice(0, probeLimit);
  if (models.length > targets.length) {
    notices.push(
      notice(
        "capability_probe_truncated",
        `tool-capability was probed for the first ${targets.length} of ${models.length} models; ` +
          `the rest are reported without capability information`
      )
    );
  }

  const probed = await Promise.all(
    targets.map(async (model) => {
      const show = await fetchShow(baseUrl, model.id);
      if (!show) return model;

      // parseOllamaShow reports supportsTools:false for junk as well as for a
      // genuine no-tools model, and only the latter may reject. Require a real
      // capabilities array before treating the answer as evidence at all.
      if (!Array.isArray(show.capabilities)) return model;

      const parsed = parseOllamaShow(show);
      return {
        ...model,
        supportsTools: parsed.supportsTools,
        capabilities: parsed.capabilities,
        ...(parsed.contextLength != null ? { context: parsed.contextLength } : {}),
      };
    })
  );

  const noTools = probed.filter((m) => m.supportsTools === false).map((m) => m.id);
  if (noTools.length) {
    notices.push(
      notice(
        "models_without_tools",
        `${noTools.join(", ")} report no "tools" capability; they cannot write the ` +
          `completion sidecar and will hang rather than finish a turn`
      )
    );
  }

  return probed.concat(models.slice(targets.length));
}

function firstEnvValue(env, names) {
  for (const name of names ?? []) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// --- default I/O -----------------------------------------------------------

/** Hard bounds for one WSL cache read. */
const WSL_CACHE_READ_TIMEOUT_MS = 5000;
const WSL_CACHE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A fixed shell program; every dynamic value is a positional argument.
 *
 * The login shell matters because the selected partner is launched under the
 * same interactive-login contract by tmux-runtime. It sees the distro user's HOME,
 * profile PATH and CLI-specific config variables instead of the Windows host's
 * unrelated values. No user-controlled value is interpolated into shell text.
 */
const WSL_CACHE_READ_SCRIPT = [
  "replace_once() {",
  "  value=$1",
  "  needle=$2",
  "  replacement=$3",
  '  case "$value" in',
  '    *"$needle"*)',
  '      prefix=${value%%"$needle"*}',
  '      suffix=${value#*"$needle"}',
  '      printf "%s%s%s" "$prefix" "$replacement" "$suffix"',
  "      ;;",
  '    *) printf "%s" "$value" ;;',
  "  esac",
  "}",
  "to_wsl_path() {",
  '  case "$1" in',
  '    [A-Za-z]:[\\\\/]*) wslpath -a -u "$1" 2>/dev/null || printf "%s" "$1" ;;',
  '    *) printf "%s" "$1" ;;',
  "  esac",
  "}",
  "seed_name=$1",
  "fallback_template=$2",
  "path_template=$3",
  "output_marker=$4",
  "config_home=",
  'if [ -n "$seed_name" ]; then',
  '  config_home=$(printenv "$seed_name" 2>/dev/null || true)',
  "fi",
  'if [ -z "$config_home" ]; then',
  '  config_home=$(replace_once "$fallback_template" "{{home}}" "$HOME")',
  "fi",
  'if [ -z "$config_home" ]; then',
  '  printf "%s\\n" "cannot resolve the WSL config home" >&2',
  "  exit 2",
  "fi",
  'config_home=$(to_wsl_path "$config_home")',
  'cache_path=$(replace_once "$path_template" "{{configHome}}" "$config_home")',
  'cache_path=$(replace_once "$cache_path" "{{home}}" "$HOME")',
  'cache_path=$(to_wsl_path "$cache_path")',
  'printf "%s\\n%s\\n" "$output_marker" "$cache_path"',
  'exec cat -- "$cache_path"',
].join("\n");

/** Run the partner command through the same login-shell PATH tmux uses. */
const WSL_PARTNER_EXEC_SCRIPT = [
  "output_marker=$1",
  "role=$2",
  "depth=$3",
  "partner_command=$4",
  "shift 4",
  'export DUALOG_ROLE="$role" DUALOG_DEPTH="$depth"',
  'case "$partner_command" in',
  '  [A-Za-z]:[\\\\/]*) partner_command=$(wslpath -a -u "$partner_command") ;;',
  "esac",
  'printf "%s\\n" "$output_marker"',
  'exec "$partner_command" "$@"',
].join("\n");

function wslExecArgs(route, args) {
  return [
    ...(route?.distro ? ["--distribution", route.distro] : []),
    "--exec",
    ...args,
  ];
}

function prepareDiscoveryCommand(command, args, route) {
  if (route?.transport !== "wsl") {
    return { command, args, transport: "local" };
  }
  const sentinel = partnerSentinelEnv();
  const outputMarker = `__DUALOG_WSL_READY_${randomUUID()}__`;
  return {
    command: route.command,
    args: wslExecArgs(
      route,
      wslLoginShellArgs(route.loginShell, WSL_PARTNER_EXEC_SCRIPT, {
        arg0: "dualog-wsl-discovery",
        args: [
          outputMarker,
          sentinel.DUALOG_ROLE,
          sentinel.DUALOG_DEPTH,
          command,
          ...args,
        ],
      })
    ),
    transport: "wsl",
    outputMarker,
  };
}

/** Read one partner-owned cache file from the selected WSL distribution. */
function defaultReadWslFile({ adapter, config, route, env, execFileImpl = execFile }) {
  return new Promise((resolve) => {
    const outputMarker = `__DUALOG_WSL_CACHE_${randomUUID()}__`;
    const isolation = adapter?.configIsolation;
    const args = wslExecArgs(
      route,
      wslLoginShellArgs(route.loginShell, WSL_CACHE_READ_SCRIPT, {
        arg0: "dualog-wsl-cache-read",
        args: [
          isolation?.seedFromEnv ?? "",
          isolation?.seedFromFallback ?? "",
          config.path,
          outputMarker,
        ],
      })
    );

    execFileImpl(
      route.command,
      args,
      {
        timeout: WSL_CACHE_READ_TIMEOUT_MS,
        killSignal: "SIGKILL",
        encoding: "utf-8",
        env,
        windowsHide: true,
        maxBuffer: WSL_CACHE_MAX_BYTES,
      },
      (err, stdout, stderr) => {
        const output = String(stdout ?? "");
        const body = discoveryCommandStdout(output, { outputMarker });
        const newline = body.indexOf("\n");
        const cachePath =
          newline === -1 ? null : body.slice(0, newline).replace(/\r$/u, "");
        const text = newline === -1 ? null : body.slice(newline + 1);

        if (err) {
          const detail = String(stderr || "").trim().slice(0, 500);
          const reason =
            err.killed || err.signal
              ? `WSL cache read timed out after ${WSL_CACHE_READ_TIMEOUT_MS}ms`
              : err.code === "ENOENT"
                ? `WSL launcher ${JSON.stringify(route.command)} was not found`
                : detail || err.message || "WSL cache read failed";
          return resolve({ path: cachePath, text: null, error: reason });
        }
        if (!cachePath) {
          return resolve({
            path: null,
            text: null,
            error: "WSL returned no cache path",
          });
        }
        resolve({ path: cachePath, text, error: null });
      }
    );
  });
}

/** Read a file, reporting WHY it failed. Never throws. */
function defaultReadFile(filePath) {
  try {
    return { text: fs.readFileSync(filePath, "utf-8"), error: null };
  } catch (err) {
    const code = err?.code;
    // "missing" and "unreadable" send you to different places: the first to
    // whether the CLI has ever run under this home, the second to permissions.
    const reason =
      code === "ENOENT" ? "no such file" : code === "EACCES" ? "permission denied" : (code ?? err?.message ?? "unreadable");
    return { text: null, error: reason };
  }
}

function discoveryCommandStdout(stdout, invocation) {
  const output = String(stdout ?? "");
  if (!invocation?.outputMarker) return output;
  const marker = invocation.outputMarker;
  const index = output.indexOf(marker);
  if (index === -1) return "";
  const after = output.slice(index + marker.length);
  if (after.startsWith("\r\n")) return after.slice(2);
  if (after.startsWith("\n")) return after.slice(1);
  return "";
}

/** Run a listing command with a hard timeout. Never throws. */
function defaultRunCommand({
  command,
  args,
  timeoutMs,
  env,
  route,
  execFileImpl = execFile,
}) {
  return new Promise((resolve) => {
    const invocation = prepareDiscoveryCommand(command, args, route);
    execFileImpl(
      invocation.command,
      invocation.args,
      { timeout: timeoutMs, encoding: "utf-8", env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const commandStdout = discoveryCommandStdout(stdout, invocation);
        if (err) {
          const detail = String(stderr || "").trim();
          const reason =
            err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? `${err.stream || "process output"} exceeded the ${4 * 1024 * 1024}-byte discovery limit`
              : err.killed || err.signal
              ? `timed out after ${timeoutMs}ms`
              : err.code === "ENOENT"
                ? invocation.transport === "wsl"
                  ? "WSL is not installed or not on PATH"
                  : "not installed"
                : invocation.transport === "wsl" &&
                    (err.code === 127 || /(?:not found|execvpe\()/iu.test(detail))
                  ? `not installed in WSL${route?.distro ? ` distribution ${route.distro}` : ""}`
                  : (detail || err.message || "failed");
          // Some CLIs write the list and still exit with an ordinary numeric
          // status. Usable stdout can win there, but never for timeout,
          // overflow, spawn failure, or a killed process: that output may be a
          // truncated prefix that only happens to look like a valid model id.
          if (
            Number.isInteger(err.code) &&
            !err.killed &&
            !err.signal &&
            commandStdout.trim()
          ) {
            return resolve({ stdout: commandStdout, error: null });
          }
          return resolve({ stdout: "", error: reason });
        }
        resolve({ stdout: commandStdout, error: null });
      }
    );
  });
}

/** A stream-json stream is small. Past this, nobody is going to answer us. */
const MAX_CONTROL_STDOUT = 4 * 1024 * 1024;

/** Enough stderr to explain a refusal ("not logged in"), no more. */
const MAX_CONTROL_STDERR = 2000;

/** How long a killed child gets to exit on its own before SIGKILL. */
const KILL_GRACE_MS = 2000;

/**
 * Send one control request over stream-json stdio and return the first line
 * that answers it. NEVER THROWS and never rejects.
 *
 * Returns `{ line, error }` -- the RAW stdout line, deliberately, so the caller
 * does the mapping with the same pure parser the tests exercise, and this
 * function stays nothing but process plumbing.
 *
 * Error codes are kept apart because they mean different things:
 *   cli_not_found       the binary is not on PATH.
 *   control_timeout     it started and never answered.
 *   no_control_response it exited first -- usually auth, so stderr is quoted.
 *   spawn_failed        the spawn itself failed.
 */
function defaultRunControlRequest({
  command,
  args,
  request,
  timeoutMs,
  env,
  route,
  spawnImpl = spawn,
  platform = process.platform,
  terminateWindowsTreeFn = terminateWindowsProcessTree,
}) {
  return new Promise((resolve) => {
    const requestId = `dualog-discovery-${randomUUID()}`;
    const invocation = prepareDiscoveryCommand(command, args, route);
    let child;
    try {
      const spawnOptions = {
        // The user's own environment, so the CLI reports what the USER can
        // select -- plus the sentinel, so anything this child spawns knows it
        // is downstream of us. The WSL wrapper exports the same sentinel again
        // after its login shell, where Windows env forwarding cannot erase it.
        env: { ...env, ...partnerSentinelEnv() },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      };
      child = spawnWithTrustedWindowsComSpec(
        spawnImpl,
        invocation.command,
        invocation.args,
        spawnOptions,
        { platform, env: spawnOptions.env }
      );
    } catch (err) {
      return resolve({
        line: null,
        error: {
          code: "spawn_failed",
          message:
            invocation.transport === "wsl"
              ? `could not start WSL to run \`${command}\`: ${err?.message ?? err}`
              : `could not run \`${command}\`: ${err?.message ?? err}`,
        },
      });
    }

    let settled = false;
    let pending = Buffer.alloc(0);
    let stdoutBytes = 0;
    const stderrChunks = [];
    let stderrBytes = 0;

    const finish = (error, line = null, { terminate = true } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Kill the moment we have the answer. This is a whole CLI process with a
      // session of its own; letting it linger for a fixed interval would add
      // seconds to every discovery call for nothing.
      // A WSL launcher is not a native `.cmd` tree: taskkill can prove only
      // that wsl.exe stopped, not that its Linux process did. Keep the prior
      // launcher signal there; the exact native tree primitive is for local
      // Windows probes where its proof applies.
      const terminationPlatform =
        invocation.transport === "local" ? platform : "wsl";
      const termination = terminate
        ? killChild(child, {
            platform: terminationPlatform,
            terminateWindowsTreeFn,
          })
        : disposeChild(child);
      if (error && termination?.status === "failed" && termination.reason) {
        error.message += `; ${termination.reason}`;
      }
      resolve({ line, error, termination });
    };

    const timer = setTimeout(
      () =>
        finish({
          code: "control_timeout",
          message: `\`${command}\` did not answer the list_models control request within ${timeoutMs}ms`,
        }),
      timeoutMs
    );

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_CONTROL_STDOUT) {
        return finish({
          code: "control_output_limit",
          message: `\`${command}\` streamed more than ${MAX_CONTROL_STDOUT} bytes without answering`,
        });
      }
      pending = Buffer.concat([pending, bytes]);

      let newline;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const line = pending.subarray(0, newline).toString("utf-8").replace(/\r$/u, "");
        pending = pending.subarray(newline + 1);
        if (!line.trim()) continue;
        // Exactly one request is outstanding, so the first models-bearing
        // control_response is necessarily the answer to it.
        if (parseClaudeListModels(line) !== null) return finish(null, line);
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= MAX_CONTROL_STDERR) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const kept = bytes.subarray(0, MAX_CONTROL_STDERR - stderrBytes);
      stderrChunks.push(kept);
      stderrBytes += kept.length;
    });

    // EPIPE, when the child has already exited. The close handler reports what
    // actually happened; an unhandled 'error' here would take down the process.
    child.stdin.on("error", () => {});

    child.on("error", (err) =>
      finish({
        code: err?.code === "ENOENT" ? "cli_not_found" : "spawn_failed",
        message:
          err?.code === "ENOENT"
            ? invocation.transport === "wsl"
              ? `WSL is not installed or not on PATH, so \`${command}\` could not be checked there`
              : `\`${command}\` is not installed or not on PATH`
            : `\`${command}\` failed to start: ${err?.message ?? err}`,
      }, null, { terminate: false })
    );

    child.on("close", (code) => {
      const stderrText = Buffer.concat(stderrChunks).toString("utf-8").trim();
      const missingInWsl =
        invocation.transport === "wsl" &&
        code === 127 &&
        /(?:not found|execvpe\()/iu.test(stderrText);
      finish({
        code: missingInWsl ? "cli_not_found" : "no_control_response",
        message: missingInWsl
          ? `\`${command}\` is not installed or not on PATH in WSL` +
            (route?.distro ? ` distribution ${route.distro}` : "")
          : `\`${command}\` exited (${code}) before answering the list_models control request` +
            (stderrText ? `: ${stderrText}` : ""),
      }, null, { terminate: false });
    });

    child.stdin.write(
      `${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`
    );
    // stdin stays OPEN on purpose. In stream-json input mode, closing it is
    // end-of-input, and the CLI would shut down before answering a request that
    // is not a user turn.
  });
}

/**
 * SIGTERM, then SIGKILL if it is still there. Never throws.
 *
 * The pipes are torn down and the child is unref'd. Killing alone is not enough:
 * a CLI that spawned a helper of its own leaves that helper holding the inherited
 * stdout fd, and a live pipe keeps OUR event loop alive long after we returned an
 * answer. Native Windows callers must taskkill the live wrapper tree BEFORE this
 * helper, or cmd.exe can exit and reparent the vendor child before /T sees it.
 */
function disposeChild(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream?.destroy();
    } catch {
      /* already closed */
    }
  }
  if (typeof child.unref === "function") child.unref();
  return { status: "not-needed", attempted: false, reason: null };
}

function killChild(
  child,
  {
    platform = process.platform,
    terminateWindowsTreeFn = terminateWindowsProcessTree,
  } = {}
) {
  if (platform === "win32") {
    const termination = terminateDiscoveryProcess(child, {
      platform,
      terminateWindowsTreeFn,
    });
    disposeChild(child);
    return termination;
  }

  disposeChild(child);
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const grace = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, KILL_GRACE_MS);
  // Must not hold the event loop open: discovery is often the last thing a
  // short-lived process does.
  if (typeof grace.unref === "function") grace.unref();
  return { status: "succeeded", attempted: true, reason: null };
}

// ---------------------------------------------------------------------------

/** JSON.parse that reports "not JSON" as null rather than as an exception. */
function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
