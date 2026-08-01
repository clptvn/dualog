#!/usr/bin/env node
/**
 * Review Runner - Background process that manages partner code review invocations
 *
 * Similar to dialog-runner.mjs but specialized for code review:
 * - Auto-starts: the partner generates an initial review from the diff
 * - Unbounded partner turns for large investigations
 * - Review-specific prompts with diff context and structured feedback categories
 */

import fs from "fs";
import { envWithAliases } from "./platform.mjs";
import path from "path";
import {
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

const sessionDir = process.argv[2];
const projectPath = process.argv[3] || process.cwd();
const partnerCommand = process.argv[4] || "codex";
const SOFT_CAP = parseInt(process.argv[5], 10) || 5;
const HARD_CAP = SOFT_CAP + 5;
const RAW_REASONING_EFFORT = process.argv[6] || null;
const PARTNER_MODEL = process.argv[7] || null;
const HOST_AGENT = normalizeAgent(process.argv[8], "claude");
const PARTNER_AGENT = normalizeAgent(process.argv[9], "codex");
// Defaulted from the adapter, never validated here: the adapter layer owns the
// per-CLI and per-model menus, and a second opinion in this file is how "high"
// came to be handed to CLIs that expose no effort control at all.
const REASONING_EFFORT = requestedReasoningEffortForAdapter(RAW_REASONING_EFFORT);
const DEFAULT_PARTNER_TIMEOUT_MS = 15 * 60 * 1000;
const PARTNER_TIMEOUT_MS =
  Math.max(1000, parseInt(process.argv[10], 10)) || DEFAULT_PARTNER_TIMEOUT_MS;
const RUNNER_TOKEN = readRunnerToken();
// Read as a flag, not by index: the preflight already decided this, and the
// turn must validate the model on the same terms or it will reject an id the
// start call deliberately allowed.
const ALLOW_UNKNOWN_MODEL = process.argv.includes("--allow-unknown-model");

if (!sessionDir || HOST_AGENT === PARTNER_AGENT) {
  process.exit(1);
}

// Prefer the adapter's own display name; getAgentDisplayName is only a
// title-cased fallback for ids with no manifest (it cannot know that
// "opencode" is not "Opencode").
const HOST_DISPLAY = tryGetAdapter(HOST_AGENT)?.displayName ?? getAgentDisplayName(HOST_AGENT);
const PARTNER_DISPLAY =
  tryGetAdapter(PARTNER_AGENT)?.displayName ?? getAgentDisplayName(PARTNER_AGENT);
const DIFF_PATH = path.join(sessionDir, "diff.patch");
const REFRESHED_DIFF_PATH = path.join(sessionDir, "diff_refreshed.patch");
const META_PATH = path.join(sessionDir, "review_meta.json");
const END_SIGNAL_PATH = path.join(sessionDir, "end_signal");
const PROCESSING_PATH = path.join(sessionDir, "partner_processing");
const ERROR_PATH = path.join(sessionDir, "last_error.txt");
const LOG_PATH = path.join(sessionDir, "runner.log");

const MAX_TURNS = HARD_CAP;
const POLL_INTERVAL_MS = 5000;
const IDLE_SHUTDOWN_MS = parsePositiveInt(
  envWithAliases(["DUALOG_IDLE_SHUTDOWN_MS", "CODEX_DIALOG_IDLE_SHUTDOWN_MS"]),
  24 * 60 * 60 * 1000
);
const MAX_CONVERSATION_MESSAGES = 20;
// Shared with the server so start_code_review can tell the host how much of the
// diff its partner will actually be handed.
const MAX_DIFF_CHARS = MAX_REVIEW_DIFF_CHARS;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
}

let terminatingFromSignal = false;

async function exitFromSignal(signal) {
  if (terminatingFromSignal) return;
  terminatingFromSignal = true;
  log(`${signal} received; exiting runner without terminating the active partner terminal`);
  // A tmux pane is deliberately preserved -- it is recorded in
  // current_terminal.json and can be inspected or terminated later. A headless
  // child has no such handle, so leaving it running orphans it for good.
  //
  // Awaited, not fire-and-forget: escalation to SIGKILL has to happen BEFORE
  // process.exit(), or the timer carrying it dies with this process and a child
  // that ignores SIGTERM outlives the runner that owned it.
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

function buildRoundBudgetBlock(partnerTurns, softCap, hardCap) {
  const currentRound = partnerTurns + 1;
  const remaining = Math.max(0, softCap - currentRound);
  const pastSoft = currentRound > softCap;

  let block = `## Round Budget

This review has a soft budget of ${softCap} rounds. You are writing round ${currentRound} of ${softCap}. Rounds remaining after this one: ${remaining}.
`;

  if (pastSoft) {
    block += `
**OVERTIME:** You are past the soft budget (round ${currentRound}, soft cap ${softCap}, hard cap ${hardCap}). Continue only if the remaining issues genuinely require more back-and-forth. Otherwise wrap up with a final summary this round and approve if appropriate.
`;
  }

  block += `
How to use the budget well:

1. **Dump every finding in this message.** Do not hold findings back for "next round." If your investigation surfaced ten issues, include all ten here. Future rounds are for verifying fixes and genuine follow-ups — not for releasing material you already had. Drip-feeding burns rounds and risks the review ending before you raise important findings.

2. **Consolidate and order by severity.** Group related findings. Lead with CRITICAL, then CORRECTNESS / ARCHITECTURE / SECURITY / ROBUSTNESS, then SUGGESTION, then a single short "Nits" section at the end — or omit nits entirely.

3. **Signal over noise.** A finding earns a slot only if a reasonable senior engineer would change a decision based on it. Skip style, naming, and cosmetic preferences unless they impact correctness or understanding. If nothing serious survives investigation after you've genuinely looked, say so plainly — a short honest review is better than padding the list with manufactured concerns.

4. **Thoroughness, not speed.** The budget is not a countdown clock. Take the time to investigate each finding properly before you write. The goal is that when you DO write, your message is COMPLETE. Brevity of conversation, not brevity of message.
`;

  return block;
}

function buildReviewPrompt(originalDiff, refreshedDiff, meta, messages, partnerTurns) {
  let conversationMessages = messages;
  if (messages.length > MAX_CONVERSATION_MESSAGES) {
    const first = messages.slice(0, 2);
    const recent = messages.slice(-(MAX_CONVERSATION_MESSAGES - 2));
    conversationMessages = [
      ...first,
      {
        id: -1,
        from: "system",
        content: `[... ${messages.length - MAX_CONVERSATION_MESSAGES} earlier messages omitted ...]`,
        timestamp: "",
      },
      ...recent,
    ];
  }

  const activeDiff = refreshedDiff ?? originalDiff;
  let diffContent = activeDiff;
  let diffTruncated = false;
  if (activeDiff.length > MAX_DIFF_CHARS) {
    diffContent = activeDiff.slice(0, MAX_DIFF_CHARS);
    diffTruncated = true;
  }

  let diffSection;
  if (refreshedDiff != null) {
    diffSection = `## Updated Changes (after fixes)

The original diff was included in your initial review (round 1 above). The reviewer has made fixes since then. Below is the current state of all changes. Compare against the original to verify fixes were applied correctly and check for any new issues introduced by the fixes.

\`\`\`diff
${diffContent}
\`\`\`
${diffTruncated ? `\n**Note:** The updated diff was truncated (${activeDiff.length} chars total, showing first ${MAX_DIFF_CHARS}). Read the full files in the project directory to see all changes.\n` : ""}`;
  } else {
    diffSection = `## The Diff
\`\`\`diff
${diffContent}
\`\`\`
${diffTruncated ? `\n**Note:** The diff was truncated (${activeDiff.length} chars total, showing first ${MAX_DIFF_CHARS}). Read the full files in the project directory to see all changes.\n` : ""}`;
  }

  let prompt = `You are a thorough code reviewer examining ${meta.diff_label || `changes on branch "${meta.branch}" compared to "${meta.base_branch}"`}.

${buildRoundBudgetBlock(partnerTurns, SOFT_CAP, HARD_CAP)}

## Review Focus
${meta.review_focus || "General code review — correctness, edge cases, error handling, naming, test coverage."}

## Changed Files
${meta.diff_stat || "(no stat available)"}

${diffSection}

## Project Directory
${projectPath}

You can read any files in this directory to understand context beyond the diff.

`;

  if (conversationMessages.length > 0) {
    prompt += `## Conversation So Far\n`;
    for (const msg of conversationMessages) {
      if (msg.id === -1) {
        prompt += `\n${msg.content}\n`;
        continue;
      }
      const speaker =
        msg.from === HOST_AGENT
          ? HOST_DISPLAY
          : msg.from === "system"
            ? "System"
            : `${PARTNER_DISPLAY} (you)`;
      prompt += `\n### ${speaker} [message #${msg.id}]:\n${msg.content}\n`;
    }
    prompt += `\n`;
  }

  const isInitialReview = partnerTurns === 0;

  const machineFooterBlock = `
## Machine-Readable Footer (IMPORTANT)
End every response with these machine-readable lines, after your prose:

REVIEW_VERDICT: <APPROVE|CHANGES_REQUESTED|NEEDS_DISCUSSION>
REFERENCED_FILES: path/to/file1.ext, path/to/file2.ext

Use REVIEW_VERDICT: APPROVE only when all significant issues are resolved and no material concern remains. Use REVIEW_VERDICT: CHANGES_REQUESTED when you found issues that should be addressed. Use REVIEW_VERDICT: NEEDS_DISCUSSION when the remaining decision needs the host or user to answer a question before you can approve.

Use paths relative to the project root (${projectPath}) in REFERENCED_FILES. This line is machine-parsed to ensure your discussion partner verifies your claims by reading the actual code. If you made no file-specific claims, omit REFERENCED_FILES, but always include REVIEW_VERDICT.`;

  if (isInitialReview) {
    prompt += `## Your Task — Initial Review
- Examine each changed file carefully. Read the full file (not just the diff) to understand context.
- For each significant finding, cite the file and line number.
- Be specific. "This might have issues" is not useful. "Line 42 of foo.ts: the null check is missing for the case where X is undefined because Y" is useful.
${meta.review_focus ? `- Prioritize your review around: ${meta.review_focus}` : ""}
- Categorize each finding (definitions matter — do not inflate categories):
  - **[CRITICAL]** — bugs, security issues, data loss risk, correctness failures. Must address.
  - **[CORRECTNESS]** — logic errors, edge cases, race conditions, incorrect error handling.
  - **[ARCHITECTURE]** — design problems, coupling issues, broken abstractions.
  - **[SECURITY]** — input validation, auth, secrets, unsafe patterns.
  - **[ROBUSTNESS]** — error paths, resource cleanup, partial failure handling.
  - **[SUGGESTION]** — concrete improvement with demonstrable benefit. Not a stylistic preference. If you cannot explain why a senior engineer would adopt it, omit it.
  - **[QUESTION]** — needs clarification before you can conclude. Used sparingly.
  - **[PRAISE]** — optional; call out a pattern genuinely worth keeping, kept to one or two lines. Only when honest — forced praise is worthless.
  - **[NIT]** — cosmetic/stylistic. Group into one short trailing "Nits" section or omit entirely.
- Deliver the complete review in this message. Do not hold findings back for later rounds.
- At the end, give an overall assessment: approve, request changes, or needs discussion.
${machineFooterBlock}

Respond with ONLY your review and the machine-readable footer. Do NOT wrap it in any JSON or metadata.`;
  } else {
    prompt += `## Your Task — Follow-up
- Address ${HOST_DISPLAY}'s responses to your review comments.
- If ${HOST_DISPLAY} fixed something, verify the fix looks correct by reading the current file.
- If ${HOST_DISPLAY} disagreed with a finding, either accept the reasoning or explain why you still think there is an issue.
- If new issues came up in discussion, address those too — but only if they meet the same severity bar as the initial review.
- Deliver complete follow-up in this message. Do not split follow-up findings across additional rounds.
- When all significant issues are resolved, set REVIEW_VERDICT: APPROVE in the machine-readable footer and include a brief summary of what was reviewed and resolved in your prose.
${machineFooterBlock}

Respond with ONLY your message and the machine-readable footer. Do NOT wrap it in any JSON or metadata.`;
  }

  return prompt;
}

async function main() {
  const originalDiff = fs.readFileSync(DIFF_PATH, "utf-8");
  const meta = JSON.parse(fs.readFileSync(META_PATH, "utf-8"));

  let lastProcessedId = 0;
  let partnerTurns = 0;
  let lastActivityTime = Date.now();
  let consecutiveErrors = 0;
  let exitReason = "hard_cap";
  let initialTerminalFailure = false;
  const MAX_CONSECUTIVE_ERRORS = 3;

  log("=== Review runner started ===");
  log(`Project: ${projectPath}`);
  log(`Branch: ${meta.branch} vs ${meta.base_branch}`);
  log(`Host agent: ${HOST_DISPLAY}`);
  log(`Partner agent: ${PARTNER_DISPLAY}`);
  log(`Partner command: ${partnerCommand}`);
  log(`Review focus: ${meta.review_focus || "general"}`);
  log(`Soft cap: ${SOFT_CAP} rounds, hard cap: ${HARD_CAP} rounds, Partner timeout hint: ${PARTNER_TIMEOUT_MS / 1000}s (interactive tmux turns are not killed by this value), Idle shutdown when no active turn: ${IDLE_SHUTDOWN_MS / 1000}s`);
  log(`Model: ${PARTNER_MODEL || "default"}`);
  log(`Reasoning effort: ${REASONING_EFFORT}`);
  log(`Generating initial review from diff with ${PARTNER_DISPLAY}...`);
  fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
  try {
    fs.unlinkSync(ERROR_PATH);
  } catch {}

  try {
    const prompt = buildReviewPrompt(originalDiff, null, meta, [], 0);
    const response = await runPartnerCommand({
      partnerAgent: PARTNER_AGENT,
      partnerCommand,
      prompt,
      projectPath,
      model: PARTNER_MODEL,
      reasoningEffort: REASONING_EFFORT,
      allowUnknownModel: ALLOW_UNKNOWN_MODEL,
      timeoutMs: PARTNER_TIMEOUT_MS,
      log,
      tempPrefix: `${PARTNER_AGENT}-review`,
      responseInstruction: "Respond with your review.",
      sessionDir,
    });

    appendMessage(sessionDir, PARTNER_AGENT, response);
    partnerTurns++;
    lastActivityTime = Date.now();
    log(
      `Initial review complete (${response.length} chars). Waiting for ${HOST_DISPLAY}...`
    );
  } catch (err) {
    if (isPartnerTurnCancelledError(err) || fs.existsSync(END_SIGNAL_PATH)) {
      log("Initial review cancelled by end_dialog");
    } else {
      consecutiveErrors++;
      log(`Error on initial review: ${err.message}`);
      fs.writeFileSync(ERROR_PATH, err.message);
      appendMessage(
        sessionDir,
        "system",
        `Failed to generate initial review: ${err.message}. ${HOST_DISPLAY} can still send messages to retry.`
      );
      if (isPartnerTerminalFailureError(err)) {
        initialTerminalFailure = true;
      }
    }
  }

  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}

  if (initialTerminalFailure) {
    log("Partner terminal reached a definitive failure; exiting runner after cleanup");
    appendMessage(
      sessionDir,
      "system",
      "Review runner stopped after a definitive partner terminal failure. Start a new review after resolving the partner CLI error."
    );
    log("=== Review runner exiting ===");
    return "partner_terminal_failure";
  }

  while (partnerTurns < MAX_TURNS) {
    if (fs.existsSync(END_SIGNAL_PATH)) {
      log("End signal detected, shutting down gracefully");
      exitReason = "end_signal";
      break;
    }

    const messages = readConversation(sessionDir);
    let refreshedDiff = null;
    if (fs.existsSync(REFRESHED_DIFF_PATH)) {
      try {
        refreshedDiff = fs.readFileSync(REFRESHED_DIFF_PATH, "utf-8");
      } catch {}
    }

    const newHostMessages = messages.filter(
      (m) => m.id > lastProcessedId && m.from === HOST_AGENT
    );

    if (newHostMessages.length > 0) {
      lastActivityTime = Date.now();
      lastProcessedId = messages.reduce(
        (max, m) =>
          typeof m.id === "number" && Number.isSafeInteger(m.id) && m.id > max
            ? m.id
            : max,
        0
      );

      log(
        `New ${HOST_DISPLAY} message(s) detected (latest id: ${lastProcessedId}). Starting review turn ${partnerTurns + 1}...`
      );

      fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
      try {
        fs.unlinkSync(ERROR_PATH);
      } catch {}

      try {
        const prompt = buildReviewPrompt(
          originalDiff,
          refreshedDiff,
          meta,
          messages,
          partnerTurns
        );
        const response = await runPartnerCommand({
          partnerAgent: PARTNER_AGENT,
          partnerCommand,
          prompt,
          projectPath,
          model: PARTNER_MODEL,
          reasoningEffort: REASONING_EFFORT,
      allowUnknownModel: ALLOW_UNKNOWN_MODEL,
          timeoutMs: PARTNER_TIMEOUT_MS,
          log,
          tempPrefix: `${PARTNER_AGENT}-review`,
          responseInstruction: "Respond with your review.",
          sessionDir,
        });

        appendMessage(sessionDir, PARTNER_AGENT, response);
        partnerTurns++;
        lastActivityTime = Date.now();
        consecutiveErrors = 0;
        log(
          `Review turn ${partnerTurns} complete (${response.length} chars). Waiting for ${HOST_DISPLAY}...`
        );
      } catch (err) {
        if (isPartnerTurnCancelledError(err) || fs.existsSync(END_SIGNAL_PATH)) {
          log(`Review turn ${partnerTurns + 1} cancelled by end_dialog`);
          exitReason = "end_signal";
          try {
            fs.unlinkSync(PROCESSING_PATH);
          } catch {}
          break;
        }

        consecutiveErrors++;
        log(
          `Error on review turn: ${err.message} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`
        );
        fs.writeFileSync(
          ERROR_PATH,
          `${err.message}\n\nConsecutive errors: ${consecutiveErrors}`
        );

        if (isPartnerTerminalFailureError(err)) {
          log("Partner terminal reached a definitive failure; exiting runner after cleanup");
          appendMessage(
            sessionDir,
            "system",
            `Review runner stopped after a definitive partner terminal failure: ${err.message}. Start a new review after resolving the partner CLI error.`
          );
          exitReason = "partner_terminal_failure";
          break;
        }

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("Too many consecutive errors, shutting down");
          appendMessage(
            sessionDir,
            "system",
            `Review runner encountered ${MAX_CONSECUTIVE_ERRORS} consecutive errors and is shutting down. Last error: ${err.message}`
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
        "Review runner shut down due to inactivity while no partner turn was active. Start a new review to continue."
      );
      exitReason = "idle_shutdown";
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (partnerTurns >= MAX_TURNS) {
    log(`Hard cap (${HARD_CAP}) reached`);
    appendMessage(
      sessionDir,
      "system",
      `Hard round cap (${HARD_CAP}) reached — soft budget was ${SOFT_CAP}. No further ${PARTNER_DISPLAY} turns will be invoked in this session. Summarize remaining findings and start a new review if more discussion is needed.`
    );
  }

  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}

  log("=== Review runner exiting ===");
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
