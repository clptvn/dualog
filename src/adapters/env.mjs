// Environment preparation for a partner invocation: config-directory
// isolation, MCP suppression, and the recursion sentinel.

import fs from "fs";
import path from "path";
import { assertManagedSessionPath, assertSeedFileName } from "../platform.mjs";

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
  const targetDir = assertManagedSessionPath(
    ctx.sessionDir,
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

  const extra = {};
  for (const [key, template] of Object.entries(isolation.extraEnv ?? {})) {
    // An extraEnv key equal to the isolation variable would REPLACE the
    // validated home in the returned overlay -- see the spread at the bottom of
    // this function -- so the containment proof above would be discarded by the
    // very next statement. There is no legitimate reason to set it twice.
    if (key === isolation.env) {
      throw new Error(
        `Adapter "${adapter.id}": configIsolation.extraEnv may not redefine ` +
          `${isolation.env}; that variable is set from configIsolation.dir, which is ` +
          `the value proven to be inside the session.`
      );
    }
    const value = render(template, { ...ctx, isolatedDir: targetDir }, adapter, "configIsolation.extraEnv");
    // extraEnv mixes two unrelated things under one field: RELOCATIONS
    // (opencode's XDG_DATA_HOME={{sessionDir}}/opencode-data) and scalar
    // SWITCHES (goose's GOOSE_DISABLE_KEYRING=1). A relocation is exactly as
    // dangerous as isolation.dir and must be contained; a switch is not a path.
    // Splitting the schema is the real fix; until then the DEFAULT must be
    // containment.
    //
    // Inferring "is this a path?" from the rendered string was the first
    // attempt and it was wrong in the one direction that matters: a relocation
    // set to a bare relative name -- `cache`, or `pwned-config` -- contains no
    // separator and is not absolute, so it sailed past and dualog created that
    // directory relative to its own cwd, i.e. inside the user's project.
    //
    // So the test is inverted. A value is a scalar switch only if it is
    // literally one of the forms a switch takes; everything else is treated as
    // a path and must prove containment. A future manifest with a non-path
    // string setting will fail loudly here and need one line added to
    // isScalarSwitch() -- which is the correct direction to be wrong in.
    if (!isScalarSwitch(value)) {
      assertManagedSessionPath(ctx.sessionDir, value, {
        fn: `adapter "${adapter.id}" configIsolation.extraEnv.${key}`,
      });
    }
    extra[key] = value;
  }

  // `extra` FIRST: the isolation variable is set from the value proven to be
  // inside the session, and nothing merged afterwards may replace it. The
  // opposite order let a single extraEnv entry silently discard the containment
  // proof one statement after it was made.
  //
  // Belt-and-braces behind the collision guard above, which rejects that key
  // before this line is reached. Reverting this order alone does NOT go
  // unnoticed, though: tests/adapter-contract.test.mjs.snapshot pins env key
  // INSERTION order, so it fails there -- as a confusing snapshot diff rather
  // than as a security failure. If you are here because of that diff, the
  // ordering is deliberate; do not regenerate the snapshot to make it go away.
  return { ...extra, [isolation.env]: targetDir };
}

/**
 * Is this rendered value a scalar switch rather than a filesystem location?
 *
 * FOUR EXACT LITERALS, and the narrowness is the whole point. A first version
 * exempted any bare integer and matched case-insensitively, which meant
 * `XDG_DATA_HOME=123` and `XDG_DATA_HOME=TRUE` sailed through uncontained --
 * and a partner CLI resolves a relative value like that against its own working
 * directory, i.e. the user's project. Identical to the `pwned-config` hole,
 * spelled with digits.
 *
 * Residual, stated rather than papered over: a manifest could still set a
 * relocation variable to the literal `0`, `1`, `true` or `false` and have the
 * partner resolve it relatively. That is four strings rather than an open set,
 * and closing it properly needs the schema to say which keys are paths
 * (`dirs:`) and which are settings (`env:`) instead of this guessing at it.
 */
function isScalarSwitch(value) {
  return value === "0" || value === "1" || value === "true" || value === "false";
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

  // Same boundary as configIsolation.dir, for the same reason: `mcp.path` is a
  // free-form Template that this function creates directories for and writes a
  // file to. Containing only the isolation directory would leave an equally
  // unchecked write one field away.
  const configPath = assertManagedSessionPath(
    ctx.sessionDir,
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
