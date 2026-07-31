import fs from "fs";
import path from "path";
import { dialogsDir } from "./platform.mjs";

export const DIALOGS_DIR = dialogsDir();
fs.mkdirSync(DIALOGS_DIR, { recursive: true });

/** Hosts that can drive the MCP tools (the client calling the server). */
export const KNOWN_HOST_AGENTS = ["claude", "codex", "grok"];
/** Partners that can be spawned in tmux by the runner. */
export const KNOWN_PARTNER_AGENTS = ["claude", "codex"];
/** Union used for display/normalization aliases. */
export const KNOWN_AGENTS = ["claude", "codex", "grok"];

const BLOCKING_FINDING_RE =
  /\[(CRITICAL|CORRECTNESS|ARCHITECTURE|SECURITY|ROBUSTNESS|GAP|AMBIGUITY|SCOPE|FEASIBILITY|UX|TESTABILITY)\]/i;
const REVIEW_STATUS_SCHEMA_VERSION = 1;

function canonicalizeAgentName(agent) {
  const raw = String(agent || "")
    .toLowerCase()
    .trim();
  if (raw === "grok-build" || raw === "grok_build" || raw === "grokbuild") {
    return "grok";
  }
  return raw;
}

export function normalizeAgent(agent, fallback = "codex") {
  const name = canonicalizeAgentName(agent);
  return KNOWN_AGENTS.includes(name) ? name : fallback;
}

/** Host agents include Grok Build; unknown values fall back to Claude (legacy default). */
export function normalizeHostAgent(agent, fallback = "claude") {
  const name = canonicalizeAgentName(agent);
  return KNOWN_HOST_AGENTS.includes(name) ? name : fallback;
}

/** Partners are only Claude or Codex CLIs in v1. */
export function normalizePartnerAgent(agent, fallback = "codex") {
  const name = canonicalizeAgentName(agent);
  return KNOWN_PARTNER_AGENTS.includes(name) ? name : fallback;
}

export function getSessionHostAgent(status) {
  return normalizeHostAgent(status?.host_agent, "claude");
}

export function getSessionPartnerAgent(status) {
  return normalizePartnerAgent(status?.partner_agent, "codex");
}

export function getAgentDisplayName(agent) {
  const name = normalizeAgent(agent, "codex");
  if (name === "claude") return "Claude";
  if (name === "grok") return "Grok";
  return "Codex";
}

export function isReviewApprovalDialog(problem) {
  return (
    /^Implementation plan review\b/i.test(problem || "") ||
    /^Feature spec review\b/i.test(problem || "") ||
    /^##\s*Plan Review Request\b/im.test(problem || "") ||
    /^##\s*Spec Review Request\b/im.test(problem || "")
  );
}

function stripMarkdownNoise(content) {
  return String(content || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .filter((line) => !/^(?: {4,}|\t)/.test(line))
    .join("\n");
}

function normalizeStructuredVerdict(raw) {
  const verdict = String(raw || "")
    .trim()
    .replace(/[*`]+/g, "")
    .replace(/[.!?;,]+$/g, "")
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (verdict === "LGTM") {
    return { state: "approved", verdict: "APPROVE", approved: true };
  }
  if (verdict === "APPROVE" || verdict === "APPROVED") {
    return { state: "approved", verdict: "APPROVE", approved: true };
  }
  if (
    [
      "REQUEST_CHANGES",
      "CHANGES_REQUESTED",
      "NEEDS_CHANGES",
      "MAJOR_CONCERNS",
      "BLOCKED",
    ].includes(verdict)
  ) {
    return {
      state: "changes_requested",
      verdict: "CHANGES_REQUESTED",
      approved: false,
    };
  }
  if (verdict === "NEEDS_DISCUSSION") {
    return {
      state: "needs_discussion",
      verdict: "NEEDS_DISCUSSION",
      approved: false,
    };
  }
  if (["IN_PROGRESS", "PENDING"].includes(verdict)) {
    return {
      state: "in_progress",
      verdict: "IN_PROGRESS",
      approved: false,
    };
  }
  return null;
}

function extractStructuredVerdict(content) {
  const searchable = stripMarkdownNoise(content);
  let lastVerdict = null;
  for (const line of searchable.split("\n")) {
    const match = line.match(
      /^\s*(?:[-*#]+\s*)?(?:\*\*|__|\*)?\s*(?:REVIEW[_\s-]?(?:VERDICT|STATUS)|VERDICT|STATUS)(?:\*\*|__|\*)?\s*:\s*(?:\*\*|__|\*)?\s*([A-Z][A-Z_\s-]*)\b/i
    );
    if (!match) continue;
    const normalized = normalizeStructuredVerdict(match[1]);
    if (normalized) {
      lastVerdict = { ...normalized, source: "structured_verdict" };
    }
  }
  return lastVerdict;
}

function hasLegacyApprovalLine(content, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenAtLineStart = new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?(?=$|[\\s.!,:;])`,
    "i"
  );
  return stripMarkdownNoise(content)
    .split("\n")
    .some((line) => tokenAtLineStart.test(line));
}

function hasLegacyApproval(content, allowsApproveVerdict) {
  if (hasLegacyApprovalLine(content, "LGTM")) {
    return { state: "approved", verdict: "APPROVE", approved: true, source: "legacy_lgtm" };
  }
  if (allowsApproveVerdict && hasLegacyApprovalLine(content, "APPROVE")) {
    return {
      state: "approved",
      verdict: "APPROVE",
      approved: true,
      source: "legacy_approve",
    };
  }
  return null;
}

function hasBlockingFindings(content) {
  return stripMarkdownNoise(content)
    .split("\n")
    .some((line) => {
      if (!BLOCKING_FINDING_RE.test(line)) return false;
      const resolvedReference =
        /\b(?:addressed|cleared|fixed|previously raised|remains fixed|resolved|still fixed)\b/i.test(line) &&
        !/\b(?:new issue|not fixed|not resolved|regression|still broken|still failing|unresolved)\b/i.test(line);
      return !resolvedReference;
    });
}

export function extractReviewVerdict(content, options = {}) {
  const allowsApproveVerdict = Boolean(options.allowsApproveVerdict);
  return (
    extractStructuredVerdict(content) ||
    hasLegacyApproval(content, allowsApproveVerdict)
  );
}

function buildReviewStatus({
  state,
  approved,
  closeAllowed,
  closeAllowedReason,
  verdict,
  source,
  sourceMessageId,
  partnerAgent,
  allowsApproveVerdict,
  hardCapReached,
}) {
  return {
    schema_version: REVIEW_STATUS_SCHEMA_VERSION,
    state,
    approved,
    close_allowed: closeAllowed,
    close_allowed_reason: closeAllowedReason,
    verdict,
    source,
    source_message_id: sourceMessageId,
    partner_agent: partnerAgent,
    allows_approve_verdict: allowsApproveVerdict,
    hard_cap_reached: hardCapReached,
  };
}

export function computeReviewStatus(status, messages, options = {}) {
  const partnerAgent = getSessionPartnerAgent(status);
  const problem = options.problem || "";
  const allowsApproveVerdict = isReviewApprovalDialog(problem);
  const maxRounds = status?.max_rounds ?? 5;
  const hardCap = status?.hard_cap ?? maxRounds + 5;
  const partnerMessages = messages.filter((m) => m.from === partnerAgent);
  const hardCapReached = partnerMessages.length >= hardCap;

  let verdictSignal = null;
  for (let i = partnerMessages.length - 1; i >= 0; i--) {
    const msg = partnerMessages[i];
    const verdict = extractStructuredVerdict(msg.content);
    if (verdict) {
      verdictSignal = { ...verdict, sourceMessageId: msg.id };
      break;
    }
  }

  for (let i = partnerMessages.length - 1; i >= 0; i--) {
    const msg = partnerMessages[i];
    const verdict = hasLegacyApproval(msg.content, allowsApproveVerdict);
    if (verdict) {
      if (!verdictSignal || msg.id > verdictSignal.sourceMessageId) {
        verdictSignal = { ...verdict, sourceMessageId: msg.id };
      }
      break;
    }
  }

  for (let i = partnerMessages.length - 1; i >= 0; i--) {
    const msg = partnerMessages[i];
    if (verdictSignal && msg.id < verdictSignal.sourceMessageId) break;
    if (hasBlockingFindings(msg.content)) {
      return buildReviewStatus({
        state: "changes_requested",
        approved: false,
        closeAllowed: hardCapReached,
        closeAllowedReason: hardCapReached ? "hard_cap" : null,
        verdict: "CHANGES_REQUESTED",
        source: "blocking_findings",
        sourceMessageId: msg.id,
        partnerAgent,
        allowsApproveVerdict,
        hardCapReached,
      });
    }
  }

  if (verdictSignal) {
    return buildReviewStatus({
      state: verdictSignal.state,
      approved: verdictSignal.approved,
      closeAllowed: verdictSignal.approved || hardCapReached,
      closeAllowedReason: verdictSignal.approved
        ? "approved"
        : hardCapReached
          ? "hard_cap"
          : null,
      verdict: verdictSignal.verdict,
      source: verdictSignal.source,
      sourceMessageId: verdictSignal.sourceMessageId,
      partnerAgent,
      allowsApproveVerdict,
      hardCapReached,
    });
  }

  return buildReviewStatus({
    state: hardCapReached ? "hard_cap_reached" : "in_progress",
    approved: false,
    closeAllowed: hardCapReached,
    closeAllowedReason: hardCapReached ? "hard_cap" : null,
    verdict: hardCapReached ? "HARD_CAP_REACHED" : null,
    source: hardCapReached ? "hard_cap" : "none",
    sourceMessageId: null,
    partnerAgent,
    allowsApproveVerdict,
    hardCapReached,
  });
}

function resolveConvPath(sessionDir) {
  return sessionDir.includes("conversation.jsonl")
    ? sessionDir
    : path.join(sessionDir, "conversation.jsonl");
}

function isValidMessage(obj) {
  return obj && typeof obj.id === "number" && Number.isSafeInteger(obj.id) && obj.id > 0 && typeof obj.from === "string" && typeof obj.content === "string";
}

export function readConversation(sessionDir) {
  const convPath = resolveConvPath(sessionDir);
  if (!fs.existsSync(convPath)) return [];
  const lines = fs
    .readFileSync(convPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (isValidMessage(obj)) messages.push(obj);
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}

function withConvLock(convPath, fn) {
  const lockPath = convPath + ".lock";
  const STALE_MS = 30000;
  for (let i = 0; i < 200; i++) {
    try {
      fs.mkdirSync(lockPath);
      try {
        return fn();
      } finally {
        try { fs.rmdirSync(lockPath); } catch {}
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Check for stale lock (older than 30s = likely crashed holder)
      if (i > 0 && i % 50 === 0) {
        try {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (age > STALE_MS) {
            try { fs.rmdirSync(lockPath); } catch {}
            continue;
          }
        } catch {}
      }
      const deadline = Date.now() + 10;
      while (Date.now() < deadline) {}
    }
  }
  throw new Error("Failed to acquire conversation lock after retries");
}

export function appendMessage(sessionDir, from, content) {
  const convPath = resolveConvPath(sessionDir);
  return withConvLock(convPath, () => {
    const messages = readConversation(sessionDir);
    const maxId = messages.reduce((max, m) => {
      const n = m?.id;
      return typeof n === "number" && Number.isSafeInteger(n) && n > max ? n : max;
    }, 0);
    const id = maxId + 1;
    const msg = { id, from, content, timestamp: new Date().toISOString() };
    fs.appendFileSync(convPath, JSON.stringify(msg) + "\n");
    return msg;
  });
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readStatus(sessionDir) {
  const statusPath = sessionDir.includes("status.json")
    ? sessionDir
    : path.join(sessionDir, "status.json");
  if (!fs.existsSync(statusPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
