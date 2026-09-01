#!/usr/bin/env node
// PreToolUse hook for mcp__dualog__end_dialog
// Blocks session closure unless the parsed review verdict is approved or the hard round cap is hit.

import fs from "fs";
import path from "path";
import { resolveExistingSessionDir, readHookPayload } from "../platform.mjs";

async function loadShared() {
  const installedShared = new URL("./shared.mjs", import.meta.url);
  if (fs.existsSync(installedShared)) return import(installedShared);
  return import(new URL("../shared.mjs", import.meta.url));
}

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

// A gate that cannot UNDERSTAND its input must not wave the call through.
//
// Three failing shapes, two answers. "unreadable" means the budget expired with
// nothing arriving (transient EAGAIN is already retried inside
// readHookPayload, so this is not a momentary blip). "invalid" means bytes
// arrived but are not valid JSON -- a truncated or corrupted write. In both the
// hook cannot evaluate the decision it exists to make, so it blocks: exit 2 is
// the direction a safety check should fail. Only a clean EMPTY read is benign,
// because there is genuinely nothing to check.
const { payload, outcome } = readHookPayload();
if (outcome === "unreadable" || outcome === "invalid") {
  process.stderr.write(
    `BLOCKED: the dualog session-close gate received ${outcome} hook input, so it cannot verify ` +
      "this call. Retry; if this persists, check that the hook payload is being piped intact.\n"
  );
  process.exit(2);
}
if (outcome !== "ok" || !payload) process.exit(0);

const sessionId = payload.tool_input?.session_id;
if (!sessionId || !/^[\w-]+$/.test(sessionId)) process.exit(0);

// resolveExistingSessionDir, not dialogSessionDir: the MCP server resolves a
// session through the legacy root as well, and a hook that only checks the
// current root cannot find any pre-rename session. Its existence check below
// then exits 0 -- which means ALLOW -- so the guard silently stopped applying
// to every session created before the rename.
const sessionDir = resolveExistingSessionDir(sessionId);
if (!fs.existsSync(sessionDir)) process.exit(0);

let partnerAgent = "codex";
let partnerDisplay = "Codex";
let hardCap = 10;
let runnerPid = null;
let runnerState = null;
let status = null;
let problem = "";

const statusPath = path.join(sessionDir, "status.json");
if (fs.existsSync(statusPath)) {
  try {
    status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    if (status?.partner_agent === "claude" || status?.partner_agent === "codex") {
      partnerAgent = status.partner_agent;
      partnerDisplay = partnerAgent === "claude" ? "Claude" : "Codex";
    }
    hardCap = status?.hard_cap || (status?.max_rounds || 5) + 5;
    runnerPid = status?.runner_pid || null;
    runnerState = typeof status?.runner_state === "string" ? status.runner_state : null;
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
let panelState = null;
if (status?.type === "pr_review") {
  try {
    panelState = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "panel_state.json"), "utf-8")
    );
  } catch {
    // Missing or unreadable panel state must fail closed for approval. The
    // shared gate distinguishes that from an ordinary non-panel review.
  }
}
const reviewStatus = computeReviewStatus(status, messages, { problem, panelState });
const partnerRounds = messages.filter((m) => m.from === partnerAgent).length;
if (reviewStatus.close_allowed) process.exit(0);

// Allow closing a session whose runner is gone. A session cannot make progress
// without one, so blocking here only strands it.
//
// The persisted state is the authoritative signal, not a PID probe: a runner
// records its own exit via markSessionRunnerExited(), and that same write sets
// runner_pid to null (keeping the old value as last_runner_pid). Checking only
// runner_pid therefore inverted the intent -- every runner that shut down
// cleanly (idle_shutdown, partner_terminal_failure, fatal_error, SIGTERM,
// SIGINT) erased the evidence this escape hatch needed, and its session could
// never be closed.
if (runnerState === "exited") process.exit(0);

// No exit record. Fall back to probing whichever PID we know about; a PID that
// is no longer running means the runner died without getting to record it.
const probePid = runnerPid || status?.last_runner_pid || null;
if (Number.isSafeInteger(probePid) && probePid > 0) {
  try {
    process.kill(probePid, 0);
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
