#!/usr/bin/env node
// PreToolUse hook for mcp__dualog__send_message.
// Blocks obvious deferrals of locally testable review findings.

import fs from "fs";
import path from "path";
import { dialogSessionDir, readStdin } from "../platform.mjs";

const input = readStdin();
let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.exit(0);
}

const sessionId = payload.tool_input?.session_id;
const outgoing = payload.tool_input?.content;
if (!sessionId || !/^[\w-]+$/.test(sessionId) || typeof outgoing !== "string") {
  process.exit(0);
}

const sessionDir = dialogSessionDir(sessionId);
if (!fs.existsSync(sessionDir)) process.exit(0);

let partnerAgent = "codex";
let partnerDisplay = "Codex";
try {
  const statusPath = path.join(sessionDir, "status.json");
  if (fs.existsSync(statusPath)) {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    if (status?.partner_agent === "claude" || status?.partner_agent === "codex") {
      partnerAgent = status.partner_agent;
      partnerDisplay = partnerAgent === "claude" ? "Claude" : "Codex";
    }
  }
} catch {}

// Skip kickoff messages. The guard is only useful after the partner has raised
// something that the host is now answering.
try {
  const convPath = path.join(sessionDir, "conversation.jsonl");
  const lines = fs.existsSync(convPath)
    ? fs.readFileSync(convPath, "utf-8").trim().split("\n").filter(Boolean)
    : [];
  const hasPartnerMessage = lines.some((line) => {
    try {
      return JSON.parse(line)?.from === partnerAgent;
    } catch {
      return false;
    }
  });
  if (!hasPartnerMessage) process.exit(0);
} catch {
  process.exit(0);
}

const deferralPatterns = [
  {
    label: "verify/check during execution or implementation",
    regex: /\b(?:i\s+will|i['’]ll|will)\s+(?:verify|validate|check|confirm|test)\b.{0,80}\b(?:during|when|while)\s+(?:execution|implementation|implementing)\b/i,
  },
  {
    label: "verify/check later",
    regex: /\b(?:i\s+will|i['’]ll|will)\s+(?:verify|validate|check|confirm|test)\b.{0,80}\b(?:later|afterwards|after implementation)\b/i,
  },
  {
    label: "follow-up task deferral",
    regex: /\b(?:follow[- ]?up task|noted as? (?:a )?follow[- ]?up|added to follow[- ]?up tasks?)\b/i,
  },
  {
    label: "defer until later implementation",
    regex: /\b(?:defer|deferred|deferring)\b.{0,80}\b(?:until|to)\s+(?:implementation|execution|later)\b/i,
  },
  {
    label: "cannot verify until implementation",
    regex: /\b(?:cannot|can't|can’t)\s+(?:confirm|verify|validate|check|test)\b.{0,80}\b(?:until|before)\s+(?:implementation|execution)\b/i,
  },
];

const searchableOutgoing = outgoing
  .replace(/```[\s\S]*?```/g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith(">"))
  .join("\n");

const matched = deferralPatterns.filter((p) => p.regex.test(searchableOutgoing));
if (matched.length === 0) process.exit(0);

const reasonMatch = searchableOutgoing.match(/Cannot resolve now because:\s*(.+)/i);
const reason = reasonMatch?.[1]?.split("\n")[0]?.trim() || "";
const hasSpecificValidReason =
  reason.length >= 12 &&
  !/^(?:later|tbd|todo|n\/a|none|unknown)$/i.test(reason) &&
  !/\b(?:follow[- ]?up|later|during implementation|during execution|when implementing|after implementation)\b/i.test(reason) &&
  !/^(?:because\s+)?(?:i\s+)?(?:don't|dont|do not)\s+(?:feel like it|want to)\b/i.test(reason) &&
  !/^(?:time|not enough time|too much work)$/i.test(reason);

if (hasSpecificValidReason) process.exit(0);

process.stderr.write(
  `BLOCKED: This response appears to defer a testable finding instead of resolving it now.

Matched deferral pattern(s): ${matched.map((p) => p.label).join(", ")}

If ${partnerDisplay}'s finding can be resolved with a local command, grep, SQL query, migration check, CLI command, filesystem inspection, or code search, run that check now and include the result before responding.

If it genuinely cannot be resolved now, include:
Cannot resolve now because: <specific, valid reason>
`
);
process.exit(2);
