#!/usr/bin/env node
// PreToolUse hook for mcp__dualog__send_message
// Blocks the send if Claude hasn't read the files the partner referenced.
// Session-scoped: only checks the marker for the target session.

import fs from "fs";
import path from "path";
import os from "os";
import { dialogSessionDir, readStdin } from "../platform.mjs";

const input = readStdin();
let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.exit(0);
}

const sessionId = payload.tool_input?.session_id;
if (!sessionId || !/^[\w-]+$/.test(sessionId)) process.exit(0);

let partnerDisplay = "Codex";
try {
  const statusPath = path.join(dialogSessionDir(sessionId), "status.json");
  if (fs.existsSync(statusPath)) {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    partnerDisplay = status?.partner_agent === "claude" ? "Claude" : "Codex";
  }
} catch {}

const markerPath = path.join(os.tmpdir(), `dualog-required-reads-${sessionId}`);
if (!fs.existsSync(markerPath)) process.exit(0);

const content = fs.readFileSync(markerPath, "utf-8").trim();
if (!content) {
  try { fs.unlinkSync(markerPath); } catch {}
  process.exit(0);
}

if (content === "__any__") {
  process.stderr.write(
    `BLOCKED: You have not investigated ${partnerDisplay}'s claims. Before responding to ${partnerDisplay}, you MUST:

1. Read the ACTUAL CODE at every file/line ${partnerDisplay} referenced — use the Read tool
2. Verify each claim against the codebase yourself
3. Form your own opinion based on what the code actually does
4. Only then write your response with evidence (file paths, line numbers, what you found)

Do NOT accept or reject findings based on whether they "sound right."
Do NOT paraphrase ${partnerDisplay}'s claims back as agreement without checking.
Go read the code NOW, then come back and send your message.
`
  );
  process.exit(2);
}

const lines = content.split("\n").filter((l) => l.trim());

process.stderr.write(
  `BLOCKED: You still have ${lines.length} file(s) referenced by ${partnerDisplay} that you haven't read:

${lines.join("\n")}

Read each of these files before responding. ${partnerDisplay} made claims about this code —
verify those claims yourself before agreeing or disagreeing.
`
);
process.exit(2);
