#!/usr/bin/env node
// PreToolUse hook for mcp__codex-dialog__end_dialog
// Blocks session closure unless the parsed review verdict is approved or the hard round cap is hit.

import fs from "fs";
import path from "path";
import { dialogsDir, readStdin } from "../platform.mjs";

async function loadShared() {
  const installedShared = new URL("./shared.mjs", import.meta.url);
  if (fs.existsSync(installedShared)) return import(installedShared);
  return import(new URL("../shared.mjs", import.meta.url));
}

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const input = readStdin();
let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.exit(0);
}

const sessionId = payload.tool_input?.session_id;
if (!sessionId || !/^[\w-]+$/.test(sessionId)) process.exit(0);

const sessionDir = path.join(dialogsDir(), sessionId);
if (!fs.existsSync(sessionDir)) process.exit(0);

let partnerAgent = "codex";
let partnerDisplay = "Codex";
let hardCap = 10;
let runnerPid = null;
let status = null;
let problem = "";

const statusPath = path.join(sessionDir, "status.json");
if (fs.existsSync(statusPath)) {
  try {
    status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    if (status?.partner_agent === "claude" || status?.partner_agent === "codex" || status?.partner_agent === "grok") {
      partnerAgent = status.partner_agent;
      partnerDisplay = partnerAgent === "claude" ? "Claude" : partnerAgent === "grok" ? "Grok" : "Codex";
    }
    hardCap = status?.hard_cap || (status?.max_rounds || 5) + 5;
    runnerPid = status?.runner_pid || null;
  } catch {}
}

const problemPath = path.join(sessionDir, "problem.md");
if (fs.existsSync(problemPath)) {
  try {
    problem = fs.readFileSync(problemPath, "utf-8");
  } catch {}
}

let computeReviewStatus;
let readConversation;
try {
  ({ computeReviewStatus, readConversation } = await loadShared());
} catch (error) {
  block(
    `BLOCKED: Cannot end this session yet. The review-status parser could not be loaded: ${error?.message || error}`
  );
}

const messages = readConversation(sessionDir);
const reviewStatus = computeReviewStatus(status, messages, { problem });
const partnerRounds = messages.filter((m) => m.from === partnerAgent).length;
if (reviewStatus.close_allowed) process.exit(0);

// Check if runner is dead (allow closing dead sessions)
if (runnerPid) {
  try {
    process.kill(runnerPid, 0);
  } catch {
    // Runner is dead — allow closing
    process.exit(0);
  }
}

process.stderr.write(
  `BLOCKED: Cannot end this session yet. ${partnerDisplay} has not approved the review and the hard cap (${hardCap}) has not been reached (${partnerRounds} rounds used).

Current parsed review status: ${reviewStatus.state}${reviewStatus.verdict ? ` (${reviewStatus.verdict})` : ""}

Wait for ${partnerDisplay} to verify your fixes and set REVIEW_VERDICT: APPROVE before closing the session.
If ${partnerDisplay} has remaining concerns, address them first.

To force-close a stuck session, the runner must be dead or the hard cap must be hit.
`
);
process.exit(2);
