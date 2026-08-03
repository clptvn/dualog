// Environment preparation for a partner invocation: config-directory
// isolation, MCP suppression, and the recursion sentinel.

import fs from "fs";
import path from "path";
import {
  assertManagedLeasePath,
  assertManagedSessionPath,
  assertSeedFileName,
} from "../platform.mjs";
import { isPathVariableName } from "./schema.mjs";

/**
 * The boundary every runtime write of this turn must stay inside.
 *
 * A turn that has been given a per-turn lease is contained against the LEASE;
 * one without falls back to its session directory, which is the pre-lease layout.
 * Both are proven boundaries -- this chooses between two containment checks, it
 * never skips one -- and the choice is made in exactly one place so no caller
 * can write without either.
 *
 * A manifest still rendering `{{sessionDir}}/...` on a turn that HAS a lease
 * fails here, loudly and with the fix named. That is deliberate: silently
 * accepting it would put the credential copy back in the archive, which is the
 * whole condition this design exists to end.
 */
function assertTurnPath(ctx, candidate, { fn }) {
  if (!ctx.scratchDir) {
    return assertManagedSessionPath(ctx.sessionDir, candidate, { fn });
  }
  try {
    return assertManagedLeasePath(ctx.scratchDir, candidate, { fn });
  } catch (err) {
    if (ctx.sessionDir && candidate.startsWith(ctx.sessionDir)) {
      throw new Error(
        `${err.message}\nThis turn has a per-turn runtime lease, so partner homes ` +
          `must be written under {{scratchDir}}, not {{sessionDir}}. A session ` +
          `directory is a durable archive; anything seeded with credentials there ` +
          `is retained for the life of the session.`
      );
    }
    throw err;
  }
}

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

  // Containment is proven BEFORE the first mkdirSync, not after it.
  //
  // `isolation.dir` is a free-form Template in the schema and manifests are
  // user-supplyable, so until this line the rendered value was simply trusted:
  // whatever it named got created and had credentials copied into it. That is
  // how a live auth.json reached a public repository's working tree.
  const targetDir = assertTurnPath(
    ctx,
    render(isolation.dir, ctx, adapter, "configIsolation.dir"),
    { fn: `adapter "${adapter.id}" configIsolation.dir` }
  );
  fs.mkdirSync(targetDir, { recursive: true });

  const seedDir = resolveSeedDir(isolation, ctx, adapter);
  if (seedDir) {
    // Seed names are joined onto the user's REAL config directory as well as
    // this one, so a name carrying `..` reads outside the source and writes
    // outside the destination in a single step.
    for (const name of isolation.copyIfMissing) {
      assertSeedFileName(name, { fn: `adapter "${adapter.id}" configIsolation.copyIfMissing` });
      copyIfMissing(path.join(seedDir, name), path.join(targetDir, name));
    }
    for (const name of isolation.copyIfExists) {
      assertSeedFileName(name, { fn: `adapter "${adapter.id}" configIsolation.copyIfExists` });
      copyIfExists(path.join(seedDir, name), path.join(targetDir, name));
    }
  }

  // RELOCATIONS. Contained unconditionally -- `dirs` means "this is a place",
  // so there is nothing left to decide at runtime.
  const relocations = {};
  for (const [key, template] of Object.entries(isolation.dirs ?? {})) {
    assertNotIsolationVariable(adapter, isolation, "configIsolation.dirs", key);
    relocations[key] = assertTurnPath(
      ctx,
      render(
        template,
        { ...ctx, isolatedDir: targetDir },
        adapter,
        `configIsolation.dirs.${key}`
      ),
      { fn: `adapter "${adapter.id}" configIsolation.dirs.${key}` }
    );
  }

  // SETTINGS. Not contained, because they are not places -- and the name rule
  // below is what makes that safe. Nothing here creates a directory; a setting
  // only becomes a filesystem location if the partner CLI reads that variable as
  // one, which is a fact about the NAME.
  const settings = {};
  for (const [key, template] of Object.entries(isolation.extraEnv ?? {})) {
    assertNotIsolationVariable(adapter, isolation, "configIsolation.extraEnv", key);
    assertSettingVariable(adapter, "configIsolation.extraEnv", key, "configIsolation.dirs");
    settings[key] = render(
      template,
      { ...ctx, isolatedDir: targetDir },
      adapter,
      `configIsolation.extraEnv.${key}`
    );
  }

  // Uncontained SETTINGS first, contained RELOCATIONS second, the isolation
  // variable last: every value merged later is one whose location was proven,
  // so no unchecked entry can displace a checked one. The schema rejects a key
  // appearing in two of these maps, which makes the ordering belt-and-braces --
  // but it is the belt that held when the collision guard did not exist.
  //
  // tests/adapter-contract.test.mjs.snapshot pins env key INSERTION order, so
  // reordering these fails there as a confusing snapshot diff rather than as a
  // security failure. If you are here because of that diff, the ordering is
  // deliberate; do not regenerate the snapshot to make it go away.
  return { ...settings, ...relocations, [isolation.env]: targetDir };
}

/**
 * A key in either map that equals the isolation variable would REPLACE the
 * validated home in the returned overlay, discarding the containment proof one
 * statement after it was made. There is no legitimate reason to set it twice.
 */
function assertNotIsolationVariable(adapter, isolation, field, key) {
  if (key !== isolation.env) return;
  throw new Error(
    `Adapter "${adapter.id}": ${field} may not redefine ${isolation.env}; ` +
      `that variable is set from configIsolation.dir, which is the value proven ` +
      `to be inside the session.`
  );
}

/**
 * Refuse to deliver a filesystem location through a settings map.
 *
 * The schema says the same thing at load time; this is the boundary that
 * actually holds, because a manifest can also reach the runtime through the
 * registry merge. It replaces isScalarSwitch(), which tried to infer the answer
 * from the rendered VALUE and could not: `auto` and `pwned-config` are the same
 * shape, so the check either rejected goose's real mode setting or admitted a
 * bare relative directory that the partner resolved against the user's project.
 */
function assertSettingVariable(adapter, field, key, dirsField) {
  if (!isPathVariableName(key)) return;
  throw new Error(
    `Adapter "${adapter.id}": ${field}.${key} names a filesystem location, which ` +
      `must be declared under ${dirsField} so the rendered path is proven to be ` +
      `inside the session.`
  );
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
    // The hole this closes: `adapter.env` is merged into the launch environment
    // independently of configIsolation, so before the split a manifest could
    // hand a partner any directory on the machine through a variable its own
    // isolation did not happen to relocate -- no containment check ran on this
    // path at all. A location now has to be declared below, where one does.
    assertSettingVariable(adapter, "env", key, "dirs");
    const value = renderOptional(template, ctx, adapter, `env.${key}`);
    if (value != null) out[key] = value;
  }

  // Static RELOCATIONS, contained like every other directory a partner is given.
  // Merged after settings so a proven path cannot be displaced by an unproven
  // one, matching the order prepareConfigIsolation uses.
  for (const [key, template] of Object.entries(adapter.dirs ?? {})) {
    const value = renderOptional(template, ctx, adapter, `dirs.${key}`);
    if (value == null) continue;
    out[key] = assertTurnPath(ctx, value, {
      fn: `adapter "${adapter.id}" dirs.${key}`,
    });
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

  // Same boundary as configIsolation.dir, for the same reason: `mcp.path` is a
  // free-form Template that this function creates directories for and writes a
  // file to. Containing only the isolation directory would leave an equally
  // unchecked write one field away.
  const configPath = assertTurnPath(
    ctx,
    render(mcp.path, ctx, adapter, "mcp.path"),
    { fn: `adapter "${adapter.id}" mcp.path` }
  );
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(mcp.content, null, 2) + "\n");
  }
  return configPath;
}

function copyIfExists(sourcePath, targetPath) {
  try {
    if (!fs.existsSync(sourcePath)) return;
    fs.copyFileSync(sourcePath, targetPath);
    // Pin the mode rather than inherit it. copyFileSync reproduces the SOURCE's
    // permissions, so a user whose real auth.json is 0644 got a 0644 copy --
    // observed landing at 0600 here only because the source happened to be
    // 0600. Every seed is config or credential material that only this turn's
    // partner reads, so 0600 is correct for all of them and does not need the
    // schema to say which are secret.
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // A filesystem without POSIX modes; the 0700 lease still contains it.
    }
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
