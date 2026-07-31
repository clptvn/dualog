#!/usr/bin/env node
/**
 * Group Runner — sequential multi-partner dialog/review turns.
 *
 * Polls for host messages, resolves targets (mode + message.to), invokes each
 * partner CLI in series via runPartnerCommand, appends replies.
 *
 * argv: sessionDir, projectPath, softCap, reasoningEffort, model,
 *       hostAgent, toolProfile, partnerTimeoutMs
 * Partner commands/models come from status.json.
 */

import fs from "fs";
import path from "path";
import {
  appendMessage,
  getAgentDisplayName,
  getSessionPartnerAgents,
  isGroupSession,
  normalizeHostAgent,
  readConversation,
  readStatus,
  resolveGroupTargets,
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
const SOFT_CAP = parseInt(process.argv[4], 10) || 5;
const HARD_CAP = SOFT_CAP + 5;
const RAW_REASONING_EFFORT = process.argv[5] || DEFAULT_REASONING_EFFORT;
const DEFAULT_MODEL = process.argv[6] || null;
const HOST_AGENT = normalizeHostAgent(process.argv[7], "claude");
const TOOL_PROFILE =
  process.argv[8] === "implementation" ? "implementation" : "read";
const DEFAULT_PARTNER_TIMEOUT_MS = 15 * 60 * 1000;
const PARTNER_TIMEOUT_MS =
  Math.max(1000, parseInt(process.argv[9], 10)) || DEFAULT_PARTNER_TIMEOUT_MS;

if (!sessionDir) process.exit(1);

const HOST_DISPLAY = getAgentDisplayName(HOST_AGENT);
const PROBLEM_PATH = path.join(sessionDir, "problem.md");
const STATUS_PATH = path.join(sessionDir, "status.json");
const END_SIGNAL_PATH = path.join(sessionDir, "end_signal");
const PROCESSING_PATH = path.join(sessionDir, "partner_processing");
const ERROR_PATH = path.join(sessionDir, "last_error.txt");
const LOG_PATH = path.join(sessionDir, "runner.log");

const POLL_INTERVAL_MS = 3000;
const IDLE_SHUTDOWN_MS = parsePositiveInt(
  process.env.CODEX_DIALOG_IDLE_SHUTDOWN_MS,
  24 * 60 * 60 * 1000
);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`);
}

function readSessionStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeSessionStatus(patch) {
  const current = readSessionStatus();
  const next = { ...current, ...patch };
  fs.writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function partnerCommandFor(status, agent) {
  return (
    status?.partner_commands?.[agent] ||
    (agent === "claude" ? "claude" : agent === "grok" ? "grok" : "codex")
  );
}

function partnerModelFor(status, agent) {
  return status?.partner_models?.[agent] || status?.model || DEFAULT_MODEL;
}

function countPartnerTurns(messages, partners) {
  const set = new Set(partners);
  return messages.filter((m) => set.has(m.from)).length;
}

function buildPartnerPrompt({
  problem,
  messages,
  partnerAgent,
  partners,
  partnerTurns,
  status,
  isReview,
}) {
  const partnerDisplay = getAgentDisplayName(partnerAgent);
  const roster = partners.map((p) => getAgentDisplayName(p)).join(", ");
  const history = messages
    .slice(-30)
    .map((m) => {
      const who = getAgentDisplayName(m.from) || m.from;
      return `### ${who} (id=${m.id})\n${m.content}`;
    })
    .join("\n\n");

  let reviewBlock = "";
  if (isReview) {
    const diffPath = path.join(sessionDir, "diff_refreshed.patch");
    const original = path.join(sessionDir, "diff.patch");
    const usePath = fs.existsSync(diffPath) ? diffPath : original;
    let diff = "";
    try {
      diff = fs.readFileSync(usePath, "utf-8");
    } catch {}
    reviewBlock = `\n## Diff under review\n\`\`\`diff\n${diff.slice(0, 350000)}\n\`\`\`\n`;
  }

  return `You are **${partnerDisplay}**, one partner in a multi-agent ${isReview ? "code review" : "dialog"} session.

Participants (partners): ${roster}
Facilitator / host: ${HOST_DISPLAY}
You speak only as ${partnerDisplay}. Do not impersonate other agents.

## Problem / charter
${problem}
${reviewBlock}
## Conversation so far
${history || "(no messages yet)"}

## Your task
Provide a thorough ${isReview ? "review" : "response"} from your perspective. Reference other partners' points when useful; do not merely restate them.
Partner turn budget context: about ${partnerTurns} partner turns used so far (soft cap waves ~${SOFT_CAP}).

If reviewing code, use structured tags like [CRITICAL], [SECURITY], [CORRECTNESS] where appropriate.
End with a clear verdict line when applicable:
REVIEW_VERDICT: APPROVE | CHANGES_REQUESTED | NEEDS_DISCUSSION | IN_PROGRESS

## File references
At the end, if you cited files:
REFERENCED_FILES: path/to/file1, path/to/file2

Respond with ONLY your message (plus optional REFERENCED_FILES).`;
}

async function main() {
  const problem = fs.existsSync(PROBLEM_PATH)
    ? fs.readFileSync(PROBLEM_PATH, "utf-8")
    : "";
  let status = readSessionStatus();
  if (!isGroupSession(status) && !status.partner_agents) {
    log("Not a group session; exiting");
    process.exit(1);
  }

  const partners = getSessionPartnerAgents(status);
  const isReview =
    status.type === "group_review" || status.type === "review";

  let lastProcessedId = 0;
  let partnerTurnCount = 0;
  let lastActivityTime = Date.now();
  let consecutiveErrors = 0;

  log("=== Group runner started ===");
  log(`Project: ${projectPath}`);
  log(`Host: ${HOST_DISPLAY}`);
  log(`Partners: ${partners.join(", ")}`);
  log(`Mode: ${status.mode || "addressable"}`);
  log(`Soft cap waves: ${SOFT_CAP}, hard partner-turns: ${HARD_CAP}`);

  // Auto first wave for group_review: synthesize a host kickoff if conversation empty
  {
    const messages = readConversation(sessionDir);
    if (isReview && messages.length === 0) {
      appendMessage(
        sessionDir,
        HOST_AGENT,
        "Begin group code review. Each partner should independently review the provided diff and report findings.",
        { to: "all", meta: { wave: "initial_review" } }
      );
      log("Seeded initial group review host message");
    }
  }

  while (partnerTurnCount < HARD_CAP) {
    if (fs.existsSync(END_SIGNAL_PATH)) {
      log("End signal detected");
      break;
    }

    status = readSessionStatus();
    const messages = readConversation(sessionDir);
    const newHostMessages = messages.filter(
      (m) => m.id > lastProcessedId && m.from === HOST_AGENT
    );

    if (newHostMessages.length > 0) {
      lastActivityTime = Date.now();
      const hostMsg = newHostMessages[newHostMessages.length - 1];
      lastProcessedId = messages.reduce(
        (max, m) =>
          typeof m.id === "number" && Number.isSafeInteger(m.id) && m.id > max
            ? m.id
            : max,
        0
      );

      let targets = resolveGroupTargets(status, hostMsg);
      if (!targets.length && (status.mode === "addressable" || !status.mode)) {
        // Fallback: if host forgot `to`, fan-out once for review; else system error
        if (isReview || status.mode === "fan_out") {
          targets = [...partners];
        } else {
          appendMessage(
            sessionDir,
            "system",
            `Group addressable mode requires send_message.to (one of: ${partners.join(", ")}, or "all"). No partner invoked.`
          );
          continue;
        }
      }

      log(
        `Host message id=${hostMsg.id}; targets=[${targets.join(", ")}]`
      );

      // Advance RR index if round_robin
      if (status.mode === "round_robin" && targets.length === 1) {
        const idx = (Number(status.turn_state?.rr_index) || 0) + 1;
        writeSessionStatus({
          turn_state: {
            ...(status.turn_state || {}),
            rr_index: idx % Math.max(partners.length, 1),
            last_host_message_id: hostMsg.id,
            pending_targets: [],
          },
        });
      } else {
        writeSessionStatus({
          turn_state: {
            ...(status.turn_state || {}),
            last_host_message_id: hostMsg.id,
            pending_targets: targets,
            completed_targets: [],
          },
        });
      }

      for (const agent of targets) {
        if (fs.existsSync(END_SIGNAL_PATH)) break;
        if (partnerTurnCount >= HARD_CAP) break;

        const cmd = partnerCommandFor(status, agent);
        const model = partnerModelFor(status, agent);
        let effort = RAW_REASONING_EFFORT;
        try {
          effort = normalizeReasoningEffortForAgent(
            status.reasoning_effort || RAW_REASONING_EFFORT,
            agent
          );
        } catch {
          effort = DEFAULT_REASONING_EFFORT;
        }

        fs.writeFileSync(
          PROCESSING_PATH,
          JSON.stringify({
            agent,
            started_at: new Date().toISOString(),
          })
        );
        try {
          fs.unlinkSync(ERROR_PATH);
        } catch {}

        const liveMessages = readConversation(sessionDir);
        const prompt = buildPartnerPrompt({
          problem,
          messages: liveMessages,
          partnerAgent: agent,
          partners,
          partnerTurns: partnerTurnCount,
          status,
          isReview,
        });

        log(`Invoking ${agent} (${cmd})…`);
        try {
          const response = await runPartnerCommand({
            partnerAgent: agent,
            partnerCommand: cmd,
            prompt,
            projectPath,
            model,
            reasoningEffort: effort,
            toolProfile: TOOL_PROFILE,
            timeoutMs: PARTNER_TIMEOUT_MS,
            log,
            tempPrefix: `${agent}-group`,
            responseInstruction: "Respond with your analysis.",
            sessionDir,
          });
          appendMessage(sessionDir, agent, response, {
            meta: { in_reply_to: hostMsg.id },
          });
          partnerTurnCount++;
          consecutiveErrors = 0;
          lastActivityTime = Date.now();
          const st = readSessionStatus();
          const completed = [
            ...(st.turn_state?.completed_targets || []),
            agent,
          ];
          writeSessionStatus({
            turn_state: {
              ...(st.turn_state || {}),
              pending_targets: (st.turn_state?.pending_targets || []).filter(
                (t) => t !== agent
              ),
              completed_targets: completed,
            },
          });
          log(`${agent} turn complete (${response.length} chars)`);
        } catch (err) {
          if (isPartnerTurnCancelledError(err) || fs.existsSync(END_SIGNAL_PATH)) {
            log(`${agent} cancelled by end_dialog`);
            break;
          }
          consecutiveErrors++;
          log(`Error from ${agent}: ${err.message}`);
          fs.writeFileSync(ERROR_PATH, `${agent}: ${err.message}`);
          appendMessage(
            sessionDir,
            "system",
            `Partner ${agent} failed: ${err.message}`
          );
          if (consecutiveErrors >= 5) {
            log("Too many consecutive errors; shutting down");
            break;
          }
        } finally {
          try {
            fs.unlinkSync(PROCESSING_PATH);
          } catch {}
        }
      }
    } else if (Date.now() - lastActivityTime > IDLE_SHUTDOWN_MS) {
      log("Idle shutdown");
      appendMessage(
        sessionDir,
        "system",
        "Group runner shut down due to inactivity."
      );
      break;
    }

    // hard cap by partner turns
    const msgs = readConversation(sessionDir);
    if (countPartnerTurns(msgs, partners) >= HARD_CAP) {
      appendMessage(
        sessionDir,
        "system",
        `Hard partner-turn cap (${HARD_CAP}) reached for this group session.`
      );
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  try {
    fs.unlinkSync(PROCESSING_PATH);
  } catch {}
  log("=== Group runner exiting ===");
}

main().catch((err) => {
  try {
    fs.appendFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] FATAL: ${err.stack || err.message}\n`
    );
  } catch {}
  process.exit(1);
});
