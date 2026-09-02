// Adapter discovery and merge.
//
// Layers are merged by adapter id, lowest precedence first. A user file that
// declares an existing id does not have to restate the whole manifest -- it
// patches it. That is what lets someone point a built-in adapter at a wrapper
// script, or retune a marker set, without forking the source.
//
// Merge semantics: objects deep-merge, ARRAYS REPLACE. Replacing arrays is the
// only sane choice for marker lists and argv rules -- concatenating a user's
// ready markers onto ours would make overrides additive-only and impossible to
// narrow.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { parseManifest } from "./schema.mjs";

const APP_DIR_NAME = "dualog";
const BUILTIN_DIR = fileURLToPath(new URL("./builtin/", import.meta.url));

let cached = null;
const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  // stderr only: stdout is the MCP stdio transport and must stay pure JSON-RPC.
  process.stderr.write(`[adapters] ${message}\n`);
}

function findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Candidate adapter directories, lowest precedence first. */
export function adapterSearchPath({ cwd = process.cwd(), env = process.env } = {}) {
  const dirs = [BUILTIN_DIR];

  for (const base of (env.XDG_CONFIG_DIRS || "").split(path.delimiter).filter(Boolean)) {
    dirs.push(path.join(base, APP_DIR_NAME, "adapters"));
  }

  const xdgHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const userDir = path.join(xdgHome, APP_DIR_NAME, "adapters");
  dirs.push(userDir);

  // Legacy location, honored only when the XDG one is absent so that a stale
  // copy can never silently shadow the current one.
  const legacyDir = path.join(os.homedir(), `.${APP_DIR_NAME}`, "adapters");
  if (!fs.existsSync(userDir) && fs.existsSync(legacyDir)) {
    warnOnce(
      "legacy-dir",
      `using legacy adapter directory ${legacyDir}; move it to ${userDir}`
    );
    dirs.push(legacyDir);
  }

  const gitRoot = findGitRoot(cwd);
  if (gitRoot) dirs.push(path.join(gitRoot, `.${APP_DIR_NAME}`, "adapters"));
  if (!gitRoot || path.resolve(cwd) !== gitRoot) {
    dirs.push(path.join(cwd, `.${APP_DIR_NAME}`, "adapters"));
  }

  for (const explicit of (env.DUALOG_ADAPTER_PATH || "").split(path.delimiter).filter(Boolean)) {
    dirs.push(explicit);
  }

  // De-duplicate while preserving precedence order.
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

function readManifestFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // A missing search-path directory is normal, not an error.
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(dir, name));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

/**
 * Load, merge, and validate every adapter on the search path.
 *
 * Validation runs on the MERGED object, not on each layer, so a user patch may
 * be a fragment. Any failure names the exact files that produced the manifest.
 */
export function loadRegistry({ cwd, env, force = false } = {}) {
  if (cached && !force) return cached;

  const merged = new Map();

  for (const dir of adapterSearchPath({ cwd, env })) {
    for (const file of readManifestFiles(dir)) {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch (err) {
        throw new Error(`Could not read adapter manifest ${file}: ${err.message}`);
      }

      const id = raw?.id;
      if (typeof id !== "string" || !id) {
        throw new Error(`Adapter manifest ${file} is missing a string "id"`);
      }

      const previous = merged.get(id);
      merged.set(id, {
        raw: previous ? deepMerge(previous.raw, raw) : raw,
        sources: [...(previous?.sources ?? []), file],
      });
    }
  }

  const adapters = new Map();
  for (const [id, { raw, sources }] of merged) {
    const manifest = parseManifest(raw, sources.join(" <- "));
    adapters.set(id, { ...manifest, __sources: sources });
  }

  if (adapters.size === 0) {
    throw new Error(
      `No adapter manifests found. Searched: ${adapterSearchPath({ cwd, env }).join(", ")}`
    );
  }

  cached = adapters;
  return adapters;
}

export function getAdapter(id, options) {
  const registry = loadRegistry(options);
  const adapter = registry.get(id);
  if (!adapter) {
    throw new Error(
      `Unknown agent "${id}". Available: ${[...registry.keys()].sort().join(", ")}`
    );
  }
  return adapter;
}

/**
 * Look up an adapter without throwing.
 *
 * For diagnostic paths that run against persisted session state: a session
 * recorded under an agent id that no longer resolves should degrade to "unknown
 * activity", not crash the tool call that was only trying to report status.
 */
export function tryGetAdapter(id, options) {
  try {
    return loadRegistry(options).get(id) ?? null;
  } catch {
    return null;
  }
}

export function adapterIds(options) {
  return [...loadRegistry(options).keys()].sort();
}

export function listAdapters(options) {
  return [...loadRegistry(options).values()];
}

/** Test hook: drop the memoized registry so a fresh search path is honored. */
export function resetRegistry() {
  cached = null;
  warned.clear();
}
