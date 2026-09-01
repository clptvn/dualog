// Adapter manifest schema.
//
// An adapter is DATA describing how to drive one AI coding CLI. It selects an
// engine by name; it never defines a new protocol. That split is deliberate --
// every comparable registry (models.dev, catwalk, litellm, goose, Continue)
// converged on it, and litellm is the cautionary tale of what happens without
// it: ~140 accreted fields including five separate booleans encoding what one
// value-set field expresses.
//
// zod/v4 is a subpath of the already-installed zod@3.25.x, so this costs no new
// dependency and buys z.prettifyError for legible manifest errors.

import { z } from "zod/v4";

/** Engines are a closed enum. Adding one is a code change, by design. */
export const ENGINES = ["tmux-interactive", "headless"];

/**
 * A string that may contain {{placeholders}} resolved against the invocation
 * context (projectPath, sessionDir, model, ...). See argv.mjs for the resolver.
 */
const Template = z.string();

/**
 * Environment variables a CLI reads as a filesystem location.
 *
 * This list is the security boundary for the settings/relocation split, and it
 * is a rule about NAMES because that is what decides interpretation. Nothing in
 * dualog creates a directory for a setting -- only `configIsolation.dir` and the
 * `dirs` maps cause a mkdir -- so a setting holding a path-shaped string is
 * inert unless the partner CLI treats that variable as a location. `GOOSE_MODE`
 * is safe at any value; `XDG_DATA_HOME` is dangerous at every value that
 * resolves outside the session.
 *
 * Guessing from the VALUE was the previous approach and could not work in
 * either direction: `auto` and `pwned-config` are the same shape, so the check
 * either rejected goose's legitimate mode or admitted a relative directory that
 * the partner then resolved against the user's own project.
 *
 * Checked against every built-in: the four grok toggles, goose's mode, thinking
 * effort and keyring switch, and opencode's project-config switch all pass;
 * `XDG_DATA_HOME` is the only settings entry any manifest had that this
 * classifies as a location, and it is a relocation that was living in the wrong
 * field. Note `OPENCODE_DISABLE_PROJECT_CONFIG` deliberately does not match --
 * a trailing `_CONFIG` names a feature far more often than a directory.
 */
const PATH_VARIABLE_NAME =
  /^XDG_|_(HOME|DIR|DIRS|PATH|ROOT|CONFIG|CACHE|DATA|FILE)$|^(HOME|PATH|TMPDIR|TMP|TEMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/;

/**
 * Names that ARE locations despite matching a suffix this list treats as a
 * feature toggle, and names that are toggles despite ending in one.
 *
 * `_CONFIG` and `_DATA` are genuinely ambiguous: `KUBECONFIG` and
 * `DOCKER_CONFIG` name directories, while `OPENCODE_DISABLE_PROJECT_CONFIG` is
 * a boolean. Suffix matching cannot separate those, so the ambiguous suffixes
 * are treated as locations by default and the real toggles are named here.
 * Erring toward "location" is the safe direction: the cost is a manifest author
 * getting a clear message telling them to use `dirs`, versus a partner CLI
 * resolving a relative path against the user's project.
 */
const SETTING_NAME_EXCEPTIONS = new Set([
  "OPENCODE_DISABLE_PROJECT_CONFIG",
]);

/**
 * Names known to be locations that the pattern above would otherwise miss.
 * Append-only; each entry is a variable some CLI reads as a filesystem path.
 */
const KNOWN_PATH_VARIABLES = new Set([
  "KUBECONFIG",
  "DOCKER_CONFIG",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GNUPGHOME",
  "SSH_AUTH_SOCK",
  "NPM_CONFIG_PREFIX",
  "NODE_PATH",
  "PYTHONPATH",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOMODCACHE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "CLOUDSDK_CONFIG",
  "NETRC",
]);

/**
 * Is this variable name one a CLI reads as a filesystem location?
 *
 * WHAT THIS IS AND IS NOT. It is a backstop that catches the accidental case
 * loudly, at load, with a message naming the entry. It is NOT a complete
 * enumeration and cannot become one -- an adapter for a CLI nobody here has run
 * may read any name it likes as a directory, and no list written in advance
 * covers that.
 *
 * The actual guarantee is `dirs`: a path declared there is proven inside the
 * turn's lease before anything is created at it, whatever it is called. A
 * manifest that puts a location in a settings map under an unrecognised name
 * with a bare relative value still slips through -- so the residual is that
 * such a value is resolved by the partner against its own working directory.
 * A manifest already chooses which BINARY runs, so this is not the weakest link
 * in that threat model, but it is stated rather than papered over.
 */
export function isPathVariableName(name) {
  // CASE-INSENSITIVE, because environment variable names are on Windows: `Path`
  // and `PATH` are the same variable there, so a case-sensitive check let the
  // most obvious location variable of all through under a different spelling.
  const key = String(name).toUpperCase();
  if (SETTING_NAME_EXCEPTIONS.has(key)) return false;
  if (KNOWN_PATH_VARIABLES.has(key)) return true;
  return PATH_VARIABLE_NAME.test(key);
}

/**
 * Does this TEMPLATE describe a filesystem location?
 *
 * Authoring hygiene rather than a security boundary, and narrow on purpose: it
 * catches the shapes a relocation actually takes so an author who puts one in a
 * settings map is told to move it, without rejecting a legitimate setting that
 * merely contains a slash. A base URL (`https://...`) is not a location; a value
 * built from {{sessionDir}} is.
 */
// `scratchDir` was missing here for one release and it was the WORST omission of
// the set: it is the variable every relocation is supposed to be built from, so
// a settings entry like `CUSTOM_STATE: "{{scratchDir}}/../../../outside"` under
// an unrecognised name passed validation and reached the partner uncontained.
// Introduced by adding scratchDir to the context without revisiting this list --
// which is the argument for deriving it from the context keys rather than
// restating them.
export const LOCATION_CONTEXT_KEYS = [
  "scratchDir",
  "sessionDir",
  "home",
  "projectPath",
  "configHome",
  "isolatedDir",
  // Added after `mcpConfigPath` was found missing the same way `scratchDir` was:
  // it is populated by applyMcpSuppression before argv rendering, so a settings
  // entry built from it -- `{{mcpConfigPath}}/../../../../.codex` -- rendered to
  // a real path outside the lease. Every context value that names a FILE or
  // DIRECTORY belongs here; a test walks the live invocation context and fails
  // if one appears that this list does not know about.
  "mcpConfigPath",
];
const LOCATION_TEMPLATE = new RegExp(`\\{\\{(${LOCATION_CONTEXT_KEYS.join("|")})\\}\\}`);

/**
 * Path shapes, not just POSIX ones.
 *
 * `/^[~/]/` and `/^\.\.?\//` describe one platform. A manifest is data and can
 * come from anywhere, so `C:\outside`, `..\outside` and `\\server\share` have to
 * read as locations too -- on Windows they are exactly that, and on POSIX they
 * are still not something a legitimate scalar setting looks like.
 */
const PATH_SHAPED_VALUE =
  /^[~/]|^\.\.?[/\\]|^[A-Za-z]:[/\\]|^\\\\|^\\/;

export function looksLikeLocation(template) {
  const text = String(template);
  return LOCATION_TEMPLATE.test(text) || PATH_SHAPED_VALUE.test(text);
}

/**
 * Conditions are intentionally trivial: a value is set, or a value equals a
 * literal. Anything more expressive belongs in code, not in JSON. Values are
 * normalized before argv is built -- an effort not valid for this adapter is
 * nulled out first -- so rules never need to re-validate.
 */
const Condition = z.union([
  z.object({ set: z.string() }).strict(),
  z.object({ notSet: z.string() }).strict(),
  z.object({
    equals: z.object({ key: z.string(), value: z.string() }).strict(),
  }).strict(),
]);

const ArgvRule = z
  .object({
    when: Condition.optional(),
    args: z.array(Template).min(1),
  })
  .strict();

/**
 * Tool profiles map a profile name to the flag values that express it. A CLI
 * with no tool-permission flags declares an empty object and relies on prompt
 * wording alone -- which `capabilities.toolProfiles: "prompt-only"` records
 * honestly rather than implying enforcement that does not exist.
 */
const ToolProfile = z
  .object({
    allowedTools: z.string().optional(),
    disallowedTools: z.string().optional(),
  })
  .strict();

/**
 * How the partner's config/state/auth directory is relocated for one session.
 * Relocating is what keeps a partner from inheriting the user's real MCP
 * servers and their credentials.
 */
const ConfigIsolation = z
  .object({
    env: z.string(),
    dir: Template,
    seedFromEnv: z.string().optional(),
    seedFromFallback: Template.optional(),
    copyIfMissing: z.array(z.string()).default([]),
    copyIfExists: z.array(z.string()).default([]),

    /**
     * TOML tables to strip out of a seeded file after it is copied.
     *
     * Seeding a CLI's real config is what makes its PROJECT-LOCAL config work:
     * codex merges a project's `.codex/config.toml` over the global one, so a
     * project table that overrides a global server (`enabled = false` and
     * nothing else) has no transport to merge with when the global file is
     * absent -- and codex rejects the whole file and exits. Isolating the
     * config home without carrying the config is what produced that.
     *
     * But the real config also names dualog's own MCP server, and a partner
     * that can call dualog can open its own dialogs. Dropping the table is the
     * containment: `-c mcp_servers.dualog.enabled=false` would instead CREATE a
     * transport-less table for anyone who has no dualog server configured,
     * which is the exact failure this whole mechanism exists to avoid.
     *
     * Keyed by seed file name; each value is a list of dotted table paths.
     */
    dropTomlTables: z.record(z.string(), z.array(z.string())).default({}),

    /**
     * Further RELOCATIONS, each contained exactly as `dir` is.
     *
     * Several CLIs need more than one variable to be fully relocated -- one for
     * config, another for data or cache. Isolating only some of them leaves the
     * partner reading the user's real state through whichever was missed.
     */
    dirs: z.record(z.string(), Template).default({}),

    /**
     * SETTINGS delivered alongside the relocation. Never a location, never
     * contained, and never used to create anything.
     *
     * This field and `dirs` were one field, which is what forced the runtime to
     * guess which kind each entry was. The guess is gone: the manifest says
     * which it means, and the two are validated by opposite rules.
     */
    extraEnv: z.record(z.string(), Template).default({}),
  })
  .strict();

/**
 * MCP suppression. `none` is not a failure -- it is a fact that the negotiator
 * turns into an error or a warning depending on whether the env sentinel
 * already covers the recursion threat for this invocation.
 */
const McpSuppression = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("empty-config-file"),
    path: Template,
    content: z.unknown(),
  }).strict(),
  z.object({ strategy: z.literal("config-dir") }).strict(),
  z.object({ strategy: z.literal("flag") }).strict(),
  z.object({ strategy: z.literal("none") }).strict(),
]);

/**
 * Terminal marker classes.
 *
 * `blocked` is distinct from `busy` and from `idle` on purpose. A CLI parked on
 * a plan-approval or ask-the-human step looks idle to a naive classifier, so a
 * driver would send the next prompt into a turn that will never advance.
 *
 * Marker syntax: a plain string is a literal substring match. A string prefixed
 * with `re:` is compiled as a case-insensitive unicode regex. Literals are
 * preferred -- they survive vendor UI churn better and are far easier to review
 * for a CLI you cannot run.
 */
// Closed set understood by tmux-runtime's sendKeyToTmux(). Startup prompts
// sometimes use arrow-key menus rather than numbered choices, so treating every
// response as pasted text can select the destructive/default option instead.
const StartupPromptKey = z.enum([
  "enter",
  "escape",
  "tab",
  "space",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "page_up",
  "page_down",
]);

const TuiMarkers = z
  .object({
    // All of `readyAll` and at least one of `readyAny` must match.
    readyAll: z.array(z.string()).default([]),
    readyAny: z.array(z.string()).default([]),
    notReady: z.array(z.string()).default([]),
    busy: z.array(z.string()).default([]),
    idle: z.array(z.string()).default([]),
    blocked: z.array(z.string()).default([]),
    startupPrompts: z
      .array(
        z
          .object({
            kind: z.string(),
            description: z.string(),
            input: z.string().optional(),
            keys: z.array(StartupPromptKey).min(1).optional(),
            matchAll: z.array(z.string()).default([]),
            matchAny: z.array(z.string()).default([]),
          })
          .strict()
          .superRefine((prompt, ctx) => {
            const hasInput = typeof prompt.input === "string";
            const hasKeys = Array.isArray(prompt.keys);
            if (hasInput === hasKeys) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "startup prompt must declare exactly one of input or keys",
              });
            }
          })
      )
      .default([]),
    // When true, a ready prompt suppresses interstitial detection. Needed for
    // CLIs that keep the trust dialog in scrollback after it is answered, which
    // would otherwise be answered again on every poll.
    suppressStartupWhenReady: z.boolean().default(false),
    exitCommand: z.string().optional(),
    exitKeys: z.array(z.string()).default([]),
    usesAltScreen: z.boolean().default(false),
  })
  .strict();

const FailurePattern = z
  .object({
    code: z.string(),
    pattern: z.string(),
    flags: z.string().default("iu"),
    summary: z.string(),
  })
  .strict();

/**
 * One entry in `models`.
 *
 * A bare string keeps exactly its historical meaning: an id we believe exists,
 * with no claim about what efforts it accepts. The object form is what lets a
 * manifest state the per-MODEL effort set -- which is the only form of that
 * fact that is ever true. `xhigh` is valid for claude-opus-4-7 and invalid for
 * claude-opus-4-6, so an adapter-level effort list can only be the union across
 * every model, never the answer for the model actually in hand.
 *
 * Three states must stay distinguishable, so `efforts` is optional rather than
 * defaulted:
 *   omitted -> nothing is claimed about this model (every bare string included)
 *   []      -> this model accepts no effort at all (claude-haiku-4-5)
 *   [...]   -> exactly these, and nothing else
 *
 * `defaultEffort` is the CLI's own default for that model, not a preference of
 * ours: Codex runs gpt-5.6-sol at `low` and gpt-5.3-codex-spark at `high` when
 * nobody says otherwise, so a single adapter-wide default would be a fiction.
 *
 * Efforts are stored as SETS, never as a ladder. opus-4-6 and sonnet-4-6 accept
 * `max` but not `xhigh`; any code that assumes an ordering is wrong for exactly
 * those two.
 */
const ModelEntry = z
  .object({
    id: z.string().min(1),
    efforts: z.array(z.string()).optional(),
    defaultEffort: z.string().optional(),
    context: z.number().int().positive().optional(),
    aliasOf: z.string().optional(),
    deprecated: z.boolean().optional(),
  })
  .strict();

const ModelDeclaration = z.union([z.string().min(1), ModelEntry]);

/**
 * Normalize `models` to the object form. A bare string becomes `{ id }` with no
 * `efforts` key -- defaulting it to `[]` would invent the opposite claim, that
 * the model supports no effort at all.
 */
export function modelEntries(manifest) {
  return (manifest.models ?? []).map((entry) =>
    typeof entry === "string" ? { id: entry } : entry
  );
}

/** Declared model ids. Aliases are excluded: an alias is not a catalog entry. */
export function modelIds(manifest) {
  return modelEntries(manifest).map((entry) => entry.id);
}

/** Does this adapter declare a way to look its models up at runtime? */
export function hasDiscoveryStrategy(manifest) {
  const strategy = manifest?.discovery?.strategy ?? null;
  return Boolean(strategy) && strategy !== "static" && strategy !== "none";
}

/**
 * May an unrecognized model be REJECTED against this list?
 *
 * Takes a discovery RESULT -- `{models, source, strategy, stale}`, as
 * resolveDiscovery returns -- never a manifest. Enumerability is a property of
 * the answer, not of the adapter: the same adapter is authoritative when its
 * cache is readable and knows nothing five minutes later when it is not. No
 * static predicate over a manifest can express that.
 *
 * Three ways a list fails to be grounds for rejection, each of which has
 * already produced a wrong answer here:
 *
 *   strategy "static" -- a degraded fallback, or a hand-maintained manifest
 *     list. Ours omit real models: claude declares ten ids while the CLI also
 *     accepts `default`, `opus`, `sonnet`, `haiku` and claude-sonnet-4-5.
 *     Rejecting against it blocks working models and makes the escape hatch
 *     mandatory for ordinary work.
 *   stale -- the requested model may simply be newer than the cache.
 *   empty -- opencode and goose declare discovery and no static models, so one
 *     transient failure on an installed CLI would otherwise reject EVERY id.
 *
 * A manifest can never satisfy this, which is deliberate: passing one in yields
 * false and degrades to a warning, so the unsafe direction is unreachable.
 */
export function isEnumerable(discovery) {
  return Boolean(
    discovery &&
      discovery.strategy &&
      discovery.strategy !== "static" &&
      !discovery.stale &&
      Array.isArray(discovery.models) &&
      discovery.models.length > 0
  );
}

/**
 * Resolve a requested model id to the entry describing it.
 *
 * Two indirections exist, and they are different things. `modelAliases` is a
 * CLI-level name that is not a catalog entry -- `gpt-5.6` selects gpt-5.6-sol
 * in the picker but never appears in the models cache -- while `aliasOf` is a
 * catalog entry that defers to another. Neither rewrites what we hand the CLI:
 * an alias is by definition a name the CLI itself accepts, so substituting the
 * canonical id would change the invocation for no reason. They decide only
 * which effort set applies.
 */
export function resolveModelEntry(manifest, requestedId) {
  if (!requestedId) {
    return { requested: null, canonicalId: null, entry: null, known: false };
  }

  const entries = modelEntries(manifest);
  const target = manifest.modelAliases?.[requestedId] ?? requestedId;

  let entry = entries.find((candidate) => candidate.id === target) ?? null;
  // Follow aliasOf hops, guarding against a cycle the schema cannot see across
  // a registry merge.
  const seen = new Set();
  while (entry?.aliasOf && !seen.has(entry.id)) {
    seen.add(entry.id);
    const next = entries.find((candidate) => candidate.id === entry.aliasOf);
    if (!next) break;
    entry = next;
  }

  return {
    requested: requestedId,
    canonicalId: entry?.id ?? target,
    entry,
    known: Boolean(entry),
  };
}

/**
 * Where a runtime model list comes from.
 *
 * ABSENT MEANS STATIC: the manifest's own `models` list is the whole answer.
 * That is spelled as absence rather than as a default value on purpose. An
 * adapter with no source and an empty list knows nothing about model ids, and a
 * downstream "can this adapter enumerate?" check must be able to tell that
 * apart from an adapter that can actually answer -- otherwise Cursor, whose
 * accepted ids are deliberately undocumented, would start rejecting every model
 * it was handed.
 *
 * `format` names which verified parser to run. It is deliberately NOT a generic
 * field-mapping DSL: reproducing the Codex picker means filtering on
 * `visibility` and sorting by `priority`, and reading Grok means honoring a
 * TTL, an `origin`, and a per-model `supports_reasoning_effort` gate. That
 * knowledge was verified against real output and is what the parsers in
 * discovery.mjs exist to hold; re-encoding it as JSON path config would express
 * it less legibly and lose the parts config cannot say.
 */
/**
 * Fields shared by every strategy, describing the models.dev ENRICHMENT axis.
 *
 * Enrichment is not a source of model ids and can never become one -- see the
 * rule enforced in catalog.mjs. It only annotates ids a real source already
 * returned, which is why it is a property of every strategy rather than a
 * strategy of its own.
 *
 * `catalogProvider` is the models.dev provider id to look bare model ids up
 * under. It is NOT a nicety: the same model id carries different effort sets
 * under different providers -- claude-sonnet-4-6 appears under 17, two of which
 * wrongly grant `xhigh` -- so a lookup without one would be a coin flip between
 * the verified answer and the exact inversion bug this project fixed. Omitted
 * means "we do not know", and enrichment then skips those models and says so.
 * Set it only where the first-party provider is unambiguous.
 */
const catalogFields = {
  catalogProvider: z.string().min(1).optional(),
};

const Discovery = z.discriminatedUnion("strategy", [
  // A file the CLI maintains for itself. The best source there is: a local read
  // costing ~1ms, already scoped to this account, so it answers "what can YOU
  // select" rather than "what exists in the world".
  z
    .object({
      ...catalogFields,
      strategy: z.literal("local-cache"),
      format: z.enum(["codex-cache", "grok-cache"]),
      /**
       * Templated against {{configHome}} and {{home}}.
       *
       * {{configHome}} is the USER'S real config directory -- never the
       * isolated per-session copy. We create that copy fresh for every turn and
       * seed it with credentials only, so it never contains a models cache;
       * pointing discovery at it would read an empty directory every time.
       */
      path: Template,
      /** Env var holding the models-list URL the cache must match. */
      originListUrlEnv: z.string().optional(),
      /** Env var holding a base URL, whose list URL is {base}/models. */
      originBaseUrlEnv: z.string().optional(),
    })
    .strict(),

  // Ask the CLI. Costs a process spawn, so it is a fallback or a last resort,
  // never the hot path.
  z
    .object({
      ...catalogFields,
      strategy: z.literal("cli-command"),
      format: z.literal("opencode-models"),
      /** Defaults to binary.default: the same binary, asked to list. */
      command: z.string().min(1).optional(),
      args: z.array(z.string()).min(1),
      timeoutMs: z.number().int().positive().default(10000),
    })
    .strict(),

  // Ask the CLI over its own control protocol, rather than over a subcommand
  // it does not have. Claude Code has no `claude models`; the list is reachable
  // only as a `list_models` control request on a stream-json session. Same cost
  // tier as cli-command -- it boots the whole CLI -- and the same last-resort
  // standing. The argv and the response shape are protocol knowledge and live
  // in discovery.mjs beside the parsers, for the reason stated above.
  z
    .object({
      ...catalogFields,
      strategy: z.literal("sdk-control"),
      format: z.literal("claude-list-models"),
      /** Defaults to binary.default: the same binary, asked over stdio. */
      command: z.string().min(1).optional(),
      // Covers a cold CLI boot, not a warm round trip. See SDK_CONTROL_TIMEOUT_MS.
      timeoutMs: z.number().int().positive().default(15000),
    })
    .strict(),

  // Ask an OpenAI-compatible endpoint directly. For CLIs that keep their
  // catalog compiled in and never expose it, but which route inference at a
  // base URL we can query ourselves.
  z
    .object({
      ...catalogFields,
      strategy: z.literal("http-openai"),
      /**
       * Env vars searched in order for the base URL. With none of them set
       * there is nothing to ask -- neither qwen nor goose serves its built-in
       * catalog over HTTP -- so discovery says so and falls back, rather than
       * probing a guessed address.
       */
      baseUrlEnv: z.array(z.string()).min(1),
      apiKeyEnv: z.array(z.string()).default([]),
      /**
       * An extra per-model capability probe to run after the id list comes
       * back. `/v1/models` returns names only, which is not enough to answer
       * the one question that decides whether a turn can work at all: can this
       * model call a tool?
       *
       * The sidecar completion protocol requires the partner to write
       * `result.md` and `done.json`. A model without tool support produces
       * prose and never signals completion, so the turn presents as a hang
       * rather than as the configuration error it is.
       *
       * Best-effort by construction: a server that does not implement the
       * endpoint (any real OpenAI-compatible host that is not Ollama) leaves
       * capability unknown, and unknown never rejects. Only a successful probe
       * that positively reports no `tools` capability does.
       */
      capabilityProbe: z.enum(["ollama-show"]).optional(),
    })
    .strict(),

  // The manifest list is the answer, deliberately. Equivalent to omitting the
  // field; spelling it out records that a source was looked for and none was
  // found, rather than that nobody checked.
  z.object({ ...catalogFields, strategy: z.literal("static") }).strict(),

  /**
   * models.dev supplies the METADATA; the manifest still supplies the IDS.
   *
   * This is deliberately not a peer of the strategies above, and the difference
   * is load-bearing rather than pedantic. `isEnumerable` treats any non-static,
   * fresh, non-empty result as a list a model may be REJECTED against. A
   * catalog that could answer as a primary source would therefore become a
   * rejection list -- and models.dev's one demonstrated failure is currency: it
   * still lists openai/gpt-5.3-codex, retired months ago, with no `status`
   * field at all. Adopting it as a primary source would both bless ids that no
   * longer work and reject real ids it has not caught up with yet.
   *
   * So this resolves to the static list of ids, annotated from the catalog. It
   * can add efforts to a model; it can never add a model.
   */
  z.object({ ...catalogFields, strategy: z.literal("catalog") }).strict(),

  // Do not discover at all, and do not enrich either -- the only setting that
  // guarantees no I/O of any kind. The point of this over `static` is the
  // registry merge: a user manifest can set it to switch off a built-in
  // adapter's spawn, HTTP call, or catalog fetch without restating anything.
  z.object({ strategy: z.literal("none") }).strict(),
]);

const Capabilities = z
  .object({
    modelFlag: z.boolean(),
    reasoningEffort: z.boolean(),
    toolProfiles: z.enum(["flags", "prompt-only", "none"]),
    addDir: z.boolean(),
    writesFiles: z.boolean(),
    tuiDrivable: z.enum(["yes", "risky", "no"]),
  })
  .strict();

export const AdapterManifest = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase kebab-case"),
    displayName: z.string().min(1),
    experimental: z.boolean().default(false),

    binary: z
      .object({
        default: z.string().min(1),
        versionArgs: z.array(z.string()).default(["--version"]),
        installHint: z.string().optional(),
      })
      .strict(),

    engines: z
      .object({
        default: z.enum(ENGINES),
        allowed: z.array(z.enum(ENGINES)).min(1),
      })
      .strict(),

    capabilities: Capabilities,

    /**
     * The union of every effort any model of this adapter accepts -- i.e. what
     * the CLI will parse, not what a given model will honor. Per-model validity
     * lives on the model entry; this stays as the outer bound.
     */
    reasoningEfforts: z.array(z.string()).default([]),
    models: z.array(ModelDeclaration).default([]),

    /**
     * CLI-level aliases that are NOT catalog entries. `gpt-5.6` selects
     * gpt-5.6-sol in the Codex picker but is not a slug in the models cache, so
     * listing it under `models` would claim a model that discovery can never
     * return. Kept as a separate map so the two can never be conflated.
     */
    modelAliases: z.record(z.string(), z.string()).default({}),

    /**
     * Effort names this adapter accepts as synonyms for one it actually parses.
     *
     * goose takes off|low|medium|high|max and has no `xhigh` at all, but a host
     * asking for effort speaks one vocabulary across every partner. Stating the
     * translation here means a caller never has to learn goose's spelling, and
     * -- because aliases are applied before any validity check -- an alias is
     * never reported as an unsupported effort.
     */
    effortAliases: z.record(z.string(), z.string()).default({}),

    /**
     * How a chosen effort actually reaches the partner.
     *
     * Not every CLI takes a flag. qwen exposes reasoning effort only as a
     * settings.json key -- no flag, no env var -- and goose only as
     * GOOSE_THINKING_EFFORT. Declaring the mechanism is what stops
     * `capabilities.reasoningEffort: true` from implying an argv rule that does
     * not exist, which is how those two came to be marked as having no effort
     * support at all.
     */
    effortDelivery: z
      .enum(["argv", "env", "settings-file", "none"])
      .default("argv"),

    /** Runtime model source. Absent means static -- see the Discovery comment. */
    discovery: Discovery.optional(),

    defaultToolProfile: z.string().default("read"),
    toolProfiles: z.record(z.string(), ToolProfile).default({}),

    mcp: McpSuppression,
    configIsolation: ConfigIsolation.nullable().default(null),

    /**
     * Static SETTINGS applied to every invocation. Some CLIs express what are
     * effectively flags only as env vars (goose's GOOSE_MODE, grok's MCP import
     * toggles), so this is not merely convenience.
     *
     * Settings only: an entry naming a location belongs in `dirs`, where it is
     * contained. Until that split existed this map was an unchecked channel for
     * arbitrary paths -- it is merged into the launch environment independently
     * of configIsolation, so a manifest could point a partner at any directory
     * through a variable its own isolation did not happen to relocate.
     */
    env: z.record(z.string(), Template).default({}),

    /**
     * Static RELOCATIONS, contained inside the session like every other
     * directory dualog hands a partner.
     *
     * Empty in every built-in adapter today. It exists so that the answer to
     * "my CLI needs one more directory redirected" is a field with a containment
     * rule attached, rather than `env`, which has none.
     */
    dirs: z.record(z.string(), Template).default({}),

    /**
     * How the bootstrap prompt reaches the partner, per engine. Both keys are
     * optional here: a headless-only adapter has no tmux delivery and a
     * tmux-only adapter has no headless one. The superRefine below requires an
     * entry for each engine the adapter actually allows.
     */
    promptDelivery: z
      .object({
        "tmux-interactive": z.enum(["argv", "tui-paste"]).optional(),
        headless: z.enum(["argv", "stdin"]).optional(),
      })
      .strict(),

    argv: z
      .object({
        "tmux-interactive": z.array(ArgvRule).default([]),
        headless: z.array(ArgvRule).default([]),
      })
      .strict(),

    tui: TuiMarkers.optional(),
    failurePatterns: z.array(FailurePattern).default([]),

    /**
     * How a finished turn is recognized.
     *
     * `sidecar`:
     *   always   -> done.json is authoritative; stdout is advisory
     *   fallback -> a stdout terminal event is authoritative, and done.json
     *               additionally proves the partner had working write access
     *   never    -> structured stdout only
     *
     * The cross-check matters: several CLIs deny write tools by default in
     * headless mode, and the model then reports success while no sidecar ever
     * appears. A missing done.json beside a successful terminal event is a
     * specific, actionable diagnosis rather than a mystery.
     */
    completion: z
      .object({
        sidecar: z.enum(["always", "fallback", "never"]),
        stdoutTrustworthy: z.boolean().default(false),
        stdout: z
          .object({
            format: z.enum(["text", "json", "stream-json"]).default("text"),
            // stream-json: the `type` of the event carrying the final result.
            resultEventType: z.string().optional(),
            // Dotted path to the result text within that event or object.
            resultPath: z.string().optional(),
            errorPath: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const fail = (message, path) =>
      ctx.addIssue({ code: "custom", message, path });

    if (!m.engines.allowed.includes(m.engines.default)) {
      fail(
        `engines.default "${m.engines.default}" is not in engines.allowed [${m.engines.allowed.join(", ")}]`,
        ["engines", "default"]
      );
    }

    for (const engine of m.engines.allowed) {
      if (!m.argv[engine]?.length) {
        fail(`engines.allowed lists "${engine}" but argv.${engine} is empty`, [
          "argv",
          engine,
        ]);
      }
      if (!m.promptDelivery[engine]) {
        fail(
          `engines.allowed lists "${engine}" but promptDelivery.${engine} is unset`,
          ["promptDelivery", engine]
        );
      }
    }

    // A TUI-driven partner that cannot be recognized as ready can never be
    // handed a prompt. Failing at load beats a silent readiness timeout.
    if (m.engines.allowed.includes("tmux-interactive")) {
      const ready = (m.tui?.readyAll?.length ?? 0) + (m.tui?.readyAny?.length ?? 0);
      if (ready === 0) {
        fail(
          "tmux-interactive is allowed but tui declares no ready markers, so readiness could never be detected",
          ["tui", "readyAny"]
        );
      }
      if (m.capabilities.tuiDrivable === "no") {
        fail(
          'capabilities.tuiDrivable is "no" but engines.allowed includes tmux-interactive',
          ["engines", "allowed"]
        );
      }
    }

    // The sidecar protocol asks the partner to write two files. A partner that
    // cannot write files cannot signal completion that way.
    if (!m.capabilities.writesFiles && m.completion.sidecar === "always") {
      fail(
        'capabilities.writesFiles is false but completion.sidecar is "always"; such a partner can never signal completion',
        ["completion", "sidecar"]
      );
    }
    if (!m.capabilities.writesFiles && !m.completion.stdoutTrustworthy) {
      fail(
        "a partner that cannot write files must have completion.stdoutTrustworthy true, or it has no completion signal at all",
        ["completion", "stdoutTrustworthy"]
      );
    }

    if (m.completion.stdoutTrustworthy && !m.completion.stdout) {
      fail(
        "completion.stdoutTrustworthy is true but completion.stdout does not say how to read the result",
        ["completion", "stdout"]
      );
    }
    if (
      m.completion.stdout?.format === "stream-json" &&
      !m.completion.stdout.resultEventType
    ) {
      fail(
        'completion.stdout.format is "stream-json" but no resultEventType is declared, so the terminal event cannot be identified',
        ["completion", "stdout", "resultEventType"]
      );
    }

    if (m.capabilities.reasoningEffort && m.reasoningEfforts.length === 0) {
      fail(
        "capabilities.reasoningEffort is true but reasoningEfforts is empty",
        ["reasoningEfforts"]
      );
    }
    if (!m.capabilities.reasoningEffort && m.reasoningEfforts.length > 0) {
      fail(
        "reasoningEfforts is non-empty but capabilities.reasoningEffort is false",
        ["capabilities", "reasoningEffort"]
      );
    }

    // Per-model effort facts must be internally coherent. Each check below
    // catches a way the table can lie that nothing downstream could detect: a
    // default outside its own set would hand the CLI a value that model
    // rejects, and an alias pointing nowhere resolves to an id that was never
    // declared -- both of which surface as a vendor error mid-turn, if at all.
    const entries = modelEntries(m);
    const declaredIds = new Set(entries.map((entry) => entry.id));

    for (const [index, entry] of entries.entries()) {
      if (entry.defaultEffort != null) {
        const efforts = entry.efforts ?? [];
        if (!efforts.includes(entry.defaultEffort)) {
          fail(
            `model "${entry.id}" declares defaultEffort "${entry.defaultEffort}", ` +
              `which is not in its own efforts [${efforts.join(", ")}]`,
            ["models", index, "defaultEffort"]
          );
        }
      }
      if (entry.aliasOf != null && !declaredIds.has(entry.aliasOf)) {
        fail(
          `model "${entry.id}" is an alias of "${entry.aliasOf}", which is not a declared model`,
          ["models", index, "aliasOf"]
        );
      }
    }

    for (const [alias, target] of Object.entries(m.modelAliases)) {
      if (!declaredIds.has(target)) {
        fail(
          `modelAliases["${alias}"] points at "${target}", which is not a declared model`,
          ["modelAliases", alias]
        );
      }
    }

    // An alias that resolves to an effort the CLI does not parse would be
    // translated into a value that then fails downstream -- worse than the
    // unaliased name, which at least fails here. An alias that shadows a real
    // effort would silently redirect a value the CLI does accept.
    for (const [alias, target] of Object.entries(m.effortAliases)) {
      if (!m.reasoningEfforts.includes(target)) {
        fail(
          `effortAliases["${alias}"] maps to "${target}", which is not in ` +
            `reasoningEfforts [${m.reasoningEfforts.join(", ")}]`,
          ["effortAliases", alias]
        );
      }
      if (m.reasoningEfforts.includes(alias)) {
        fail(
          `effortAliases["${alias}"] shadows "${alias}", which this adapter ` +
            `already accepts as a real effort`,
          ["effortAliases", alias]
        );
      }
    }

    // settings-file delivery writes the effort into the partner's config
    // directory before spawn. Without an isolated one, the only place to write
    // is the user's own config -- a permanent edit made for one turn.
    // {{configHome}} resolves through configIsolation's seed settings, which is
    // what makes it point at the user's real config dir rather than the session
    // copy. Without isolation there is nothing to resolve it from, and the
    // failure mode is the quiet one: discovery falls back to the static list
    // forever and nobody learns that the source was never readable.
    if (
      m.discovery?.strategy === "local-cache" &&
      m.discovery.path.includes("{{configHome}}") &&
      !m.configIsolation
    ) {
      fail(
        'discovery.path uses {{configHome}} but configIsolation is null, so the ' +
          "user's real config directory cannot be located",
        ["discovery", "path"]
      );
    }

    if (m.effortDelivery === "settings-file" && !m.configIsolation) {
      fail(
        'effortDelivery is "settings-file" but configIsolation is null, so there ' +
          "is no session-owned config directory to write the setting into",
        ["effortDelivery"]
      );
    }

    // --- settings are not relocations -----------------------------------------
    //
    // Caught at load rather than at spawn so a manifest author is told which
    // field to use, in a message naming the entry, instead of discovering it as
    // a containment refusal mid-turn.
    const settingsMaps = [
      { label: "env", map: m.env, dirsField: "dirs", path: ["env"] },
      ...(m.configIsolation
        ? [
            {
              label: "configIsolation.extraEnv",
              map: m.configIsolation.extraEnv,
              dirsField: "configIsolation.dirs",
              path: ["configIsolation", "extraEnv"],
            },
          ]
        : []),
    ];
    for (const { label, map, dirsField, path: base } of settingsMaps) {
      for (const [key, template] of Object.entries(map)) {
        if (isPathVariableName(key)) {
          fail(
            `${label}.${key} names a filesystem location. Declare it under ` +
              `${dirsField}, where the rendered path is proven to be inside the ` +
              `session before anything is created at it.`,
            [...base, key]
          );
        } else if (looksLikeLocation(template)) {
          fail(
            `${label}.${key} is set to ${JSON.stringify(template)}, which describes a ` +
              `filesystem location. Declare it under ${dirsField} so it is contained, ` +
              `or use a value that is not a path.`,
            [...base, key]
          );
        }
      }
    }

    // ALL FOUR overlay maps are checked against each other, not just the two
    // pairs that share a parent.
    //
    // Checking only `dirs` vs `extraEnv` and `dirs` vs `env` left a live hole:
    // a key in TOP-LEVEL `dirs` and in `configIsolation.extraEnv` passed
    // validation, and since buildInvocationFromAdapter merges staticEnv before
    // isolationEnv, the contained relocation was silently replaced by the
    // uncontained setting. Demonstrated with `dirs: {FOO: "{{scratchDir}}/data"}`
    // and `configIsolation.extraEnv: {FOO: "pwned-config"}`: the partner
    // received the bare relative path, which it resolves against its own working
    // directory. Any key declared twice is a precedence question the manifest
    // did not intend to ask.
    const overlayMaps = [
      { field: "env", map: m.env, path: ["env"] },
      { field: "dirs", map: m.dirs, path: ["dirs"] },
      ...(m.configIsolation
        ? [
            {
              field: "configIsolation.dirs",
              map: m.configIsolation.dirs,
              path: ["configIsolation", "dirs"],
            },
            {
              field: "configIsolation.extraEnv",
              map: m.configIsolation.extraEnv,
              path: ["configIsolation", "extraEnv"],
            },
          ]
        : []),
    ];
    for (let i = 0; i < overlayMaps.length; i++) {
      for (let j = i + 1; j < overlayMaps.length; j++) {
        const a = overlayMaps[i];
        const b = overlayMaps[j];
        // CASE-FOLDED. Environment names are case-insensitive on Windows, so
        // `FOO` in one map and `foo` in another are one variable there -- and
        // they passed validation as two, producing an overlay whose effective
        // value was no longer guaranteed to be the contained relocation.
        const foldedB = new Map(Object.keys(b.map).map((k) => [k.toUpperCase(), k]));
        for (const key of Object.keys(a.map)) {
          if (foldedB.has(key.toUpperCase())) {
            fail(
              `${a.field}.${key} is also declared in ${b.field} (as ` +
                `${foldedB.get(key.toUpperCase())}); every one of these ` +
                "maps is merged into the same launch environment, so a key in two of " +
                "them silently resolves to whichever is merged last",
              [...a.path, key]
            );
          }
        }
      }
    }

    if (m.configIsolation) {
      const isolation = m.configIsolation;
      // Same rule the runtime enforces for extraEnv, and for the same reason:
      // the primary variable is set from the one value proven contained, and
      // nothing may redefine it.
      for (const field of ["dirs", "extraEnv"]) {
        const collides = Object.keys(isolation[field]).some(
          (key) => key.toUpperCase() === isolation.env.toUpperCase()
        );
        if (collides) {
          fail(
            `configIsolation.${field} may not redefine ${isolation.env}; that ` +
              "variable is set from configIsolation.dir",
            ["configIsolation", field, isolation.env]
          );
        }
      }
    }

    if (m.capabilities.toolProfiles === "flags" && !m.toolProfiles[m.defaultToolProfile]) {
      fail(
        `defaultToolProfile "${m.defaultToolProfile}" has no entry in toolProfiles`,
        ["defaultToolProfile"]
      );
    }
  });

/**
 * Parse one manifest, attributing any failure to the file it came from. The
 * source path is the single most useful thing in the error: a wrong flag in a
 * user-supplied manifest is otherwise very hard to trace.
 */
export function parseManifest(raw, sourcePath) {
  const result = AdapterManifest.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid adapter manifest at ${sourcePath}:\n${z.prettifyError(result.error)}`
    );
  }
  return { ...result.data, __sources: [sourcePath] };
}
