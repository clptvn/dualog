import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getAgentDisplayName, normalizeAgent } from "./shared.mjs";
import {
  analyzeTerminalActivity,
  buildTmuxSessionName,
  captureTmuxPane,
  inspectPartnerTerminal,
  isTmuxAvailable,
  isTmuxSessionAlive,
  readTerminalState,
  sendTextToTmux,
  startTmuxSession,
  terminateTmuxSession,
  writeTerminalState,
} from "./tmux-runtime.mjs";
import {
  CLAUDE_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
} from "./runtime-defaults.mjs";

const VALID_CODEX_EFFORTS = new Set(CODEX_REASONING_EFFORTS);
const VALID_CLAUDE_EFFORTS = new Set(CLAUDE_REASONING_EFFORTS);
const VALID_TOOL_PROFILES = new Set(["read", "implementation"]);
const CLAUDE_READ_TOOLS = "Read,Grep,Glob,Bash,LSP";
const CLAUDE_IMPLEMENTATION_TOOLS =
  "Read,Grep,Glob,Bash,LSP,Edit,MultiEdit,Write";
const CLAUDE_READ_DISALLOWED_TOOLS = "Edit,MultiEdit,Write,NotebookEdit";
const DONE_WITHOUT_RESULT_GRACE_MS = 10000;
const POST_SUBMIT_VERIFY_MS = 30000;
const POST_SUBMIT_RETRY_MS = 15000;
const IDLE_PROMPT_STALL_MS = 2 * 60 * 1000;
const UNKNOWN_STALL_MS = parsePositiveInt(
  process.env.CODEX_DIALOG_STALLED_PANE_MS,
  15 * 60 * 1000
);

export class PartnerTurnCancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "PartnerTurnCancelledError";
    this.cancelledByEndDialog = true;
  }
}

export function isPartnerTurnCancelledError(err) {
  return Boolean(err?.cancelledByEndDialog);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeToolProfile(toolProfile) {
  return VALID_TOOL_PROFILES.has(toolProfile) ? toolProfile : "read";
}

function buildInvocation({
  partnerAgent,
  partnerCommand,
  projectPath,
  sessionDir,
  model,
  reasoningEffort,
  toolProfile,
  sessionName,
  initialPrompt,
}) {
  const normalizedAgent = normalizeAgent(partnerAgent, "codex");
  const normalizedToolProfile = normalizeToolProfile(toolProfile);

  if (normalizedAgent === "claude") {
    const allowedTools =
      normalizedToolProfile === "implementation"
        ? CLAUDE_IMPLEMENTATION_TOOLS
        : CLAUDE_READ_TOOLS;
    const emptyMcpConfigPath = path.join(sessionDir, "claude-empty-mcp.json");
    ensureEmptyClaudeMcpConfig(emptyMcpConfigPath);
    const args = [
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      allowedTools,
      "--mcp-config",
      emptyMcpConfigPath,
      "--strict-mcp-config",
      "--add-dir",
      projectPath,
      "--add-dir",
      sessionDir,
      "--name",
      sessionName,
    ];
    if (normalizedToolProfile === "read") {
      args.push("--disallowedTools", CLAUDE_READ_DISALLOWED_TOOLS);
    }
    if (model) {
      args.push("--model", model);
    }
    if (reasoningEffort && VALID_CLAUDE_EFFORTS.has(reasoningEffort)) {
      args.push("--effort", reasoningEffort);
    }
    return { command: partnerCommand, args };
  }

  const args = [
    "-C",
    projectPath,
    "--sandbox",
    "workspace-write",
    "--add-dir",
    sessionDir,
    "--ask-for-approval",
    "never",
    "--no-alt-screen",
    "-c",
    'approval_policy="never"',
  ];
  if (model) {
    args.push("--model", model);
  }
  if (reasoningEffort && VALID_CODEX_EFFORTS.has(reasoningEffort)) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  if (initialPrompt) {
    args.push(initialPrompt);
  }
  return {
    command: partnerCommand,
    args,
    env: prepareCodexPartnerEnv(sessionDir),
    usesInitialPrompt: Boolean(initialPrompt),
  };
}

function prepareCodexPartnerEnv(sessionDir) {
  const sourceHome =
    process.env.CODEX_HOME ||
    (process.env.HOME ? path.join(process.env.HOME, ".codex") : null);
  const partnerHome = path.join(sessionDir, "codex-home");
  fs.mkdirSync(partnerHome, { recursive: true });

  if (sourceHome) {
    copyIfMissing(path.join(sourceHome, "auth.json"), path.join(partnerHome, "auth.json"));
    copyIfExists(path.join(sourceHome, "version.json"), path.join(partnerHome, "version.json"));
  }

  return { CODEX_HOME: partnerHome };
}

function ensureEmptyClaudeMcpConfig(configPath) {
  if (fs.existsSync(configPath)) return;
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
}

function copyIfExists(sourcePath, targetPath) {
  try {
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  } catch {
    // Missing auth is surfaced by the Codex CLI itself and captured from tmux.
  }
}

function copyIfMissing(sourcePath, targetPath) {
  try {
    if (!fs.existsSync(targetPath)) {
      copyIfExists(sourcePath, targetPath);
    }
  } catch {
    // Missing auth is surfaced by the Codex CLI itself and captured from tmux.
  }
}

export async function runPartnerCommand({
  partnerAgent,
  partnerCommand,
  prompt,
  projectPath,
  model,
  reasoningEffort,
  toolProfile,
  timeoutMs,
  log,
  tempPrefix,
  responseInstruction,
  sessionDir,
}) {
  const normalizedAgent = normalizeAgent(partnerAgent, "codex");
  const partnerDisplay = getAgentDisplayName(normalizedAgent);
  const normalizedToolProfile = normalizeToolProfile(toolProfile);

  if (!sessionDir) {
    throw new Error("Interactive partner invocation requires sessionDir");
  }
  if (!(await isTmuxAvailable())) {
    throw new Error("tmux is required for interactive partner sessions but was not found on PATH");
  }

  const turnId = `${tempPrefix || normalizedAgent}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
  const turnDir = path.join(sessionDir, "turns", turnId);
  fs.mkdirSync(turnDir, { recursive: true });

  const promptPath = path.join(turnDir, "prompt.md");
  const resultPath = path.join(turnDir, "result.md");
  const donePath = path.join(turnDir, "done.json");
  const capturePath = path.join(turnDir, "terminal-capture.txt");
  fs.writeFileSync(promptPath, prompt);

  const sessionName = buildTmuxSessionName(
    path.basename(sessionDir),
    turnId
  );
  const bootstrap = buildBootstrapPrompt({
    partnerDisplay,
    promptPath,
    resultPath,
    donePath,
    projectPath,
    responseInstruction,
  });
  const { command, args, env, usesInitialPrompt } = buildInvocation({
    partnerAgent: normalizedAgent,
    partnerCommand,
    projectPath,
    sessionDir,
    model,
    reasoningEffort,
    toolProfile: normalizedToolProfile,
    sessionName,
    initialPrompt: normalizedAgent === "codex" ? bootstrap : null,
  });

  const timeoutHint =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : null;
  const terminalBaseState = {
    runtime: "tmux-interactive",
    agent: normalizedAgent,
    display_name: partnerDisplay,
    session_name: sessionName,
    pane_target: `${sessionName}:0.0`,
    cwd: projectPath,
    command,
    args,
    turn_dir: turnDir,
    prompt_path: promptPath,
    result_path: resultPath,
    done_path: donePath,
    timeout_hint_ms: timeoutHint,
    tool_profile: normalizedToolProfile,
    model: model || null,
    reasoning_effort: reasoningEffort || null,
    status: "starting",
    started_at: new Date().toISOString(),
  };

  let handle = null;
  let state = writeTerminalState(sessionDir, terminalBaseState, { active: true });

  try {
    log(
      `Invoking ${partnerDisplay} interactively via tmux session "${sessionName}" (prompt: ${prompt.length} chars, tool profile: ${normalizedToolProfile}, timeout hint: ${timeoutHint ? `${timeoutHint / 1000}s` : "none"})`
    );

    handle = await startTmuxSession({
      sessionName,
      cwd: projectPath,
      command,
      args,
      env,
    });
    state = writeTerminalState(
      sessionDir,
      {
        ...state,
        pane_target: handle.paneTarget,
        pane_id: handle.paneId || null,
        status: "readying",
      },
      { active: true }
    );

    await waitForInteractiveReady({
      agent: normalizedAgent,
      handle,
      log,
      partnerDisplay,
      sessionDir,
      capturePath,
      acceptBusy: usesInitialPrompt,
    });

    state = writeTerminalState(
      sessionDir,
      {
        ...state,
        status: "running",
      },
      { active: true }
    );

    if (!usesInitialPrompt) {
      await sendTextToTmux(handle, bootstrap, { enter: false });
      await new Promise((resolve) => setTimeout(resolve, 750));
      await sendTextToTmux(handle, "", { enter: true, submitDelayMs: 0 });
      await waitForPromptSubmission({
        agent: normalizedAgent,
        handle,
      log,
      partnerDisplay,
      sessionDir,
      capturePath,
      resultPath,
      donePath,
      });
    }

    const response = await waitForSidecarCompletion({
      partnerDisplay,
      agent: normalizedAgent,
      sessionDir,
      turnDir,
      resultPath,
      donePath,
      handle,
      capturePath,
      log,
    });

    const finalCapture = await captureAndPersist(handle, capturePath, log);
    await terminateTmuxSession(handle);
    writeTerminalState(
      sessionDir,
      {
        ...state,
        status: "complete",
        completed_at: new Date().toISOString(),
        last_capture_path: finalCapture?.path || null,
      },
      { active: false }
    );

    return response.trim();
  } catch (err) {
    const finalCapture = handle
      ? await captureAndPersist(handle, capturePath, log)
      : null;
    let finalCapturePath = finalCapture?.path || null;
    if (!finalCapturePath && fs.existsSync(capturePath)) {
      finalCapturePath = capturePath;
    }
    if (handle) {
      try {
        await terminateTmuxSession(handle);
      } catch (cleanupErr) {
        log(`Failed to terminate ${partnerDisplay} tmux session: ${cleanupErr.message}`);
      }
    }
    const { last } = readTerminalState(sessionDir);
    const alreadyTerminated =
      last?.session_name === state.session_name && last.status === "terminated";
    const cancelled = isPartnerTurnCancelledError(err);
    if (!alreadyTerminated) {
      writeTerminalState(
        sessionDir,
        {
          ...state,
          status: cancelled ? "cancelled" : "failed",
          completed_at: new Date().toISOString(),
          last_capture_path: finalCapturePath,
          ...(cancelled ? {} : { error: err.message }),
        },
        { active: false }
      );
    }
    throw err;
  }
}

function buildBootstrapPrompt({
  partnerDisplay,
  promptPath,
  resultPath,
  donePath,
  projectPath,
  responseInstruction,
}) {
  return `Read the prompt file at:
${promptPath}

Follow the prompt exactly for the project at:
${projectPath}

${responseInstruction || "Produce the requested response."}

Completion protocol is mandatory:
1. Do all investigation or implementation work requested by the prompt.
2. Write ONLY the final message that should be sent back to the host agent to:
${resultPath}
3. Then write this JSON object to:
${donePath}

{"status":"ok","result_path":"${jsonEscape(resultPath)}","summary":"completed","error":null}

If you cannot complete the work, still write a useful final message to the result file, then write done.json with "status":"error" and a concise non-empty "error" string.

Use shell/Bash commands for these sidecar writes if file-write tools are unavailable in this session.

Do not stop after printing to the terminal. The host will not receive your response until both sidecar files exist.`;
}

async function waitForInteractiveReady({
  agent,
  handle,
  log,
  partnerDisplay,
  sessionDir,
  capturePath,
  acceptBusy = false,
}) {
  const endSignalPath = path.join(sessionDir, "end_signal");
  const deadline = Date.now() + 45000;
  const handledStartupPrompts = new Set();
  let lastSnapshot = "";
  while (Date.now() <= deadline) {
    if (fs.existsSync(endSignalPath)) {
      throw new PartnerTurnCancelledError(`${partnerDisplay} interactive turn was cancelled by end_dialog`);
    }
    if (!(await isTmuxSessionAlive(handle.sessionName))) {
      const persistedCapturePath = persistCaptureText(capturePath, lastSnapshot, log);
      throw new Error(
        `${partnerDisplay} tmux session exited before the interactive prompt was ready` +
          (lastSnapshot ? `; terminal: ${lastSnapshot.slice(-1000)}` : "") +
          (persistedCapturePath ? `; capture: ${persistedCapturePath}` : "")
      );
    }
    try {
      lastSnapshot = await captureTmuxPane(handle, { lines: 80 });
    } catch {
      lastSnapshot = "";
    }

    const startupPrompt = lastSnapshot
      ? detectStartupPrompt(agent, lastSnapshot)
      : null;
    if (
      startupPrompt &&
      !handledStartupPrompts.has(startupPrompt.kind)
    ) {
      log(`${partnerDisplay} interactive session showed ${startupPrompt.kind}; sending ${startupPrompt.description}`);
      await sendTextToTmux(handle, startupPrompt.input, {
        enter: true,
        submitDelayMs: 0,
      });
      handledStartupPrompts.add(startupPrompt.kind);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    if (lastSnapshot && isInteractiveReady(agent, lastSnapshot)) {
      persistCaptureText(capturePath, lastSnapshot, log);
      return;
    }

    if (acceptBusy && lastSnapshot && isInteractiveBusy(agent, lastSnapshot)) {
      persistCaptureText(capturePath, lastSnapshot, log);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  log(
    `${partnerDisplay} interactive prompt did not show a ready marker before bootstrap; attempting paste anyway` +
      (lastSnapshot ? ` (last capture: ${lastSnapshot.slice(-500)})` : "")
  );
  persistCaptureText(capturePath, lastSnapshot, log);
}

async function waitForPromptSubmission({
  agent,
  handle,
  log,
  partnerDisplay,
  sessionDir,
  capturePath,
  resultPath,
  donePath,
}) {
  const endSignalPath = path.join(sessionDir, "end_signal");
  const startedAt = Date.now();
  let deadline = startedAt + POST_SUBMIT_VERIFY_MS;
  let retriedEnter = false;
  let lastSnapshot = "";

  while (Date.now() <= deadline) {
    if (fs.existsSync(endSignalPath)) {
      throw new PartnerTurnCancelledError(`${partnerDisplay} interactive turn was cancelled by end_dialog`);
    }
    if (fs.existsSync(donePath) || fs.existsSync(resultPath)) return;

    if (!(await isTmuxSessionAlive(handle.sessionName))) {
      throw new Error(`${partnerDisplay} tmux session exited after prompt submission`);
    }

    try {
      lastSnapshot = await captureTmuxPane(handle, { lines: 80 });
      persistCaptureText(capturePath, lastSnapshot, log);
    } catch {
      lastSnapshot = "";
    }

    const activity = analyzeTerminalActivity(lastSnapshot, agent, { alive: true });
    if (
      activity.state === "thinking" ||
      activity.state === "working" ||
      activity.state === "running_command" ||
      activity.state === "reading" ||
      activity.state === "writing"
    ) {
      return;
    }

    if (
      !retriedEnter &&
      Date.now() - startedAt > 5000 &&
      isInteractiveReady(agent, lastSnapshot)
    ) {
      log(`${partnerDisplay} still appears idle after prompt paste; retrying Enter once`);
      await sendTextToTmux(handle, "", { enter: true, submitDelayMs: 0 });
      retriedEnter = true;
      deadline = Date.now() + POST_SUBMIT_RETRY_MS;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `${partnerDisplay} did not begin processing after prompt submission` +
      (lastSnapshot ? `; terminal: ${lastSnapshot.slice(-1000)}` : "")
  );
}

async function waitForSidecarCompletion({
  partnerDisplay,
  agent,
  sessionDir,
  turnDir,
  resultPath,
  donePath,
  handle,
  capturePath,
  log,
}) {
  const endSignalPath = path.join(sessionDir, "end_signal");
  let lastProgressLog = 0;
  let idlePromptSince = null;
  let unknownSince = null;
  let lastActivityFingerprint = null;
  let lastActivityChangedAt = Date.now();

  while (true) {
    if (fs.existsSync(endSignalPath)) {
      throw new PartnerTurnCancelledError(`${partnerDisplay} interactive turn was cancelled by end_dialog`);
    }

    const completion = readCompletion({ turnDir, resultPath, donePath });
    if (completion) {
      if (completion.status === "error") {
        throw new Error(
          `${partnerDisplay} reported an interactive turn error: ${completion.error || completion.result}`
        );
      }
      return completion.result;
    }

    if (!(await isTmuxSessionAlive(handle.sessionName))) {
      const persistedCapture = readOptionalText(capturePath);
      const inspection = await inspectPartnerTerminal(sessionDir).catch(() => null);
      throw new Error(
        `${partnerDisplay} tmux session exited before writing completion sidecars` +
          (persistedCapture ? `; terminal: ${persistedCapture.slice(-1000)}` : "") +
          (!persistedCapture && inspection?.capture?.text
            ? `; terminal: ${inspection.capture.text.slice(-1000)}`
            : "")
      );
    }

    if (Date.now() - lastProgressLog > 60000) {
      lastProgressLog = Date.now();
      const capture = await captureAndPersist(handle, capturePath, log);
      const activity = analyzeTerminalActivity(capture?.text || "", agent, {
        alive: true,
      });
      const activityFingerprint = [
        activity.state,
        activity.status_line || "",
        activity.tokens ?? "",
        activity.elapsed || "",
      ].join("|");
      if (activityFingerprint !== lastActivityFingerprint) {
        lastActivityFingerprint = activityFingerprint;
        lastActivityChangedAt = Date.now();
      }

      if (
        activity.state === "idle_prompt" ||
        (
          activity.idle_prompt_visible &&
          Date.now() - lastActivityChangedAt > IDLE_PROMPT_STALL_MS
        )
      ) {
        idlePromptSince ||= Date.now();
        if (Date.now() - idlePromptSince > IDLE_PROMPT_STALL_MS) {
          throw new Error(
            `${partnerDisplay} appears idle in tmux without writing completion sidecars: ${activity.summary}`
          );
        }
      } else {
        idlePromptSince = null;
      }

      if (activity.state === "unknown") {
        unknownSince ||= Date.now();
        if (Date.now() - unknownSince > UNKNOWN_STALL_MS) {
          throw new Error(
            `${partnerDisplay} tmux pane did not show recognizable activity for ${Math.round(UNKNOWN_STALL_MS / 1000)}s`
          );
        }
      } else {
        unknownSince = null;
      }
      log(`${partnerDisplay} interactive turn is still running in tmux session "${handle.sessionName}"`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function readCompletion({ turnDir, resultPath, donePath }) {
  let doneStat;
  try {
    doneStat = fs.statSync(donePath);
  } catch (err) {
    if (isTransientFsError(err)) return null;
    throw err;
  }

  let done;
  try {
    done = JSON.parse(fs.readFileSync(donePath, "utf-8"));
  } catch {
    return null;
  }

  const status = done?.status === "error" ? "error" : "ok";
  const selectedResultPath =
    typeof done?.result_path === "string" && done.result_path.trim()
      ? done.result_path
      : resultPath;
  const resolvedResultPath = assertPathInside(turnDir, selectedResultPath);
  let resultExists = false;
  try {
    resultExists = fs.statSync(resolvedResultPath).isFile();
  } catch (err) {
    if (!isTransientFsError(err)) throw err;
  }
  if (!resultExists) {
    if (status === "error") {
      return {
        status,
        result: "",
        error: typeof done?.error === "string" ? done.error : "Partner reported an error before writing a result file",
      };
    }
    const doneAgeMs = Date.now() - doneStat.mtimeMs;
    if (doneAgeMs > DONE_WITHOUT_RESULT_GRACE_MS) {
      return {
        status: "error",
        result: "",
        error: `Partner wrote done.json with status ok but result file is missing: ${resolvedResultPath}`,
      };
    }
    return null;
  }
  let realResultPath;
  let result;
  try {
    realResultPath = assertRealPathInside(turnDir, resolvedResultPath);
    result = fs.readFileSync(realResultPath, "utf-8");
  } catch (err) {
    if (isTransientFsError(err)) return null;
    throw err;
  }
  return {
    status,
    result,
    error: typeof done?.error === "string" ? done.error : null,
  };
}

async function captureAndPersist(handle, capturePath, log) {
  try {
    const capture = await captureTmuxPane(handle, { lines: 240 });
    persistCaptureText(capturePath, capture, log);
    return { path: capturePath, text: capture };
  } catch (err) {
    log(`Failed to capture tmux pane for ${handle.sessionName}: ${err.message}`);
    return null;
  }
}

function persistCaptureText(capturePath, capture, log) {
  if (!capturePath || !capture) return null;
  try {
    fs.writeFileSync(capturePath, capture);
    return capturePath;
  } catch (err) {
    log(`Failed to persist tmux pane capture at ${capturePath}: ${err.message}`);
    return null;
  }
}

function readOptionalText(filePath) {
  try {
    return filePath && fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf-8")
      : null;
  } catch {
    return null;
  }
}

function isInteractiveBusy(agent, snapshot) {
  if (detectStartupPrompt(agent, snapshot)) return false;
  const activity = analyzeTerminalActivity(snapshot, agent, { alive: true });
  return [
    "thinking",
    "working",
    "running_command",
    "reading",
    "writing",
  ].includes(activity.state);
}

function isInteractiveReady(agent, snapshot) {
  if (agent === "claude") {
    const hasClaudeHeader =
      /Claude Code v\d+\.\d+\.\d+/u.test(snapshot) ||
      snapshot.includes("Claude Code v");
    const hasPromptUi =
      snapshot.includes('Try "') ||
      snapshot.includes("shift+tab to cycle") ||
      snapshot.includes("bypass permissions on") ||
      snapshot.includes("plan mode on");
    return hasClaudeHeader && hasPromptUi;
  }

  const tail = snapshot.slice(-2000);
  if (tail.includes("Booting MCP server") || /model:\s+loading/u.test(tail)) {
    return false;
  }
  const hasCodexHeader =
    /OpenAI Codex \(v\d+\.\d+\.\d+\)/u.test(snapshot) ||
    snapshot.includes("OpenAI Codex");
  const hasPromptUi =
    snapshot.includes("›") ||
    snapshot.includes("Context ") ||
    snapshot.includes("/model to change") ||
    snapshot.includes("Tip: Try the Codex App");
  return hasCodexHeader && hasPromptUi;
}

function detectStartupPrompt(agent, snapshot) {
  const tail = snapshot.slice(-4000);
  const lowerTail = tail.toLowerCase();
  if (agent === "claude") {
    if (isInteractiveReady(agent, snapshot)) return null;
    if (
      snapshot.includes("Quick safety check") &&
      snapshot.includes("Yes, I trust this folder") &&
      snapshot.includes("No, exit")
    ) {
      return {
        kind: "workspace_trust",
        input: "1",
        description: "trusted-folder option",
      };
    }
    if (
      lowerTail.includes("bypass permissions") &&
      (lowerTail.includes("warning") || lowerTail.includes("mode")) &&
      (
        lowerTail.includes("yes, i accept") ||
        /^\s*(?:\d+[\).]?\s*)?(?:yes|accept|continue)\b.*(?:accept|bypass|permission|continue)/imu.test(tail)
      ) &&
      /^[^\w\n]*(?:\d+[\).]?\s*)?(?:no|cancel|exit)\b/imu.test(tail)
    ) {
      return {
        kind: "bypass_permissions_warning",
        input: "2",
        description: "bypass-permissions confirmation",
      };
    }
    if (
      lowerTail.includes("choose") &&
      (lowerTail.includes("theme") || lowerTail.includes("text style"))
    ) {
      return {
        kind: "theme_picker",
        input: "",
        description: "default theme selection",
      };
    }
    return null;
  }
  if (
    snapshot.includes("Do you trust the contents of this directory") &&
    snapshot.includes("Yes, continue") &&
    snapshot.includes("No, quit")
  ) {
    return {
      kind: "workspace_trust",
      input: "1",
      description: "trusted-directory option",
    };
  }
  if (
    snapshot.includes("Do you trust") &&
    snapshot.includes("Trusting the directory") &&
    snapshot.includes("No, quit")
  ) {
    return {
      kind: "workspace_trust",
      input: "1",
      description: "trusted-directory option",
    };
  }
  return null;
}

function assertPathInside(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(root, targetPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Completion result path is outside the turn directory: ${targetPath}`);
  }
  return resolved;
}

function isTransientFsError(err) {
  return ["ENOENT", "ENOTDIR", "EAGAIN", "EBUSY"].includes(err?.code);
}

function assertRealPathInside(rootDir, targetPath) {
  const root = fs.realpathSync(rootDir);
  const resolved = fs.realpathSync(targetPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Completion result path resolves outside the turn directory: ${targetPath}`);
  }
  return resolved;
}

function jsonEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
