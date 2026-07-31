#!/usr/bin/env node
/**
 * Dialog Runner - Background process that manages partner CLI invocations
 *
 * Polls for new host-agent messages. When one appears, invokes the configured
 * partner CLI with the full conversation history and writes the response back
 * to the shared conversation file. Handles crashes and graceful shutdown.
 */

import fs from "fs";
import path from "path";
import {
  appendMessage,
  getAgentDisplayName,
  normalizeHostAgent,
  normalizePartnerAgent,
  readConversation,
  sleep,
} from "./shared.mjs";
import {
  isPartnerTurnCancelledError,
  runPartnerCommand,
} from "./partner-invocation.mjs";
import {
  DEFAULT_REASONING_EFFORT,
  normalizeReasoningEffortForAgent,
} from "./runtime-defaults.mjs";

const sessionDir = process.argv[2];
const projectPath = process.argv[3] || process.cwd();
const partnerCommand = process.argv[4] || "codex";
const SOFT_CAP = parseInt(process.argv[5], 10) || 5;
const HARD_CAP = SOFT_CAP + 5;
const RAW_REASONING_EFFORT = process.argv[6] || DEFAULT_REASONING_EFFORT;
const PARTNER_MODEL = process.argv[7] || null;
const HOST_AGENT = normalizeHostAgent(process.argv[8], "claude");
const PARTNER_AGENT = normalizePartnerAgent(process.argv[9], "codex");
const REASONING_EFFORT = normalizeReasoningEffortForAgent(
  RAW_REASONING_EFFORT,
  PARTNER_AGENT
);
const TOOL_PROFILE = process.argv[10] === "implementation" ? "implementation" : "read";
const DEFAULT_PARTNER_TIMEOUT_MS = 15 * 60 * 1000;
const PARTNER_TIMEOUT_MS =
  Math.max(1000, parseInt(process.argv[11], 10)) || DEFAULT_PARTNER_TIMEOUT_MS;

if (!sessionDir || HOST_AGENT === PARTNER_AGENT) {
  process.exit(1);
}

const HOST_DISPLAY = getAgentDisplayName(HOST_AGENT);
const PARTNER_DISPLAY = getAgentDisplayName(PARTNER_AGENT);
const PROBLEM_PATH = path.join(sessionDir, "problem.md");
const STATUS_PATH = path.join(sessionDir, "status.json");
const END_SIGNAL_PATH = path.join(sessionDir, "end_signal");
const PROCESSING_PATH = path.join(sessionDir, "partner_processing");
const ERROR_PATH = path.join(sessionDir, "last_error.txt");
const LOG_PATH = path.join(sessionDir, "runner.log");

const MAX_TURNS = HARD_CAP;
const POLL_INTERVAL_MS = 3000;
const IDLE_SHUTDOWN_MS = parsePositiveInt(
  process.env.CODEX_DIALOG_IDLE_SHUTDOWN_MS,
  24 * 60 * 60 * 1000
);
const MAX_CONVERSATION_MESSAGES = 30;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
}

let terminatingFromSignal = false;

function exitFromSignal(signal) {
  if (terminatingFromSignal) return;
  terminatingFromSignal = true;
  log(`${signal} received; exiting runner without terminating the active partner terminal`);
  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}
  process.exit(0);
}

process.once("SIGTERM", () => {
  exitFromSignal("SIGTERM");
});
process.once("SIGINT", () => {
  exitFromSignal("SIGINT");
});

function readSessionStatus() {
  if (!fs.existsSync(STATUS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function displaySubjectKind(kind) {
  if (kind === "plan") return "Plan";
  if (kind === "spec") return "Spec";
  return "Document";
}

function displaySubjectPath(subjectPath) {
  if (!subjectPath) return "";
  const rel = path.relative(projectPath, subjectPath);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel || ".";
  return subjectPath;
}

function buildCurrentSubjectBlock(status) {
  const subjectPath = status?.subject_path;
  if (!subjectPath) return "";

  const subjectKind = displaySubjectKind(status.subject_kind);
  const subjectLabel = subjectKind.toLowerCase();
  const pathLabel = displaySubjectPath(subjectPath);
  try {
    const content = fs.readFileSync(subjectPath, "utf-8");
    return `## Current ${subjectKind} Snapshot

Path: ${pathLabel}

This is the authoritative current ${subjectLabel}. It supersedes any older copy or summary of the ${subjectLabel} in the original problem description or conversation history. Re-review this current ${subjectLabel} each round after ${HOST_DISPLAY} says they updated it.

<current_${subjectLabel}>
${content}
</current_${subjectLabel}>

`;
  } catch (err) {
    return `## Current ${subjectKind} Snapshot

Path: ${pathLabel}

Could not read the current ${subjectLabel} from disk: ${err.message}

`;
  }
}

function buildRoundBudgetBlock(partnerTurns, softCap, hardCap) {
  const currentRound = partnerTurns + 1;
  const remaining = Math.max(0, softCap - currentRound);
  const pastSoft = currentRound > softCap;

  let block = `## Round Budget

This session has a soft budget of ${softCap} rounds. You are writing round ${currentRound} of ${softCap}. Rounds remaining after this one: ${remaining}.
`;

  if (pastSoft) {
    block += `
**OVERTIME:** You are past the soft budget (round ${currentRound}, soft cap ${softCap}, hard cap ${hardCap}). Continue only if the remaining issues genuinely require more back-and-forth. Otherwise wrap up with a final summary this round.
`;
  }

  block += `
How to use the budget well:

1. **Include everything you have in this message.** Do not hold findings, concerns, or suggestions back for "next round." If your investigation surfaced ten items, include all ten here. Future rounds are for verifying fixes and genuine follow-ups — not for releasing material you already had. Drip-feeding burns rounds and risks the conversation ending before you raise important points.

2. **Consolidate and order by severity.** Group related items. Lead with the highest-severity categories first. Stylistic or cosmetic points, if any, belong in a single short "Nits" section at the end — or are omitted entirely.

3. **Signal over noise.** An item earns a slot only if a reasonable senior engineer would change a decision based on it. Skip style, naming, and cosmetic preferences unless they impact correctness or understanding. If nothing serious survives investigation, say so plainly — a short honest response is better than padding the list.

4. **Thoroughness, not speed.** The budget is not a countdown clock. Take the time to investigate each item properly before you write. The goal is that when you DO write, your message is COMPLETE. Brevity of conversation, not brevity of message.
`;

  return block;
}

function buildPartnerPrompt(problem, messages, partnerTurns, status) {
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

  let prompt = `You are participating in a technical discussion with ${HOST_DISPLAY} about a challenging problem. You are "${PARTNER_DISPLAY}" in this conversation.

Your goal is to collaboratively solve the problem by bringing your own independent analysis, ideas, and critical thinking. You and ${HOST_DISPLAY} are working together, so build on strong reasoning and challenge weak reasoning.

${buildRoundBudgetBlock(partnerTurns, SOFT_CAP, HARD_CAP)}

## Problem Description
${problem}

${buildCurrentSubjectBlock(status)}
## Project Directory
${projectPath}

You can read any files in this directory to understand the code.

${TOOL_PROFILE === "implementation" ? `## Implementation Authority
You may edit files in the project directory. Treat ${HOST_DISPLAY} as the backend/integration owner and yourself as the frontend/UI owner unless the conversation says otherwise.

Keep changes scoped to your assigned frontend/UI work. Do not rewrite backend, database, auth, billing, or infrastructure code unless ${HOST_DISPLAY} explicitly asks you to touch a narrow integration point. When you change files, summarize exactly what changed and list the paths.

` : ""}

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

  prompt += `## Your Task
- Read the conversation above carefully and provide your next response.
- Think deeply about the problem. Explore relevant code files before responding.
- If ${HOST_DISPLAY} made a suggestion, evaluate it critically and point out flaws or improvements.
- If you have a new idea, explain your reasoning step by step.
- Propose concrete solutions: specific files, functions, line numbers, code changes when relevant.
- If you agree with ${HOST_DISPLAY}'s analysis, say so but add something new: a refinement, edge case, or next step.
- Be direct and technical. No filler.
- Respect the round budget above: deliver complete feedback this message; do not save material for later rounds.

## File References (IMPORTANT)
At the very end of your response, on its own line, list every source file you referenced or made claims about using exactly this format:
REFERENCED_FILES: path/to/file1.ext, path/to/file2.ext
Use paths relative to the project root (${projectPath}). This line is machine-parsed to ensure your discussion partner verifies your claims by reading the actual code. If you made no file-specific claims, omit this line entirely.

Respond with ONLY your message (plus the REFERENCED_FILES line). Do NOT wrap it in any JSON or metadata.`;

  return prompt;
}

async function main() {
  const problem = fs.readFileSync(PROBLEM_PATH, "utf-8");
  const status = readSessionStatus();

  let lastProcessedId = 0;
  let partnerTurns = 0;
  let lastActivityTime = Date.now();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  log("=== Dialog runner started ===");
  log(`Project: ${projectPath}`);
  log(`Host agent: ${HOST_DISPLAY}`);
  log(`Partner agent: ${PARTNER_DISPLAY}`);
  log(`Partner command: ${partnerCommand}`);
  log(`Soft cap: ${SOFT_CAP} rounds, hard cap: ${HARD_CAP} rounds`);
  log(`Partner timeout hint: ${PARTNER_TIMEOUT_MS / 1000}s (interactive tmux turns are not killed by this value)`);
  log(`Model: ${PARTNER_MODEL || "default"}`);
  log(`Reasoning effort: ${REASONING_EFFORT}`);
  log(`Tool profile: ${TOOL_PROFILE}`);
  if (status.subject_path) {
    log(`Subject: ${status.subject_kind || "document"} at ${status.subject_path}`);
  }
  log(`Idle shutdown when no active turn: ${IDLE_SHUTDOWN_MS / 1000}s`);
  while (partnerTurns < MAX_TURNS) {
    if (fs.existsSync(END_SIGNAL_PATH)) {
      log("End signal detected, shutting down gracefully");
      break;
    }

    const messages = readConversation(sessionDir);
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
        `New ${HOST_DISPLAY} message(s) detected (latest id: ${lastProcessedId}). Starting ${PARTNER_DISPLAY} turn ${partnerTurns + 1}...`
      );

      fs.writeFileSync(PROCESSING_PATH, new Date().toISOString());
      try {
        fs.unlinkSync(ERROR_PATH);
      } catch {}

      try {
        const prompt = buildPartnerPrompt(problem, messages, partnerTurns, status);
        const response = await runPartnerCommand({
          partnerAgent: PARTNER_AGENT,
          partnerCommand,
          prompt,
          projectPath,
          model: PARTNER_MODEL,
          reasoningEffort: REASONING_EFFORT,
          toolProfile: TOOL_PROFILE,
          timeoutMs: PARTNER_TIMEOUT_MS,
          log,
          tempPrefix: `${PARTNER_AGENT}-dialog`,
          responseInstruction: "Respond with your analysis.",
          sessionDir,
        });

        appendMessage(sessionDir, PARTNER_AGENT, response);
        partnerTurns++;
        lastActivityTime = Date.now();
        consecutiveErrors = 0;
        log(
          `${PARTNER_DISPLAY} turn ${partnerTurns} complete (${response.length} chars). Waiting for ${HOST_DISPLAY}...`
        );
      } catch (err) {
        if (isPartnerTurnCancelledError(err) || fs.existsSync(END_SIGNAL_PATH)) {
          log(`${PARTNER_DISPLAY} turn cancelled by end_dialog`);
          try {
            fs.unlinkSync(PROCESSING_PATH);
          } catch {}
          break;
        }

        consecutiveErrors++;
        log(
          `Error on ${PARTNER_DISPLAY} turn: ${err.message} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`
        );
        fs.writeFileSync(
          ERROR_PATH,
          `${err.message}\n\nConsecutive errors: ${consecutiveErrors}`
        );

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("Too many consecutive errors, shutting down");
          appendMessage(
            sessionDir,
            "system",
            `Dialog runner encountered ${MAX_CONSECUTIVE_ERRORS} consecutive errors and is shutting down. Last error: ${err.message}`
          );
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
        "Dialog runner shut down due to inactivity while no partner turn was active. Start a new dialog to continue the discussion."
      );
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (partnerTurns >= MAX_TURNS) {
    log(`Hard cap (${HARD_CAP}) reached`);
    appendMessage(
      sessionDir,
      "system",
      `Hard round cap (${HARD_CAP}) reached — soft budget was ${SOFT_CAP}. No further ${PARTNER_DISPLAY} turns will be invoked in this session. Summarize remaining findings and start a new dialog if more discussion is needed.`
    );
  }

  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}

  log("=== Dialog runner exiting ===");
}

main().catch((err) => {
  log(`Fatal error: ${err.message}\n${err.stack}`);
  try {
    fs.writeFileSync(ERROR_PATH, `Fatal: ${err.message}`);
  } catch {}
  process.exit(1);
});
