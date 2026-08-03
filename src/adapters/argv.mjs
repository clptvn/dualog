// Data-driven argv construction.
//
// The invocation context is normalized ONCE, up front: an effort the adapter
// does not accept becomes null, an unknown tool profile falls back to the
// adapter's default. Argv rules therefore never re-validate -- every condition
// is a plain "is this set" or "does this equal that" check, which is what keeps
// manifests reviewable for a CLI you cannot run.

import os from "os";
import {
  applyEffortSettingsFile,
  applyMcpSuppression,
  prepareConfigIsolation,
  partnerSentinelEnv,
  staticEnv,
} from "./env.mjs";
import { DEFAULT_REASONING_EFFORT } from "../runtime-defaults.mjs";
import {
  hasDiscoveryStrategy,
  isEnumerable,
  modelIds,
  resolveModelEntry,
} from "./schema.mjs";

/**
 * CLIs that accept an unsupported effort and quietly run at something else.
 *
 * Claude never rejects an invalid model/effort pair -- it clamps to `high` and
 * says nothing. That silence is the whole reason the per-model table has to be
 * enforced here: without it the host believes it got the effort it asked for,
 * and there is no signal anywhere that says otherwise.
 */
const SILENT_EFFORT_FALLBACK = { claude: "high" };

/**
 * Why a model could not be checked. Each branch sends the reader somewhere
 * different -- install the CLI, refresh the cache, or accept that this adapter
 * has no catalog at all -- so collapsing them would waste the warning.
 */
function unverifiableBecause(adapter, discovery) {
  if (!discovery) {
    return hasDiscoveryStrategy(adapter)
      ? `no model catalog was fetched for adapter "${adapter.id}", and its declared list is a hand-maintained snapshot`
      : `adapter "${adapter.id}" has no discovery source, so its model list cannot be established`;
  }
  if (discovery.strategy === "static") {
    return `discovery for adapter "${adapter.id}" fell back to its declared list, which is a hand-maintained snapshot rather than a catalog`;
  }
  if (discovery.stale) {
    return `the model catalog for adapter "${adapter.id}" is stale (${discovery.source}), so this model may simply be newer than the cache`;
  }
  return `discovery for adapter "${adapter.id}" returned no models (${discovery.source}), which cannot rule anything out`;
}

/**
 * Build the full template context for one partner turn, applying every
 * normalization rule. Also reports what was dropped, so the caller can surface
 * it rather than let the host agent believe it configured something it didn't.
 *
 * Every finding is a notice carrying its own severity and message. negotiate()
 * relays those verbatim into errors and warnings, so the preflight check and
 * the actual invocation can never disagree about what this turn will do.
 */
export function resolveContext(adapter, options) {
  const {
    projectPath,
    sessionDir,
    // The per-turn runtime lease: where every partner home, MCP config and
    // settings file for THIS turn is written. Separate from sessionDir because
    // the two have opposite lifetimes -- the session directory is an archive
    // kept for months, the lease is removed as soon as the turn's process is
    // proven gone. Conflating them is what left a credential copy in every
    // session ever run.
    scratchDir = null,
    sessionName = null,
    model = null,
    reasoningEffort = null,
    toolProfile = null,
    initialPrompt = null,
    allowUnknownModel = false,
    // A discovery result -- { models: [{id}], source } -- from discovery.mjs.
    // Supplying one is what turns an unrecognized model from a warning into a
    // rejection, because it is the only thing that establishes the full set.
    discoveredModels = null,
    // Whether an OMITTED effort should become the operator default.
    //
    // Off by default so this stays a pure function of its inputs: the golden
    // argv snapshots assert that asking for no effort produces no effort flag,
    // and that contract is what makes a manifest reviewable for a CLI you
    // cannot run. The paths that model a real start -- negotiate() and the two
    // invocation builders -- opt in, because for them "the caller said nothing"
    // does mean "use the house default".
    applyOperatorDefault = false,
  } = options;

  const sources = adapter.__sources?.join(" <- ") ?? "<unknown source>";
  const notices = [];
  const note = (notice) =>
    notices.push({
      severity: "warning",
      ...notice,
      // The historical message for a plain drop, kept verbatim so existing
      // callers' output does not move.
      message:
        notice.message ??
        `${notice.field}=${JSON.stringify(notice.requested)} was dropped: ${notice.reason}`,
    });

  const resolvedProfileName = adapter.toolProfiles[toolProfile]
    ? toolProfile
    : adapter.defaultToolProfile;
  if (toolProfile && resolvedProfileName !== toolProfile) {
    note({
      code: "dropped_tool_profile",
      field: "tool_profile",
      requested: toolProfile,
      applied: resolvedProfileName,
      reason:
        adapter.capabilities.toolProfiles === "flags"
          ? `"${toolProfile}" is not a tool profile this adapter defines`
          : `adapter "${adapter.id}" does not express tool profiles as flags`,
    });
  }
  const profile = adapter.toolProfiles[resolvedProfileName] ?? {};

  let effectiveModel = model;
  if (model && !adapter.capabilities.modelFlag) {
    effectiveModel = null;
    note({
      code: "dropped_model",
      field: "model",
      requested: model,
      applied: null,
      reason: `adapter "${adapter.id}" has no model flag`,
    });
  }

  // Model identity first: the effort set that applies is a property of the
  // MODEL, so nothing about effort can be decided until this is settled.
  const resolved = resolveModelEntry(adapter, effectiveModel);
  const manifestEntry = resolved.entry;

  // What may a model be REJECTED against?
  //
  // Only a live, non-empty, non-stale list -- see isEnumerable, which decides
  // that from the discovery RESULT rather than from the manifest. A declared
  // model list, a degraded fallback, a stale cache, and an empty answer all
  // fail it: being absent from any of those is not evidence that a model does
  // not exist. Without such a list, an unrecognized id can only be flagged.
  const catalog = isEnumerable(discoveredModels) ? discoveredModels : null;
  const catalogIds = catalog?.models.map((m) => m.id) ?? null;
  const modelKnown = catalogIds
    ? // An alias is never a catalog entry, so it is the resolved target that
      // has to appear in the fetched list.
      catalogIds.includes(resolved.canonicalId)
    : resolved.known;

  // A model that cannot call a tool cannot satisfy a sidecar-always completion
  // protocol: writing result.md and done.json IS a tool call. Such a turn does
  // not fail, it hangs -- the partner produces prose and never signals
  // completion -- so this has to be caught before spawning, where the reason is
  // still visible. Only a probe that positively reported no tool support can
  // trip it; an absent or failed probe leaves supportsTools undefined, and
  // unknown must never reject.
  const discoveredEntry = catalog?.models.find((m) => m.id === resolved.canonicalId) ?? null;

  // The per-model effort menu comes from the live catalog when there is one.
  //
  // The manifest list is a hand-maintained snapshot, and for several adapters it
  // is EMPTY -- opencode declares no models at all, so a manifest-only check has
  // nothing to check against and falls back to the adapter-wide union, which is
  // the widest possible set and rejects nothing. Discovery is what actually
  // knows: the Codex and Grok caches carry `efforts` per model, and models.dev
  // enrichment fills them in for the rest. Preferring it here is what makes the
  // start-time preflight agree with what the CLI will really accept.
  //
  // Manifest stays the fallback: a discovery result that carries no effort data
  // for this id must not erase what the manifest does know.
  const entry =
    discoveredEntry && Array.isArray(discoveredEntry.efforts)
      ? {
          ...manifestEntry,
          ...discoveredEntry,
          id: discoveredEntry.id ?? manifestEntry?.id ?? resolved.canonicalId,
        }
      : manifestEntry;
  const effortSource = entry === manifestEntry ? sources : (catalog?.source ?? sources);

  if (
    discoveredEntry?.supportsTools === false &&
    adapter.completion.sidecar === "always"
  ) {
    note({
      code: "model_cannot_call_tools",
      severity: "error",
      field: "model",
      requested: effectiveModel,
      applied: null,
      reason: `model "${resolved.canonicalId}" reports no "tools" capability`,
      message:
        `model "${resolved.canonicalId}" reports no "tools" capability, but adapter ` +
        `"${adapter.id}" requires the partner to write its completion sidecar with a ` +
        `tool call. Such a turn hangs rather than finishing. Reported by ${catalog.source}.`,
    });
  }

  if (effectiveModel && !modelKnown) {
    const validIds = catalogIds ?? modelIds(adapter);
    const aliases = Object.keys(adapter.modelAliases ?? {});
    const from = catalog?.source ?? sources;
    const inventory =
      `Valid ids: ${validIds.join(", ") || "(none)"}` +
      (aliases.length ? `. Aliases: ${aliases.join(", ")}` : "") +
      `. Source: ${from}`;

    if (!catalog) {
      // Not a rejection: nobody has established what this adapter routes to.
      // Still worth a warning -- "no error" must not read as "verified" -- and
      // the reason matters, since "not fetched" and "fetched and stale" send
      // whoever reads it to different places.
      const why = unverifiableBecause(adapter, discoveredModels);
      note({
        code: "unknown_model",
        severity: "warning",
        field: "model",
        requested: effectiveModel,
        applied: effectiveModel,
        reason: `${why}, so "${effectiveModel}" is passed through unverified`,
        message: `model ${JSON.stringify(effectiveModel)} could not be verified: ${why}. Declared ids: ${modelIds(adapter).join(", ") || "(none)"}. Declared in ${sources}`,
      });
    } else if (allowUnknownModel) {
      note({
        code: "unknown_model_allowed",
        severity: "info",
        field: "model",
        requested: effectiveModel,
        applied: effectiveModel,
        reason: `allow_unknown_model was set, so "${effectiveModel}" is passed through unchecked`,
        message: `model ${JSON.stringify(effectiveModel)} is absent from the catalog for adapter "${adapter.id}", but allow_unknown_model was set, so it is passed through unchecked. ${inventory}`,
      });
    } else {
      note({
        code: "unknown_model",
        severity: "error",
        field: "model",
        requested: effectiveModel,
        applied: effectiveModel,
        reason: `adapter "${adapter.id}" cannot route to "${effectiveModel}"`,
        message: `model ${JSON.stringify(effectiveModel)} is not one adapter "${adapter.id}" can route to. ${inventory}. Set allow_unknown_model to use it anyway.`,
      });
    }
  }

  // The operator default is applied HERE, after the model is known -- never by
  // the caller beforehand.
  //
  // Defaulting to the adapter-wide "high" before resolving the model turned an
  // omitted option into an invented request, and an invented request can be
  // rejected: claude-haiku-4-5 declares `efforts: []`, so omitting
  // reasoning_effort became `high`, which the model refuses, and no explicit
  // value existed that would have worked -- a listed model became impossible to
  // start. An omission must degrade to "send no flag and let the CLI apply the
  // model's own default", which is what defaultEffort below reports.
  //
  // A value the CALLER actually supplied is still validated and still errors:
  // silently ignoring an explicit request is the failure mode this whole file
  // exists to prevent. Only the absence of one is allowed to fall back.
  const callerSuppliedEffort = Boolean(reasoningEffort);
  let requestedEffort = reasoningEffort;
  if (applyOperatorDefault && !callerSuppliedEffort && adapter.capabilities.reasoningEffort) {
    // The MODEL's own default outranks the house default.
    //
    // gpt-5.6-sol runs at `low` unless told otherwise; substituting `high`
    // because nobody named a level would silently change the turn and hide the
    // real answer, which is what the default_effort_applied notice exists to
    // report. Omitting the flag is what makes the CLI apply that default, so
    // the right move for a model that declares one is to send nothing.
    const modelDeclaresDefault = typeof entry?.defaultEffort === "string" && entry.defaultEffort;

    if (!modelDeclaresDefault) {
      const operatorDefault = DEFAULT_REASONING_EFFORT;
      const adapterAccepts = adapter.reasoningEfforts.includes(operatorDefault);
      // ...and only if this model would actually take it. claude-haiku-4-5
      // declares `efforts: []`, so inventing `high` made a listed model
      // impossible to start: the invented value was refused and no explicit
      // value would have worked either.
      const modelAccepts =
        !Array.isArray(entry?.efforts) || entry.efforts.includes(operatorDefault);
      if (adapterAccepts && modelAccepts) requestedEffort = operatorDefault;
    }
  }

  let effectiveEffort = requestedEffort;

  // Aliases resolve before any check, so a caller's vocabulary never surfaces
  // as an unsupported effort.
  const aliasTarget = requestedEffort
    ? adapter.effortAliases?.[requestedEffort]
    : null;
  if (aliasTarget) {
    effectiveEffort = aliasTarget;
    note({
      code: "effort_alias_applied",
      severity: "info",
      field: "reasoning_effort",
      requested: requestedEffort,
      applied: aliasTarget,
      reason: `adapter "${adapter.id}" treats "${requestedEffort}" as an alias of "${aliasTarget}"`,
      message: `reasoning_effort ${JSON.stringify(requestedEffort)} was translated to ${JSON.stringify(aliasTarget)}: adapter "${adapter.id}" does not use the name "${aliasTarget}"`,
    });
  }

  if (effectiveEffort && !adapter.reasoningEfforts.includes(effectiveEffort)) {
    effectiveEffort = null;
    note({
      code: "dropped_reasoning_effort",
      field: "reasoning_effort",
      requested: requestedEffort,
      applied: null,
      reason: adapter.capabilities.reasoningEffort
        ? `adapter "${adapter.id}" accepts ${adapter.reasoningEfforts.join(", ")}`
        : `adapter "${adapter.id}" does not expose reasoning effort`,
    });
  }

  // Per-MODEL validity. An adapter-wide effort list can only ever be the union
  // across every model, so passing this check says nothing about the model in
  // hand -- which is exactly the case Claude answers by clamping in silence.
  if (effectiveEffort && entry?.efforts) {
    const silent = SILENT_EFFORT_FALLBACK[adapter.id];
    const clamp = silent
      ? ` ${adapter.displayName} would silently run this at \`${silent}\`.`
      : "";

    if (entry.efforts.length === 0) {
      effectiveEffort = null;
      note({
        code: "effort_unsupported_by_model",
        severity: "error",
        field: "reasoning_effort",
        requested: requestedEffort,
        applied: null,
        reason: `model "${entry.id}" accepts no reasoning effort at all`,
        message: `model "${entry.id}" accepts no reasoning effort at all, so reasoning_effort ${JSON.stringify(requestedEffort)} cannot be honored. Declared in ${effortSource}.${clamp}`,
      });
    } else if (!entry.efforts.includes(effectiveEffort)) {
      effectiveEffort = null;
      note({
        code: "effort_unsupported_by_model",
        severity: "error",
        field: "reasoning_effort",
        requested: requestedEffort,
        applied: null,
        reason: `model "${entry.id}" accepts ${entry.efforts.join(", ")}`,
        message: `reasoning_effort ${JSON.stringify(requestedEffort)} is not accepted by model "${entry.id}", which accepts ${entry.efforts.join(", ")}. Declared in ${effortSource}.${clamp}`,
      });
    }
  }

  // The CLI's own default for this model. It is reported, never restated in the
  // invocation: omitting the flag is what makes the CLI apply exactly this
  // value, so passing it would change the command line without changing the
  // turn. What the host needs is the answer to "what will this actually run
  // at", and that is what the notice carries.
  let defaultEffort = null;
  if (!reasoningEffort && entry?.defaultEffort) {
    defaultEffort = entry.defaultEffort;
    note({
      code: "default_effort_applied",
      severity: "info",
      field: "reasoning_effort",
      requested: null,
      applied: defaultEffort,
      reason: `${adapter.displayName} runs "${entry.id}" at "${defaultEffort}" when no effort is given`,
      message: `no reasoning_effort was given; ${adapter.displayName} runs "${entry.id}" at ${JSON.stringify(defaultEffort)} by default`,
    });
  }

  const ctx = {
    home: os.homedir(),
    projectPath,
    sessionDir,
    scratchDir,
    sessionName,
    model: effectiveModel,
    reasoningEffort: effectiveEffort,
    reasoningEffortJson: effectiveEffort ? JSON.stringify(effectiveEffort) : null,
    initialPrompt,
    toolProfile: resolvedProfileName,
    toolProfileAllowedTools: profile.allowedTools ?? null,
    toolProfileDisallowedTools: profile.disallowedTools ?? null,
    mcpConfigPath: null,
  };

  return {
    ctx,
    notices,
    resolution: {
      model: effectiveModel,
      modelId: resolved.canonicalId,
      modelKnown,
      modelVerifiedAgainst: catalog?.source ?? null,
      modelEntry: entry,
      efforts: entry?.efforts ?? null,
      reasoningEffort: effectiveEffort,
      defaultEffort,
      // What the turn will actually run at, whether we said so or the CLI did.
      effectiveEffort: effectiveEffort ?? defaultEffort,
    },
  };
}

function renderTemplate(template, ctx, adapter, field) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = ctx[key];
    if (value == null) {
      throw new Error(
        `Adapter "${adapter.id}" ${field} references {{${key}}}, which is not set for this turn. ` +
          `Declared in ${adapter.__sources?.join(", ") ?? "<unknown source>"}`
      );
    }
    return String(value);
  });
}

function isSet(value) {
  return value != null && String(value).length > 0;
}

function conditionHolds(condition, ctx) {
  if (!condition) return true;
  if ("set" in condition) return isSet(ctx[condition.set]);
  if ("notSet" in condition) return !isSet(ctx[condition.notSet]);
  if ("equals" in condition) {
    return String(ctx[condition.equals.key] ?? "") === condition.equals.value;
  }
  return false;
}

/** Evaluate the adapter's argv rules for one engine, in declaration order. */
export function buildArgs(adapter, engine, ctx) {
  const rules = adapter.argv[engine];
  if (!rules?.length) {
    throw new Error(
      `Adapter "${adapter.id}" declares no argv for engine "${engine}". ` +
        `Declared in ${adapter.__sources?.join(", ") ?? "<unknown source>"}`
    );
  }

  const args = [];
  for (const [index, rule] of rules.entries()) {
    if (!conditionHolds(rule.when, ctx)) continue;
    for (const template of rule.args) {
      args.push(
        renderTemplate(template, ctx, adapter, `argv.${engine}[${index}]`)
      );
    }
  }
  return args;
}

/**
 * Build a complete partner invocation from an adapter manifest.
 *
 * Performs the filesystem side effects the invocation depends on -- creating
 * the isolated config dir and writing an empty MCP config -- because argv can
 * reference their paths.
 */
export function buildInvocationFromAdapter(adapter, options) {
  const engine = options.engine ?? adapter.engines.default;
  if (!adapter.engines.allowed.includes(engine)) {
    throw new Error(
      `Adapter "${adapter.id}" does not allow engine "${engine}" ` +
        `(allowed: ${adapter.engines.allowed.join(", ")}). ` +
        `Declared in ${adapter.__sources?.join(", ") ?? "<unknown source>"}`
    );
  }

  const { ctx, notices, resolution } = resolveContext(adapter, options);

  // Order matters: the isolated config dir must exist before anything is seeded
  // into it or written into it, and the MCP config path must be resolved before
  // argv references it.
  const isolationEnv = prepareConfigIsolation(adapter, ctx);
  const effortSettingsPath = applyEffortSettingsFile(adapter, ctx, isolationEnv);
  ctx.mcpConfigPath = applyMcpSuppression(adapter, ctx);

  const args = buildArgs(adapter, engine, ctx);

  return {
    command: options.partnerCommand || adapter.binary.default,
    args,
    // Sentinel last: nothing an adapter declares may override the recursion
    // guard, since that is the one protection every partner depends on.
    env: { ...staticEnv(adapter, ctx), ...isolationEnv, ...partnerSentinelEnv() },
    usesInitialPrompt:
      adapter.promptDelivery[engine] === "argv" && isSet(ctx.initialPrompt),
    engine,
    notices,
    resolution,
    effortSettingsPath,
  };
}
