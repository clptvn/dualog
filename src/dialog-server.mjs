import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { spawn, execSync, execFileSync } from "child_process";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  DIALOGS_DIR,
  LEGACY_DIALOGS_DIR,
  resolveExistingSessionDir,
  getAgentDisplayName,
  getSessionHostAgent,
  getSessionPartnerAgent,
  normalizeAgent,
  readConversation,
  appendMessage,
  readStatus,
  computeReviewStatus,
  isProcessAlive,
} from "./shared.mjs";
import {
  inspectPartnerTerminal,
  probeTmuxSession,
  readTerminalState,
  sendKeyToTmux,
  terminateCurrentPartnerTerminal,
  TMUX_NAMED_KEYS,
  tmuxPaneBelongsToSession,
} from "./tmux-runtime.mjs";
import {
  ALL_REASONING_EFFORTS,
  MAX_REVIEW_DIFF_CHARS,
  requestedReasoningEffortForAdapter,
} from "./runtime-defaults.mjs";
import {
  buildRunnerTokenArg,
  isSessionRunnerAlive,
  markSessionRunnerStarted,
  probeSessionRunner,
  watchRunnerExit,
} from "./runner-lifecycle.mjs";
import {
  adapterIds,
  getAdapter,
  listAdapters,
  tryGetAdapter,
} from "./adapters/registry.mjs";
import { describeAdapter, negotiate } from "./adapters/negotiate.mjs";
import { isEnumerable, modelIds } from "./adapters/schema.mjs";
import { resolveDiscovery } from "./adapters/discovery.mjs";
import { resolveDiscoveryForValidation } from "./adapters/resolve-for-validation.mjs";
import {
  ASPECT_HEADER_RE,
  ASPECT_IDS,
  CONSOLIDATED_HEADER_RE,
  FINDING_CATEGORIES,
  PR_REVIEW_ASPECTS,
  extractAspectResult,
  extractNormalizedFindings,
  selectAspects,
} from "./pr-review-aspects.mjs";
import { ENGINES, resolveEngine } from "./engines/index.mjs";
import { reapOrphanedHeadlessChildren } from "./engines/headless.mjs";
import { sweepLeases } from "./runtime-lease.mjs";

const server = new McpServer({
  name: "dualog",
  version: "2.0.0",
});

// ── Recursion guard ──────────────────────────────────────────────────────────
// A partner CLI spawned by this server inherits our environment. If that CLI is
// itself an MCP client configured with this same server, it would boot a nested
// copy and recurse. Per-CLI "disable MCP" switches do not cover this: several
// partner CLIs have no reliable zero-MCP flag, and some read MCP config from
// homedir() regardless of their config-dir override.
//
// This env sentinel is the one defense that works for every partner CLI without
// needing its cooperation. Env inherits transitively, so it also catches the
// A -> B -> C case. Set in partner-invocation.mjs on every spawned partner.
const MAX_PARTNER_DEPTH = (() => {
  const parsed = Number.parseInt(process.env.DUALOG_MAX_DEPTH, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
})();
const PARTNER_DEPTH = (() => {
  const parsed = Number.parseInt(process.env.DUALOG_DEPTH ?? "0", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
})();
const RECURSION_BLOCKED =
  process.env.DUALOG_ROLE === "partner" || PARTNER_DEPTH >= MAX_PARTNER_DEPTH;

if (RECURSION_BLOCKED) {
  // Serve an empty tool list rather than exiting: the partner CLI connects
  // cleanly and simply sees no tools, instead of reporting a failed MCP server.
  //
  // Suppressing registration alone is not enough. The SDK only wires up the
  // tools/list handler and advertises the tools capability when the first tool
  // is registered, so a server with zero tools answers tools/list with
  // "Method not found" -- which reads as a broken server, not an empty one.
  // Register the capability and an empty handler explicitly.
  server.tool = () => {};
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
}

// Agent choices come from the adapter registry, so adding a CLI is a manifest
// drop-in rather than a source edit. Still a closed enum, so MCP clients get
// completions and a typo fails at the tool boundary rather than at spawn time.
const AGENT_IDS = adapterIds();
const AGENT_CHOICE_DESCRIPTION =
  "Which agent responds in the background runner (default: 'codex'). " +
  "Call list_adapters first to see which of these are actually installed: " +
  AGENT_IDS.join(", ") + ".";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PARTNER_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_PARTNER_TIMEOUT_MS = 60 * 1000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const MAX_WAIT_TIMER_MS = 2_147_483_647;
const WAIT_FALLBACK_INTERVAL_MS = 5000;
const WAIT_PROGRESS_INTERVAL_MS = 30000;
const END_DIALOG_GRACE_MS = 5500;
const END_DIALOG_POLL_MS = 100;
const MODEL_OVERRIDE_DESCRIPTION =
  "Optional partner model override, forwarded verbatim to the selected partner CLI. " +
  "An id absent from a LIVE catalog is rejected; where no live catalog can be " +
  "fetched it is passed through with a warning instead, because a declared list " +
  "is a hand-maintained snapshot and vendors ship new ids continuously. Set " +
  "allow_unknown_model to start anyway. Known ids by agent: " +
  listAdapters()
    // modelIds, not `models`: an entry may be an object carrying that model's
    // own effort set, and interpolating those directly renders "[object
    // Object]" into the tool description every MCP client sees.
    .map((adapter) => [adapter.id, modelIds(adapter)])
    .filter(([, ids]) => ids.length)
    .map(([id, ids]) => `${id}: ${ids.join(", ")}`)
    .join(" | ") +
  ".";
const REASONING_EFFORT_DESCRIPTION =
  "Optional reasoning effort. Omit it to use the model's own default, which is " +
  "the right choice unless you specifically need another level; omitting falls " +
  "back to high only for models that declare no default of their own. Validated " +
  "per MODEL, not just per agent: a level the chosen model does not accept is an " +
  "ERROR that refuses the call, because a silently dropped effort would leave you " +
  "reasoning about a setting that never applied. The lists below are each agent's " +
  "union across all its models -- call list_models for one model's actual set. " +
  "Accepted values by agent: " +
  listAdapters()
    .filter((a) => a.reasoningEfforts.length)
    .map((a) => `${a.id}: ${a.reasoningEfforts.join("|")}`)
    .join(" | ") +
  ". Agents not listed do not expose reasoning effort.";
const ALL_EFFORTS = [
  ...new Set([...ALL_REASONING_EFFORTS, ...listAdapters().flatMap((a) => a.reasoningEfforts)]),
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveSessionDir(sessionId) {
  if (!/^(dialog|review)-\d+-[0-9a-f]+$/.test(sessionId)) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }
  // New sessions land under the current root; sessions created before the
  // rename are still readable in place rather than orphaned.
  return resolveExistingSessionDir(sessionId);
}

function readConv(sessionId) {
  return readConversation(resolveSessionDir(sessionId));
}

function appendMsg(sessionId, from, content) {
  return appendMessage(resolveSessionDir(sessionId), from, content);
}

function readStat(sessionId) {
  return readStatus(resolveSessionDir(sessionId));
}

function readProblem(sessionDir) {
  const problemPath = path.join(sessionDir, "problem.md");
  if (!fs.existsSync(problemPath)) return "";
  try {
    return fs.readFileSync(problemPath, "utf-8");
  } catch {
    return "";
  }
}

function readOptionalText(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}

/** A missing or half-written sidecar reads as absent, never as a thrown tool call. */
function readOptionalJson(filePath) {
  const text = readOptionalText(filePath);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolvePartnerCommandValue(
  partnerAgent,
  partnerCommand,
  codexCommand,
  claudeCommand
) {
  if (partnerCommand) return partnerCommand;
  // Legacy per-agent aliases, kept working for existing callers.
  if (partnerAgent === "claude" && claudeCommand) return claudeCommand;
  if (partnerAgent === "codex" && codexCommand) return codexCommand;
  try {
    return getAdapter(partnerAgent).binary.default;
  } catch {
    return partnerAgent;
  }
}

function getProcessingPath(sessionDir) {
  const partnerPath = path.join(sessionDir, "partner_processing");
  if (fs.existsSync(partnerPath)) return partnerPath;
  return path.join(sessionDir, "codex_processing");
}

function unlinkProcessingMarkers(sessionDir) {
  for (const marker of ["partner_processing", "codex_processing"]) {
    try {
      fs.unlinkSync(path.join(sessionDir, marker));
    } catch {}
  }
}

function writeFileAtomic(targetPath, content) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content);
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

function resolveSubjectPath(subjectPath, projectPath) {
  if (!subjectPath) return null;

  const resolvedProjectPath = projectPath || process.cwd();
  const resolvedPath = path.isAbsolute(subjectPath)
    ? subjectPath
    : path.resolve(resolvedProjectPath, subjectPath);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Subject path is not a file: ${subjectPath}`);
  }
  return resolvedPath;
}

function computeBudget(status, messages) {
  const maxRounds = status?.max_rounds ?? 5;
  const hardCap = status?.hard_cap ?? maxRounds + 5;
  const partnerAgent = getSessionPartnerAgent(status);
  // Only real partner turns count toward the budget. System notices (idle
  // shutdown, hard-cap reached, error shutdown, etc.) use from: "system"
  // and must not inflate rounds_used past hard_cap.
  const roundsUsed = messages.filter((m) => m.from === partnerAgent).length;
  const roundsRemaining = Math.max(0, maxRounds - roundsUsed);
  const hardRoundsRemaining = Math.max(0, hardCap - roundsUsed);
  return {
    max_rounds: maxRounds,
    hard_cap: hardCap,
    rounds_used: roundsUsed,
    rounds_remaining: roundsRemaining,
    hard_rounds_remaining: hardRoundsRemaining,
    past_soft_cap: roundsUsed > maxRounds,
  };
}

function extractReferencedFiles(messages, projectPath, partnerAgent = "codex") {
  const raw = new Set();
  for (const msg of messages) {
    if (msg.from !== partnerAgent) continue;
    const content = msg.content;
    // Primary: structured REFERENCED_FILES line (machine-readable, the partner fills this in)
    const refMatch = content.match(/^REFERENCED_FILES:\s*(.+)$/m);
    if (refMatch) {
      for (const entry of refMatch[1].split(/,\s*/)) {
        const p = entry.trim().replace(/:\d+(?::\d+)?$/, "");
        if (p) raw.add(p);
      }
    }
    // Fallback: markdown links [text](/path/to/file) or [text](/path/to/file:line)
    for (const m of content.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
      let p = m[2].replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
      if (p.includes("/") && !p.startsWith("http")) raw.add(p);
    }
    // Fallback: backtick paths — with or without directory separators.
    // Permissive match; filesystem validation filters false positives.
    for (const m of content.matchAll(/`([^`\s]+\.[a-zA-Z]{1,5}(?::\d+)?)`/g)) {
      let p = m[1].replace(/:\d+(?::\d+)?$/, "");
      raw.add(p);
    }
  }
  // Resolve against project root and validate existence
  let resolvedRoot;
  try {
    resolvedRoot = fs.realpathSync(projectPath || process.cwd());
  } catch {
    resolvedRoot = path.resolve(projectPath || process.cwd());
  }
  const validated = new Set();
  for (const p of raw) {
    let resolved = path.isAbsolute(p)
      ? p.replace(/#.*$/, "")
      : path.resolve(resolvedRoot, p);
    try {
      resolved = fs.realpathSync(resolved);
      if (!fs.statSync(resolved).isFile()) continue;
    } catch {
      continue; // doesn't exist or not a file — skip
    }
    const rel = path.relative(resolvedRoot, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    validated.add(resolved);
  }
  return [...validated];
}

function getLatestMessageId(messages) {
  return messages.length > 0 ? messages[messages.length - 1].id : 0;
}

function getWakeMessages(messages, status, sinceId, includeSystem) {
  const partnerAgent = getSessionPartnerAgent(status);
  return messages.filter(
    (m) =>
      m.id > sinceId &&
      (m.from === partnerAgent || (includeSystem && m.from === "system"))
  );
}

function normalizePartnerTimeout(timeoutMs) {
  if (timeoutMs == null) return DEFAULT_PARTNER_TIMEOUT_MS;
  return Math.max(MIN_PARTNER_TIMEOUT_MS, timeoutMs);
}

/**
 * The single preflight both start tools run before a session exists.
 *
 * Every option-level check (model known, effort accepted by the adapter AND by
 * the specific model, alias translation, tool profile) comes from the same
 * resolveContext() the argv builder uses, so the answer here cannot disagree
 * with what the spawned turn would actually do.
 *
 * Returns { ok, effort, model, errorText, warnings }. On !ok the caller must
 * not create a session: an error-severity finding means the turn would run with
 * something the caller asked for silently missing.
 */
async function preflightPartner(partnerAgent, {
  partnerCommand,
  model,
  reasoningEffort,
  toolProfile,
  projectPath,
  allowUnknownModel = false,
}) {
  const adapter = tryGetAdapter(partnerAgent);
  if (!adapter) {
    return {
      ok: false,
      errorText: `Unknown partner_agent "${partnerAgent}". Known adapters: ${adapterIds().join(", ")}`,
    };
  }

  let engine;
  try {
    engine = resolveEngine(adapter);
  } catch (err) {
    return { ok: false, errorText: err.message };
  }

  const requestedEffort = requestedReasoningEffortForAdapter(reasoningEffort);

  // Discovery is what turns "this id is not in the manifest" into a rejection
  // rather than a shrug, and it is the only thing that knows whether a locally
  // served model can call tools at all. It never throws and never blocks for
  // long: `none`/`static` short-circuit without I/O, results are cached, and
  // any failure degrades to the static list.
  const discoveredModels = await resolveDiscoveryForValidation(adapter, {
    model,
    projectPath,
  });

  let result;
  try {
    result = negotiate(adapter, {
      engine,
      partnerCommand,
      toolProfile: toolProfile || "read",
      model: model || null,
      reasoningEffort: requestedEffort,
      projectPath: projectPath || process.cwd(),
      sessionDir: projectPath || process.cwd(),
      discoveredModels,
      allowUnknownModel,
    });
  } catch (err) {
    return { ok: false, errorText: err.message };
  }

  if (result.errors.length) {
    const lines = result.errors.map((e) => `  - [${e.code}] ${e.message}`);
    return {
      ok: false,
      errorText:
        `Cannot start a ${adapter.displayName} session as requested:\n${lines.join("\n")}\n\n` +
        `Call list_models for "${partnerAgent}" to see what this model accepts.`,
      warnings: result.warnings,
    };
  }

  return {
    ok: true,
    // What the caller asked for, echoed back untouched. This is the only field
    // that can prove the parameter survived transport: `effort` below is the
    // RESOLVED value, and a legitimate alias translation (goose maps xhigh ->
    // max) makes it differ for reasons that have nothing to do with loss.
    requestedModel: model ?? null,
    requestedEffort: reasoningEffort ?? null,
    // What the turn will actually run as, which is not always what was asked
    // for -- an alias may have been translated, or the CLI's own default used.
    //
    // A deliberate null must survive. `?? requestedEffort` looked like a
    // harmless fallback but inverted the meaning of the one answer that matters:
    // resolveContext() returns null precisely when it DROPPED the effort (Cursor
    // exposes no effort control), and coalescing put the dropped value back, so
    // status and the tool response both claimed an effort the turn would never
    // apply. Only fall back when resolveContext did not run at all.
    effort: result.resolution ? result.resolution.reasoningEffort : requestedEffort ?? null,
    // What the CLI will actually run at, including its own default when we pass
    // no flag -- reported separately because "we sent nothing" and "it will run
    // at nothing" are different facts.
    effectiveEffort: result.resolution?.effectiveEffort ?? null,
    model: result.resolution ? result.resolution.model : model ?? null,
    warnings: result.warnings ?? [],
    // Info-severity findings are deliberately excluded from `warnings` by
    // negotiate(), but they are the ones that EXPLAIN a difference between what
    // was requested and what resolved -- effort_alias_applied and
    // default_effort_applied both live here. Without them the docs were citing
    // notices no caller could ever see.
    notices: result.notices ?? [],
  };
}

/**
 * How to describe the effort in a human-readable summary.
 *
 * The summary must not contradict the structured fields beside it. Printing the
 * FLAG (`reasoning_effort`) says "null" whenever we deliberately send no flag
 * and let the model's own default apply -- which reads as "no effort setting"
 * when the turn will in fact run at the model's default. The effective value is
 * the one a human is asking about.
 */
function describeEffort(flagEffort, effectiveEffort) {
  if (effectiveEffort && flagEffort && effectiveEffort !== flagEffort) {
    return `${effectiveEffort} (requested flag: ${flagEffort})`;
  }
  if (effectiveEffort) {
    return flagEffort ? effectiveEffort : `${effectiveEffort} (the model's own default; no flag sent)`;
  }
  return "not configurable for this adapter";
}

function normalizeWaitTimeout(timeoutMs) {
  if (timeoutMs == null) {
    return DEFAULT_WAIT_TIMEOUT_MS;
  }
  return Math.min(MAX_WAIT_TIMER_MS, Math.max(MIN_WAIT_TIMEOUT_MS, timeoutMs));
}

function buildSessionSnapshot(sessionId, options = {}) {
  const sessionDir = resolveSessionDir(sessionId);
  const sinceId = options.sinceId || 0;
  const messages = readConversation(sessionDir);
  const newMessages = messages.filter((m) => m.id > sinceId);
  const status = readStatus(sessionDir);
  const hostAgent = getSessionHostAgent(status);
  const partnerAgent = getSessionPartnerAgent(status);
  const runnerAlive = isSessionRunnerAlive(status, sessionDir);
  const processingPath = getProcessingPath(sessionDir);
  const partnerProcessing = fs.existsSync(processingPath);
  const errorPath = path.join(sessionDir, "last_error.txt");
  const lastError = readOptionalText(errorPath);
  const budget = computeBudget(status, messages);
  const reviewStatus = computeReviewStatus(status, messages, {
    problem: readProblem(sessionDir),
  });
  const projectPath = status?.project_path || process.cwd();
  const referencedFiles = extractReferencedFiles(
    newMessages,
    projectPath,
    partnerAgent
  );
  const terminalState = readTerminalState(sessionDir);
  const activeTerminal = terminalState.current;

  const payload = {
    new_messages: newMessages,
    total_messages: messages.length,
    latest_id: getLatestMessageId(messages),
    host_agent: hostAgent,
    partner_agent: partnerAgent,
    partner_timeout_ms: normalizePartnerTimeout(status?.partner_timeout_ms),
    partner_runner_alive: runnerAlive,
    partner_currently_processing: partnerProcessing,
    ...(partnerAgent === "codex"
      ? {
          codex_runner_alive: runnerAlive,
          codex_currently_processing: partnerProcessing,
        }
      : {}),
    last_error: lastError,
    partner_terminal: activeTerminal
      ? {
          active: true,
          status: activeTerminal.status || "unknown",
          session_name: activeTerminal.session_name,
          pane_target: activeTerminal.pane_target,
          agent: activeTerminal.agent || partnerAgent,
          started_at: activeTerminal.started_at || null,
          updated_at: activeTerminal.updated_at || null,
          turn_dir: activeTerminal.turn_dir || null,
        }
      : {
          active: false,
          last_status: terminalState.last?.status || null,
          last_session_name: terminalState.last?.session_name || null,
          last_completed_at: terminalState.last?.completed_at || null,
          last_capture_path: terminalState.last?.last_capture_path || null,
        },
    budget,
    review_status: reviewStatus,
    referenced_files: referencedFiles,
  };

  return {
    payload,
    internal: {
      sessionDir,
      messages,
      status,
      processingPath,
      errorPath,
      endSignalPath: path.join(sessionDir, "end_signal"),
    },
  };
}

function hasHardCapReached(snapshot) {
  return Boolean(
    snapshot.payload.review_status?.hard_cap_reached ||
      snapshot.payload.budget?.hard_rounds_remaining === 0
  );
}

function classifyWaitResult(snapshot, sinceId, includeSystem) {
  if (snapshot.payload.last_error) return "error";
  if (fs.existsSync(snapshot.internal.endSignalPath)) return "ended";
  if (hasHardCapReached(snapshot)) return "hard_cap";
  if (!snapshot.payload.partner_runner_alive) return "runner_exited";
  if (
    getWakeMessages(
      snapshot.internal.messages,
      snapshot.internal.status,
      sinceId,
      includeSystem
    ).length > 0
  ) {
    return "message";
  }
  return null;
}

function addWaitMetadata(snapshot, waitResult, startedAt, timedOut = false) {
  return {
    ...snapshot.payload,
    wait_result: waitResult,
    waited_ms: Date.now() - startedAt,
    timed_out: timedOut,
    next_since_id: snapshot.payload.latest_id,
  };
}

function safeWatch(targetPath, onChange, watchers) {
  try {
    const watcher = fs.watch(targetPath, onChange);
    watchers.push(watcher);
    return true;
  } catch {
    return false;
  }
}

async function sendWaitProgress(extra, progressToken, startedAt, timeoutMs) {
  if (progressToken == null) return;
  const elapsedMs = Date.now() - startedAt;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: elapsedMs,
        total: timeoutMs,
        message: `Waiting for partner response, ${Math.floor(elapsedMs / 1000)}s elapsed`,
      },
    });
  } catch {
    // Progress is best-effort; clients may omit or ignore progress support.
  }
}

function waitForSessionChange(sessionId, options, extra) {
  const sinceId = options.sinceId || 0;
  const includeSystem = options.includeSystem !== false;
  const startedAt = Date.now();
  const sessionDir = resolveSessionDir(sessionId);
  const timeoutMs = normalizeWaitTimeout(options.timeoutMs);
  const conversationPath = path.join(sessionDir, "conversation.jsonl");
  const errorPath = path.join(sessionDir, "last_error.txt");
  const endSignalPath = path.join(sessionDir, "end_signal");
  const progressToken = extra?._meta?.progressToken;

  return new Promise((resolve) => {
    let done = false;
    const watchers = [];
    let fallbackTimer = null;
    let timeoutTimer = null;
    let progressTimer = null;

    const cleanup = () => {
      for (const watcher of watchers) {
        try { watcher.close(); } catch {}
      }
      if (fallbackTimer) clearInterval(fallbackTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (progressTimer) clearInterval(progressTimer);
      extra?.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (snapshot, waitResult, timedOut = false) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(addWaitMetadata(snapshot, waitResult, startedAt, timedOut));
    };

    const readSnapshot = () => buildSessionSnapshot(sessionId, { sinceId });

    const check = () => {
      if (done) return;
      if (extra?.signal?.aborted) {
        finish(readSnapshot(), "cancelled");
        return;
      }
      const snapshot = readSnapshot();
      const waitResult = classifyWaitResult(snapshot, sinceId, includeSystem);
      if (waitResult) finish(snapshot, waitResult);
    };

    const onAbort = () => {
      if (done) return;
      finish(readSnapshot(), "cancelled");
    };

    const onTimeout = () => {
      if (done) return;
      const snapshot = readSnapshot();
      const waitResult = snapshot.payload.partner_currently_processing
        ? "timeout_processing"
        : "timeout_idle";
      finish(snapshot, waitResult, true);
    };

    const onFileChange = () => {
      setImmediate(check);
    };

    safeWatch(sessionDir, onFileChange, watchers);
    safeWatch(conversationPath, onFileChange, watchers);
    if (fs.existsSync(errorPath)) safeWatch(errorPath, onFileChange, watchers);
    if (fs.existsSync(endSignalPath)) safeWatch(endSignalPath, onFileChange, watchers);

    fallbackTimer = setInterval(check, WAIT_FALLBACK_INTERVAL_MS);
    timeoutTimer = setTimeout(onTimeout, timeoutMs);
    progressTimer = setInterval(
      () => sendWaitProgress(extra, progressToken, startedAt, timeoutMs),
      WAIT_PROGRESS_INTERVAL_MS
    );
    extra?.signal?.addEventListener("abort", onAbort, { once: true });

    check();
  });
}

// ── Dialog Tools ────────────────────────────────────────────────────────────

server.tool(
  "start_dialog",
  "Start a new discussion session with a partner CLI. By default the host is Claude and the partner is Codex, but the session can be inverted so Codex hosts and Claude is the partner. Enforces a soft round budget (default 5) with a hard cap 5 rounds past that. Use subject_path for reviewed documents that should be reread each round, and tool_profile='implementation' only when the partner should edit files. The response echoes back the model, reasoning_effort, and other settings it actually used -- compare them against what you passed, because an omitted parameter and one lost in transit are indistinguishable here, and the echo is the only place a dropped setting becomes visible.",
  {
    problem_description: z
      .string()
      .describe("The problem to discuss with the partner agent"),
    project_path: z
      .string()
      .optional()
      .describe("Path to the project directory for context"),
    host_agent: z
      .enum(AGENT_IDS)
      .optional()
      .describe("Which agent is orchestrating the session (default: 'claude')"),
    partner_agent: z
      .enum(AGENT_IDS)
      .optional()
      .describe(AGENT_CHOICE_DESCRIPTION),
    partner_command: z
      .string()
      .optional()
      .describe("Command to invoke the partner CLI. Overrides the agent-specific defaults."),
    codex_command: z
      .string()
      .optional()
      .describe("Deprecated alias for partner_command when partner_agent='codex'"),
    claude_command: z
      .string()
      .optional()
      .describe("Alias for partner_command when partner_agent='claude'"),
    max_rounds: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Soft round budget (default: 5). The partner is asked to deliver all feedback within this many rounds. Hard cap = max_rounds + 5. Do not override unless the user explicitly requested a different budget."
      ),
    reasoning_effort: z
      .enum(ALL_EFFORTS)
      .optional()
      .describe(REASONING_EFFORT_DESCRIPTION),
    model: z
      .string()
      .optional()
      .describe(MODEL_OVERRIDE_DESCRIPTION),
    partner_timeout_ms: z
      .number()
      .int()
      .min(MIN_PARTNER_TIMEOUT_MS)
      .optional()
      .describe("Backward-compatible wait-time hint in milliseconds (default: 900000 = 15 minutes). Interactive tmux partner turns are not killed by this value."),
    tool_profile: z
      .enum(["read", "implementation"])
      .optional()
      .describe(
        "Partner tool access profile. 'read' is the default for analysis/review; 'implementation' permits file editing for implementation collaboration."
      ),
    subject_path: z
      .string()
      .optional()
      .describe(
        "Optional path to a reviewed document, such as a plan or spec. The runner rereads this file before each partner turn and includes the current contents as authoritative context."
      ),
    subject_kind: z
      .enum(["plan", "spec", "document"])
      .optional()
      .describe("Kind of reviewed document at subject_path. Used only for prompt labels."),
    allow_unknown_model: z
      .boolean()
      .optional()
      .describe(
        "Start with a model this server's catalog does not list. Only has an effect when a live catalog was consulted -- without one an unrecognized model is already just a warning."
      ),
  },
  async ({
    problem_description,
    project_path,
    host_agent,
    partner_agent,
    partner_command,
    codex_command,
    claude_command,
    max_rounds,
    reasoning_effort,
    model,
    partner_timeout_ms,
    tool_profile,
    subject_path,
    subject_kind,
    allow_unknown_model,
  }) => {
    const hostAgent = normalizeAgent(host_agent, "claude");
    const partnerAgent = normalizeAgent(partner_agent, "codex");
    if (hostAgent === partnerAgent) {
      return {
        content: [
          {
            type: "text",
            text: "Error: host_agent and partner_agent must be different",
          },
        ],
      };
    }
    const softCap = max_rounds || 5;
    const hardCap = softCap + 5;
    const partnerTimeoutMs = normalizePartnerTimeout(partner_timeout_ms);
    const partnerCommand = resolvePartnerCommandValue(
      partnerAgent,
      partner_command,
      codex_command,
      claude_command
    );
    const partnerDisplay = getAgentDisplayName(partnerAgent);
    const resolvedProjectPath = project_path || process.cwd();

    // Validate against the selected adapter before a session directory exists.
    // Reaching the runner with an effort the model rejects used to produce a
    // live session that reported the requested effort and ran without it.
    const preflight = await preflightPartner(partnerAgent, {
      partnerCommand,
      model,
      reasoningEffort: reasoning_effort,
      toolProfile: tool_profile,
      projectPath: resolvedProjectPath,
      allowUnknownModel: allow_unknown_model === true,
    });
    if (!preflight.ok) {
      return { content: [{ type: "text", text: `Error: ${preflight.errorText}` }] };
    }
    const effectiveReasoningEffort = preflight.effort;
    // The model the invocation will ACTUALLY use, which is not always the one
    // requested: an adapter with capabilities.modelFlag:false drops it entirely
    // (resolveContext emits dropped_model and resolves to null). Persisting and
    // echoing the requested value there would certify a selection the turn does
    // not make -- the precise failure the requested/resolved split exists to
    // expose, so the resolved side has to be the one that travels.
    const effectiveModel = preflight.model;
    // Degradations the caller must see. These are warnings rather than errors --
    // per negotiate()'s rule, a change to how WELL the partner works is loud, a
    // change to what it is ALLOWED to do is fatal -- but "loud" only counts if
    // it reaches the host, and the runner log does not.
    const preflightWarnings = preflight.warnings ?? [];
    let subjectPath = null;
    try {
      subjectPath = resolveSubjectPath(subject_path, resolvedProjectPath);
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not read subject_path "${subject_path}": ${err.message}`,
          },
        ],
      };
    }

    const sessionId = `dialog-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const sessionDir = resolveSessionDir(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Write problem description
    fs.writeFileSync(path.join(sessionDir, "problem.md"), problem_description);

    // Initialize empty conversation
    fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), "");

    // Write initial status
    const runnerToken = crypto.randomBytes(16).toString("hex");
    const status = {
      session_id: sessionId,
      type: "dialog",
      started_at: new Date().toISOString(),
      project_path: project_path || process.cwd(),
      host_agent: hostAgent,
      partner_agent: partnerAgent,
      partner_command: partnerCommand,
      ...(partnerAgent === "codex" ? { codex_command: partnerCommand } : {}),
      max_rounds: softCap,
      hard_cap: hardCap,
      reasoning_effort: effectiveReasoningEffort,
      model: effectiveModel ?? null,
      partner_timeout_ms: partnerTimeoutMs,
      tool_profile: tool_profile || "read",
      allow_unknown_model: allow_unknown_model === true,
      subject_path: subjectPath,
      subject_kind: subjectPath ? (subject_kind || "document") : null,
      runner_pid: null,
      runner_token: runnerToken,
      runner_state: "starting",
    };
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

    // Spawn the dialog runner in background
    const runnerPath = fileURLToPath(new URL("dialog-runner.mjs", import.meta.url));
    const runnerArgs = [
      runnerPath,
      sessionDir,
      project_path || process.cwd(),
      partnerCommand,
      String(softCap),
      // Absent must serialize as empty, not as null. spawn() stringifies a null
      // argv entry to the literal "null", which the runner then reads as an
      // explicitly requested effort named "null" before dropping it again.
      effectiveReasoningEffort || "",
      effectiveModel || "",
      hostAgent,
      partnerAgent,
      tool_profile || "read",
      String(partnerTimeoutMs),
      buildRunnerTokenArg(runnerToken),
      // Appended as a flag rather than a positional: the runners read their
      // options by index, and the preflight's answer has to survive into the
      // turn or the two validate the same id differently.
      ...(allow_unknown_model === true ? ["--allow-unknown-model"] : []),
    ];
    const runner = spawn(
      process.execPath,
      runnerArgs,
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
        windowsHide: true,
      }
    );
    runner.on("error", () => {});
    runner.unref();

    // Record the PID without clobbering an exit the runner may already have
    // written; keep the in-memory copy in step for the response below.
    status.runner_pid = runner.pid;
    status.runner_state = "running";
    markSessionRunnerStarted(sessionDir, {
      runnerToken,
      pid: runner.pid,
    });
    // Closes the remaining start-vs-exit race. The write above and the runner's
    // own exit record are two whole-file writes with no ordering between them;
    // the exit EVENT has an unambiguous order, so use it to re-assert the truth
    // if our "running" landed on top of a newer "exited".
    watchRunnerExit(runner, sessionDir, { runnerToken });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              session_id: sessionId,
              runner_pid: runner.pid,
              dialog_dir: sessionDir,
              host_agent: hostAgent,
              partner_agent: partnerAgent,
              partner_command: partnerCommand,
              max_rounds: softCap,
              hard_cap: hardCap,
              requested_model: preflight.requestedModel,
              requested_reasoning_effort: preflight.requestedEffort,
              reasoning_effort: effectiveReasoningEffort,
              effective_reasoning_effort: preflight.effectiveEffort,
              warnings: preflightWarnings,
              notices: preflight.notices ?? [],
              model: effectiveModel ?? "default",
              partner_timeout_ms: partnerTimeoutMs,
              tool_profile: tool_profile || "read",
              subject_path: subjectPath,
              subject_kind: subjectPath ? (subject_kind || "document") : null,
              message:
                `Dialog started with a soft budget of ${softCap} rounds (hard cap ${hardCap}), partner wait hint ${(partnerTimeoutMs / 60000).toFixed(1)} minutes, model: ${effectiveModel ?? "default"}, reasoning effort: ${describeEffort(effectiveReasoningEffort, preflight.effectiveEffort)}, tool profile: ${tool_profile || "read"}. Partner turns run in detached tmux and are not killed by the wait hint. Send your first message with send_message, then wait for ${partnerDisplay}.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Code Review Tools ───────────────────────────────────────────────────────

server.tool(
  "start_code_review",
  "Start a code review session where the configured partner agent reviews changes in the background. By default the host is Claude and the reviewer is Codex, but the flow can be inverted so Codex hosts and Claude reviews. The response echoes back the model, reasoning_effort, and other settings it actually used -- compare them against what you passed, because an omitted parameter and one lost in transit are indistinguishable here, and the echo is the only place a dropped setting becomes visible.",
  {
    project_path: z
      .string()
      .describe("Path to the git project directory"),
    diff_target: z
      .string()
      .optional()
      .describe(
        "What to diff. 'uncommitted' (default) = all working tree + staged changes vs HEAD. 'staged' = only staged changes vs HEAD. 'branch' = compare branch vs base_branch. 'commit:<sha>' = review a specific commit."
      ),
    branch: z
      .string()
      .optional()
      .describe("Branch to review (only used when diff_target='branch', default: current branch)"),
    base_branch: z
      .string()
      .optional()
      .describe("Base branch to compare against (only used when diff_target='branch', default: 'main')"),
    review_focus: z
      .string()
      .optional()
      .describe(
        "Optional focus area for the review, e.g. 'security', 'performance', 'correctness'"
      ),
    host_agent: z
      .enum(AGENT_IDS)
      .optional()
      .describe("Which agent is orchestrating the review (default: 'claude')"),
    partner_agent: z
      .enum(AGENT_IDS)
      .optional()
      .describe(AGENT_CHOICE_DESCRIPTION),
    partner_command: z
      .string()
      .optional()
      .describe("Command to invoke the reviewing partner CLI."),
    codex_command: z
      .string()
      .optional()
      .describe("Deprecated alias for partner_command when partner_agent='codex'"),
    claude_command: z
      .string()
      .optional()
      .describe("Alias for partner_command when partner_agent='claude'"),
    max_rounds: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Soft round budget (default: 5). The reviewer is asked to deliver all feedback within this many rounds. Hard cap = max_rounds + 5. Do not override unless the user explicitly requested a different budget."
      ),
    reasoning_effort: z
      .enum(ALL_EFFORTS)
      .optional()
      .describe(REASONING_EFFORT_DESCRIPTION),
    model: z
      .string()
      .optional()
      .describe(MODEL_OVERRIDE_DESCRIPTION),
    partner_timeout_ms: z
      .number()
      .int()
      .min(MIN_PARTNER_TIMEOUT_MS)
      .optional()
      .describe("Backward-compatible wait-time hint in milliseconds (default: 900000 = 15 minutes). Interactive tmux partner turns are not killed by this value."),
    allow_unknown_model: z
      .boolean()
      .optional()
      .describe(
        "Start with a model this server's catalog does not list. Only has an effect when a live catalog was consulted -- without one an unrecognized model is already just a warning."
      ),
  },
  async ({
    project_path,
    diff_target,
    branch,
    base_branch,
    review_focus,
    host_agent,
    partner_agent,
    partner_command,
    codex_command,
    claude_command,
    max_rounds,
    reasoning_effort,
    model,
    partner_timeout_ms,
    allow_unknown_model,
  }) => {
    const hostAgent = normalizeAgent(host_agent, "claude");
    const partnerAgent = normalizeAgent(partner_agent, "codex");
    if (hostAgent === partnerAgent) {
      return {
        content: [
          {
            type: "text",
            text: "Error: host_agent and partner_agent must be different",
          },
        ],
      };
    }
    const target = diff_target || "uncommitted";
    if (!["staged", "uncommitted", "branch"].includes(target) && !target.startsWith("commit:")) {
      return {
        content: [{ type: "text", text: `Error: Unknown diff_target "${target}". Use: staged, uncommitted, branch, or commit:<sha>` }],
      };
    }
    const softCap = max_rounds || 5;
    const hardCap = softCap + 5;
    const partnerTimeoutMs = normalizePartnerTimeout(partner_timeout_ms);
    const partnerCommand = resolvePartnerCommandValue(
      partnerAgent,
      partner_command,
      codex_command,
      claude_command
    );
    const partnerDisplay = getAgentDisplayName(partnerAgent);

    // Same preflight as start_dialog, for the same reason: a review that runs
    // at an effort the model silently clamped is a review the host misreads.
    const preflight = await preflightPartner(partnerAgent, {
      partnerCommand,
      model,
      reasoningEffort: reasoning_effort,
      toolProfile: "read",
      projectPath: project_path,
      allowUnknownModel: allow_unknown_model === true,
    });
    if (!preflight.ok) {
      return { content: [{ type: "text", text: `Error: ${preflight.errorText}` }] };
    }
    const effectiveReasoningEffort = preflight.effort;
    // The model the invocation will ACTUALLY use, which is not always the one
    // requested: an adapter with capabilities.modelFlag:false drops it entirely
    // (resolveContext emits dropped_model and resolves to null). Persisting and
    // echoing the requested value there would certify a selection the turn does
    // not make -- the precise failure the requested/resolved split exists to
    // expose, so the resolved side has to be the one that travels.
    const effectiveModel = preflight.model;
    // Degradations the caller must see. These are warnings rather than errors --
    // per negotiate()'s rule, a change to how WELL the partner works is loud, a
    // change to what it is ALLOWED to do is fatal -- but "loud" only counts if
    // it reaches the host, and the runner log does not.
    const preflightWarnings = preflight.warnings ?? [];

    const execOpts = { cwd: project_path, timeout: 30000, maxBuffer: 10 * 1024 * 1024 };

    // Resolve current branch and HEAD SHA for metadata
    let currentBranch, headSha;
    try {
      headSha = execSync("git rev-parse HEAD", {
        cwd: project_path,
        timeout: 10000,
      }).toString().trim();
    } catch {}
    try {
      currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: project_path,
        timeout: 10000,
      })
        .toString()
        .trim();
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not determine current branch. Is "${project_path}" a git repository?\n${err.message}`,
          },
        ],
      };
    }

    let diff, diffStat, diffLabel;

    try {
      if (target === "staged") {
        // Only staged changes
        diff = execSync("git diff --cached", execOpts).toString();
        diffStat = execSync("git diff --cached --stat", { ...execOpts, timeout: 10000 }).toString();
        diffLabel = "staged changes vs HEAD";
      } else if (target === "uncommitted") {
        // All working tree changes (staged + unstaged) vs HEAD
        diff = execSync("git diff HEAD", execOpts).toString();
        diffStat = execSync("git diff HEAD --stat", { ...execOpts, timeout: 10000 }).toString();
        diffLabel = "uncommitted changes vs HEAD";

        // If no diff against HEAD (maybe no commits yet), try plain diff
        if (!diff.trim()) {
          diff = execSync("git diff", execOpts).toString();
          diffStat = execSync("git diff --stat", { ...execOpts, timeout: 10000 }).toString();
          diffLabel = "unstaged changes";
        }
      } else if (target.startsWith("commit:")) {
        const sha = target.slice("commit:".length);
        if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
          throw new Error(`Invalid commit SHA: ${sha}`);
        }
        diff = execFileSync("git", ["show", sha, "--format="], execOpts).toString();
        diffStat = execFileSync("git", ["show", sha, "--stat", "--format="], { ...execOpts, timeout: 10000 }).toString();
        diffLabel = `commit ${sha}`;
      } else {
        // Branch mode
        const baseBranch = base_branch || "main";
        const headBranch = branch || currentBranch;

        try {
          diff = execFileSync("git", ["diff", `${baseBranch}...${headBranch}`], execOpts).toString();
          diffStat = execFileSync("git", ["diff", "--stat", `${baseBranch}...${headBranch}`], { ...execOpts, timeout: 10000 }).toString();
        } catch {
          // Fall back to two-dot diff
          diff = execFileSync("git", ["diff", `${baseBranch}..${headBranch}`], execOpts).toString();
          diffStat = execFileSync("git", ["diff", "--stat", `${baseBranch}..${headBranch}`], { ...execOpts, timeout: 10000 }).toString();
        }
        diffLabel = `${headBranch} vs ${baseBranch}`;
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error generating diff (${target}):\n${err.message}`,
          },
        ],
      };
    }

    if (!diff.trim()) {
      return {
        content: [
          {
            type: "text",
            text: `No changes found (${diffLabel}). Nothing to review.`,
          },
        ],
      };
    }

    // Create session
    const sessionId = `review-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const sessionDir = resolveSessionDir(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Write review artifacts
    fs.writeFileSync(path.join(sessionDir, "diff.patch"), diff);

    const headBranchForMeta = target === "branch" ? (branch || currentBranch) : currentBranch;
    const baseBranchForMeta = target === "branch" ? (base_branch || "main") : "HEAD";
    const meta = {
      branch: headBranchForMeta,
      base_branch: baseBranchForMeta,
      diff_target: target,
      diff_label: diffLabel,
      diff_stat: diffStat.trim(),
      review_focus: review_focus || null,
      files_changed: diffStat
        .trim()
        .split("\n")
        .slice(0, -1)
        .map((l) => l.trim().split(/\s+/)[0])
        .filter(Boolean),
    };
    fs.writeFileSync(
      path.join(sessionDir, "review_meta.json"),
      JSON.stringify(meta, null, 2)
    );

    // Initialize empty conversation (runner will auto-populate the first message)
    fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), "");

    // Write status
    const runnerToken = crypto.randomBytes(16).toString("hex");
    const status = {
      session_id: sessionId,
      type: "review",
      started_at: new Date().toISOString(),
      project_path,
      host_agent: hostAgent,
      partner_agent: partnerAgent,
      partner_command: partnerCommand,
      ...(partnerAgent === "codex" ? { codex_command: partnerCommand } : {}),
      diff_target: target,
      diff_label: diffLabel,
      branch: headBranchForMeta,
      base_branch: baseBranchForMeta,
      head_sha: headSha || null,
      review_focus: review_focus || null,
      max_rounds: softCap,
      hard_cap: hardCap,
      reasoning_effort: effectiveReasoningEffort,
      model: effectiveModel ?? null,
      partner_timeout_ms: partnerTimeoutMs,
      allow_unknown_model: allow_unknown_model === true,
      runner_pid: null,
      runner_token: runnerToken,
      runner_state: "starting",
    };
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

    // Spawn the review runner
    const runnerPath = fileURLToPath(new URL("review-runner.mjs", import.meta.url));
    const reviewRunnerArgs = [
      runnerPath,
      sessionDir,
      project_path,
      partnerCommand,
      String(softCap),
      // Absent must serialize as empty, not as null. spawn() stringifies a null
      // argv entry to the literal "null", which the runner then reads as an
      // explicitly requested effort named "null" before dropping it again.
      effectiveReasoningEffort || "",
      effectiveModel || "",
      hostAgent,
      partnerAgent,
      String(partnerTimeoutMs),
      buildRunnerTokenArg(runnerToken),
      // Appended as a flag rather than a positional: the runners read their
      // options by index, and the preflight's answer has to survive into the
      // turn or the two validate the same id differently.
      ...(allow_unknown_model === true ? ["--allow-unknown-model"] : []),
    ];
    const runner = spawn(
      process.execPath,
      reviewRunnerArgs,
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
        windowsHide: true,
      }
    );
    runner.on("error", () => {});
    runner.unref();

    // Same read-modify-write as start_dialog: never replay a pre-spawn status
    // object over an exit record the runner already produced.
    status.runner_pid = runner.pid;
    status.runner_state = "running";
    markSessionRunnerStarted(sessionDir, {
      runnerToken,
      pid: runner.pid,
    });
    // Closes the remaining start-vs-exit race. The write above and the runner's
    // own exit record are two whole-file writes with no ordering between them;
    // the exit EVENT has an unambiguous order, so use it to re-assert the truth
    // if our "running" landed on top of a newer "exited".
    watchRunnerExit(runner, sessionDir, { runnerToken });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              session_id: sessionId,
              runner_pid: runner.pid,
              review_dir: sessionDir,
              diff_target: target,
              diff_label: diffLabel,
              files_changed: meta.files_changed.length,
              diff_size: diff.length,
              // How much of the diff is actually embedded in the partner's
              // prompt. The partner is told to read the rest from disk, but only
              // the host can judge whether a review that leaned on the embedded
              // copy covered the change -- and it cannot judge that without
              // being told the copy was partial.
              diff_chars_embedded: Math.min(diff.length, MAX_REVIEW_DIFF_CHARS),
              diff_truncated: diff.length > MAX_REVIEW_DIFF_CHARS,
              host_agent: hostAgent,
              partner_agent: partnerAgent,
              partner_command: partnerCommand,
              max_rounds: softCap,
              hard_cap: hardCap,
              requested_model: preflight.requestedModel,
              requested_reasoning_effort: preflight.requestedEffort,
              reasoning_effort: effectiveReasoningEffort,
              effective_reasoning_effort: preflight.effectiveEffort,
              warnings: preflightWarnings,
              notices: preflight.notices ?? [],
              model: effectiveModel ?? "default",
              partner_timeout_ms: partnerTimeoutMs,
              message:
                `Code review started with a soft budget of ${softCap} rounds (hard cap ${hardCap}), partner wait hint ${(partnerTimeoutMs / 60000).toFixed(1)} minutes, model: ${effectiveModel ?? "default"}, reasoning effort: ${describeEffort(effectiveReasoningEffort, preflight.effectiveEffort)}. ${partnerDisplay} is generating an initial review in detached tmux and is not killed by the wait hint.` +
                (diff.length > MAX_REVIEW_DIFF_CHARS
                  ? ` NOTE: this diff is ${diff.length} chars and only the first ${MAX_REVIEW_DIFF_CHARS} (${Math.round((MAX_REVIEW_DIFF_CHARS / diff.length) * 100)}%) are embedded in ${partnerDisplay}'s prompt. It is instructed to read the changed files from ${project_path} for the remainder, but treat any finding that depends on the unembedded portion as unverified unless it cites the file it read.`
                  : ""),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_review_summary",
  "Get the full code review context: diff metadata, original diff stat, and the complete review conversation.",
  {
    session_id: z.string().describe("The review session ID"),
  },
  async ({ session_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const messages = readConv(session_id);
    const status = readStat(session_id);
    const partnerAgent = getSessionPartnerAgent(status);

    const metaPath = path.join(sessionDir, "review_meta.json");
    let meta = null;
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
    }

    // Parse structured findings from partner messages. The taxonomy is imported
    // rather than restated: it is also stated verbatim to every PR-review
    // specialist and matched by the approval gate in shared.mjs, and three
    // copies of one list is three chances for a category to exist in a prompt
    // that no parser here will ever recognize.
    const findings = Object.fromEntries(
      FINDING_CATEGORIES.map((c) => [c.toLowerCase(), []])
    );
    for (const msg of messages) {
      if (msg.from !== partnerAgent) continue;
      const lines = msg.content.split("\n");
      for (const line of lines) {
        for (const cat of FINDING_CATEGORIES) {
          if (line.includes(`[${cat}]`)) {
            findings[cat.toLowerCase()].push(line.trim());
          }
        }
      }
    }

    const budget = computeBudget(status, messages);
    const reviewStatus = computeReviewStatus(status, messages, {
      problem: readProblem(sessionDir),
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              meta,
              total_messages: messages.length,
              findings,
              approved: reviewStatus.approved,
              review_status: reviewStatus,
              budget,
              messages,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── PR Review (multi-specialist panel) ──────────────────────────────────────

/**
 * Resolve a pull request through `gh`.
 *
 * Kept separate from the local-diff path because the failure modes are
 * different in kind: a local diff fails on git state the caller can see, while
 * this fails on a CLI that may be missing, unauthenticated, or pointed at
 * another host -- and each of those needs its own instruction to be actionable.
 */
function resolvePullRequest(ref, projectPath) {
  // A ref is a positional argument, so nothing shell-interprets it -- but `gh`
  // still parses a leading dash as one of its own flags, and `--repo=other/repo`
  // would quietly review a different repository than the one the caller named.
  // The change would be reviewed correctly and be the wrong change.
  if (typeof ref !== "string" || ref.startsWith("-")) {
    throw new Error(
      `Invalid pull request reference ${JSON.stringify(ref)}: it may not begin with "-", ` +
        `which gh would read as one of its own flags rather than as a PR.`
    );
  }

  const execOpts = {
    cwd: projectPath,
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
  };

  let view;
  try {
    view = execFileSync(
      "gh",
      [
        "pr",
        "view",
        ref,
        "--json",
        "number,title,body,author,baseRefName,headRefName,url,state,isDraft",
      ],
      execOpts
    ).toString();
  } catch (err) {
    const stderr = (err.stderr || "").toString().trim();
    if (err.code === "ENOENT") {
      throw new Error(
        `The GitHub CLI ("gh") is not installed or not on PATH, so a pull request cannot be fetched. ` +
          `Install it, or omit "pr" and review the change locally with diff_target instead.`
      );
    }
    if (/auth|login|HTTP 401|HTTP 403/i.test(stderr)) {
      throw new Error(
        `gh is not authenticated for this repository: ${stderr || err.message}. Run "gh auth login" and retry.`
      );
    }
    throw new Error(
      `Could not read pull request "${ref}": ${stderr || err.message}`
    );
  }

  let pr;
  try {
    pr = JSON.parse(view);
  } catch (err) {
    throw new Error(`gh returned output that is not valid JSON: ${err.message}`);
  }

  let diff;
  try {
    diff = execFileSync("gh", ["pr", "diff", ref], execOpts).toString();
  } catch (err) {
    const stderr = (err.stderr || "").toString().trim();
    throw new Error(
      `Could not read the diff for pull request #${pr.number}: ${stderr || err.message}`
    );
  }

  return {
    number: pr.number,
    title: pr.title || "",
    body: (pr.body || "").slice(0, 8000),
    author: pr.author?.login || null,
    base: pr.baseRefName || null,
    head: pr.headRefName || null,
    url: pr.url || null,
    state: pr.state || null,
    is_draft: Boolean(pr.isDraft),
    diff,
  };
}

server.tool(
  "start_pr_review",
  "Start a MULTI-SPECIALIST pull request review, where the partner agent reviews the change once per aspect -- general code quality, test coverage, error handling, comment accuracy, type design, and optionally simplification -- and then consolidates those passes into one prioritized report. This is the pr-review-toolkit panel flow, and it is deliberately separate from start_code_review, which runs a single general reviewer in one pass. Any connected agent can serve as the panel, so Codex can review for Claude, Claude for Grok, and so on. Aspects are auto-selected from the diff unless you name them. The response echoes back the model, reasoning_effort, and the selected/skipped aspects it actually used -- compare them against what you passed, because an omitted parameter and one lost in transit are indistinguishable here.",
  {
    project_path: z.string().describe("Path to the git project directory"),
    pr: z
      .string()
      .optional()
      .describe(
        "Pull request to review: a number ('123'), a URL, or a branch name. Requires an authenticated `gh`. Omit this to review local changes instead, via diff_target."
      ),
    diff_target: z
      .string()
      .optional()
      .describe(
        "What to review when `pr` is omitted. 'branch' (default) = current branch vs base_branch, which is the pre-PR shape. Also accepts 'uncommitted', 'staged', or 'commit:<sha>'."
      ),
    branch: z
      .string()
      .optional()
      .describe("Head branch (only used when diff_target='branch', default: current branch)"),
    base_branch: z
      .string()
      .optional()
      .describe("Base branch to compare against (only used when diff_target='branch', default: 'main')"),
    aspects: z
      .array(z.enum(ASPECT_IDS))
      .optional()
      .describe(
        "Explicit panel selection, overriding auto-detection in both directions -- it can add an aspect the diff does not suggest and drop one it does. Aspects: " +
          ASPECT_IDS.map(
            (id) =>
              `'${id}' (${PR_REVIEW_ASPECTS[id].title}${PR_REVIEW_ASPECTS[id].optIn ? ", opt-in only" : ""})`
          ).join(", ") +
          ". Each selected aspect costs one partner turn, plus one for consolidation."
      ),
    review_focus: z
      .string()
      .optional()
      .describe(
        "Optional focus applied WITHIN each specialist's lens, e.g. 'the new auth path'. It narrows attention; it does not replace the aspect rubrics."
      ),
    host_agent: z
      .enum(AGENT_IDS)
      .optional()
      .describe("Which agent is orchestrating the review (default: 'claude')"),
    partner_agent: z.enum(AGENT_IDS).optional().describe(AGENT_CHOICE_DESCRIPTION),
    partner_command: z
      .string()
      .optional()
      .describe("Command to invoke the reviewing partner CLI."),
    codex_command: z
      .string()
      .optional()
      .describe("Deprecated alias for partner_command when partner_agent='codex'"),
    claude_command: z
      .string()
      .optional()
      .describe("Alias for partner_command when partner_agent='claude'"),
    follow_up_rounds: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "Soft budget for the CONVERSATION after the panel reports (default: 5). Panel and consolidation passes are the review itself and are not charged against this. The follow-up conversation's own hard cap is follow_up_rounds + 5; the session-wide `hard_cap` in the response is larger, because it also covers the panel passes."
      ),
    reasoning_effort: z.enum(ALL_EFFORTS).optional().describe(REASONING_EFFORT_DESCRIPTION),
    model: z.string().optional().describe(MODEL_OVERRIDE_DESCRIPTION),
    partner_timeout_ms: z
      .number()
      .int()
      .min(MIN_PARTNER_TIMEOUT_MS)
      .optional()
      .describe(
        "Per-turn wait hint in milliseconds (default: 900000 = 15 minutes). Note this is PER PASS, and a panel runs several passes back to back, so a full review takes roughly this times the number of aspects. Interactive tmux turns are not killed by this value."
      ),
    allow_unknown_model: z
      .boolean()
      .optional()
      .describe(
        "Start with a model this server's catalog does not list. Only has an effect when a live catalog was consulted."
      ),
  },
  async ({
    project_path,
    pr,
    diff_target,
    branch,
    base_branch,
    aspects,
    review_focus,
    host_agent,
    partner_agent,
    partner_command,
    codex_command,
    claude_command,
    follow_up_rounds,
    reasoning_effort,
    model,
    partner_timeout_ms,
    allow_unknown_model,
  }) => {
    const hostAgent = normalizeAgent(host_agent, "claude");
    const partnerAgent = normalizeAgent(partner_agent, "codex");
    if (hostAgent === partnerAgent) {
      return {
        content: [
          { type: "text", text: "Error: host_agent and partner_agent must be different" },
        ],
      };
    }

    // An empty array is rejected rather than treated as "auto". The two mean
    // opposite things to a caller, and silently running the full panel for
    // someone who asked for none of it is the worse guess.
    if (Array.isArray(aspects) && aspects.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "Error: `aspects` was provided but empty. Omit it entirely to auto-select from the diff, " +
              `or name at least one of: ${ASPECT_IDS.join(", ")}.`,
          },
        ],
      };
    }

    const followUpRounds = follow_up_rounds || 5;
    const partnerTimeoutMs = normalizePartnerTimeout(partner_timeout_ms);
    const partnerCommand = resolvePartnerCommandValue(
      partnerAgent,
      partner_command,
      codex_command,
      claude_command
    );
    const partnerDisplay = getAgentDisplayName(partnerAgent);

    const preflight = await preflightPartner(partnerAgent, {
      partnerCommand,
      model,
      reasoningEffort: reasoning_effort,
      toolProfile: "read",
      projectPath: project_path,
      allowUnknownModel: allow_unknown_model === true,
    });
    if (!preflight.ok) {
      return { content: [{ type: "text", text: `Error: ${preflight.errorText}` }] };
    }

    // Anything the caller must know about how the reviewed change was resolved,
    // surfaced in the start response's `notices`. Declared before the first
    // thing that can append to it, which is the HEAD lookup immediately below.
    //
    // Everything here shares one property: the review still runs, but over a
    // change that is not quite the one the caller believes they asked for. `pr`
    // selects the change wholesale, so the local-diff parameters have nothing
    // left to decide; the merge-base diff can fall back to a two-dot range that
    // includes commits the author never wrote; an unresolvable HEAD leaves the
    // refresh baseline floating. None is fatal, and none may be silent.
    const startupNotices = [];

    const execOpts = { cwd: project_path, timeout: 30000, maxBuffer: 10 * 1024 * 1024 };
    let currentBranch, headSha;
    try {
      headSha = execSync("git rev-parse HEAD", { cwd: project_path, timeout: 10000 })
        .toString()
        .trim();
    } catch {
      // Not fatal, but not silent either. send_message's uncommitted AND staged
      // refreshes both use `status.head_sha || "HEAD"` as their baseline, so a
      // null here means that once the author commits, the refreshed diff LOSES
      // the committed work and shows only what is still uncommitted -- a
      // quietly narrower change than the one under review. (The `branch`
      // default, and the `pr` and `commit:` targets, never read head_sha for
      // refresh at all, so the notice is advisory rather than actionable there.)
      startupNotices.push(
        "HEAD could not be resolved, so this session has no fixed baseline; if you commit mid-review, " +
          "the refreshed diff will show only what remains uncommitted"
      );
    }
    try {
      currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: project_path,
        timeout: 10000,
      })
        .toString()
        .trim();
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Could not determine current branch. Is "${project_path}" a git repository?\n${err.message}`,
          },
        ],
      };
    }

    let diff = "";
    let diffStat = "";
    let scopeLabel = "";
    let prInfo = null;
    const target = pr ? "pr" : diff_target || "branch";

    if (pr) {
      for (const [name, value] of [
        ["diff_target", diff_target],
        ["branch", branch],
        ["base_branch", base_branch],
      ]) {
        if (value != null) {
          startupNotices.push(
            `${name} was ignored: "pr" selects the change, and the two cannot both define it`
          );
        }
      }
    }

    try {
      if (pr) {
        const resolved = resolvePullRequest(pr, project_path);
        diff = resolved.diff;
        prInfo = { ...resolved };
        delete prInfo.diff;
        scopeLabel = `pull request #${resolved.number} (${resolved.head} → ${resolved.base})`;
      } else if (target === "staged") {
        diff = execSync("git diff --cached", execOpts).toString();
        scopeLabel = "staged changes vs HEAD";
      } else if (target === "uncommitted") {
        diff = execSync("git diff HEAD", execOpts).toString();
        scopeLabel = "uncommitted changes vs HEAD";
        if (!diff.trim()) {
          diff = execSync("git diff", execOpts).toString();
          scopeLabel = "unstaged changes";
        }
      } else if (target.startsWith("commit:")) {
        const sha = target.slice("commit:".length);
        if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) {
          throw new Error(`Invalid commit SHA: ${sha}`);
        }
        diff = execFileSync("git", ["show", sha, "--format="], execOpts).toString();
        scopeLabel = `commit ${sha}`;
      } else if (target === "branch") {
        const baseBranch = base_branch || "main";
        const headBranch = branch || currentBranch;
        try {
          diff = execFileSync("git", ["diff", `${baseBranch}...${headBranch}`], execOpts).toString();
        } catch {
          // Keep the fallback -- it is the right recovery for a stale base, a
          // shallow clone, or a detached HEAD -- but say so. Three dots is
          // merge-base; two dots also includes everything the base gained since
          // the branch point, so the panel can end up reviewing commits the
          // author never wrote and filing findings against them, all under a
          // label that still reads "branch X vs Y".
          diff = execFileSync("git", ["diff", `${baseBranch}..${headBranch}`], execOpts).toString();
          startupNotices.push(
            `the three-dot (merge-base) diff of ${baseBranch}...${headBranch} failed, so a two-dot diff was used instead: the review may include commits added to ${baseBranch} since the branch point`
          );
        }
        scopeLabel = `branch ${headBranch} vs ${baseBranch}`;
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Error: Unknown diff_target "${target}". Use: branch, uncommitted, staged, or commit:<sha>.`,
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error resolving the change to review:\n${err.message}` }],
      };
    }

    if (!diff.trim()) {
      return {
        content: [
          {
            type: "text",
            text:
              `No changes found (${scopeLabel}). Nothing to review.` +
              (target === "branch"
                ? ` start_pr_review defaults to comparing your branch against "${base_branch || "main"}"; if the work is not committed yet, pass diff_target: "uncommitted".`
                : ""),
          },
        ],
      };
    }

    // The stat is derived from the diff text itself rather than a second git
    // call, because for a `gh pr diff` there is no local ref to run `git diff
    // --stat` against -- the PR may not even be fetched.
    const changedFiles = [
      ...new Set(
        diff
          .split("\n")
          .map((l) => l.match(/^diff --git a\/(.+?) b\/(.+)$/))
          .filter(Boolean)
          .map((m) => m[2])
      ),
    ];
    diffStat = changedFiles.length
      ? `${changedFiles.length} file(s) changed:\n${changedFiles.map((f) => `  ${f}`).join("\n")}`
      : "(no file headers found in diff)";

    let selection;
    try {
      selection = selectAspects(diff, aspects);
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }
    // Defence in depth, not a live path: `code` always applies, an empty
    // explicit list is rejected above, and an unknown id throws in
    // selectAspects. It stays because a future aspect-selection change could
    // make it reachable, and a panel with no passes would otherwise start a
    // runner that reports nothing and explains nothing.
    if (selection.selected.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "Error: no review aspects were selected, so there is no panel to run. " +
              `Name at least one of: ${ASPECT_IDS.join(", ")}.`,
          },
        ],
      };
    }

    const skipped = selection.decisions
      .filter((d) => !d.selected)
      .map((d) => ({ aspect: d.aspect, reason: d.reason }));

    // Session ids keep the `review-` prefix on purpose.
    //
    // The prefix is a STORAGE key, not the session's identity: it is what
    // resolveSessionDir's pattern, the list_sessions scan, and -- most
    // importantly -- session-scratch's GENERATED_SESSION_ID cleanup allowlist
    // all match on. A new prefix would have to be added to every one of them,
    // and the cost of missing the last one is not a cosmetic bug: partner
    // credential copies inside these sessions would stop being reaped. The
    // session's real identity travels in status.type, which every tool reads.
    const sessionId = `review-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const sessionDir = resolveSessionDir(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "diff.patch"), diff);

    const meta = {
      review_kind: "pr_panel",
      scope: target,
      scope_label: scopeLabel,
      pr: prInfo,
      branch: prInfo?.head || branch || currentBranch,
      base_branch: prInfo?.base || base_branch || (target === "branch" ? "main" : "HEAD"),
      diff_stat: diffStat,
      files_changed: changedFiles,
      review_focus: review_focus || null,
      aspects: selection.selected,
      skipped,
      diff_facts: selection.facts,
    };
    fs.writeFileSync(
      path.join(sessionDir, "pr_review_meta.json"),
      JSON.stringify(meta, null, 2)
    );
    fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), "");

    // Every panel and consolidation pass appends a partner message, and
    // computeBudget can only count partner messages -- so the budget it reports
    // is only honest if the panel is included in max_rounds. follow_up_rounds
    // is reported separately for the caller who wants the conversational half.
    const panelPasses = selection.selected.length;
    const maxRounds = panelPasses + 1 + followUpRounds;
    const hardCap = maxRounds + 5;

    const runnerToken = crypto.randomBytes(16).toString("hex");
    const status = {
      session_id: sessionId,
      type: "pr_review",
      started_at: new Date().toISOString(),
      project_path,
      host_agent: hostAgent,
      partner_agent: partnerAgent,
      partner_command: partnerCommand,
      ...(partnerAgent === "codex" ? { codex_command: partnerCommand } : {}),
      pr_number: prInfo?.number ?? null,
      pr_url: prInfo?.url ?? null,
      diff_target: target,
      diff_label: scopeLabel,
      branch: meta.branch,
      base_branch: meta.base_branch,
      head_sha: headSha || null,
      review_focus: review_focus || null,
      aspects: selection.selected,
      skipped_aspects: skipped,
      panel_passes: panelPasses,
      follow_up_rounds: followUpRounds,
      max_rounds: maxRounds,
      hard_cap: hardCap,
      reasoning_effort: preflight.effort,
      model: preflight.model ?? null,
      partner_timeout_ms: partnerTimeoutMs,
      allow_unknown_model: allow_unknown_model === true,
      runner_pid: null,
      runner_token: runnerToken,
      runner_state: "starting",
    };
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

    const runnerPath = fileURLToPath(new URL("pr-review-runner.mjs", import.meta.url));
    const runner = spawn(
      process.execPath,
      [
        runnerPath,
        sessionDir,
        project_path,
        partnerCommand,
        String(followUpRounds),
        preflight.effort || "",
        preflight.model || "",
        hostAgent,
        partnerAgent,
        String(partnerTimeoutMs),
        buildRunnerTokenArg(runnerToken),
        ...(allow_unknown_model === true ? ["--allow-unknown-model"] : []),
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env },
        windowsHide: true,
      }
    );
    runner.on("error", () => {});
    runner.unref();

    status.runner_pid = runner.pid;
    status.runner_state = "running";
    markSessionRunnerStarted(sessionDir, { runnerToken, pid: runner.pid });
    watchRunnerExit(runner, sessionDir, { runnerToken });

    const totalPasses = panelPasses + 1;
    const notices = [...(preflight.notices ?? []), ...startupNotices];
    if (prInfo?.is_draft) notices.push("pull request is a DRAFT");
    if (prInfo?.state && prInfo.state !== "OPEN") {
      notices.push(`pull request state is ${prInfo.state}, not OPEN`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              session_id: sessionId,
              runner_pid: runner.pid,
              review_dir: sessionDir,
              review_kind: "pr_panel",
              scope: target,
              scope_label: scopeLabel,
              pr: prInfo
                ? {
                    number: prInfo.number,
                    title: prInfo.title,
                    url: prInfo.url,
                    state: prInfo.state,
                    is_draft: prInfo.is_draft,
                  }
                : null,
              aspects: selection.selected,
              skipped_aspects: skipped,
              panel_passes: panelPasses,
              total_passes: totalPasses,
              files_changed: changedFiles.length,
              diff_size: diff.length,
              diff_chars_embedded: Math.min(diff.length, MAX_REVIEW_DIFF_CHARS),
              diff_truncated: diff.length > MAX_REVIEW_DIFF_CHARS,
              host_agent: hostAgent,
              partner_agent: partnerAgent,
              partner_command: partnerCommand,
              follow_up_rounds: followUpRounds,
              max_rounds: maxRounds,
              hard_cap: hardCap,
              requested_model: preflight.requestedModel,
              requested_reasoning_effort: preflight.requestedEffort,
              reasoning_effort: preflight.effort,
              effective_reasoning_effort: preflight.effectiveEffort,
              warnings: preflight.warnings ?? [],
              notices,
              model: preflight.model ?? "default",
              partner_timeout_ms: partnerTimeoutMs,
              message:
                `PR review panel started: ${panelPasses} specialist pass(es) (${selection.selected.join(", ")}) ` +
                `then 1 consolidation pass, run by ${partnerDisplay} at model ${preflight.model ?? "default"}, ` +
                `effort ${describeEffort(preflight.effort, preflight.effectiveEffort)}. ` +
                `Each pass appends its report as it lands, so expect ${totalPasses} partner messages before the follow-up ` +
                `conversation begins — do not read the first one as the finished review. ` +
                `Poll with wait_for_partner_response, or call get_pr_review_report for panel progress and the consolidated findings.` +
                (skipped.length
                  ? ` Skipped aspects: ${skipped.map((s) => `${s.aspect} (${s.reason})`).join("; ")}. An aspect nobody ran is not an aspect that came back clean.`
                  : "") +
                (diff.length > MAX_REVIEW_DIFF_CHARS
                  ? ` NOTE: the diff is ${diff.length} chars and only the first ${MAX_REVIEW_DIFF_CHARS} are embedded in each pass's prompt; specialists are told to read the rest from ${project_path}.`
                  : ""),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_pr_review_report",
  "Get the state and findings of a multi-specialist PR review: which aspects ran, which are still pending, which failed, the per-aspect normalized findings, and the consolidated report once it exists. Use this rather than get_review_summary for sessions started by start_pr_review -- it is the only view that distinguishes an aspect that found nothing from an aspect that never ran.",
  {
    session_id: z.string().describe("The PR review session ID"),
    include_reports: z
      .boolean()
      .optional()
      .describe(
        "Include each specialist's full prose report (default: false). The findings index and the consolidated report are always included; the full reports are long and usually only needed when you are chasing one aspect's reasoning."
      ),
  },
  async ({ session_id, include_reports }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const status = readStat(session_id);
    if (status?.type && status.type !== "pr_review") {
      return {
        content: [
          {
            type: "text",
            text:
              `Error: session ${session_id} is a "${status.type}" session, not a PR review panel. ` +
              `Use get_review_summary for it.`,
          },
        ],
      };
    }

    const messages = readConv(session_id);
    const partnerAgent = getSessionPartnerAgent(status);
    const meta = readOptionalJson(path.join(sessionDir, "pr_review_meta.json"));
    const panel = readOptionalJson(path.join(sessionDir, "panel_state.json"));

    // Aspect attribution comes from the header the runner writes, not from
    // guessing at content: a specialist that mentions another aspect by name in
    // its prose must not be filed under it.
    const aspectReports = [];
    let consolidated = null;
    for (const msg of messages) {
      if (msg.from !== partnerAgent) continue;
      // Pattern and producer are imported from one place, so the header cannot
      // drift out from under the parser and silently empty the report.
      const header = msg.content.match(ASPECT_HEADER_RE);
      if (header) {
        aspectReports.push({
          aspect: header[4],
          message_id: msg.id,
          result: extractAspectResult(msg.content),
          findings: extractNormalizedFindings(msg.content),
          ...(include_reports ? { report: msg.content } : {}),
        });
        continue;
      }
      if (CONSOLIDATED_HEADER_RE.test(msg.content)) {
        consolidated = {
          message_id: msg.id,
          content: msg.content,
          findings: extractNormalizedFindings(msg.content),
        };
      }
    }

    const byCategory = Object.fromEntries(FINDING_CATEGORIES.map((c) => [c.toLowerCase(), []]));
    for (const report of aspectReports) {
      for (const finding of report.findings) {
        byCategory[finding.category.toLowerCase()].push({
          aspect: report.aspect,
          text: finding.text,
        });
      }
    }

    const ran = new Set(aspectReports.map((r) => r.aspect));
    // A failed pass appends a system message, not a headered partner report, so
    // it never enters `ran`. Without subtracting it here it would sit in
    // aspects_pending forever -- contradicting aspects_failed in the same
    // document, and stranding any host that polls for pending to empty.
    const failed = (panel?.completed ?? []).filter((c) => c.status === "failed");
    const failedAspects = new Set(failed.map((c) => c.aspect));
    const planned = meta?.aspects ?? status?.aspects ?? [];
    const budget = computeBudget(status, messages);
    const reviewStatus = computeReviewStatus(status, messages, {
      problem: readProblem(sessionDir),
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              session_id,
              review_kind: "pr_panel",
              scope_label: meta?.scope_label ?? status?.diff_label ?? null,
              pr: meta?.pr
                ? {
                    number: meta.pr.number,
                    title: meta.pr.title,
                    url: meta.pr.url,
                    state: meta.pr.state,
                    is_draft: meta.pr.is_draft,
                  }
                : null,
              phase: panel?.phase ?? (consolidated ? "follow_up" : "panel"),
              panel_complete: Boolean(consolidated),
              // Liveness, because otherwise this tool cannot tell you the panel
              // is dead.
              //
              // The runner now writes a `starting` marker before reading its
              // meta and diff, so a corrupt sidecar surfaces as phase
              // "starting". But writePanelState swallows its own failure, so a
              // full disk or a lost write permission leaves no state and then
              // kills the runner at its first unguarded write -- no
              // panel_state.json, no system message -- and the report then
              // falls back to `phase: "panel"` with every aspect pending,
              // forever, while a host polls a corpse. `panel_state_available`
              // separates "the runner never got far enough to write state" from
              // "state exists".
              // Tri-state, resolved in the probe rather than at this call site.
              //
              // isSessionRunnerAlive folds "cannot read the command line" into
              // `false`, so reporting it directly calls a healthy panel dead in
              // any sandboxed environment. But mapping its `false` to `null`
              // was worse: it erased a PROVEN death, which is the case this
              // field exists for -- a runner killed without recording it, sitting
              // behind a stale `runner_state: "running"`. Now `null` means only
              // "the process exists and we could not identify it".
              runner_alive: { alive: true, dead: false, unknown: null }[
                probeSessionRunner(status, sessionDir)
              ],
              runner_state: status?.runner_state ?? null,
              runner_exit_reason: status?.runner_exit_reason ?? null,
              last_error: readOptionalText(path.join(sessionDir, "last_error.txt")),
              panel_state_available: panel != null,
              aspects_planned: planned,
              aspects_reported: [...ran],
              aspects_pending: planned.filter(
                (a) => !ran.has(a) && !failedAspects.has(a)
              ),
              aspects_failed: failed.map((c) => ({
                aspect: c.aspect,
                error: c.error,
              })),
              // A pass that produced a report but omitted its mandatory
              // ASPECT_RESULT footer. It ran, so it is not failed -- but it
              // never confirmed it worked its rubric to the end, and without a
              // top-level field the only trace is `result: null` buried in
              // aspect_reports, which a reader scanning the summary will not
              // see. Same class the whole design defends against: a pass that
              // did not confirm it finished reading as one that did.
              aspects_unverified: (panel?.completed ?? [])
                .filter((c) => c.status === "complete_unverified")
                .map((c) => c.aspect),
              // Carried through verbatim from the start call. The report is the
              // place a reader decides what this review actually covered, and a
              // skipped aspect is invisible here unless it is stated.
              aspects_skipped: meta?.skipped ?? status?.skipped_aspects ?? [],
              findings_by_category: byCategory,
              aspect_reports: aspectReports,
              consolidated_report: consolidated,
              review_status: reviewStatus,
              budget,
              total_messages: messages.length,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Shared Tools (work with both dialog and review sessions) ────────────────

server.tool(
  "send_message",
  "Send a message to the configured partner session. The background runner will detect it and invoke the partner CLI to respond.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
    content: z.string().describe("Your message to the partner agent"),
  },
  async ({ session_id, content }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }
    const status = readStat(session_id);
    const hostAgent = getSessionHostAgent(status);
    const partnerAgent = getSessionPartnerAgent(status);
    const partnerDisplay = getAgentDisplayName(partnerAgent);

    // A message needs a runner to consume it. Without this check the log is an
    // append-only sink that still accepts writes after the session is over --
    // work that will never be answered, growing a file every poll re-reads.
    if (status?.runner_state === "exited" || !isSessionRunnerAlive(status, sessionDir)) {
      return {
        content: [
          {
            type: "text",
            text:
              `Error: this session's runner is no longer running` +
              (status?.runner_exit_reason ? ` (${status.runner_exit_reason})` : "") +
              `, so ${partnerDisplay} cannot answer. Start a new session; call end_dialog to close this one.`,
          },
        ],
      };
    }

    // Auto-refresh diff BEFORE appending message so it's ready when the runner
    // sees the new message and immediately starts building the prompt.
    let refreshError = null;
    let refreshNotice = null;
    const isReviewSession = status?.type === "review" || status?.type === "pr_review";
    if (isReviewSession && status.diff_target && !status.diff_target.startsWith("commit:")) {
      try {
        const refreshOpts = { cwd: status.project_path, timeout: 30000, maxBuffer: 10 * 1024 * 1024 };
        const baseline = status.head_sha || "HEAD";
        let refreshedDiff;
        if (status.diff_target === "pr") {
          // The only refresh path that leaves the machine. A PR review's subject
          // lives on the remote, so re-reading it locally would show the partner
          // a diff the PR does not have -- but it also means this branch can be
          // slow or fail offline, which the catch below turns into "keep using
          // the diff we started with" rather than a failed send.
          refreshedDiff = execFileSync(
            "gh",
            ["pr", "diff", String(status.pr_number ?? status.branch)],
            refreshOpts
          ).toString();
        } else if (status.diff_target === "staged") {
          let filesChanged = [];
          try {
            const metaFile =
              status.type === "pr_review" ? "pr_review_meta.json" : "review_meta.json";
            const meta = JSON.parse(
              fs.readFileSync(path.join(sessionDir, metaFile), "utf-8")
            );
            filesChanged = Array.isArray(meta?.files_changed) ? meta.files_changed : [];
          } catch {}

          try {
            refreshedDiff = filesChanged.length > 0
              ? execFileSync("git", ["diff", baseline, "--", ...filesChanged], refreshOpts).toString()
              : execFileSync("git", ["diff", baseline], refreshOpts).toString();
          } catch {
            refreshedDiff = execFileSync("git", ["diff", "HEAD"], refreshOpts).toString();
          }
        } else if (status.diff_target === "branch") {
          const base = status.base_branch || "main";
          const head = status.branch;
          try {
            refreshedDiff = execFileSync("git", ["diff", `${base}...${head}`], refreshOpts).toString();
          } catch {
            // Same fallback as the start path, and the same hazard: two dots
            // also includes whatever the base gained since the branch point, so
            // the reviewed change can quietly GROW between rounds while the
            // scope label stays identical. The partner would then file findings
            // against commits the author never wrote, mid-conversation, with
            // nothing marking the change of subject.
            refreshedDiff = execFileSync("git", ["diff", `${base}..${head}`], refreshOpts).toString();
            refreshNotice =
              `the merge-base diff of ${base}...${head} failed, so this refresh used a two-dot diff: ` +
              `the reviewed change may now include commits ${base} gained since the branch point`;
          }
        } else {
          // uncommitted: diff against the original HEAD SHA to keep baseline stable
          try {
            refreshedDiff = execFileSync("git", ["diff", baseline], refreshOpts).toString();
          } catch {
            refreshedDiff = execFileSync("git", ["diff"], refreshOpts).toString();
          }
        }
        writeFileAtomic(path.join(sessionDir, "diff_refreshed.patch"), refreshedDiff);
      } catch (err) {
        // Caught WITH the error. This catch covers every refresh target, not
        // just `pr` -- a branch/staged/uncommitted refresh failing lands here
        // too -- but the `pr` path is the one that leaves the machine, and its
        // failure modes are the ones that used to vanish: a dead network, an
        // expired gh token, a rate limit, a diff past maxBuffer, or a
        // force-pushed ref all arrived here identically and
        // silently -- while send_message still returned sent: true and the
        // partner was handed the session-start diff under a header calling it
        // current, alongside an instruction to verify fixes against it.
        //
        // Removing the stale file is still right (the runner falls back to the
        // original), but a refresh that worked last round and fails this one
        // regresses the partner to strictly older content, which is worth
        // saying out loud.
        refreshError = err.message;
        // The fallback notice describes a refresh that was computed and then
        // thrown away -- emitting both would tell the caller in one breath that
        // the diff could not be refreshed and that the refresh included extra
        // commits, with no way to tell which diff the partner actually has.
        refreshNotice = null;
        try { fs.unlinkSync(path.join(sessionDir, "diff_refreshed.patch")); } catch {}
      }
    }

    const msg = appendMsg(session_id, hostAgent, content);
    const messages = readConv(session_id);
    const budget = computeBudget(status, messages);
    const reviewStatus = computeReviewStatus(status, messages, {
      problem: readProblem(sessionDir),
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sent: true,
              message_id: msg.id,
              host_agent: hostAgent,
              partner_agent: partnerAgent,
              partner_timeout_ms: normalizePartnerTimeout(status?.partner_timeout_ms),
              budget,
              review_status: reviewStatus,
              // Always present, never conditionally spread. start_pr_review
              // returns `notices` unconditionally, so a caller writing
              // `result.notices.length` worked against one tool and threw
              // against the other.
              notices: [
                ...(refreshError
                  ? [
                      `The diff could not be refreshed (${refreshError}). ${partnerDisplay} is reviewing the diff captured when the review started, not the current state — treat any claim about a fix as unverified.`,
                    ]
                  : []),
                ...(refreshNotice ? [refreshNotice] : []),
              ],
              message:
                `Message sent (id: ${msg.id}). ${partnerDisplay} will be invoked to respond.` +
                (refreshError || refreshNotice ? ` NOTE: see notices about the refreshed diff.` : ""),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "check_messages",
  "Check for new messages from the configured partner agent. Returns messages after the given ID, plus runner status.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
    since_id: z
      .number()
      .optional()
      .describe("Return messages with ID greater than this (default: 0 = all)"),
  },
  async ({ session_id, since_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const snapshot = buildSessionSnapshot(session_id, { sinceId: since_id || 0 });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(snapshot.payload, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "wait_for_partner_response",
  "Long-poll a dialog or review session until the configured partner replies, a terminal condition occurs, or this wait call times out. A wait timeout does not kill the interactive tmux partner turn. Defaults to a 10 minute wait and emits best-effort progress heartbeats when the MCP client supplies a progress token.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
    since_id: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Return messages with ID greater than this and wait for partner/system wake messages after this ID"),
    timeout_ms: z
      .number()
      .int()
      .min(MIN_WAIT_TIMEOUT_MS)
      .optional()
      .describe("Maximum time for this wait call in milliseconds (default: 600000). This only controls the wait call; it does not kill the partner tmux session."),
    include_system: z
      .boolean()
      .optional()
      .describe("Wake on system messages as well as partner messages (default: true)"),
  },
  async ({ session_id, since_id, timeout_ms, include_system }, extra) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const result = await waitForSessionChange(
      session_id,
      {
        sinceId: since_id || 0,
        timeoutMs: timeout_ms,
        includeSystem: include_system !== false,
      },
      extra
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get_full_history",
  "Get the complete conversation history including the original problem description or review diff, plus the current reviewed subject when configured.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
  },
  async ({ session_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const messages = readConv(session_id);
    const status = readStat(session_id);
    const partnerAgent = getSessionPartnerAgent(status);
    const projectPath = status?.project_path || process.cwd();
    const reviewStatus = computeReviewStatus(status, messages, {
      problem: readProblem(sessionDir),
    });
    const referencedFiles = extractReferencedFiles(
      messages,
      projectPath,
      partnerAgent
    );

    // Return problem for dialogs, meta for reviews.
    //
    // The filename is type-dependent: a panel writes pr_review_meta.json, so
    // reading only review_meta.json here reported `review_meta: null` for every
    // PR review -- the same oversight that made send_message's refresh miss them.
    const problemPath = path.join(sessionDir, "problem.md");
    const metaPath = path.join(
      sessionDir,
      status?.type === "pr_review" ? "pr_review_meta.json" : "review_meta.json"
    );
    const problem = fs.existsSync(problemPath)
      ? fs.readFileSync(problemPath, "utf-8")
      : null;
    let currentSubject = null;
    if (status?.subject_path) {
      try {
        currentSubject = {
          path: status.subject_path,
          kind: status.subject_kind || "document",
          content: fs.readFileSync(status.subject_path, "utf-8"),
        };
      } catch (err) {
        currentSubject = {
          path: status.subject_path,
          kind: status.subject_kind || "document",
          error: err.message,
        };
      }
    }
    let meta = null;
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ problem, current_subject: currentSubject, review_meta: meta, messages, review_status: reviewStatus, referenced_files: referencedFiles }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "check_partner_alive",
  "Check if the partner runner process and current interactive tmux partner turn are alive. Returns compact live tmux status, activity inference, and a small pane tail by default; full pane capture is opt-in.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
    tail_lines: z
      .number()
      .int()
      .min(1)
      .max(40)
      .optional()
      .describe("Number of bottom tmux pane lines to return in capture.tail_text (default: 6)."),
    include_full_capture: z
      .boolean()
      .optional()
      .describe("When true, include the full bounded pane capture in capture.full_text. Defaults to false to avoid filling context windows."),
  },
  async ({ session_id, tail_lines, include_full_capture }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const status = readStat(session_id);
    const partnerAgent = getSessionPartnerAgent(status);
    const alive = isSessionRunnerAlive(status, sessionDir);

    const processingPath = getProcessingPath(sessionDir);
    const processing = fs.existsSync(processingPath);

    const messages = readConv(session_id);
    const lastPartnerMsg = [...messages]
      .reverse()
      .find((m) => m.from === partnerAgent);
    const lastPartnerTime = lastPartnerMsg
      ? new Date(lastPartnerMsg.timestamp)
      : null;
    const secondsSinceLastPartner = lastPartnerTime
      ? (Date.now() - lastPartnerTime.getTime()) / 1000
      : null;

    const errorPath = path.join(sessionDir, "last_error.txt");
    const lastError = fs.existsSync(errorPath)
      ? fs.readFileSync(errorPath, "utf-8")
      : null;

    // Read runner log tail
    const logPath = path.join(sessionDir, "runner.log");
    let logTail = null;
    if (fs.existsSync(logPath)) {
      const logLines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      logTail = logLines.slice(-5).join("\n");
    }

    const budget = computeBudget(status, messages);
    const reviewStatus = computeReviewStatus(status, messages, {
      problem: readProblem(sessionDir),
    });
    const partnerTerminal = await inspectPartnerTerminal(sessionDir, {
      tailLines: tail_lines,
      includeFullCapture: include_full_capture === true,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
      session_type: status?.type || "unknown",
      host_agent: getSessionHostAgent(status),
      partner_agent: partnerAgent,
      partner_timeout_ms: normalizePartnerTimeout(status?.partner_timeout_ms),
      runner_alive: alive,
      runner_pid: status?.runner_pid,
              partner_currently_processing: processing,
              seconds_since_last_partner_message: secondsSinceLastPartner,
              ...(partnerAgent === "codex"
                ? {
                    codex_currently_processing: processing,
                    seconds_since_last_codex_message: secondsSinceLastPartner,
                  }
                : {}),
              last_error: lastError,
              partner_terminal: partnerTerminal,
              started_at: status?.started_at,
              recent_log: logTail,
              budget,
              review_status: reviewStatus,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "send_key",
  "Send one key to the current live tmux pane for a Dualog partner turn. Use this only after check_partner_alive shows the exact interactive prompt and the intended response is already authorized by the user or the current task. It cannot target arbitrary tmux sessions. Set submit=true to follow a printable choice such as '2' with Enter. Delivery to tmux does not prove the TUI accepted the key, so inspect the pane again afterward.",
  {
    session_id: z.string().describe("The Dualog dialog or review session ID"),
    key: z
      .union([
        z.string().length(1).regex(/^[\x20-\x7E]$/u),
        z.enum(TMUX_NAMED_KEYS),
      ])
      .describe(
        `One printable ASCII character or a named key: ${TMUX_NAMED_KEYS.join(", ")}`
      ),
    submit: z
      .boolean()
      .optional()
      .describe("Also press Enter after this key. Intended for numbered or single-character menu choices."),
  },
  async ({ session_id, key, submit }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    const { current } = readTerminalState(sessionDir);
    if (!current) {
      return {
        content: [
          {
            type: "text",
            text: "Error: This session has no active tmux-backed partner turn",
          },
        ],
      };
    }
    if (current.runtime !== "tmux-interactive") {
      return {
        content: [
          {
            type: "text",
            text: "Error: The active partner turn is not running in tmux",
          },
        ],
      };
    }

    // current_terminal.json is a runtime record, not permission to address an
    // arbitrary local pane. Tie its identity back to this exact Dualog session
    // and require the stable pane id captured after tmux created it.
    const expectedSessionPrefix = `dlg-${session_id}-`;
    if (
      typeof current.session_name !== "string" ||
      !current.session_name.startsWith(expectedSessionPrefix) ||
      !/^%\d+$/u.test(current.pane_id || "")
    ) {
      return {
        content: [
          {
            type: "text",
            text: "Error: The active terminal record does not identify a managed Dualog pane",
          },
        ],
      };
    }

    const liveness = await probeTmuxSession(current.session_name);
    if (liveness !== "alive") {
      return {
        content: [
          {
            type: "text",
            text:
              liveness === "absent"
                ? "Error: The recorded partner tmux session is no longer running"
                : "Error: tmux could not confirm that the recorded partner pane is live; no key was sent",
          },
        ],
      };
    }
    if (!(await tmuxPaneBelongsToSession(current.session_name, current.pane_id))) {
      return {
        content: [
          {
            type: "text",
            text: "Error: The recorded pane ID does not belong to this Dualog tmux session; no key was sent",
          },
        ],
      };
    }

    try {
      await sendKeyToTmux(
        { paneId: current.pane_id },
        key,
        { submit: submit === true }
      );
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: Failed to send key: ${err.message}` }],
      };
    }

    const status = readStat(session_id);
    const partnerAgent = getSessionPartnerAgent(status);
    const partnerDisplay = getAgentDisplayName(partnerAgent);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sent: true,
              key,
              submitted: submit === true,
              partner_agent: partnerAgent,
              tmux_session: current.session_name,
              pane_id: current.pane_id,
              message:
                `Sent ${JSON.stringify(key)}` +
                (submit === true ? " followed by Enter" : "") +
                ` to ${partnerDisplay}'s active pane. Call check_partner_alive to verify the prompt advanced.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "end_dialog",
  "End a dialog or review session. Terminates the runner and returns the final conversation.",
  {
    session_id: z.string().describe("The session ID (dialog or review)"),
  },
  async ({ session_id }) => {
    const sessionDir = resolveSessionDir(session_id);
    if (!fs.existsSync(sessionDir)) {
      return { content: [{ type: "text", text: "Error: Session not found" }] };
    }

    // Signal the runner to stop
    fs.writeFileSync(path.join(sessionDir, "end_signal"), "");

    const status = readStat(session_id);
    let partnerTerminal = await terminateCurrentPartnerTerminal(sessionDir);
    unlinkProcessingMarkers(sessionDir);

    // The headless counterpart to terminateCurrentPartnerTerminal. A headless
    // child has no entry in current_terminal.json, so ending the session was the
    // one place it could be orphaned without anything noticing.
    let reapedHeadlessChildren = 0;
    try {
      reapedHeadlessChildren = await reapOrphanedHeadlessChildren(sessionDir);
    } catch {
      // Cleanup is best-effort; never fail closing a session over it.
    }

    if (isSessionRunnerAlive(status, sessionDir)) {
      // Observe the runner rather than assume it. An idle runner checks
      // end_signal at the TOP of its loop, so it usually exits within a few
      // hundred milliseconds of the write above -- measured at ~200ms -- while
      // a flat sleep charged every caller the full worst case before returning.
      //
      // The poll deliberately uses isProcessAlive (a cheap kill(pid, 0)) rather
      // than isSessionRunnerAlive: waiting has no side effects, so it does not
      // need the command-line identity check, and running that check 55 times
      // would spawn 55 `ps` processes. Identity still gates the SIGTERM below,
      // which is the only step that can harm an unrelated process after PID
      // reuse.
      const graceEndsAt = Date.now() + END_DIALOG_GRACE_MS;
      while (Date.now() < graceEndsAt && isProcessAlive(status.runner_pid)) {
        await new Promise((resolve) => setTimeout(resolve, END_DIALOG_POLL_MS));
      }
      if (isSessionRunnerAlive(status, sessionDir)) {
        try {
          process.kill(status.runner_pid, "SIGTERM");
        } catch {
          /* already dead */
        }
        // Only meaningful after a signal: give SIGTERM time to land before the
        // sweeps below look for what the runner left behind.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      // The runner is gone now, so this attempt can reach a pane the first one
      // could not. Keep whichever result actually found a terminal: the second
      // call returns `found: false` once the first proved the pane absent and
      // cleared the record, and overwriting the real verdict with that would
      // report the terminal as never having existed.
      const second = await terminateCurrentPartnerTerminal(sessionDir);
      if (second.found) partnerTerminal = second;
      unlinkProcessingMarkers(sessionDir);
      // The runner had to be signalled, so it may have spawned a child between
      // the first sweep and dying. Sweep again now that it is gone.
      try {
        reapedHeadlessChildren += await reapOrphanedHeadlessChildren(sessionDir);
      } catch {
        /* best-effort */
      }
    }

    // The partner is down and the runner is gone, so this session's leases are
    // now provably reclaimable. Sweeping rather than resolving this session's
    // turn pointers directly is deliberate: the lease's own metadata carries
    // everything needed to judge it, so a session whose archive was deleted by
    // hand still gets its credential projection reclaimed.
    let reclaimedLeases = 0;
    try {
      reclaimedLeases = sweepLeases({ apply: true }).removed.length;
    } catch {
      // Best-effort; a retained lease is reclaimed at the next startup sweep.
    }

    const messages = readConv(session_id);
    const reviewStatus = computeReviewStatus(status, messages, {
      problem: readProblem(sessionDir),
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ended: true,
              reclaimed_runtime_leases: reclaimedLeases,
              // Now means "there was a pane and it is PROVEN gone", where it
              // previously meant "there was a pane and we tried". A pane that
              // survived, or one tmux could not be asked about, reported as
              // terminated -- see partner_terminal_status for which it was.
              terminated_partner_terminal:
                partnerTerminal.found && partnerTerminal.verdict === "absent",
              partner_terminal_status: partnerTerminal.status,
              reaped_headless_children: reapedHeadlessChildren,
              session_type: status?.type || "unknown",
              total_messages: messages.length,
              review_status: reviewStatus,
              messages,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "list_adapters",
  "List every AI CLI this server can drive as a partner, with its capabilities and whether its binary is actually installed. Call this before start_dialog when you are unsure which partner agents are available.",
  {
    probe: z
      .boolean()
      .optional()
      .describe(
        "Also run each installed CLI's version command. Slower; off by default."
      ),
    installed_only: z
      .boolean()
      .optional()
      .describe("Return only adapters whose binary is present on PATH."),
  },
  async ({ probe, installed_only }) => {
    const described = await Promise.all(
      listAdapters().map((adapter) => describeAdapter(adapter, { probe: probe === true }))
    );
    const adapters = installed_only === true
      ? described.filter((a) => a.binary_available)
      : described;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              adapters,
              installed: adapters.filter((a) => a.binary_available).map((a) => a.id),
              missing: described.filter((a) => !a.binary_available).map((a) => a.id),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

/**
 * How a discovery result should be read. The structured fields say what
 * happened; this says what it MEANS, because the difference between "these are
 * your seven real Codex models" and "nothing answered, here is a list we
 * maintain by hand" is the whole value of the call, and a caller that misreads
 * it will confidently tell the user a working model does not exist.
 */
function describeProvenance(adapter, discovery) {
  const name = adapter.displayName;
  if (discovery.strategy === "static") {
    return (
      `Discovery did not answer for ${name}, so this is the hand-maintained list from ` +
      `its manifest. It is a snapshot, not a catalog: treat an id that is absent as ` +
      `unverified rather than invalid, and pass it through if the user asked for it.`
    );
  }
  if (discovery.stale) {
    return (
      `Read from ${discovery.source}, but that source is past its refresh window. A ` +
      `model released since it was written would be missing. Call again with ` +
      `refresh: true to re-read it.`
    );
  }
  if (discovery.models.length === 0) {
    return (
      `${discovery.source} was reachable and returned no models at all. That is a ` +
      `configuration or credentials problem at the source, not proof that ${name} has ` +
      `no models -- it rules nothing in or out.`
    );
  }
  return (
    `These are the models ${name} can currently be asked for, read live from ` +
    `${discovery.source}. An id absent from this list will be rejected.`
  );
}

server.tool(
  "list_models",
  "List the models one partner agent can actually be asked for right now, with where that list came from. Call this before passing a model to start_dialog or start_code_review -- do not assert from memory which models exist. Reports whether the list is a live catalog or a hand-maintained fallback, which decides whether an absent id is invalid or merely unverified.",
  {
    agent: z.string().describe("Adapter id, as returned by list_adapters"),
    refresh: z
      .boolean()
      .optional()
      .describe(
        "Re-read the source, bypassing the per-source cache. Off by default: some sources are free to re-read (a local cache file) and others are expensive (listing grok's models boots a full agent shell)."
      ),
    include_metadata: z
      .boolean()
      .optional()
      .describe(
        "Return each model's accepted efforts, default effort and context window instead of bare ids."
      ),
  },
  async ({ agent, refresh, include_metadata }) => {
    let adapter;
    try {
      adapter = getAdapter(agent);
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }

    // Never throws: a failed lookup degrades to the static list with a notice,
    // because a partner that could have been started must not be blocked by a
    // listing that did not answer.
    const discovery = await resolveDiscovery(adapter, { refresh: refresh === true });

    const models =
      include_metadata === true
        ? discovery.models.map((model) => ({
            id: model.id,
            ...(model.efforts ? { efforts: model.efforts } : {}),
            ...(model.defaultEffort ? { default_effort: model.defaultEffort } : {}),
            ...(model.context ? { context: model.context } : {}),
          }))
        : discovery.models.map((model) => model.id);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              agent: adapter.id,
              models,
              count: discovery.models.length,
              source: discovery.source,
              strategy: discovery.strategy,
              fetched_at: discovery.fetchedAt,
              stale: discovery.stale,
              // Whether this list is grounds to call an absent id invalid.
              authoritative: isEnumerable(discovery),
              provenance: describeProvenance(adapter, discovery),
              notices: discovery.notices,
              // Aliases are not catalog entries, so no discovery source can
              // return them -- but they are still valid to pass.
              aliases: adapter.modelAliases ?? {},
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "check_adapter",
  "Preflight one partner agent against the options you intend to use. Reports blocking errors and any option that would be silently dropped, without starting a session. Validates the model and reasoning effort together, since which efforts are legal depends on the model. Use list_models for what models exist.",
  {
    agent: z.string().describe("Adapter id, as returned by list_adapters"),
    engine: z
      .enum(ENGINES)
      .optional()
      .describe("Execution engine to check. Defaults to the adapter's own default."),
    model: z.string().optional(),
    reasoning_effort: z
      .string()
      .optional()
      .describe(
        "Checked against the chosen MODEL, not just the agent: an effort the agent parses may still be invalid for that model, and Claude answers such a pair by silently running at high."
      ),
    tool_profile: z.string().optional(),
    allow_unknown_model: z
      .boolean()
      .optional()
      .describe(
        "Pass a model the server does not recognize anyway. Only relevant when a live catalog was consulted; an unrecognized model is otherwise a warning already."
      ),
  },
  async ({ agent, engine, model, reasoning_effort, tool_profile, allow_unknown_model }) => {
    let adapter;
    try {
      adapter = getAdapter(agent);
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }

    let resolvedEngine;
    try {
      resolvedEngine = resolveEngine(adapter, { requested: engine ?? null });
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }

    // Discovery, on the same terms the start tools use.
    //
    // This used to be deliberately omitted, on the reasoning that the spawn path
    // did not fetch a catalog either and feeding one only to the preflight was
    // the one way the two could disagree. That reasoning was right; its premise
    // stopped being true when the start tools began resolving discovery. Left
    // as-is it produced exactly the disagreement it was written to prevent:
    // check_adapter accepting an opencode effort against an empty manifest that
    // start_dialog then rejects against the live catalog.
    const discoveredModels = await resolveDiscoveryForValidation(adapter, {
      model: model ?? null,
    });

    const result = negotiate(adapter, {
      engine: resolvedEngine,
      model: model ?? null,
      reasoningEffort: reasoning_effort ?? null,
      toolProfile: tool_profile ?? null,
      allowUnknownModel: allow_unknown_model === true,
      discoveredModels,
    });

    const { resolution } = result;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              agent: adapter.id,
              engine: resolvedEngine,
              ok: result.errors.length === 0,
              errors: result.errors,
              warnings: result.warnings,
              // What the turn would actually run as. `effective_effort` is the
              // one fact nothing else reports: with no effort given, the CLI
              // applies its own per-model default and never says which.
              resolved: {
                model: resolution.model,
                model_id: resolution.modelId,
                model_known: resolution.modelKnown,
                accepted_efforts: resolution.efforts,
                reasoning_effort: resolution.reasoningEffort,
                default_effort: resolution.defaultEffort,
                effective_effort: resolution.effectiveEffort,
              },
              notices: result.notices,
              adapter: await describeAdapter(adapter, { probe: true }),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "list_sessions",
  "List all dialog and review sessions (active and completed).",
  {},
  async () => {
    // Both roots, de-duplicated: the current one and the pre-rename one.
    const seen = new Set();
    const sessions = [];
    for (const root of [DIALOGS_DIR, LEGACY_DIALOGS_DIR]) {
      let entries;
      try {
        entries = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith("dialog-") && !entry.startsWith("review-")) continue;
        if (seen.has(entry)) continue;
        seen.add(entry);
        sessions.push(entry);
      }
    }
    const results = [];
    for (const sessionId of sessions) {
      try {
        const status = readStat(sessionId);
        const messages = readConv(sessionId);
        const alive = isSessionRunnerAlive(
          status,
          resolveSessionDir(sessionId)
        );
        const budget = computeBudget(status, messages);
        results.push({
        session_id: sessionId,
        // status.type is the session's real identity; the id prefix is only the
        // storage key, and PR review panels deliberately share the `review-`
        // prefix so they inherit its path validation and scratch cleanup. Read
        // the prefix alone and every panel reports as a plain review.
        type:
          status?.type ||
          (sessionId.startsWith("review-") ? "review" : "dialog"),
        started_at: status?.started_at,
        host_agent: getSessionHostAgent(status),
        partner_agent: getSessionPartnerAgent(status),
        partner_timeout_ms: normalizePartnerTimeout(status?.partner_timeout_ms),
        message_count: messages.length,
          runner_alive: alive,
          budget,
          ...(status?.branch ? { branch: status.branch, base_branch: status.base_branch } : {}),
        });
      } catch {
        results.push({ session_id: sessionId, error: "failed to read session" });
      }
    }

    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

// Reclaim runtime leases whose consumers are gone.
//
// A turn releases its own lease when its partner exits, so this catches only
// what a crash left behind -- a SIGKILLed runner, a machine that went down
// mid-turn. It runs at startup because that is the earliest moment a previous
// boot's leases can be shown unreachable: `sweepLeases` removes only what it can
// PROVE finished, so nothing here can touch a turn running under another server.
try {
  const receipt = sweepLeases({ apply: true });
  if (receipt.removed.length || receipt.errors.length) {
    console.error(
      `[dualog] runtime leases: reclaimed ${receipt.removed.length}, ` +
        `retained ${receipt.retained.length}, errors ${receipt.errors.length}`
    );
  }
} catch (err) {
  // Never block startup on cleanup. Retention is the safe direction anyway.
  console.error(`[dualog] runtime lease sweep skipped: ${err.message}`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
