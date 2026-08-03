import fs from "fs";
import { assertManagedSessionPath, envWithAliases } from "./platform.mjs";
import path from "path";
import crypto from "crypto";
import { getAgentDisplayName, normalizeAgent } from "./shared.mjs";
import {
  analyzeTerminalActivity,
  buildTmuxSessionName,
  captureTmuxPane,
  inspectPartnerTerminal,
  isTmuxAvailable,
  probeTmuxSession,
  readTerminalState,
  sendTextToTmux,
  startTmuxSession,
  terminateTmuxSession,
  writeTerminalState,
} from "./tmux-runtime.mjs";
import { buildInvocationFromAdapter } from "./adapters/argv.mjs";
import {
  allocateLease,
  releaseLease,
  transitionLease,
} from "./runtime-lease.mjs";
import { probeProcess } from "./process-probe.mjs";
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

const VALID_TOOL_PROFILES = new Set(["read", "implementation"]);
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

// The hand-written per-agent buildInvocation() lived here until the adapter
// registry replaced it. It is gone rather than kept as a reference, because it
// had stopped being inert: its codex branch called a private
// prepareCodexPartnerEnv() that created `<sessionDir>/codex-home` and copied
// auth.json into it WITHOUT passing through assertManagedSessionPath() -- a
// second credential-writing path that the containment boundary did not cover.
// Its only remaining caller was the golden-snapshot equivalence gate, which had
// already served its purpose: the snapshots now come from
// buildInvocationFromAdapter() directly, so the same argv is still pinned with
// one implementation instead of two.

/**
 * Does this adapter write anything at runtime that needs a lease?
 *
 * Derived from the manifest rather than assumed per agent: claude relocates
 * nothing and reuses its auth in place, but still needs somewhere to put
 * `claude-empty-mcp.json`, so "has configIsolation" alone would have missed it.
 */
function needsRuntimeArtifacts(adapter) {
  return Boolean(
    adapter?.configIsolation ||
      adapter?.effortDelivery === "settings-file" ||
      adapter?.mcp?.strategy === "empty-config-file" ||
      Object.keys(adapter?.dirs ?? {}).length > 0
  );
}

/**
 * How long to wait for a partner to finish exiting after its pane closes.
 *
 * Measured against the observed behaviour: codex writes its models cache during
 * shutdown, well within this window. Short on purpose -- it delays only the
 * cleanup, never the turn's result, and a partner that outlasts it keeps its
 * lease rather than blocking anything.
 */
const PARTNER_EXIT_GRACE_MS = 3000;

/** Poll until a process is gone, or the budget runs out. Never throws. */
async function waitForProcessExit(pid, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (probeProcess(pid) === "absent") return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return probeProcess(pid) === "absent";
}

/**
 * Release a lease without ever letting cleanup break a turn.
 *
 * Retention is the safe direction, so a failure here is logged and dropped: a
 * lease that outlives its turn is reclaimed by the sweep, while an exception
 * thrown out of a `catch` block would replace the real error with a cleanup one.
 */
function releaseLeaseQuietly(lease, log, options = {}) {
  if (!lease) return;
  try {
    const { released, reason } = releaseLease(lease, options);
    if (!released && reason) {
      log(`Runtime lease ${lease.id} retained: ${reason}`);
    }
  } catch (err) {
    log(`Runtime lease ${lease.id} could not be released: ${err.message}`);
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

  const turnId = `${tempPrefix || normalizedAgent}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
  // Containment is proven HERE, not later inside config isolation.
  //
  // This is the first write of the turn, and it happens ~60 lines before
  // buildInvocationFromAdapter()/runHeadlessTurn() reach
  // assertManagedSessionPath(). So an unvalidated sessionDir still got a
  // `turns/<id>/prompt.md` -- the full prompt text -- written into it, and only
  // then was the call refused. The refusal was correct and far too late: the
  // audit that said "every credential-writing path is contained" missed that a
  // prompt is written first, into a directory nobody had checked.
  const turnDir = assertManagedSessionPath(sessionDir, path.join(sessionDir, "turns", turnId), {
    fn: "runPartnerCommand turn directory",
  });

  // Only now: whether tmux happens to be installed is an ENVIRONMENT question,
  // and it used to be asked first -- so on a machine without tmux an unmanaged
  // session directory was refused with "tmux is required" instead of the
  // containment error, and the boundary was effectively gated behind a probe.
  // A security decision must not depend on what is on PATH.
  if (engine === "tmux-interactive" && !(await isTmuxAvailable())) {
    throw new Error("tmux is required for interactive partner sessions but was not found on PATH");
  }

  fs.mkdirSync(turnDir, { recursive: true });

  const promptPath = path.join(turnDir, "prompt.md");
  const resultPath = path.join(turnDir, "result.md");
  const donePath = path.join(turnDir, "done.json");
  const capturePath = path.join(turnDir, "terminal-capture.txt");
  fs.writeFileSync(promptPath, prompt);

  // The per-turn runtime lease, allocated only for turns that actually write
  // runtime artifacts. An adapter that relocates nothing, delivers effort by
  // flag, and needs no MCP config file has nothing to project -- giving it a
  // lease would create an empty directory per turn and call it isolation.
  const lease = needsRuntimeArtifacts(resolvedAdapter)
    ? allocateLease({
        sessionId: path.basename(sessionDir),
        turnId,
        agent: normalizedAgent,
        engine,
        turnDir,
      })
    : null;

  if (engine === "headless") {
    return (
      await runHeadlessTurn({
        adapter: resolvedAdapter,
        lease,
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

  // EVERY path from here releases the lease, including the ones that fail before
  // a pane exists.
  //
  // Credentials are projected by buildInvocationFromAdapter() below, which is
  // OUTSIDE the turn's own try/catch -- so a rendering error, an unwritable MCP
  // config or a malformed seeded settings file escaped both release paths. The
  // runner survives a failed turn, so that projection then sat on disk until the
  // whole session ended, which is the lifetime this design exists to bound.
  //
  // The inner catch already releases once a pane exists; reaching this one after
  // that is a no-op, because releaseLease() finds the directory gone.
  try {
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
    // `projecting` is recorded BEFORE this call, not after it: building the
    // invocation is what copies the credentials in, so a crash midway through
    // must leave a lease that says secrets MAY be present rather than one that
    // says none can be.
    if (lease) transitionLease(lease, "projecting");
    const { command, args, env, usesInitialPrompt, notices } =
      buildInvocationFromAdapter(adapter, {
        partnerCommand,
        projectPath,
        sessionDir,
        scratchDir: lease?.dir ?? null,
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
      // A turn rejected here has projected credentials but will never spawn, so
      // the lease is removable immediately and on the strongest possible grounds:
      // the API invariant says no process-creating call has been made.
      releaseLeaseQuietly(lease, log, { consumerAbsent: true });
      throw new Error(
        `Adapter "${adapter.id}" cannot run this turn as requested: ` +
          blocking.map((notice) => notice.message).join("; ")
      );
    }
    if (lease) transitionLease(lease, "ready");

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

      // Recorded BEFORE the pane can exist. tmux session names are deterministic
      // and chosen by us, so the identity is already known here -- which closes
      // the identity-less `spawning` window entirely for this engine. A crash
      // between this line and the next still leaves a lease that names exactly
      // what to probe.
      if (lease) {
        transitionLease(lease, "spawning", {
          consumer: { kind: "tmux", session_name: sessionName },
        });
      }
      handle = await startTmuxSession({
        sessionName,
        cwd: projectPath,
        command,
        args,
        env,
      });
      if (lease) {
        transitionLease(lease, "active", {
          // The pane's process as well as the pane. Releasing on the session alone
          // demonstrably reclaimed the home while the partner was still shutting
          // down, and it then recreated the directory to flush its cache.
          consumer: { kind: "tmux", session_name: sessionName, pane_pid: handle.panePid ?? null },
        });
      }
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
      const verdict = await terminateTmuxSession(handle);
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
      // The credentials go the moment the process holding them is PROVEN gone.
      //
      // "Proven gone" means the PROCESS, not the pane. Releasing on the tmux
      // verdict alone reclaimed the home while codex was still shutting down, and
      // it then recreated the directory to flush its models cache -- leaving an
      // unattributable orphan on every turn. So wait briefly for the pane's
      // process to exit, then let releaseLease() do the full proof rather than
      // asserting absence from here.
      //
      // The wait is short and bounded because it is a courtesy, not a guarantee: a
      // partner that takes longer simply keeps its lease, and the sweep reclaims
      // it once the process can be shown gone.
      if (lease && verdict === "absent" && handle?.panePid) {
        await waitForProcessExit(handle.panePid, PARTNER_EXIT_GRACE_MS);
      }
      releaseLeaseQuietly(lease, log);

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
      // Every exit from this function releases the lease if it can. A failed turn
      // has exactly the same credential copy on disk as a successful one, and it
      // is the failure paths -- not the happy path -- that left 176 of them behind.
      releaseLeaseQuietly(lease, log);

      const { last } = readTerminalState(sessionDir);
      const alreadyTerminated =
        last?.session_name === state.session_name && last.status === "terminated";
      // Report what is actually true after cleanup rather than assuming it worked:
      // a pane that survived termination is a fact the host needs.
      // Anything short of a proven absence counts as "may still be up". Reporting
      // a pane we could not check as cleanly gone would clear current_terminal.json
      // and tell the host the terminal is down -- the two things that must not
      // happen while a partner might still be holding a live session.
      const terminalStillAlive = handle
        ? (await probeTmuxSession(handle.sessionName).catch(() => "unknown")) !== "absent"
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
  } catch (setupErr) {
    releaseLeaseQuietly(lease, log);
    throw setupErr;
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
    // Only a proven absence ends the turn. See waitForSidecarCompletion for why
    // an unprovable one must not.
    if ((await probeTmuxSession(handle.sessionName)) === "absent") {
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

    if ((await probeTmuxSession(handle.sessionName)) === "absent") {
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
  let lastLivenessWarning = 0;

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

    // This loop polls for the whole length of a turn, which can be hours, so it
    // is the one most exposed to a single unlucky tmux call. The probe is
    // three-valued precisely for this: `unknown` covers a 10s exec timeout and a
    // tmux binary that momentarily would not spawn, and treating either as "the
    // pane exited" aborted turns that were running perfectly well. Only a proven
    // absence ends the turn; anything else waits, because the sidecar check at
    // the top of the loop still terminates it the moment real completion lands.
    const liveness = await probeTmuxSession(handle.sessionName);
    if (liveness === "absent") {
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
    if (liveness === "unknown" && Date.now() - lastLivenessWarning > 60000) {
      lastLivenessWarning = Date.now();
      log(
        `${partnerDisplay} tmux liveness could not be determined; continuing to wait rather than assuming the pane exited`
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
