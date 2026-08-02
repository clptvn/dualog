#!/usr/bin/env node
// PostToolUse hook for dualog response-reading tools. Parses responses,
// extracts validated referenced_files, and writes them to a session-scoped
// marker file.

import fs from "fs";
import path from "path";
import os from "os";
import { resolveExistingSessionDir, readHookPayload } from "../platform.mjs";

// PostToolUse: the call has already run, so blocking is meaningless. But a
// failed read is not harmless -- this hook arms the guard that runs later, and
// skipping it silently disables that guard without a trace. Both failure
// shapes ("unreadable" and "invalid") are reported; a clean empty read is not
// a failure and stays quiet.
const { payload, outcome } = readHookPayload();
if (outcome === "unreadable" || outcome === "invalid") {
  process.stderr.write(
    `dualog investigation marker: received ${outcome} hook input; the downstream guard was not armed for this turn.\n`
  );
  process.exit(0);
}
if (outcome !== "ok" || !payload) process.exit(0);

// Claude Code passes tool_response as [{type, text}], but handle the raw
// MCP shape (content: [{type, text}]) too for robustness.
const responseText =
  payload.tool_response?.[0]?.text ??
  payload.tool_response?.content?.[0]?.text;
if (!responseText) process.exit(0);

let response;
try {
  response = JSON.parse(responseText);
} catch {
  process.exit(0);
}

const referencedFiles = response.referenced_files || [];
const sessionId = payload.tool_input?.session_id;
if (!sessionId || !/^[\w-]+$/.test(sessionId)) process.exit(0);

let partnerAgent = "codex";
try {
  const statusPath = path.join(resolveExistingSessionDir(sessionId), "status.json");
  if (fs.existsSync(statusPath)) {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    if (status?.partner_agent === "claude" || status?.partner_agent === "codex") {
      partnerAgent = status.partner_agent;
    }
  }
} catch {}

// If the partner provided specific file references, always enforce them.
// If no specific files but severity-tagged findings exist, use __any__ fallback.
// If neither, nothing to enforce.
// check_messages and wait_for_partner_response use new_messages;
// get_full_history uses messages.
const msgs = response.new_messages || response.messages || [];
const hasTaggedFindings = msgs.some(
  (m) =>
    m.from === partnerAgent &&
    /\[(CRITICAL|CORRECTNESS|ARCHITECTURE|SECURITY|ROBUSTNESS|SUGGESTION|QUESTION)\]/.test(
      m.content
    )
);
if (referencedFiles.length === 0 && !hasTaggedFindings) process.exit(0);

const marker = path.join(os.tmpdir(), `dualog-required-reads-${sessionId}`);

// Don't overwrite an existing marker — investigation is still in progress
if (fs.existsSync(marker)) process.exit(0);

if (referencedFiles.length > 0) {
  fs.writeFileSync(marker, referencedFiles.join("\n") + "\n");
} else {
  fs.writeFileSync(marker, "__any__\n");
}

process.exit(0);
