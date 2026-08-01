// Environment preparation for a partner invocation: config-directory
// isolation, MCP suppression, and the recursion sentinel.

import fs from "fs";
import path from "path";

/**
 * Marks a spawned process as a partner so that a nested copy of this MCP server
 * serves no tools instead of recursing.
 *
 * Always passed explicitly rather than relied on through inheritance: the tmux
 * server is long-lived, so a session started later would otherwise reuse
 * whatever environment that server first booted with.
 */
export function partnerSentinelEnv() {
  const parsed = Number.parseInt(process.env.DUALOG_DEPTH ?? "0", 10);
  const depth = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  return {
    DUALOG_ROLE: "partner",
    DUALOG_DEPTH: String(depth + 1),
  };
}

/**
 * Relocate the partner's config/state/auth directory for this session, seeding
 * it with the credentials it needs and nothing else. This is what keeps a
 * partner from inheriting the user's real MCP servers -- and, with them, any
 * credentials those servers carry in their env blocks.
 *
 * Returns the env overlay, or an empty object when the adapter declares no
 * isolation mechanism.
 */
export function prepareConfigIsolation(adapter, ctx) {
  const isolation = adapter.configIsolation;
  if (!isolation) return {};

  const targetDir = render(isolation.dir, ctx, adapter, "configIsolation.dir");
  fs.mkdirSync(targetDir, { recursive: true });

  const seedDir = resolveSeedDir(isolation, ctx, adapter);
  if (seedDir) {
    for (const name of isolation.copyIfMissing) {
      copyIfMissing(path.join(seedDir, name), path.join(targetDir, name));
    }
    for (const name of isolation.copyIfExists) {
      copyIfExists(path.join(seedDir, name), path.join(targetDir, name));
    }
  }

  const extra = {};
  for (const [key, template] of Object.entries(isolation.extraEnv ?? {})) {
    extra[key] = render(template, { ...ctx, isolatedDir: targetDir }, adapter, "configIsolation.extraEnv");
  }

  return { [isolation.env]: targetDir, ...extra };
}

/**
 * Static per-adapter environment, templated against the turn context.
 *
 * An entry referencing a context value that is null FOR THIS TURN drops out
 * instead of failing. That is what makes env a usable delivery channel for an
 * optional setting: goose declares GOOSE_THINKING_EFFORT once and the variable
 * simply does not appear on a turn where no effort was requested, rather than
 * every optional entry needing a conditional form that only env would use.
 *
 * A reference to a key that does not exist at all is still fatal -- that is a
 * typo in a manifest, and quietly dropping it is how an author comes to believe
 * a setting took effect when it never did.
 */
export function staticEnv(adapter, ctx) {
  const out = {};
  for (const [key, template] of Object.entries(adapter.env ?? {})) {
    const value = renderOptional(template, ctx, adapter, `env.${key}`);
    if (value != null) out[key] = value;
  }
  return out;
}

// The one filename every settings-file delivery writes. Kept a constant rather
// than a manifest field until a second CLI needs a different one: a field with
// a single possible value is a field nobody can get right for the wrong reason.
const SETTINGS_FILE = "settings.json";

/**
 * Deliver reasoning effort through the partner's own settings file.
 *
 * qwen exposes effort nowhere else -- no flag, no env var -- so for it this is
 * the only channel that exists. Returns the path written, or null when this
 * adapter delivers effort some other way or none was requested.
 *
 * The write MERGES. Config isolation may have seeded a real settings.json into
 * this directory, and replacing it would strip the user's model choice and auth
 * settings as a side effect of setting one key.
 */
export function applyEffortSettingsFile(adapter, ctx, isolationEnv = {}) {
  if (adapter.effortDelivery !== "settings-file") return null;
  if (!ctx.reasoningEffort) return null;

  // Guaranteed by the schema, which refuses settings-file delivery without an
  // isolated dir -- there would be nowhere to write but the user's own config.
  const isolation = adapter.configIsolation;
  const targetDir = isolation ? isolationEnv[isolation.env] : null;
  if (!targetDir) return null;

  const settingsPath = path.join(targetDir, SETTINGS_FILE);
  let existing = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    try {
      existing = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Adapter "${adapter.id}" cannot deliver reasoning effort: ${settingsPath} ` +
          `is not valid JSON (${err.message}). Refusing to overwrite it.`
      );
    }
    if (!isPlainObject(existing)) {
      throw new Error(
        `Adapter "${adapter.id}" cannot deliver reasoning effort: ${settingsPath} ` +
          `is not a JSON object. Refusing to overwrite it.`
      );
    }
  }

  const merged = {
    ...existing,
    model: {
      ...(isPlainObject(existing.model) ? existing.model : {}),
      reasoningEffort: ctx.reasoningEffort,
    },
  };

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  return settingsPath;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveSeedDir(isolation, ctx, adapter) {
  const fromEnv = isolation.seedFromEnv
    ? process.env[isolation.seedFromEnv]
    : null;
  if (fromEnv) return fromEnv;
  if (!isolation.seedFromFallback) return null;
  // The fallback is home-relative; with no home there is nothing to seed from.
  if (!ctx.home) return null;
  return render(
    isolation.seedFromFallback,
    ctx,
    adapter,
    "configIsolation.seedFromFallback"
  );
}

/**
 * Apply the adapter's MCP suppression strategy. Returns the path of a written
 * config file when the strategy produces one, otherwise null.
 *
 * `config-dir` is handled entirely by prepareConfigIsolation -- a fresh config
 * home has no MCP servers in it. `none` is not silently tolerated here; the
 * negotiator decides whether it is survivable for a given invocation.
 */
export function applyMcpSuppression(adapter, ctx) {
  const mcp = adapter.mcp;
  if (mcp.strategy !== "empty-config-file") return null;

  const configPath = render(mcp.path, ctx, adapter, "mcp.path");
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(mcp.content, null, 2) + "\n");
  }
  return configPath;
}

function copyIfExists(sourcePath, targetPath) {
  try {
    if (fs.existsSync(sourcePath)) fs.copyFileSync(sourcePath, targetPath);
  } catch {
    // Missing or unreadable auth is surfaced by the partner CLI itself and
    // captured from its terminal, which gives a far better message than
    // anything we could synthesize here.
  }
}

function copyIfMissing(sourcePath, targetPath) {
  try {
    if (!fs.existsSync(targetPath)) copyIfExists(sourcePath, targetPath);
  } catch {
    // Same rationale as copyIfExists.
  }
}

/**
 * Render a template, or return null when a referenced value is unset for this
 * turn. An unknown key still throws: null means "not this turn", while a key
 * the context has never heard of means the manifest is wrong.
 */
function renderOptional(template, ctx, adapter, field) {
  let unset = false;
  const rendered = String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in ctx)) {
      throw new Error(
        `Adapter "${adapter.id}" ${field} references {{${key}}}, which is not a ` +
          `known context value. Declared in ${adapter.__sources?.join(", ") ?? "<unknown source>"}`
      );
    }
    if (ctx[key] == null) {
      unset = true;
      return "";
    }
    return String(ctx[key]);
  });
  return unset ? null : rendered;
}

// Local copy of the template renderer to keep env.mjs independent of argv.mjs.
function render(template, ctx, adapter, field) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = ctx[key];
    if (value == null) {
      throw new Error(
        `Adapter "${adapter.id}" ${field} references {{${key}}}, which is not set. ` +
          `Declared in ${adapter.__sources?.join(", ") ?? "<unknown source>"}`
      );
    }
    return String(value);
  });
}
