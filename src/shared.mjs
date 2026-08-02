import fs from "fs";
import path from "path";
import { dialogsDir, legacyDialogsDir, resolveExistingSessionDir } from "./platform.mjs";

export const DIALOGS_DIR = dialogsDir();
export const LEGACY_DIALOGS_DIR = legacyDialogsDir();
export { resolveExistingSessionDir };

// Creating the sessions root at import time is deliberate -- everything below
// assumes it exists -- but it must not be able to take down the process before
// any caller's error handling is in place.
//
// Six modules import this at the top of the file, three of them process entry
// points, and the hook scripts import it before their own try/catch exists. An
// unwritable or non-directory HOME therefore surfaced as an unhandled
// module-load exception rather than as the clean exit(0)/exit(2) contract the
// hooks otherwise maintain. (os.homedir() itself is not the hazard: with HOME
// unset it falls back to the passwd entry rather than throwing.)
//
// A failure here is still fatal for anything that needs to WRITE a session, but
// it now fails at the point of use, with context, instead of at import.
try {
  fs.mkdirSync(DIALOGS_DIR, { recursive: true });
} catch {
  // Deliberately swallowed. Readers (hooks inspecting an existing session) can
  // still work; writers will fail on their own operation with a better message
  // than a stack trace from an import side effect.
}
// Agent ids are validated structurally here, not against the adapter registry.
// This file is copied into the user-level hooks directory by the installer and
// must stay dependency-light -- importing the registry would drag zod and the
// whole adapter layer in with it.
//
// The authoritative check lives at the MCP tool boundary, where the parameter
// enum is built from the registry. By the time an id reaches this module it has
// already been validated; all that is needed here is that it round-trips safely
// into the conversation log's `from` field.
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Retained for callers that want the historical pair. */
export const KNOWN_AGENTS = ["claude", "codex"];
const BLOCKING_FINDING_RE =
  /\[(CRITICAL|CORRECTNESS|ARCHITECTURE|SECURITY|ROBUSTNESS|GAP|AMBIGUITY|SCOPE|FEASIBILITY|UX|TESTABILITY)\]/i;
const REVIEW_STATUS_SCHEMA_VERSION = 1;

export function normalizeAgent(agent, fallback = "codex") {
  return typeof agent === "string" && AGENT_ID_PATTERN.test(agent) ? agent : fallback;
}

export function getSessionHostAgent(status) {
  return normalizeAgent(status?.host_agent, "claude");
}

export function getSessionPartnerAgent(status) {
  return normalizeAgent(status?.partner_agent, "codex");
}

/**
 * Human-readable name for an agent id.
 *
 * A fallback only. Callers with registry access should prefer the adapter's own
 * `displayName`, which is the one an adapter author controls (and the only way
 * to get casing like "opencode" rather than "Opencode").
 */
export function getAgentDisplayName(agent) {
  const id = normalizeAgent(agent, "codex");
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

  // A session the partner has never spoken in can always be abandoned.
  //
  // The gate exists to stop a host walking away from findings it does not like.
  // Before the first partner turn there are no findings, so there is nothing to
  // walk away from -- and refusing here strands the caller in a session they
  // just discovered is misconfigured (a dropped model/effort parameter is only
  // visible in the start response, which arrives before any turn). Without this
  // the documented "end it and retry" recovery is impossible to perform, and
  // the only exit is killing the runner from a shell.
  if (partnerMessages.length === 0) {
    return {
      schema_version: REVIEW_STATUS_SCHEMA_VERSION,
      state: "in_progress",
      approved: false,
      close_allowed: true,
      close_allowed_reason: "no_partner_turns",
      verdict: null,
      source: "none",
      source_message_id: null,
      partner_agent: partnerAgent,
      allows_approve_verdict: allowsApproveVerdict,
      hard_cap_reached: hardCapReached,
    };
  }

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

/**
 * The largest single message that may enter the conversation log.
 *
 * The log is append-only and re-read in full by every poll, so an unbounded
 * message is not just one large allocation -- it becomes a permanent cost paid
 * several times a second for the rest of the session. Both producers are
 * capped: the partner through the completion sidecar, and the host through
 * send_message, which otherwise had no ceiling of any kind.
 */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * A whole session's conversation log may not exceed this.
 *
 * The per-entry cap bounds one message; it does NOT bound the file, because
 * nothing limits how many messages a host may append. The round budget counts
 * PARTNER replies, so a host can append indefinitely -- including after the
 * runner has exited and nothing is left to consume them. Since every poll
 * re-reads this file in full, an unbounded log is an unbounded recurring cost,
 * which is the thing the per-message cap was mistaken for fixing.
 */
export const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;

/**
 * The id for the next message, in constant time when the cache can be trusted.
 *
 * Ids are assigned here and only ever appended, so the next one can be
 * remembered rather than recomputed. Two earlier attempts at that were wrong in
 * instructive ways, and the guards below exist because of them:
 *
 *  - Reading the last record off a fixed 64 KiB tail broke as soon as a record
 *    exceeded the window: no parseable line remained in it, so it silently fell
 *    back to scanning the whole log while holding the lock -- losing the
 *    optimization exactly when the log was largest.
 *
 *  - Caching the bare next id was WORSE THAN THE SCAN. The lock serializes
 *    writers but does not make the JSONL append and the cache update one
 *    transaction: a crash between them, or the deliberately swallowed cache
 *    write failure, leaves a stale value that still looks valid. The next append
 *    then reuses a live id, and because both runners advance `lastProcessedId`
 *    to the maximum they have seen and accept only strictly greater ids, the
 *    duplicated message is skipped permanently rather than merely misnumbered.
 *
 * So the cache records the log SIZE it describes. If the file is not exactly
 * that long, the cache does not describe it and is ignored. Interruption at any
 * point leaves a size mismatch, which costs one rebuild scan -- never a
 * duplicate id.
 */
function messageIdCachePath(convPath) {
  return `${convPath}.next-id`;
}

function readMessageIdCache(convPath, currentSize) {
  try {
    const parsed = JSON.parse(fs.readFileSync(messageIdCachePath(convPath), "utf-8"));
    const nextId = parsed?.next_id;
    const bytes = parsed?.bytes;
    if (!Number.isSafeInteger(nextId) || nextId <= 0) return null;
    if (!Number.isSafeInteger(bytes) || bytes !== currentSize) return null;
    return nextId;
  } catch {
    return null;
  }
}

function nextMessageId(sessionDir, convPath, currentSize) {
  // An empty log always restarts at 1, whatever a stale cache claims.
  if (currentSize === 0) return 1;

  const cached = readMessageIdCache(convPath, currentSize);
  if (cached !== null) return cached;

  const messages = readConversation(sessionDir);
  const maxId = messages.reduce((max, m) => {
    const n = m?.id;
    return typeof n === "number" && Number.isSafeInteger(n) && n > max ? n : max;
  }, 0);
  return maxId + 1;
}

export function appendMessage(sessionDir, from, content) {
  const convPath = resolveConvPath(sessionDir);
  const text = String(content ?? "");
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(
      `Message is ${bytes} bytes, past the ${MAX_MESSAGE_BYTES}-byte limit for one conversation entry. ` +
        `The log is re-read in full on every poll, so an oversized entry is a cost paid for the whole session.`
    );
  }

  return withConvLock(convPath, () => {
    // Enforced inside the lock, against the size on disk, so concurrent
    // appenders cannot each observe a log that is under the limit and together
    // push it past.
    let currentSize = 0;
    try {
      currentSize = fs.statSync(convPath).size;
    } catch {
      /* not created yet */
    }
    if (currentSize + bytes > MAX_CONVERSATION_BYTES) {
      throw new Error(
        `This session's conversation log would exceed ${MAX_CONVERSATION_BYTES} bytes ` +
          `(currently ${currentSize}, adding ${bytes}). The log is re-read in full on every ` +
          `poll, so it cannot grow without bound. End this session and start another.`
      );
    }

    const id = nextMessageId(sessionDir, convPath, currentSize);
    const msg = { id, from, content: text, timestamp: new Date().toISOString() };
    const line = JSON.stringify(msg) + "\n";
    fs.appendFileSync(convPath, line);

    try {
      // Stamped with the size this value describes. A crash between the append
      // above and this write, or a failure of this write, leaves the recorded
      // size disagreeing with the file -- which the reader treats as "does not
      // describe this log" and rebuilds from. That is what makes the cache safe
      // to lose rather than a source of duplicate ids.
      fs.writeFileSync(
        messageIdCachePath(convPath),
        JSON.stringify({ next_id: id + 1, bytes: currentSize + Buffer.byteLength(line, "utf-8") })
      );
    } catch {
      // Advisory: a missing or unwritable cache costs one full scan on the next
      // append, never correctness.
    }
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
