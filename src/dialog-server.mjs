import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { spawn, execSync, execFileSync } from "child_process";
import crypto from "crypto";
import { fileURLToPath } from "url";
import {
  DIALOGS_DIR,
  getAgentDisplayName,
  getSessionHostAgent,
  getSessionPartnerAgent,
  normalizeAgent,
  readConversation,
  appendMessage,
  isProcessAlive,
  readStatus,
  computeReviewStatus,
} from "./shared.mjs";
import {
  inspectPartnerTerminal,
  readTerminalState,
  sweepOrphanedPartnerTerminals,
  terminateCurrentPartnerTerminal,
} from "./tmux-runtime.mjs";
import {
  ALL_REASONING_EFFORTS,
  normalizeReasoningEffortForAgent,
} from "./runtime-defaults.mjs";

const server = new McpServer({
  name: "codex-dialog",
  version: "1.0.0",
});

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_PARTNER_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_PARTNER_TIMEOUT_MS = 60 * 1000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const MAX_WAIT_TIMER_MS = 2_147_483_647;
const WAIT_FALLBACK_INTERVAL_MS = 5000;
const WAIT_PROGRESS_INTERVAL_MS = 30000;
const END_DIALOG_GRACE_MS = 5500;
const MODEL_OVERRIDE_DESCRIPTION =
  "Optional partner model override. Model strings are forwarded to the selected partner CLI. Claude examples: claude-fable-5, claude-opus-4-8, claude-opus-4-8[1m], claude-opus-4-7[1m], claude-opus-4-6[1m], claude-sonnet-4-6. Claude Fable 5 has 1M context by default; do not add a [1m] suffix. Codex examples: gpt-5.5, gpt-5.4, gpt-5.3-codex.";
const REASONING_EFFORT_DESCRIPTION =
  "Optional partner-specific reasoning effort level. Defaults to high. For Codex this is typically low|medium|high|xhigh; for Claude low|medium|high|xhigh|max.";

sweepOrphanedPartnerTerminals(DIALOGS_DIR, {
  log: (msg) => console.error(`[codex-dialog] ${msg}`),
}).catch((err) => {
  console.error(`[codex-dialog] Failed to sweep orphaned tmux sessions: ${err.message}`);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveSessionDir(sessionId) {
  if (!/^(dialog|review)-\d+-[0-9a-f]+$/.test(sessionId)) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }
  return path.join(DIALOGS_DIR, sessionId);
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

function resolvePartnerCommandValue(
  partnerAgent,
  partnerCommand,
  codexCommand,
  claudeCommand
) {
  if (partnerCommand) return partnerCommand;
  if (partnerAgent === "claude") return claudeCommand || "claude";
  return codexCommand || "codex";
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

function normalizeReasoningEffort(reasoningEffort, partnerAgent) {
  return normalizeReasoningEffortForAgent(reasoningEffort, partnerAgent);
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
  const runnerAlive = status?.runner_pid
    ? isProcessAlive(status.runner_pid)
    : false;
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
  "Start a new discussion session with a partner CLI. By default the host is Claude and the partner is Codex, but the session can be inverted so Codex hosts and Claude is the partner. Enforces a soft round budget (default 5) with a hard cap 5 rounds past that. Use subject_path for reviewed documents that should be reread each round, and tool_profile='implementation' only when the partner should edit files.",
  {
    problem_description: z
      .string()
      .describe("The problem to discuss with the partner agent"),
    project_path: z
      .string()
      .optional()
      .describe("Path to the project directory for context"),
    host_agent: z
      .enum(["claude", "codex"])
      .optional()
      .describe("Which agent is orchestrating the session (default: 'claude')"),
    partner_agent: z
      .enum(["claude", "codex"])
      .optional()
      .describe("Which agent should respond in the background runner (default: 'codex')"),
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
      .enum(ALL_REASONING_EFFORTS)
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
    let effectiveReasoningEffort;
    try {
      effectiveReasoningEffort = normalizeReasoningEffort(
        reasoning_effort,
        partnerAgent
      );
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err.message}`,
          },
        ],
      };
    }
    const partnerCommand = resolvePartnerCommandValue(
      partnerAgent,
      partner_command,
      codex_command,
      claude_command
    );
    const partnerDisplay = getAgentDisplayName(partnerAgent);
    const resolvedProjectPath = project_path || process.cwd();
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
      model: model || null,
      partner_timeout_ms: partnerTimeoutMs,
      tool_profile: tool_profile || "read",
      subject_path: subjectPath,
      subject_kind: subjectPath ? (subject_kind || "document") : null,
      runner_pid: null,
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
      effectiveReasoningEffort,
      model || "",
      hostAgent,
      partnerAgent,
      tool_profile || "read",
      String(partnerTimeoutMs),
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

    // Update status with PID
    status.runner_pid = runner.pid;
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

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
              reasoning_effort: effectiveReasoningEffort,
              model: model || "default",
              partner_timeout_ms: partnerTimeoutMs,
              tool_profile: tool_profile || "read",
              subject_path: subjectPath,
              subject_kind: subjectPath ? (subject_kind || "document") : null,
              message:
                `Dialog started with a soft budget of ${softCap} rounds (hard cap ${hardCap}), partner wait hint ${(partnerTimeoutMs / 60000).toFixed(1)} minutes, model: ${model || "default"}, reasoning effort: ${effectiveReasoningEffort}, tool profile: ${tool_profile || "read"}. Partner turns run in detached tmux and are not killed by the wait hint. Send your first message with send_message, then wait for ${partnerDisplay}.`,
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
  "Start a code review session where the configured partner agent reviews changes in the background. By default the host is Claude and the reviewer is Codex, but the flow can be inverted so Codex hosts and Claude reviews.",
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
      .enum(["claude", "codex"])
      .optional()
      .describe("Which agent is orchestrating the review (default: 'claude')"),
    partner_agent: z
      .enum(["claude", "codex"])
      .optional()
      .describe("Which agent should review in the background (default: 'codex')"),
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
      .enum(ALL_REASONING_EFFORTS)
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
    let effectiveReasoningEffort;
    try {
      effectiveReasoningEffort = normalizeReasoningEffort(
        reasoning_effort,
        partnerAgent
      );
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err.message}`,
          },
        ],
      };
    }
    const partnerCommand = resolvePartnerCommandValue(
      partnerAgent,
      partner_command,
      codex_command,
      claude_command
    );
    const partnerDisplay = getAgentDisplayName(partnerAgent);
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
      model: model || null,
      partner_timeout_ms: partnerTimeoutMs,
      runner_pid: null,
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
      effectiveReasoningEffort,
      model || "",
      hostAgent,
      partnerAgent,
      String(partnerTimeoutMs),
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

    status.runner_pid = runner.pid;
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify(status, null, 2)
    );

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
              host_agent: hostAgent,
              partner_agent: partnerAgent,
              partner_command: partnerCommand,
              max_rounds: softCap,
              hard_cap: hardCap,
              reasoning_effort: effectiveReasoningEffort,
              model: model || "default",
              partner_timeout_ms: partnerTimeoutMs,
              message:
                `Code review started with a soft budget of ${softCap} rounds (hard cap ${hardCap}), partner wait hint ${(partnerTimeoutMs / 60000).toFixed(1)} minutes, model: ${model || "default"}, reasoning effort: ${effectiveReasoningEffort}. ${partnerDisplay} is generating an initial review in detached tmux and is not killed by the wait hint.`,
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

    // Parse structured findings from codex messages. Keep in sync with the
    // taxonomy advertised in runner prompts and skill docs.
    const FINDING_CATEGORIES = [
      "CRITICAL",
      "CORRECTNESS",
      "ARCHITECTURE",
      "SECURITY",
      "ROBUSTNESS",
      "SUGGESTION",
      "QUESTION",
      "PRAISE",
      "NIT",
    ];
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

    // Auto-refresh diff BEFORE appending message so it's ready when the runner
    // sees the new message and immediately starts building the prompt.
    if (status?.type === "review" && status.diff_target && !status.diff_target.startsWith("commit:")) {
      try {
        const refreshOpts = { cwd: status.project_path, timeout: 30000, maxBuffer: 10 * 1024 * 1024 };
        const baseline = status.head_sha || "HEAD";
        let refreshedDiff;
        if (status.diff_target === "staged") {
          let filesChanged = [];
          try {
            const meta = JSON.parse(
              fs.readFileSync(path.join(sessionDir, "review_meta.json"), "utf-8")
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
            refreshedDiff = execFileSync("git", ["diff", `${base}..${head}`], refreshOpts).toString();
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
      } catch {
        // On failure, remove stale refreshed diff so runner falls back to original
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
              message: `Message sent (id: ${msg.id}). ${partnerDisplay} will be invoked to respond.`,
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

    // Return problem for dialogs, meta for reviews
    const problemPath = path.join(sessionDir, "problem.md");
    const metaPath = path.join(sessionDir, "review_meta.json");
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
    const alive = status?.runner_pid
      ? isProcessAlive(status.runner_pid)
      : false;

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
    const terminatedPartnerTerminal = await terminateCurrentPartnerTerminal(sessionDir);
    unlinkProcessingMarkers(sessionDir);

    if (status?.runner_pid && isProcessAlive(status.runner_pid)) {
      await new Promise((resolve) => setTimeout(resolve, END_DIALOG_GRACE_MS));
      if (isProcessAlive(status.runner_pid)) {
        try {
          process.kill(status.runner_pid, "SIGTERM");
        } catch {
          /* already dead */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      await terminateCurrentPartnerTerminal(sessionDir);
      unlinkProcessingMarkers(sessionDir);
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
              terminated_partner_terminal: terminatedPartnerTerminal,
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
  "list_sessions",
  "List all dialog and review sessions (active and completed).",
  {},
  async () => {
    if (!fs.existsSync(DIALOGS_DIR)) {
      return { content: [{ type: "text", text: "[]" }] };
    }

    const sessions = fs
      .readdirSync(DIALOGS_DIR)
      .filter((d) => d.startsWith("dialog-") || d.startsWith("review-"));
    const results = [];
    for (const sessionId of sessions) {
      try {
        const status = readStat(sessionId);
        const messages = readConv(sessionId);
        const alive = status?.runner_pid
          ? isProcessAlive(status.runner_pid)
          : false;
        const budget = computeBudget(status, messages);
        results.push({
        session_id: sessionId,
        type: sessionId.startsWith("review-") ? "review" : "dialog",
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

const transport = new StdioServerTransport();
await server.connect(transport);
