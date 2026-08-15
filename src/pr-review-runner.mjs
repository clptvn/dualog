#!/usr/bin/env node
/**
 * PR Review Runner - drives a multi-specialist review panel against one change.
 *
 * Where review-runner.mjs runs ONE reviewer that looks at everything, this runs
 * several narrow specialists in sequence and then consolidates them, which is
 * the shape of Anthropic's pr-review-toolkit plugin. The specialists live in
 * pr-review-aspects.mjs; this file is the loop that schedules them.
 *
 * Three phases:
 *
 *   1. Panel — one partner turn per selected aspect. Each is a fresh invocation
 *      carrying only its own lens, and each appends its report as soon as it
 *      lands so the host can read pass 1 while pass 2 is still running.
 *   2. Consolidation — one turn that merges the reports, re-ranks by real
 *      severity, and is the FIRST turn permitted to emit a REVIEW_VERDICT. No
 *      specialist pass may; follow-up turns are required to.
 *   3. Follow-up — an ordinary review conversation. The panel does not re-run:
 *      spending six specialist turns to confirm one fix would exhaust the round
 *      budget on a line of code.
 *
 * The passes are sequential rather than parallel, which is the one place this
 * departs from the plugin's optional "parallel" mode. It is not a performance
 * oversight: every TMUX partner turn in a session writes the same
 * current_terminal.json, and two concurrent turns in one session directory would
 * leave that record describing whichever finished last -- so end_dialog and
 * check_partner_alive would be reasoning about, and terminating, the wrong pane.
 * A headless partner has no such record, but shares this session's
 * partner_processing marker and last_error.txt, which carry the same
 * single-writer assumption.
 */

import fs from "fs";
import path from "path";
import { envWithAliases } from "./platform.mjs";
import {
  MAX_MESSAGE_BYTES,
  appendMessage,
  getAgentDisplayName,
  normalizeAgent,
  readConversation,
  sleep,
} from "./shared.mjs";
import {
  isPartnerTurnCancelledError,
  isPartnerTerminalFailureError,
  runPartnerCommand,
} from "./partner-invocation.mjs";
import {
  markSessionRunnerExited,
  readRunnerToken,
} from "./runner-lifecycle.mjs";
import { tryGetAdapter } from "./adapters/registry.mjs";
import { terminateActiveHeadlessTurnsAndWait } from "./engines/headless.mjs";
import {
  MAX_REVIEW_DIFF_CHARS,
  requestedReasoningEffortForAdapter,
} from "./runtime-defaults.mjs";
import {
  CONSOLIDATED_HEADER,
  PR_REVIEW_ASPECTS,
  buildAggregationPrompt,
  buildAspectHeader,
  buildAspectPrompt,
  buildFollowUpPrompt,
  extractAspectResult,
  extractNormalizedFindings,
  suppressVerdictLines,
} from "./pr-review-aspects.mjs";

const sessionDir = process.argv[2];
const projectPath = process.argv[3] || process.cwd();
const partnerCommand = process.argv[4] || "codex";
// The FOLLOW-UP budget only. Panel and consolidation turns are the review
// itself, not rounds of conversation about it, so they are not charged here --
// the server folds them into status.max_rounds separately so computeBudget,
// which can only count partner messages, still reports the truth.
const FOLLOWUP_SOFT_CAP = parseInt(process.argv[5], 10) || 5;
const FOLLOWUP_HARD_CAP = FOLLOWUP_SOFT_CAP + 5;
const RAW_REASONING_EFFORT = process.argv[6] || null;
const PARTNER_MODEL = process.argv[7] || null;
const HOST_AGENT = normalizeAgent(process.argv[8], "claude");
const PARTNER_AGENT = normalizeAgent(process.argv[9], "codex");
const REASONING_EFFORT = requestedReasoningEffortForAdapter(RAW_REASONING_EFFORT);
const DEFAULT_PARTNER_TIMEOUT_MS = 15 * 60 * 1000;
const PARTNER_TIMEOUT_MS =
  Math.max(1000, parseInt(process.argv[10], 10)) || DEFAULT_PARTNER_TIMEOUT_MS;
const RUNNER_TOKEN = readRunnerToken();
const ALLOW_UNKNOWN_MODEL = process.argv.includes("--allow-unknown-model");

if (!sessionDir || HOST_AGENT === PARTNER_AGENT) {
  process.exit(1);
}

const HOST_DISPLAY =
  tryGetAdapter(HOST_AGENT)?.displayName ?? getAgentDisplayName(HOST_AGENT);
const PARTNER_DISPLAY =
  tryGetAdapter(PARTNER_AGENT)?.displayName ?? getAgentDisplayName(PARTNER_AGENT);

const DIFF_PATH = path.join(sessionDir, "diff.patch");
const REFRESHED_DIFF_PATH = path.join(sessionDir, "diff_refreshed.patch");
const META_PATH = path.join(sessionDir, "pr_review_meta.json");
const PANEL_PATH = path.join(sessionDir, "panel_state.json");
const END_SIGNAL_PATH = path.join(sessionDir, "end_signal");
const PROCESSING_PATH = path.join(sessionDir, "partner_processing");
const ERROR_PATH = path.join(sessionDir, "last_error.txt");
const LOG_PATH = path.join(sessionDir, "runner.log");

const POLL_INTERVAL_MS = 5000;
const IDLE_SHUTDOWN_MS = parsePositiveInt(
  envWithAliases(["DUALOG_IDLE_SHUTDOWN_MS", "CODEX_DIALOG_IDLE_SHUTDOWN_MS"]),
  24 * 60 * 60 * 1000
);
const MAX_FOLLOWUP_CONTEXT_MESSAGES = 20;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function log(msg) {
  const ts = new Date().toISOString();
  try {
    fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
  } catch {
    // A logger must never be the thing that kills the process it exists to
    // diagnose. This is a detached runner with stdio ignored, and log() is the
    // first statement that can THROW in both the signal handler and the fatal
    // catch (the signal handler's re-entrancy guard precedes it) -- so an
    // unwritable log (ENOSPC, session dir removed by cleanup, permissions)
    // would throw before the processing marker is cleared and before the exit
    // is recorded, pinning the session "running" behind a dead process. That
    // zombie state is exactly what the lifecycle code works to prevent.
  }
}

let terminatingFromSignal = false;

async function exitFromSignal(signal) {
  if (terminatingFromSignal) return;
  terminatingFromSignal = true;
  log(`${signal} received; exiting runner without terminating the active partner terminal`);
  try {
    const signalled = await terminateActiveHeadlessTurnsAndWait();
    if (signalled) log(`Terminated ${signalled} headless partner process(es) on ${signal}`);
  } catch (err) {
    log(`Failed to terminate headless partner process(es): ${err.message}`);
  }
  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}
  markSessionRunnerExited(sessionDir, {
    runnerToken: RUNNER_TOKEN,
    reason: signal,
    exitCode: 0,
  });
  process.exit(0);
}

process.once("SIGTERM", () => {
  exitFromSignal("SIGTERM");
});
process.once("SIGINT", () => {
  exitFromSignal("SIGINT");
});

/**
 * Append a partner message that is guaranteed to fit.
 *
 * completion.mjs sets MAX_RESULT_BYTES equal to MAX_MESSAGE_BYTES deliberately,
 * so "every accepted result fits in a conversation entry" -- an invariant this
 * runner BREAKS, because it prepends a pass header and the verdict suppressor
 * can lengthen the text it rewrites. A maximal report that legitimately cleared
 * the completion gate would therefore throw in appendMessage and land in the
 * per-pass catch, which files a complete, successful report as UNREVIEWED -- the
 * review-that-happened rendering as one that did not, which is the failure this
 * file exists to prevent. (The catch's own append is a ~300-byte system message
 * against a 2 MiB ceiling, so it does not throw in turn; an earlier version of
 * this comment claimed a fatal cascade that does not occur.)
 *
 * Truncation is marked, never silent. Losing the tail of a report without saying
 * so is the exact failure this whole design exists to prevent.
 */
function appendBoundedPartnerMessage(content) {
  if (Buffer.byteLength(content, "utf-8") <= MAX_MESSAGE_BYTES) {
    appendMessage(sessionDir, PARTNER_AGENT, content);
    return;
  }

  // Cut from the MIDDLE, keeping the tail.
  //
  // get_pr_review_report re-parses each pass out of the conversation message, and
  // both things it looks for -- the "### Normalized Findings" block and the
  // ASPECT_RESULT footer -- sit at the end. Truncating from the end therefore
  // turned a pass that ran and reported into one that, in the findings index,
  // found nothing: panel_state would say complete with a real aspect_result while
  // the report showed `result: null` and `findings: []` for the same pass.
  const marker = "\n\n[report truncated in the middle: it did not fit in one conversation entry]\n\n";
  const TAIL_BYTES = 8 * 1024;
  const budget = MAX_MESSAGE_BYTES - Buffer.byteLength(marker, "utf-8");
  const buf = Buffer.from(content, "utf-8");

  // Both cuts land on a character boundary, or this helper can hand
  // appendMessage something LARGER than the slice it made.
  //
  // A cut inside a multi-byte sequence decodes to U+FFFD, which re-encodes to 3
  // bytes -- so a naive `subarray(0, budget).toString()` can exceed
  // MAX_MESSAGE_BYTES by up to 2, and shared.mjs throws on strictly greater.
  // Two bytes is enough, and these reports are unusually dense in multi-byte
  // characters: the prompt asks for `path:LINE — one-sentence statement`, so
  // there is an em dash per finding. The throw would land in the per-pass catch
  // and file a complete, successful report as UNREVIEWED.
  const isContinuation = (byte) => (byte & 0xc0) === 0x80;
  let headEnd = Math.min(budget - TAIL_BYTES, buf.length);
  while (headEnd > 0 && isContinuation(buf[headEnd])) headEnd--;
  let tailStart = Math.max(buf.length - TAIL_BYTES, headEnd);
  while (tailStart < buf.length && isContinuation(buf[tailStart])) tailStart++;

  const head = buf.subarray(0, headEnd).toString("utf-8");
  const tail = buf.subarray(tailStart).toString("utf-8");

  log(`Report exceeded the conversation entry limit; kept the head and the trailing ${TAIL_BYTES} bytes`);
  appendMessage(sessionDir, PARTNER_AGENT, head + marker + tail);
}

/**
 * Best-effort recovery I/O, for use INSIDE a catch.
 *
 * An error handler that throws turns a recoverable pass failure into a fatal one
 * that abandons the whole panel -- the same principle as the guarded spec.title
 * dereference, applied to the writes beside it. The conversation log is the most
 * likely thing to be failing at the moment we are trying to write the failure to
 * it.
 */
function tryRecovery(what, fn) {
  try {
    fn();
  } catch (err) {
    log(`Recovery step "${what}" failed: ${err.message}`);
  }
}

/**
 * Record panel progress where the server can read it.
 *
 * The conversation log carries the reports themselves, but not which passes are
 * still pending or which failed -- and "aspect produced no findings" and "aspect
 * never ran" are the two states a review must never confuse.
 */
function writePanelState(state) {
  try {
    const tmp = `${PANEL_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, PANEL_PATH);
  } catch (err) {
    log(`Failed to write panel state: ${err.message}`);
  }
}

function readActiveDiff(originalDiff) {
  try {
    if (fs.existsSync(REFRESHED_DIFF_PATH)) {
      const refreshed = fs.readFileSync(REFRESHED_DIFF_PATH, "utf-8");
      if (refreshed.trim()) return refreshed;
    }
  } catch (err) {
    // NOT a bare swallow like the unlink idioms elsewhere in this file. Those
    // are "delete if present", where ENOENT is the expected case. Here the file
    // was observed to EXIST and then could not be read -- a truncated write, a
    // permissions change, a replacement mid-read -- and the fallback shows the
    // partner the session-start diff under a header calling it current. Silence
    // would make stale content indistinguishable from fresh.
    log(
      `Could not read the refreshed diff (${err.message}); falling back to the diff captured at review start`
    );
  }
  return originalDiff;
}

async function runTurn(prompt, tempPrefix) {
  return runPartnerCommand({
    partnerAgent: PARTNER_AGENT,
    partnerCommand,
    prompt,
    projectPath,
    model: PARTNER_MODEL,
    reasoningEffort: REASONING_EFFORT,
    allowUnknownModel: ALLOW_UNKNOWN_MODEL,
    timeoutMs: PARTNER_TIMEOUT_MS,
    log,
    tempPrefix,
    responseInstruction: "Respond with your report.",
    sessionDir,
  });
}

async function main() {
  // Written BEFORE the reads below, so a crash while loading the diff or the
  // meta leaves a record rather than a void. Both reads are unguarded on
  // purpose -- there is no sane way to review without them -- but without this
  // marker a failure there produced no panel_state.json at all, and the report
  // tool fell back to `phase: "panel"` with every aspect pending: a runner that
  // died before it started rendering identically to one genuinely working its
  // first pass. `starting` is what it shows now, and only because of this line.
  writePanelState({ phase: "starting", completed: [], started_at: new Date().toISOString() });

  const originalDiff = fs.readFileSync(DIFF_PATH, "utf-8");
  const meta = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));
  const selected = Array.isArray(meta.aspects) ? meta.aspects : [];
  const skipped = Array.isArray(meta.skipped) ? meta.skipped : [];
  const reviewFocus = meta.review_focus || null;

  log("=== PR review runner started ===");
  log(`Project: ${projectPath}`);
  log(`Scope: ${meta.scope_label}`);
  log(`Host agent: ${HOST_DISPLAY}`);
  log(`Partner agent: ${PARTNER_DISPLAY} (${partnerCommand})`);
  log(`Panel: ${selected.join(", ") || "(none)"}`);
  log(`Skipped: ${skipped.map((s) => s.aspect).join(", ") || "(none)"}`);
  log(`Follow-up budget: soft ${FOLLOWUP_SOFT_CAP}, hard ${FOLLOWUP_HARD_CAP}`);
  log(`Model: ${PARTNER_MODEL || "default"}, effort: ${REASONING_EFFORT || "adapter default"}`);

  const panelState = {
    phase: "panel",
    total_passes: selected.length + 1,
    completed: [],
    pending: [...selected, "__aggregate__"],
    started_at: new Date().toISOString(),
  };
  writePanelState(panelState);

  fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
  try {
    fs.unlinkSync(ERROR_PATH);
  } catch {}

  // ── Phase 1: the specialist panel ─────────────────────────────────────────
  const reports = [];
  const priorFindings = [];
  let terminalFailure = false;

  for (const [index, aspectId] of selected.entries()) {
    if (fs.existsSync(END_SIGNAL_PATH)) {
      log("End signal detected during panel; stopping");
      break;
    }
    if (terminalFailure) break;

    const spec = PR_REVIEW_ASPECTS[aspectId];
    const passIndex = index + 1;
    const passTotal = selected.length + 1;
    log(`Panel pass ${passIndex}/${selected.length}: ${aspectId}`);

    // Clear the error marker before each pass, the way the follow-up loop does.
    //
    // A per-pass failure here is RECOVERABLE -- the panel continues -- but
    // classifyWaitResult checks last_error before anything else, so leaving the
    // file in place made every subsequent wait_for_partner_response return
    // `error` instantly for the entire rest of the panel. The host loses the
    // documented way to watch the panel finish, keeps being re-notified of a
    // failure already handled, and a genuinely new failure hides under the old
    // one. The durable record of the failure lives in panel_state.json and the
    // system message, which is where it belongs.
    try {
      fs.unlinkSync(ERROR_PATH);
    } catch {}

    try {
      // Prompt construction belongs INSIDE the try, because it can throw.
      // buildAspectPrompt rejects an id it does not know, and spec would be
      // undefined for one -- which is reachable without anyone hand-editing
      // anything: a session started under one version and resumed after an
      // upgrade that renamed or removed an aspect. Outside the try, that threw
      // clean out of the loop into the fatal handler and abandoned every OTHER
      // pass in the panel over one bad id, leaving nothing but "Fatal:" in
      // last_error.txt. Inside, it costs exactly the pass it belongs to.
      if (!spec) {
        throw new Error(
          `Unknown review aspect "${aspectId}" in this session's saved panel. ` +
            `It may have been renamed or removed since the review started; this aspect is unreviewed.`
        );
      }

      const prompt = buildAspectPrompt({
        aspect: aspectId,
        meta,
        diff: readActiveDiff(originalDiff),
        projectPath,
        maxDiffChars: MAX_REVIEW_DIFF_CHARS,
        passIndex,
        passTotal,
        reviewFocus,
        // Headlines only. Handing a specialist the full text of every earlier
        // report would re-couple the lenses this design exists to keep apart.
        priorFindings: priorFindings.slice(0, 40),
      });

      const response = await runTurn(prompt, `${PARTNER_AGENT}-pr-${aspectId}`);

      // An empty response is a FAILED pass, not a clean one.
      //
      // A turn can exit successfully having produced no text: a partner whose
      // write tools were silently denied, a turn stopped by a content filter, a
      // done.json that raced result.md. Recorded as success, that aspect lands
      // in aspects_reported with findings: [] -- indistinguishable, in the
      // findings index, from a specialist that ran and found nothing. Worse,
      // `anyReport` would still be
      // true, so consolidation would run over empty sections, read them as
      // "this lens found nothing", and be free to emit APPROVE for a panel that
      // reviewed nothing at all. Throwing routes it through the catch below,
      // which already records the hole in all three places.
      if (!response.trim()) {
        throw new Error(
          `${PARTNER_DISPLAY} returned an empty report for aspect "${aspectId}". ` +
            `The turn exited cleanly but produced no text, so this aspect is unreviewed.`
        );
      }

      const header =
        buildAspectHeader({
          aspect: aspectId,
          title: spec.title,
          passIndex,
          specialistCount: selected.length,
        }) +
        `\n_${passIndex < selected.length ? `${selected.length - passIndex} more specialist pass(es) and then consolidation still to come.` : "Consolidation pass still to come."}_\n\n`;
      const { text: safeResponse, suppressed } = suppressVerdictLines(response);
      if (suppressed > 0) {
        log(
          `Suppressed ${suppressed} verdict line(s) in the "${aspectId}" pass; only consolidation and follow-up turns may set a session verdict`
        );
      }
      appendBoundedPartnerMessage(header + safeResponse);
      // The SANITIZED text, not the raw response.
      //
      // Suppressing the verdict only on the way into conversation.jsonl
      // protected the gate and left the consolidator exposed -- and the
      // consolidator is the turn actually permitted to set a verdict, so it is
      // the more consequential reader of the two. A specialist's
      // "REVIEW_VERDICT: APPROVE" would have been scrubbed from the record while
      // being embedded verbatim in the prompt of the turn deciding the outcome.
      reports.push({ aspect: aspectId, content: safeResponse, failed: false });
      for (const finding of extractNormalizedFindings(safeResponse)) {
        priorFindings.push(`[${finding.category}] ${finding.text}`);
      }
      // The specialist's own machine-readable claim that it worked its rubric to
      // the end. A pass that omits the footer completed, but did not confirm it
      // finished -- worth distinguishing from one that did.
      // Read from the SANITIZED text, like the finding extraction beside it.
      // Two parsers over one response reading different sources is how the last
      // divergence started; today the suppressor cannot touch an ASPECT_RESULT
      // line, but the next widening of it would make that luck rather than
      // design.
      const aspectResult = extractAspectResult(safeResponse);
      panelState.completed.push({
        aspect: aspectId,
        status: aspectResult ? "complete" : "complete_unverified",
        aspect_result: aspectResult,
        chars: response.length,
      });
      log(`Panel pass ${aspectId} complete (${response.length} chars)`);
    } catch (err) {
      if (isPartnerTurnCancelledError(err) || fs.existsSync(END_SIGNAL_PATH)) {
        log(`Panel pass ${aspectId} cancelled by end_dialog`);
        break;
      }
      // One specialist failing does not invalidate the others. The pass is
      // recorded as FAILED and carried into consolidation as an explicit hole,
      // because a panel quietly missing its security lens reads exactly like a
      // panel whose security lens came back clean.
      log(`Panel pass ${aspectId} FAILED: ${err.message}`);
      // Every write in this handler is best-effort. An error handler that throws
      // escalates a recoverable pass failure into a fatal one that abandons the
      // whole panel -- and the conversation log is the single most likely thing
      // to be failing at the moment we try to record a failure into it. `spec`
      // may also be undefined, since an unknown aspect id is one of the cases
      // this catch now handles.
      tryRecovery("write last_error.txt", () =>
        fs.writeFileSync(ERROR_PATH, `Panel pass ${aspectId} failed: ${err.message}`)
      );
      tryRecovery("append the UNREVIEWED notice", () =>
        appendMessage(
          sessionDir,
          "system",
          `Panel pass "${aspectId}"${spec ? ` (${spec.title})` : ""} failed: ${err.message}\n\n` +
            `This aspect is UNREVIEWED. Do not read its absence as a clean result.`
        )
      );
      reports.push({ aspect: aspectId, content: "", failed: true, error: err.message });
      panelState.completed.push({
        aspect: aspectId,
        status: "failed",
        error: err.message,
      });
      if (isPartnerTerminalFailureError(err)) {
        log("Partner terminal reached a definitive failure; abandoning the panel");
        terminalFailure = true;
      }
    }

    panelState.pending = panelState.pending.filter((p) => p !== aspectId);
    writePanelState(panelState);
  }

  // ── Phase 2: consolidation ────────────────────────────────────────────────
  const ended = fs.existsSync(END_SIGNAL_PATH);
  const anyReport = reports.some((r) => !r.failed);

  if (!ended && !terminalFailure && anyReport) {
    panelState.phase = "consolidating";
    writePanelState(panelState);
    log("Consolidation pass starting");

    // Clear the error marker here too, the way each pass and each follow-up turn
    // does. A failure in the LAST pass otherwise survives into the consolidation
    // window -- the longest single wait in the session, and the one a host is
    // most likely to be polling -- where classifyWaitResult checks last_error
    // first and returns `error` instantly, and get_pr_review_report now reports
    // it as the review's current error. Two surfaces showing a handled failure
    // as live. The durable record stays in panel_state.json and the system
    // message.
    try {
      fs.unlinkSync(ERROR_PATH);
    } catch {}
    try {
      const prompt = buildAggregationPrompt({
        meta,
        projectPath,
        reports,
        skipped,
        reviewFocus,
        hostDisplay: HOST_DISPLAY,
      });
      const response = await runTurn(prompt, `${PARTNER_AGENT}-pr-aggregate`);

      // Same rule as a panel pass, and it matters more here. An empty aggregate
      // was appended as a header-only message reading "Panel complete: 5 of 5
      // specialist pass(es) reported." with nothing beneath it -- a literal,
      // affirmative claim of completeness over no content at all, and
      // panel_complete would go true on the strength of it. That is the review
      // rendering as finished, one level up from the aspect case.
      if (!response.trim()) {
        throw new Error(
          `${PARTNER_DISPLAY} returned an empty consolidation. The turn exited cleanly but produced no report.`
        );
      }

      appendBoundedPartnerMessage(
        `${CONSOLIDATED_HEADER}\n_Panel complete: ${reports.filter((r) => !r.failed).length} of ${selected.length} specialist pass(es) reported._\n\n${response}`
      );
      panelState.completed.push({ aspect: "__aggregate__", status: "complete" });
      log(`Consolidation complete (${response.length} chars)`);
    } catch (err) {
      if (isPartnerTurnCancelledError(err) || fs.existsSync(END_SIGNAL_PATH)) {
        log("Consolidation cancelled by end_dialog");
      } else {
        log(`Consolidation FAILED: ${err.message}`);
        tryRecovery("write last_error.txt", () =>
          fs.writeFileSync(ERROR_PATH, `Consolidation failed: ${err.message}`)
        );
        tryRecovery("append the consolidation-failure notice", () =>
          appendMessage(
            sessionDir,
            "system",
            `The consolidation pass failed: ${err.message}\n\n` +
              `The individual specialist reports above are intact and complete — read them directly. ` +
              `Send a message to ask ${PARTNER_DISPLAY} to consolidate them.`
          )
        );
        panelState.completed.push({
          aspect: "__aggregate__",
          status: "failed",
          error: err.message,
        });
        if (isPartnerTerminalFailureError(err)) terminalFailure = true;
      }
    }
  } else if (!anyReport && !ended) {
    appendMessage(
      sessionDir,
      "system",
      "No specialist pass produced a report, so there was nothing to consolidate. " +
        "Check runner.log and last_error.txt, then start a new review."
    );
  }

  panelState.phase = "follow_up";
  panelState.pending = [];
  panelState.panel_finished_at = new Date().toISOString();
  writePanelState(panelState);

  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}

  if (terminalFailure) {
    appendMessage(
      sessionDir,
      "system",
      "PR review runner stopped after a definitive partner terminal failure. " +
        "Resolve the partner CLI error and start a new review."
    );
    log("=== PR review runner exiting (partner terminal failure) ===");
    return "partner_terminal_failure";
  }
  if (ended) {
    log("=== PR review runner exiting (end signal) ===");
    return "end_signal";
  }

  // ── Phase 3: follow-up conversation ───────────────────────────────────────
  // Seeded at 0, deliberately, and NOT at the highest id the panel produced.
  //
  // The loop's filter already excludes the panel's own output by author
  // (`from === HOST_AGENT`), so seeding from the max id buys nothing and costs a
  // whole host turn: a message sent while the panel was running would be marked
  // processed before this loop ever looked at it, and send_message would have
  // told the host it "will be invoked to respond" while nothing ever did. The
  // window is up to one per-pass timeout times the number of aspects PLUS the
  // consolidation turn, which is precisely when an impatient host writes.
  let lastProcessedId = 0;
  let followUpTurns = 0;
  let lastActivityTime = Date.now();
  let consecutiveErrors = 0;
  let exitReason = "hard_cap";
  const MAX_CONSECUTIVE_ERRORS = 3;

  log(`Panel finished. Waiting for ${HOST_DISPLAY} (follow-up budget ${FOLLOWUP_SOFT_CAP}/${FOLLOWUP_HARD_CAP})`);

  while (followUpTurns < FOLLOWUP_HARD_CAP) {
    if (fs.existsSync(END_SIGNAL_PATH)) {
      log("End signal detected, shutting down gracefully");
      exitReason = "end_signal";
      break;
    }

    const messages = readConversation(sessionDir);
    const newHostMessages = messages.filter(
      (m) => m.id > lastProcessedId && m.from === HOST_AGENT
    );

    if (newHostMessages.length > 0) {
      lastActivityTime = Date.now();
      lastProcessedId = messages.reduce(
        (max, m) => (Number.isSafeInteger(m.id) && m.id > max ? m.id : max),
        0
      );
      log(`New ${HOST_DISPLAY} message(s) (latest id ${lastProcessedId}); follow-up turn ${followUpTurns + 1}`);

      fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
      try {
        fs.unlinkSync(ERROR_PATH);
      } catch {}

      try {
        let context = messages;
        if (messages.length > MAX_FOLLOWUP_CONTEXT_MESSAGES) {
          const first = messages.slice(0, 2);
          const recent = messages.slice(-(MAX_FOLLOWUP_CONTEXT_MESSAGES - 2));
          context = [
            ...first,
            {
              id: -1,
              from: "system",
              content: `[... ${messages.length - MAX_FOLLOWUP_CONTEXT_MESSAGES} earlier messages omitted ...]`,
              timestamp: "",
            },
            ...recent,
          ];
        }

        const prompt = buildFollowUpPrompt({
          meta,
          projectPath,
          diff: readActiveDiff(originalDiff),
          maxDiffChars: MAX_REVIEW_DIFF_CHARS,
          messages: context,
          hostDisplay: HOST_DISPLAY,
          partnerDisplay: PARTNER_DISPLAY,
          hostAgent: HOST_AGENT,
          partnerAgent: PARTNER_AGENT,
          roundsUsed: followUpTurns,
          softCap: FOLLOWUP_SOFT_CAP,
          hardCap: FOLLOWUP_HARD_CAP,
          // Carried for the whole session, not just consolidation. A hole in
          // the panel does not close because a turn went by.
          failedAspects: reports.filter((r) => r.failed).map((r) => r.aspect),
        });

        const response = await runTurn(prompt, `${PARTNER_AGENT}-pr-followup`);

        // Without this, an empty reply was appended as an empty partner message
        // and then treated as a successful turn: followUpTurns++, activity
        // refreshed, consecutiveErrors reset to 0. A partner returning empty
        // every time would burn the entire follow-up budget to the hard cap and
        // never trip MAX_CONSECUTIVE_ERRORS -- the error counter defeated by the
        // one failure mode that raises no error. Throwing lets it do its job.
        if (!response.trim()) {
          throw new Error(
            `${PARTNER_DISPLAY} returned an empty follow-up. The turn exited cleanly but produced no text.`
          );
        }

        appendBoundedPartnerMessage(response);
        followUpTurns++;
        lastActivityTime = Date.now();
        consecutiveErrors = 0;
        log(`Follow-up turn ${followUpTurns} complete (${response.length} chars)`);
      } catch (err) {
        if (isPartnerTurnCancelledError(err) || fs.existsSync(END_SIGNAL_PATH)) {
          log(`Follow-up turn cancelled by end_dialog`);
          exitReason = "end_signal";
          try {
            fs.unlinkSync(PROCESSING_PATH);
          } catch {}
          break;
        }

        consecutiveErrors++;
        log(`Error on follow-up turn: ${err.message} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
        fs.writeFileSync(
          ERROR_PATH,
          `${err.message}\n\nConsecutive errors: ${consecutiveErrors}`
        );

        if (isPartnerTerminalFailureError(err)) {
          appendMessage(
            sessionDir,
            "system",
            `PR review runner stopped after a definitive partner terminal failure: ${err.message}.`
          );
          exitReason = "partner_terminal_failure";
          break;
        }
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          appendMessage(
            sessionDir,
            "system",
            `PR review runner hit ${MAX_CONSECUTIVE_ERRORS} consecutive errors and is shutting down. Last error: ${err.message}`
          );
          exitReason = "consecutive_errors";
          break;
        }
      }

      try {
        fs.unlinkSync(PROCESSING_PATH);
      } catch {}
    } else if (Date.now() - lastActivityTime > IDLE_SHUTDOWN_MS) {
      log(`Idle shutdown reached (${((Date.now() - lastActivityTime) / 1000).toFixed(0)}s with no active turn).`);
      appendMessage(
        sessionDir,
        "system",
        "PR review runner shut down due to inactivity while no partner turn was active."
      );
      exitReason = "idle_shutdown";
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (followUpTurns >= FOLLOWUP_HARD_CAP) {
    log(`Follow-up hard cap (${FOLLOWUP_HARD_CAP}) reached`);
    appendMessage(
      sessionDir,
      "system",
      `Follow-up hard cap (${FOLLOWUP_HARD_CAP}) reached — soft budget was ${FOLLOWUP_SOFT_CAP}. ` +
        `No further ${PARTNER_DISPLAY} turns will run in this session.`
    );
  }

  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}

  log("=== PR review runner exiting ===");
  return exitReason;
}

main()
  .then((reason) => {
    markSessionRunnerExited(sessionDir, {
      runnerToken: RUNNER_TOKEN,
      reason,
      exitCode: 0,
    });
  })
  .catch((err) => {
    log(`Fatal error: ${err.message}\n${err.stack}`);
    try {
      fs.writeFileSync(ERROR_PATH, `Fatal: ${err.message}`);
    } catch {}
    markSessionRunnerExited(sessionDir, {
      runnerToken: RUNNER_TOKEN,
      reason: "fatal_error",
      exitCode: 1,
    });
    process.exit(1);
  });
