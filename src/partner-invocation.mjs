import fs from "fs";
import { envWithAliases } from "./platform.mjs";
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
import { buildInvocationFromAdapter } from "./adapters/argv.mjs";
// Imported rather than redefined. A recursion guard with two definitions is a
// recursion guard that can drift, and only one of them would be the one a real
// spawn uses.
import { partnerSentinelEnv } from "./adapters/env.mjs";
import { resolveDiscoveryForValidation } from "./adapters/resolve-for-validation.mjs";
import { getAdapter, tryGetAdapter } from "./adapters/registry.mjs";
import {
  isReady,
  detectStartupPrompt as detectStartupPromptFromTui,
} from "./tui/markers.mjs";
import {
  SUBMISSION_MARKER,
  buildBootstrapPrompt,
  readCompletion,
} from "./engines/completion.mjs";
import { resolveEngine } from "./engines/index.mjs";
import { runHeadlessTurn } from "./engines/headless.mjs";

const VALID_CODEX_EFFORTS = new Set(CODEX_REASONING_EFFORTS);
const VALID_CLAUDE_EFFORTS = new Set(CLAUDE_REASONING_EFFORTS);
const VALID_TOOL_PROFILES = new Set(["read", "implementation"]);
const CLAUDE_READ_TOOLS = "Read,Grep,Glob,Bash,LSP";
const CLAUDE_IMPLEMENTATION_TOOLS =
  "Read,Grep,Glob,Bash,LSP,Edit,MultiEdit,Write";
const CLAUDE_READ_DISALLOWED_TOOLS = "Edit,MultiEdit,Write,NotebookEdit";
const POST_SUBMIT_VERIFY_MS = parsePositiveInt(
  envWithAliases(["DUALOG_POST_SUBMIT_VERIFY_MS", "CODEX_DIALOG_POST_SUBMIT_VERIFY_MS"]),
  30000
);
const POST_SUBMIT_RETRY_MS = parsePositiveInt(
  envWithAliases(["DUALOG_POST_SUBMIT_RETRY_MS", "CODEX_DIALOG_POST_SUBMIT_RETRY_MS"]),
  15000
);
const POST_SUBMIT_RETRY_TRIGGER_MS = parsePositiveInt(
  envWithAliases(["DUALOG_POST_SUBMIT_RETRY_TRIGGER_MS", "CODEX_DIALOG_POST_SUBMIT_RETRY_TRIGGER_MS"]),
  5000
);
const TERMINAL_FAILURE_CHECK_INTERVAL_MS = parsePositiveInt(
  envWithAliases(["DUALOG_TERMINAL_FAILURE_CHECK_MS", "CODEX_DIALOG_TERMINAL_FAILURE_CHECK_MS"]),
  5000
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

export class PartnerTerminalFailureError extends Error {
  constructor(message, failureCode = "terminal_failure") {
    super(message);
    this.name = "PartnerTerminalFailureError";
    this.partnerTerminalFailed = true;
    this.failureCode = failureCode;
  }
}

export function isPartnerTerminalFailureError(err) {
  return Boolean(err?.partnerTerminalFailed);
}

export function detectPartnerTerminalFailure(captureText) {
  const recentLines = String(captureText || "").split(/\r?\n/u).slice(-50);
  const text = normalizeCapturedText(recentLines.join("\n"));
  if (!text) return null;

  const failures = [
    {
      code: "usage_limit",
      pattern:
        /\b(?:you(?:'|’)ve hit your (?:monthly spend|session|usage|rate) limit|usage limit (?:has been )?reached|rate limit (?:has been )?reached|insufficient[_ ]quota|credit balance is too low)\b/iu,
      summary: "the partner CLI reported an account usage, spend, or rate limit",
    },
    {
      code: "policy_block",
      pattern:
        /\b(?:safeguards flagged this message|Claude Code can(?:not|'t|’t) respond to this request)\b/iu,
      summary: "the partner CLI reported a terminal policy or safeguard refusal",
    },
    {
      code: "authentication_required",
      pattern:
        /\b(?:authentication required|not logged in|please (?:run|use) \/?login|401 unauthorized|account has been disabled)\b/iu,
      summary: "the partner CLI reported an authentication or account failure",
    },
  ];

  for (const failure of failures) {
    if (failure.pattern.test(text)) {
      return { code: failure.code, summary: failure.summary };
    }
  }
  return null;
}

function normalizeToolProfile(toolProfile) {
  return VALID_TOOL_PROFILES.has(toolProfile) ? toolProfile : "read";
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Exported for the golden argv snapshots. Those snapshots are the regression
// proof for the adapter-registry refactor: the registry-driven argv builder
// must reproduce this function's output byte for byte.
export function buildInvocation({
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
    return { command: partnerCommand, args, env: partnerSentinelEnv() };
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
    env: { ...prepareCodexPartnerEnv(sessionDir), ...partnerSentinelEnv() },
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
  engine: requestedEngine = null,
  // Decided by the start-tool preflight and carried through the runner. Without
  // it the turn re-validates on stricter terms than the start call used and
  // rejects a model the caller explicitly allowed.
  allowUnknownModel = false,
}) {
  const normalizedAgent = normalizeAgent(partnerAgent, "codex");
  const partnerDisplay =
    tryGetAdapter(normalizedAgent)?.displayName ?? getAgentDisplayName(normalizedAgent);
  const normalizedToolProfile = normalizeToolProfile(toolProfile);

  if (!sessionDir) {
    throw new Error("Partner invocation requires sessionDir");
  }

  const resolvedAdapter = getAdapter(normalizedAgent);
  const engine = resolveEngine(resolvedAdapter, { requested: requestedEngine, log });

  if (engine === "tmux-interactive" && !(await isTmuxAvailable())) {
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

  if (engine === "headless") {
    return (
      await runHeadlessTurn({
        adapter: resolvedAdapter,
        partnerCommand,
        bootstrap: buildBootstrapPrompt({
          promptPath,
          resultPath,
          donePath,
          projectPath,
          responseInstruction,
        }),
        projectPath,
        sessionDir,
        turnDir,
        resultPath,
        donePath,
        model,
        reasoningEffort,
        allowUnknownModel,
        toolProfile: normalizedToolProfile,
        timeoutMs,
        log,
        endSignalPath: path.join(sessionDir, "end_signal"),
      })
    ).trim();
  }

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
  // Whether the bootstrap goes in argv or gets pasted into the TUI is the
  // adapter's call, not a hardcoded per-agent branch: pass it either way and
  // let promptDelivery decide.
  const adapter = getAdapter(normalizedAgent);
  // The same catalog the start-tool preflight validated against. Without it this
  // check falls back to the manifest, and a live catalog that has widened a
  // model's effort set would let a session start and then have its every turn
  // refused here -- the two disagreeing about the same pair.
  const discoveredModels = await resolveDiscoveryForValidation(adapter, {
    model,
    projectPath,
    log,
  });
  const { command, args, env, usesInitialPrompt, notices } =
    buildInvocationFromAdapter(adapter, {
      partnerCommand,
      projectPath,
      sessionDir,
      sessionName,
      model,
      reasoningEffort,
      toolProfile: normalizedToolProfile,
      initialPrompt: bootstrap,
      discoveredModels,
      applyOperatorDefault: true,
      allowUnknownModel,
    });

  // A dropped or adjusted option must be reported. If the host asked for an
  // effort level this partner cannot honor, it needs to know that before it
  // reasons about the reply as though the setting had applied.
  for (const notice of notices) {
    log(`Adapter "${adapter.id}": ${notice.message}`);
  }

  // Logging alone was not enough. The runner's log is not visible to the host,
  // so an error-severity finding -- an effort this MODEL rejects, say -- would
  // drop the flag, start the turn anyway, and leave the session reporting a
  // setting that was never applied. Refuse instead: the same check runs in
  // preflightPartner() before a session exists, so reaching here means the
  // options changed underneath us or a caller bypassed the start tools.
  const blocking = notices.filter((notice) => notice.severity === "error");
  if (blocking.length) {
    throw new Error(
      `Adapter "${adapter.id}" cannot run this turn as requested: ` +
        blocking.map((notice) => notice.message).join("; ")
    );
  }

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
    const cancelled = isPartnerTurnCancelledError(err);

    // Once a pane exists, every exit from this function must take it down.
    //
    // Cleanup used to run only for cancellation and PartnerTerminalFailureError,
    // leaving any other exception's pane alive under status
    // "error_waiting_for_end". Nothing ever attached to such a pane -- that
    // status is written here and read nowhere -- so it was not a resume path,
    // just a pane nobody owned. It also could not be reclaimed later:
    // terminateCurrentPartnerTerminal() resolves exactly one handle out of
    // current_terminal.json, and the next turn overwrites that file. A single
    // ordinary error (a partner naming a result_path outside its turn directory
    // trips a plain Error in readCompletion) was enough to strand a pane for the
    // lifetime of the session.
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
    // Report what is actually true after cleanup rather than assuming it worked:
    // a pane that survived termination is a fact the host needs.
    const terminalStillAlive = handle
      ? await isTmuxSessionAlive(handle.sessionName).catch(() => false)
      : false;
    if (!alreadyTerminated) {
      writeTerminalState(
        sessionDir,
        {
          ...state,
          status: cancelled
            ? "cancelled"
            : terminalStillAlive
              ? "error_terminal_leaked"
              : "failed",
          ...(terminalStillAlive ? {} : { completed_at: new Date().toISOString() }),
          last_capture_path: finalCapturePath,
          ...(cancelled ? {} : { error: err.message }),
        },
        { active: terminalStillAlive }
      );
    }
    throw err;
  }
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
      throw new PartnerTerminalFailureError(
        `${partnerDisplay} tmux session exited before the interactive prompt was ready` +
          (lastSnapshot ? `; terminal: ${lastSnapshot.slice(-1000)}` : "") +
          (persistedCapturePath ? `; capture: ${persistedCapturePath}` : ""),
        "terminal_exited"
      );
    }
    try {
      lastSnapshot = await captureTmuxPane(handle, { lines: 80 });
    } catch {
      lastSnapshot = "";
    }
    throwIfPartnerTerminalFailed(lastSnapshot, partnerDisplay, agent);

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
  let submissionObserved = false;

  while (Date.now() <= deadline) {
    if (fs.existsSync(endSignalPath)) {
      throw new PartnerTurnCancelledError(`${partnerDisplay} interactive turn was cancelled by end_dialog`);
    }
    if (fs.existsSync(donePath) || fs.existsSync(resultPath)) return;

    if (!(await isTmuxSessionAlive(handle.sessionName))) {
      throw new PartnerTerminalFailureError(
        `${partnerDisplay} tmux session exited after prompt submission`,
        "terminal_exited"
      );
    }

    try {
      lastSnapshot = await captureTmuxPane(handle, { lines: 80 });
      persistCaptureText(capturePath, lastSnapshot, log);
    } catch {
      lastSnapshot = "";
    }
    throwIfPartnerTerminalFailed(lastSnapshot, partnerDisplay, agent);
    if (lastSnapshot.includes(SUBMISSION_MARKER)) {
      submissionObserved = true;
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
      Date.now() - startedAt > POST_SUBMIT_RETRY_TRIGGER_MS &&
      isInteractiveReady(agent, lastSnapshot)
    ) {
      log(`${partnerDisplay} still appears idle after prompt paste; retrying Enter once`);
      await sendTextToTmux(handle, "", { enter: true, submitDelayMs: 0 });
      retriedEnter = true;
      deadline = Date.now() + POST_SUBMIT_RETRY_MS;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const finalActivity = analyzeTerminalActivity(lastSnapshot, agent, {
    alive: true,
  });
  if (!submissionObserved && finalActivity.state === "idle_prompt") {
    throw new PartnerTerminalFailureError(
      `${partnerDisplay} prompt submission failed: the partner remained at its input prompt and the submitted turn was never observed`,
      "prompt_submission_failed"
    );
  }

  log(
    `${partnerDisplay} activity could not be confirmed after prompt submission; continuing to wait for explicit completion or end_dialog` +
      (lastSnapshot ? ` (last capture: ${lastSnapshot.slice(-500)})` : "")
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
  let lastFailureCheck = 0;

  while (true) {
    if (fs.existsSync(endSignalPath)) {
      throw new PartnerTurnCancelledError(`${partnerDisplay} interactive turn was cancelled by end_dialog`);
    }

    const completion = readCompletion({ turnDir, resultPath, donePath });
    if (completion) {
      if (completion.status === "error") {
        throw new PartnerTerminalFailureError(
          `${partnerDisplay} reported an interactive turn error: ${completion.error || completion.result}`,
          "sidecar_error"
        );
      }
      return completion.result;
    }

    if (!(await isTmuxSessionAlive(handle.sessionName))) {
      const persistedCapture = readOptionalText(capturePath);
      const inspection = await inspectPartnerTerminal(sessionDir).catch(() => null);
      throw new PartnerTerminalFailureError(
        `${partnerDisplay} tmux session exited before writing completion sidecars` +
          (persistedCapture ? `; terminal: ${persistedCapture.slice(-1000)}` : "") +
          (!persistedCapture && inspection?.capture?.text
            ? `; terminal: ${inspection.capture.text.slice(-1000)}`
            : ""),
        "terminal_exited"
      );
    }

    const now = Date.now();
    const shouldLogProgress = now - lastProgressLog > 60000;
    if (
      shouldLogProgress ||
      now - lastFailureCheck > TERMINAL_FAILURE_CHECK_INTERVAL_MS
    ) {
      lastFailureCheck = now;
      const capture = await captureAndPersist(handle, capturePath, log);
      throwIfPartnerTerminalFailed(capture?.text, partnerDisplay, agent);
      if (!shouldLogProgress) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      lastProgressLog = now;
      const activity = analyzeTerminalActivity(capture?.text || "", agent, {
        alive: true,
      });
      log(
        `${partnerDisplay} interactive turn is still running in tmux session "${handle.sessionName}": ${activity.summary}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function throwIfPartnerTerminalFailed(captureText, partnerDisplay, agent) {
  const failure = detectPartnerTerminalFailure(captureText);
  if (!failure) return;
  const activity = analyzeTerminalActivity(captureText, agent, { alive: true });
  if (
    [
      "thinking",
      "working",
      "running_command",
      "reading",
      "writing",
      "starting",
    ].includes(activity.state)
  ) {
    return;
  }
  throw new PartnerTerminalFailureError(
    `${partnerDisplay} interactive turn cannot continue because ${failure.summary}`,
    failure.code
  );
}

function normalizeCapturedText(captureText) {
  return String(captureText || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
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

// Readiness and startup-interstitial detection are adapter data now. These
// wrappers keep the existing call sites unchanged while the matching itself
// comes from the manifest's marker sets. See src/tui/markers.mjs for the scope
// rules, which are not uniform across marker classes.
function adapterTuiFor(agent) {
  return tryGetAdapter(agent)?.tui ?? null;
}

function isInteractiveReady(agent, snapshot) {
  return isReady(adapterTuiFor(agent), snapshot);
}

function detectStartupPrompt(agent, snapshot) {
  const tui = adapterTuiFor(agent);
  return detectStartupPromptFromTui(tui, snapshot, {
    readyWins: Boolean(tui?.suppressStartupWhenReady),
  });
}
