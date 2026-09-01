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
export const BLOCKING_FINDING_CATEGORIES = Object.freeze([
  "CRITICAL",
  "CORRECTNESS",
  "ARCHITECTURE",
  "SECURITY",
  "ROBUSTNESS",
  "GAP",
  "AMBIGUITY",
  "SCOPE",
  "FEASIBILITY",
  "UX",
  "TESTABILITY",
]);
export const ADVISORY_FINDING_CATEGORIES = Object.freeze([
  "SUGGESTION",
  "QUESTION",
  "PRAISE",
  "NIT",
]);
export const PR_REVIEW_FINDING_CATEGORIES = Object.freeze([
  ...BLOCKING_FINDING_CATEGORIES,
  ...ADVISORY_FINDING_CATEGORIES,
]);
const BLOCKING_FINDING_RE = new RegExp(
  `\\[(${BLOCKING_FINDING_CATEGORIES.join("|")})\\]`,
  "i"
);
export const PANEL_FINDING_LEDGER_VERSION = 1;
export const FINDING_DISPOSITIONS = Object.freeze([
  "resolved",
  "duplicate",
  "false-positive",
  "pre-existing",
]);
const FINDING_ID_SOURCE = "F-[a-z0-9][a-z0-9-]{0,79}";
const FINDING_ID_RE = new RegExp(`^${FINDING_ID_SOURCE}$`);
const REVIEW_STATUS_SCHEMA_VERSION = 1;
const CONSOLIDATED_PR_REVIEW_HEADER = "## Consolidated PR Review";
const PANEL_PASS_HEADER_RE =
  /^## Panel pass (\d+) of (\d+) — [^\r\n]+ \(aspect: ([a-z][a-z0-9-]*)\)(?:\r?\n|$)/;

export function isBlockingFindingCategory(category) {
  return BLOCKING_FINDING_CATEGORIES.includes(String(category || "").toUpperCase());
}

export function isValidFindingId(id) {
  return FINDING_ID_RE.test(String(id || ""));
}

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

/**
 * The prefix of a line this module will read as a session verdict.
 *
 * Not consumed directly outside this file -- the panel reaches it through
 * matchVerdictLine() below -- but kept as the single definition both halves
 * derive from, because they were written separately once already and diverged.
 * The PR review panel must SUPPRESS exactly the lines
 * this file would ACT on -- suppress fewer and a single specialist can approve a
 * review whose other passes have not run; suppress more and it rewrites the
 * reviewer's own prose. Both happened: a hand-written suppressor missed
 * `## VERDICT: APPROVE` (a heading, which is the shape a model naturally writes
 * under a "Machine-Readable Footer" section) while mangling `**Status:**` inside
 * a report.
 *
 * Keep the two halves derivable from this constant rather than similar to it.
 */
export const VERDICT_LINE_PREFIX_SOURCE =
  "^\\s*(?:[-*#]+\\s*)?(?:\\*\\*|__|\\*)?\\s*(?:REVIEW[_\\s-]?(?:VERDICT|STATUS)|VERDICT|STATUS)(?:\\*\\*|__|\\*)?\\s*:";

/** Blockquoted or indented: content the verdict scan never reads. */
function isNoiseLine(line) {
  return line.trimStart().startsWith(">") || /^(?: {4,}|\t)/.test(line);
}

const NOISE_BLOCKS = [/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g, /<!--[\s\S]*?-->/g];

function redactMarkdownNoise(content) {
  let redacted = String(content || "");
  for (const pattern of NOISE_BLOCKS) {
    redacted = redacted.replace(pattern, (match) => " ".repeat(match.length));
  }
  return redacted;
}

/**
 * Which lines of `content` would the verdict scan actually read?
 *
 * Returns a boolean per line, parallel to `content.split("\n")`. THE one
 * implementation of that question, exported so the PR review panel's suppressor
 * consumes it rather than modelling it a second time.
 *
 * Modelling it twice has now failed twice, the same way both times. The most
 * recent: the suppressor walked lines toggling an `inFence` boolean, so an
 * UNCLOSED fence latched it for the rest of the document and it skipped
 * everything after -- while this scan uses PAIRED, non-greedy regexes, which
 * match nothing when a fence is unclosed and therefore read straight past it.
 * They diverged in the dangerous direction: the gate reading text the suppressor
 * had decided not to look at, so `` ```diff `` left open (a very ordinary model
 * malformation) let a verdict through with `suppressed: 0` logged.
 *
 * Pairing is deliberately preserved here rather than "fixed": an unbalanced
 * fence is now wrong in BOTH halves identically, which is safe, instead of wrong
 * in one, which is not.
 */
export function gateReadableLineMask(content) {
  const text = String(content || "");
  const lines = text.split("\n");

  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  // Patterns are consumed SEQUENTIALLY, each over the previous result, because
  // that is what stripMarkdownNoise does -- and applying them independently over
  // the original text is not the same thing when marker types interleave.
  //
  // A fuzz over 300,000 generated reports found 519 documents where they differ,
  // reduced to: a `<!--` on line 0, a verdict on line 1, then two ```js lines
  // whose pairing consumes the `-->` between them. Sequentially, the fences go
  // first and eat the comment's terminator, leaving `<!--` unpaired so the gate
  // reads the verdict. Independently, both a comment span and a fence span
  // exist, the verdict line is blocked, and the suppressor never looks at it.
  // That is not exotic: the `comments` specialist's literal job is writing about
  // comment syntax while also quoting fenced snippets.
  //
  // Redaction is length-preserving rather than deleting, so offsets stay valid
  // AND a consumed span cannot participate in a later pattern's match -- which
  // is precisely what sequential excision does.
  // Redacted to spaces rather than to a magic character, which is safe because
  // the only question asked of the result is "did any NON-SPACE character of
  // this line survive". A verdict always contains non-space characters, so a
  // line whose surviving remnant is whitespace cannot carry one, and treating
  // it as blocked costs nothing.
  const redacted = redactMarkdownNoise(text);

  // A line is blocked only when NO character of it survived redaction --
  // equivalently, wholly inside the consumed regions rather than merely
  // overlapping them.
  //
  // stripMarkdownNoise excises a span and keeps scanning what remains of the
  // line, so if any character survives the gate may read that part, and a
  // consumer of this mask must therefore examine the line. An earlier version
  // blocked on partial overlap and broke exactly that, in the direction that
  // matters: a finding line containing an inline ``` paired with a later fence,
  // the span covered the line's tail, and the whole line vanished -- so
  // `[CRITICAL] ... an unclosed ``` ...` stopped being a blocking finding and
  // the review flipped to approved, for every session type.
  //
  // The guarantee is LINE-granular and cannot be more than that: excision can
  // splice the head of one line onto the tail of another, and can repair a token
  // from the inside (`VERDICT<!-- x -->: APPROVE`). suppressVerdictLines covers
  // both by checking its postcondition against the gate rather than trusting
  // this mask alone.
  const blocked = lines.map((line, i) => {
    if (line.length === 0) return false;
    const slice = redacted.slice(starts[i], starts[i] + line.length);
    return !/\S/.test(slice);
  });

  return lines.map((line, i) => !blocked[i] && !isNoiseLine(line));
}

/**
 * Which complete lines are safe to treat as machine authorization records.
 * Unlike gateReadableLineMask, a line is rejected when any non-space byte was
 * consumed by a fence/comment. That prevents a protocol prefix inside a fence
 * from becoming actionable merely because unrelated trailing text survives on
 * the same line.
 */
export function protocolReadableLineMask(content) {
  const text = String(content || "");
  const lines = text.split("\n");
  const redacted = redactMarkdownNoise(text);
  const result = [];
  let offset = 0;
  for (const line of lines) {
    const slice = redacted.slice(offset, offset + line.length);
    // Both strings are indexed in UTF-16 code units. Iterating `line` with
    // `[...line]` uses Unicode code points instead and shifts every comparison
    // after an astral character, allowing a harmless emoji to hide a protocol
    // line from the strict source mask.
    let whollyReadable = true;
    for (let index = 0; index < line.length; index++) {
      if (!/\s/.test(line[index]) && slice[index] !== line[index]) {
        whollyReadable = false;
        break;
      }
    }
    result.push(whollyReadable && !isNoiseLine(line));
    offset += line.length + 1;
  }
  return result;
}

/**
 * Return the line indexes belonging to the authoritative normalized-findings
 * protocol block.
 *
 * This selection is shared with the runner-facing parser. Approval enforcement
 * must not decide that a different fenced/example block is authoritative from
 * the one the runner numbered and persisted.
 */
export function normalizedFindingsLineIndexes(
  content,
  { allProtocolBlocks = false } = {}
) {
  const lines = String(content || "").split("\n");
  const readable = protocolReadableLineMask(content || "");
  const lineOffsets = [];
  let lineOffset = 0;
  for (const line of lines) {
    lineOffsets.push(lineOffset);
    lineOffset += line.length + 1;
  }
  const spansFor = (patterns) =>
    patterns.flatMap((pattern) =>
      [...String(content || "").matchAll(pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      }))
    );
  const codeSpans = spansFor([/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g]);
  const commentSpans = spansFor([/<!--[\s\S]*?-->/g]);
  const containingSpan = (offset, spans) =>
    spans.find((span) => offset >= span.start && offset < span.end) ?? null;
  const headingRe = /^ {0,3}(#{1,6})\s+Normalized Findings(?:\s+\(REQUIRED\))?\s*$/i;
  const headingCandidates = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(headingRe);
    if (match) {
      const offset = lineOffsets[index];
      const codeSpan = containingSpan(offset, codeSpans);
      const commentSpan = containingSpan(offset, commentSpans);
      headingCandidates.push({
        index,
        level: match[1].length,
        readable: readable[index],
        code_span: codeSpan && !commentSpan ? codeSpan : null,
      });
    }
  }

  const readableHeading = headingCandidates
    .filter((candidate) => candidate.readable)
    .at(-1);
  const fencedHeading =
    !readableHeading &&
    headingCandidates.length === 1 &&
    headingCandidates[0].code_span &&
    lines.some(
      (line, index) =>
        index > headingCandidates[0].index &&
        readable[index] &&
        /^(?:ASPECT_RESULT|REVIEW_VERDICT)\s*:/i.test(line.trim())
    )
      ? headingCandidates[0]
      : null;
  const selectedHeading = readableHeading ?? fencedHeading;
  const selectedHeadings = allProtocolBlocks
    ? headingCandidates.filter((candidate) => candidate.readable || candidate.code_span)
    : selectedHeading
      ? [selectedHeading]
      : [];
  const indexes = [];
  for (const heading of selectedHeadings) {
    for (let index = heading.index + 1; index < lines.length; index++) {
      const nextHeading = lines[index].match(/^ {0,3}(#{1,6})\s+/);
      if (nextHeading && nextHeading[1].length <= heading.level) break;
      const offset = lineOffsets[index];
      const allowed = heading.readable
        ? readable[index]
        : heading.code_span &&
          offset >= heading.code_span.start &&
          offset < heading.code_span.end;
      if (!allowed) continue;
      indexes.push(index);
    }
  }

  return [...new Set(indexes)];
}

/**
 * Behaviour left exactly as it was, deliberately. (The two chained noise filters
 * are now one call to isNoiseLine, which the mask also uses; `!(A || B)` is the
 * chained `!A` then `!B`, so the predicate is unchanged.)
 *
 * The suppressor needed to stop modelling markdown noise for itself; the GATE
 * did not need to change, and rewriting it on top of the mask is what produced
 * the regression described above. Excision semantics -- remove the span, keep
 * the rest of the line -- are preserved here, and gateReadableLineMask is only
 * ever a conservative "could the gate read any of this line".
 */
function stripMarkdownNoise(content) {
  return String(content || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !isNoiseLine(line))
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

const VERDICT_LINE_RE = new RegExp(
  `${VERDICT_LINE_PREFIX_SOURCE}\\s*(?:\\*\\*|__|\\*)?\\s*([A-Z][A-Z_\\s-]*)\\b`,
  "i"
);

/**
 * Would this ONE line be read as a session verdict?
 *
 * The decision function, exported so the PR review panel's suppressor asks the
 * same question rather than approximating it. Approximating it failed in both
 * directions -- the prefix alone matched `**Status:** the error path is fine`,
 * which this rejects because nothing verdict-shaped follows the colon, while a
 * hand-written pattern missed `## VERDICT: APPROVE` entirely.
 *
 * Returns { match, normalized } or null. `match.index` and `match[0]` let a
 * caller rewrite exactly the matched span and keep the rest of the line.
 */
export function matchVerdictLine(line) {
  const match = String(line ?? "").match(VERDICT_LINE_RE);
  if (!match) return null;
  const normalized = normalizeStructuredVerdict(match[1]);
  return normalized ? { match, normalized } : null;
}

function extractStructuredVerdict(content) {
  const searchable = stripMarkdownNoise(content);
  let lastVerdict = null;
  for (const line of searchable.split("\n")) {
    const hit = matchVerdictLine(line);
    if (hit) {
      lastVerdict = { ...hit.normalized, source: "structured_verdict" };
    }
  }
  return lastVerdict;
}

/**
 * Would this ONE line be read as a bare legacy approval token?
 *
 * Exported for the same reason as matchVerdictLine: the panel's suppressor has
 * to neutralize every signal this file acts on, and a bare `LGTM` approves a
 * session on its own, with no verdict footer anywhere.
 */
export function matchLegacyApprovalLine(line, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenAtLineStart = new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?(?=$|[\\s.!,:;])`,
    "i"
  );
  return String(line ?? "").match(tokenAtLineStart);
}

function hasLegacyApprovalLine(content, token) {
  return stripMarkdownNoise(content)
    .split("\n")
    .some((line) => matchLegacyApprovalLine(line, token));
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

function isUnresolvedBlockingFindingLine(line) {
  if (!BLOCKING_FINDING_RE.test(line)) return false;
  const resolvedReference =
    /\b(?:addressed|cleared|fixed|previously raised|remains fixed|resolved|still fixed)\b/i.test(line) &&
    !/\b(?:new issue|not fixed|not resolved|regression|still broken|still failing|unresolved)\b/i.test(line);
  return !resolvedReference;
}

function isExplicitlyResolvedPanelFindingLine(line) {
  // Resolution prose is only nonblocking when it does not contradict itself.
  // Models sometimes lead with the subject adjective ("Resolved path
  // handling") or start a stale resolution summary and then explicitly say
  // the issue is still broken. The broad before-category matcher below must
  // not let that wording erase a real, gate-readable finding.
  const contradictionSeparator = "[\\s,:;—–-]+";
  const unresolvedContradiction = new RegExp(
    `\\b(?:new${contradictionSeparator}issue|` +
      `not${contradictionSeparator}(?:addressed|cleared|fixed|resolved)|` +
      `still${contradictionSeparator}(?:broken|failing|unresolved|vulnerable)|` +
      `remains${contradictionSeparator}(?:broken|failing|unresolved|vulnerable)|` +
      `continues?${contradictionSeparator}to${contradictionSeparator}fail|` +
      "regression|unresolved)\\b",
    "i"
  );
  if (unresolvedContradiction.test(line)) return false;

  const categorySource = `\\[(?:${BLOCKING_FINDING_CATEGORIES.join("|")})\\]`;
  const resolutionWord = "(?:addressed|cleared|fixed|resolved)";
  const beforeCategory = new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:${resolutionWord}|previously raised|remains fixed|still fixed)(?:\\s*[:—-])?\\s+${categorySource}`,
    "i"
  );
  const afterCategory = new RegExp(
    `${categorySource}\\s*(?:[:—-]\\s*)?(?:(?:${resolutionWord})(?=\\s+(?:in|by|with|via|after|at)\\b|\\s*[.!;:]?\\s*$)|previously raised\\b|remains fixed\\b|still fixed\\b)`,
    "i"
  );
  return beforeCategory.test(line) || afterCategory.test(line);
}

function isUnresolvedPanelBlockingFindingLine(line) {
  if (!BLOCKING_FINDING_RE.test(line)) return false;
  return !isExplicitlyResolvedPanelFindingLine(line);
}

/**
 * The exact blocking lines the verdict gate acts on, exposed so the panel
 * runner can durably ledger even a specialist that violates the normalized
 * output contract and puts a category only in human prose.
 */
export function extractGateBlockingFindings(content) {
  return stripMarkdownNoise(content)
    .split("\n")
    .filter((line) => {
      if (/^\s*FINDING_DISPOSITION\s*:/i.test(line)) return false;
      const leadingCategory = line.match(NORMALIZED_PROTOCOL_FINDING_RE)?.[1];
      if (PR_REVIEW_FINDING_CATEGORIES.includes(String(leadingCategory).toUpperCase())) {
        // A valid leading normalized category owns the line. Advisory text may
        // legitimately quote a blocking taxonomy token without manufacturing
        // a second, unindexed blocking finding.
        return isBlockingFindingCategory(leadingCategory);
      }
      return isUnresolvedPanelBlockingFindingLine(line);
    })
    .map((line) => {
      const leadingCategory = line.match(NORMALIZED_PROTOCOL_FINDING_RE)?.[1];
      const category = isBlockingFindingCategory(leadingCategory)
        ? leadingCategory.toUpperCase()
        : line.match(BLOCKING_FINDING_RE)?.[1]?.toUpperCase() ?? null;
      return { category, text: line.trim(), line: line.trim() };
    });
}

const NORMALIZED_PROTOCOL_FINDING_RE =
  /^\s*(?:[-*+]\s+|\d+[.)]\s+)?\**\[([A-Z][A-Z-]*)\]\**\s*(.*)$/i;
const NORMALIZED_PROTOCOL_ID_RE =
  /^\[FINDING_ID:\s*([^\]]+)\]\s*(.*)$/i;

/** Authorization-bearing protocol text must not depend on how an unmatched
 * markdown delimiter happens to be interpreted. */
export function hasBalancedProtocolNoise(content) {
  const text = String(content || "");
  for (const delimiter of ["```", "~~~"]) {
    let count = 0;
    let offset = 0;
    while ((offset = text.indexOf(delimiter, offset)) !== -1) {
      count++;
      offset += delimiter.length;
    }
    if (count % 2 !== 0) return false;
  }

  let commentDepth = 0;
  const commentTokens = text.match(/<!--|-->/g) ?? [];
  for (const token of commentTokens) {
    if (token === "<!--") commentDepth++;
    else if (commentDepth === 0) return false;
    else commentDepth--;
  }
  return commentDepth === 0;
}

/**
 * Parse the exact normalized-findings protocol section without trusting the
 * mutable panel sidecar. Invalid categories and malformed runner IDs are kept
 * as evidence rather than silently becoming an empty findings block.
 */
function parseNormalizedFindingProtocol(content) {
  const text = String(content || "");
  const lines = text.split("\n");
  const strictReadable = protocolReadableLineMask(text);
  const headingRe = /^ {0,3}#{1,6}\s+Normalized Findings(?:\s+\(REQUIRED\))?\s*$/i;
  const headingCount = lines.filter((line) => headingRe.test(line)).length;
  const selectedIndexes = normalizedFindingsLineIndexes(text);
  const allIndexes = normalizedFindingsLineIndexes(text, {
    allProtocolBlocks: true,
  });
  const selectedSet = new Set(selectedIndexes);
  const errors = [];

  const parseIndexes = (indexes, authoritative) => {
    const records = [];
    for (const lineIndex of indexes) {
      const line = lines[lineIndex] ?? "";
      const match = line.match(NORMALIZED_PROTOCOL_FINDING_RE);
      if (!match) {
        const trimmed = line.trim();
        const noneLine = /^\(?none\)?\.?$/i.test(trimmed);
        const controlLine =
          /^(?:FINDING_DISPOSITION|REVIEW_VERDICT|REFERENCED_FILES|ASPECT_RESULT|ASPECT)\s*:/i.test(
            trimmed
          );
        const acceptedFenceDelimiter =
          !strictReadable[lineIndex] && /^(?:```|~~~)\s*$/.test(trimmed);
        if (!controlLine && /\[FINDING_ID\s*:/i.test(line)) {
          errors.push({
            line: lineIndex + 1,
            reason: "finding_id_outside_normalized_record",
            text: line.trim(),
            authoritative,
          });
        } else if (
          authoritative &&
          trimmed &&
          !noneLine &&
          !controlLine &&
          !acceptedFenceDelimiter
        ) {
          // The final machine-readable section is a closed grammar. Treat a
          // mistyped category (`[CRITICAL ]`, `[ CRITICAL]`) or free-form text
          // below the heading as an invalid protocol record, never as `(none)`.
          errors.push({
            line: lineIndex + 1,
            reason: "malformed_normalized_protocol_line",
            text: trimmed,
            authoritative,
          });
        }
        continue;
      }

      const category = match[1].toUpperCase();
      let findingText = match[2].trim();
      let id = null;
      let idTagPresent = false;
      if (/^\[FINDING_ID\s*:/i.test(findingText)) {
        idTagPresent = true;
        const idMatch = findingText.match(NORMALIZED_PROTOCOL_ID_RE);
        if (!idMatch || !isValidFindingId(idMatch[1])) {
          errors.push({
            line: lineIndex + 1,
            reason: "invalid_finding_id",
            text: line.trim(),
            authoritative,
          });
          findingText = idMatch?.[2]?.trim() ?? findingText;
        } else {
          id = idMatch[1];
          findingText = idMatch[2].trim();
        }
      } else if (/\[FINDING_ID\s*:/i.test(findingText)) {
        errors.push({
          line: lineIndex + 1,
          reason: "finding_id_not_after_category",
          text: line.trim(),
          authoritative,
        });
      }
      const validCategory = PR_REVIEW_FINDING_CATEGORIES.includes(category);
      if (!validCategory) {
        errors.push({
          line: lineIndex + 1,
          reason: "unsupported_finding_category",
          category,
          text: line.trim(),
          authoritative,
        });
      }
      if (!findingText) {
        errors.push({
          line: lineIndex + 1,
          reason: "missing_finding_text",
          category,
          text: line.trim(),
          authoritative,
        });
      }
      records.push({
        id,
        id_tag_present: idTagPresent,
        category,
        text: findingText,
        line: line.trim(),
        line_index: lineIndex,
        valid_category: validCategory,
        authoritative,
      });
    }
    return records;
  };

  const records = parseIndexes(selectedIndexes, true);
  const nonAuthoritativeRecords = parseIndexes(
    allIndexes.filter((index) => !selectedSet.has(index)),
    false
  );
  for (const record of nonAuthoritativeRecords) {
    if (isBlockingFindingCategory(record.category) || !record.valid_category) {
      errors.push({
        line: record.line_index + 1,
        reason: "finding_in_non_authoritative_normalized_block",
        category: record.category,
        text: record.line,
        authoritative: false,
      });
    }
  }

  const noneCount = selectedIndexes.filter((index) =>
    /^\s*\(?none\)?\.?\s*$/i.test(lines[index] ?? "")
  ).length;
  if (noneCount > 0 && records.length > 0) {
    errors.push({ reason: "none_with_findings", authoritative: true });
  }

  const normalizedBlockingCounts = new Map();
  for (const record of records) {
    if (!record.valid_category || !isBlockingFindingCategory(record.category)) continue;
    normalizedBlockingCounts.set(
      record.line,
      (normalizedBlockingCounts.get(record.line) ?? 0) + 1
    );
  }
  const gateUnindexed = [];
  for (const finding of extractGateBlockingFindings(text)) {
    const count = normalizedBlockingCounts.get(finding.line) ?? 0;
    if (count > 0) normalizedBlockingCounts.set(finding.line, count - 1);
    else gateUnindexed.push(finding);
  }

  return {
    available: selectedIndexes.length > 0,
    heading_count: headingCount,
    records,
    valid_records: records.filter(
      (record) => record.valid_category && record.text
    ),
    non_authoritative_records: nonAuthoritativeRecords,
    gate_unindexed: gateUnindexed,
    selected_line_indexes: selectedIndexes,
    none_count: noneCount,
    errors,
  };
}

function hasBlockingFindings(content) {
  return stripMarkdownNoise(content)
    .split("\n")
    .some(isUnresolvedBlockingFindingLine);
}

function hasPanelBlockingFindings(content) {
  return stripMarkdownNoise(content)
    .split("\n")
    .filter((line) => !/^\s*FINDING_DISPOSITION\s*:/i.test(line))
    .some((line) => {
      const leadingCategory = line.match(NORMALIZED_PROTOCOL_FINDING_RE)?.[1];
      if (PR_REVIEW_FINDING_CATEGORIES.includes(String(leadingCategory).toUpperCase())) {
        return isBlockingFindingCategory(leadingCategory);
      }
      return isUnresolvedPanelBlockingFindingLine(line);
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

/**
 * Read the explicit close-out records carried by an approval-bearing panel turn.
 *
 * These lines are intentionally stricter than the human-facing finding parser.
 * A disposition is authorization to stop blocking on a durable finding, so it
 * must be a plain, gate-readable protocol line rather than text quoted from a
 * prompt, hidden in a fence, or repaired by stripping an HTML comment.
 */
export function parseFindingDispositions(content) {
  const lines = String(content || "").split("\n");
  const gateReadable = gateReadableLineMask(content || "");
  const readable = protocolReadableLineMask(content || "");
  const dispositionRe = new RegExp(
    `^FINDING_DISPOSITION:\\s*(${FINDING_ID_SOURCE})\\s*\\|\\s*([a-z-]+)\\s*\\|\\s*(\\S(?:.*\\S)?)\\s*$`,
    "i"
  );
  const dispositions = [];
  const invalidLines = [];
  const seen = new Set();

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!gateReadable[index]) continue;
    if (!/^FINDING_DISPOSITION\s*:/i.test(trimmed)) continue;

    if (!readable[index]) {
      invalidLines.push({
        line: index + 1,
        reason: "protocol_line_partially_hidden",
        text: trimmed,
      });
      continue;
    }

    if (stripMarkdownNoise(trimmed) !== trimmed) {
      invalidLines.push({
        line: index + 1,
        reason: "markdown_noise_not_allowed",
        text: trimmed,
      });
      continue;
    }

    const match = trimmed.match(dispositionRe);
    if (!match) {
      invalidLines.push({ line: index + 1, reason: "malformed", text: trimmed });
      continue;
    }

    const id = match[1];
    const disposition = match[2].toLowerCase();
    const rationale = match[3].trim();
    if (!FINDING_DISPOSITIONS.includes(disposition)) {
      invalidLines.push({
        line: index + 1,
        id,
        reason: "unsupported_disposition",
        text: trimmed,
      });
      continue;
    }
    if (seen.has(id)) {
      invalidLines.push({ line: index + 1, id, reason: "duplicate_disposition", text: trimmed });
      continue;
    }

    let duplicateOf = null;
    if (disposition === "duplicate") {
      const duplicateMatch = rationale.match(
        new RegExp(`^duplicate-of=(${FINDING_ID_SOURCE})\\s*;\\s*(\\S(?:.*\\S)?)$`, "i")
      );
      if (!duplicateMatch) {
        invalidLines.push({
          line: index + 1,
          id,
          reason: "duplicate_target_or_rationale_missing",
          text: trimmed,
        });
        continue;
      }
      duplicateOf = duplicateMatch[1];
    }

    seen.add(id);
    dispositions.push({
      id,
      disposition,
      rationale,
      duplicate_of: duplicateOf,
      line: index + 1,
    });
  }

  return { dispositions, invalid_lines: invalidLines };
}

function evaluatePanelApprovalSource(content, reviewStatus, ledgerIds) {
  const text = String(content || "");
  const effectiveText = stripMarkdownNoise(text);
  const lines = text.split("\n");
  const strictReadable = protocolReadableLineMask(text);
  const exactApprovals = [];
  const approvalSignals = [];
  for (const [index, line] of lines.entries()) {
    if (!strictReadable[index]) continue;
    if (/^REVIEW_VERDICT:\s*APPROVE\s*$/i.test(line)) exactApprovals.push(index + 1);
  }
  // Count the same effective verdict sources computeReviewStatus can act on.
  // In particular, paired HTML comments can splice `VERD<!-- -->ICT` or
  // `LG<!-- -->TM` into a real signal after markdown-noise excision. Such a
  // signal is not canonical authorization, but it must still make an otherwise
  // canonical approval ambiguous.
  for (const [index, line] of effectiveText.split("\n").entries()) {
    if (
      matchVerdictLine(line) ||
      matchLegacyApprovalLine(line, "LGTM") ||
      matchLegacyApprovalLine(line, "APPROVE")
    ) {
      approvalSignals.push(index + 1);
    }
  }

  const normalized = parseNormalizedFindingProtocol(text);
  const effectiveNormalized = parseNormalizedFindingProtocol(effectiveText);
  const parsedDispositions = parseFindingDispositions(text);
  const errors = [];
  if (!hasBalancedProtocolNoise(text)) {
    errors.push({ reason: "unbalanced_markdown_noise" });
  }
  if (reviewStatus.source !== "structured_verdict") {
    errors.push({ reason: "legacy_or_noncanonical_approval_source" });
  }
  if (exactApprovals.length !== 1 || approvalSignals.length !== 1) {
    errors.push({
      reason: "approval_verdict_count_or_shape_invalid",
      exact_approval_lines: exactApprovals,
      signal_lines: approvalSignals,
    });
  }
  if (!normalized.available || normalized.heading_count !== 1) {
    errors.push({
      reason: "normalized_findings_heading_count_invalid",
      heading_count: normalized.heading_count,
    });
  }
  if (normalized.valid_records.length === 0 && normalized.none_count !== 1) {
    errors.push({ reason: "normalized_findings_payload_missing" });
  }
  for (const record of normalized.valid_records) {
    if (!record.id) {
      errors.push({
        line: record.line_index + 1,
        reason: "normalized_finding_missing_id",
        category: record.category,
      });
    }
  }
  errors.push(...normalized.errors);

  const acceptedFencedProtocolBlock =
    normalized.available &&
    normalized.selected_line_indexes.length > 0 &&
    normalized.selected_line_indexes.every((index) => !strictReadable[index]);
  if (acceptedFencedProtocolBlock) {
    // The effective source removes the one accepted fence entirely. Any
    // normalized heading that remains was reconstructed somewhere outside the
    // selected block (for example `Normalized <!-- -->Findings`) and creates a
    // second machine-readable protocol source.
    if (
      effectiveNormalized.available ||
      effectiveNormalized.heading_count !== 0 ||
      effectiveNormalized.records.length !== 0 ||
      effectiveNormalized.none_count !== 0 ||
      effectiveNormalized.errors.length !== 0
    ) {
      errors.push({
        reason: "normalized_protocol_outside_accepted_fence",
        effective_heading_count: effectiveNormalized.heading_count,
      });
    }
  } else {
    if (
      effectiveNormalized.available !== normalized.available ||
      effectiveNormalized.heading_count !== normalized.heading_count ||
      effectiveNormalized.none_count !== normalized.none_count
    ) {
      errors.push({
        reason: "normalized_protocol_shape_changed_by_markdown_noise",
        raw_heading_count: normalized.heading_count,
        effective_heading_count: effectiveNormalized.heading_count,
        raw_none_count: normalized.none_count,
        effective_none_count: effectiveNormalized.none_count,
      });
    }
    const protocolFingerprint = (record) =>
      JSON.stringify({
        id: record.id,
        category: record.category,
        text: record.text,
        line: record.line,
        valid_category: record.valid_category,
      });
    const rawRecords = new Set(normalized.records.map(protocolFingerprint));
    for (const record of effectiveNormalized.records) {
      if (!rawRecords.has(protocolFingerprint(record))) {
        errors.push({
          line: record.line_index + 1,
          reason: "normalized_protocol_changed_by_markdown_noise",
          text: record.line,
        });
      }
    }
    for (const error of effectiveNormalized.errors) {
      if (
        !normalized.errors.some(
          (rawError) =>
            rawError.reason === error.reason && rawError.text === error.text
        )
      ) {
        errors.push({
          ...error,
          reason: `markdown_noise_${error.reason}`,
        });
      }
    }
  }

  const normalizedRecordByLine = new Map(
    normalized.records.map((record) => [record.line_index, record])
  );
  const dispositionLines = new Set(
    parsedDispositions.dispositions.map((disposition) => disposition.line - 1)
  );
  const selectedLines = new Set(normalized.selected_line_indexes);
  for (const [index, line] of lines.entries()) {
    if (!strictReadable[index] && !selectedLines.has(index)) continue;
    if (dispositionLines.has(index)) continue;
    const record = normalizedRecordByLine.get(index);
    for (const id of ledgerIds) {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const occurrences = [...line.matchAll(new RegExp(`(^|[^A-Za-z0-9-])(${escaped})(?![A-Za-z0-9-])`, "g"))];
      if (occurrences.length === 0) continue;
      const allowedOccurrences = record?.id === id ? 1 : 0;
      if (occurrences.length > allowedOccurrences) {
        errors.push({
          line: index + 1,
          id,
          reason: "known_finding_id_outside_protocol_record",
        });
      }
    }
  }

  // Cross-check known IDs against the exact text after the same markdown-noise
  // excision used by computeReviewStatus. Raw partially-hidden lines are not
  // valid records, so any ID they reconstruct is an unauthorized extra.
  for (const id of ledgerIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const idRe = new RegExp(
      `(^|[^A-Za-z0-9-])(${escaped})(?![A-Za-z0-9-])`,
      "g"
    );
    const effectiveCount = effectiveText
      .split("\n")
      .reduce((count, line) => count + [...line.matchAll(idRe)].length, 0);
    let authorizedCount = normalized.records.filter(
      (record) => record.id === id && strictReadable[record.line_index]
    ).length;
    for (const disposition of parsedDispositions.dispositions) {
      const line = lines[disposition.line - 1] ?? "";
      authorizedCount += [...line.matchAll(idRe)].length;
    }
    if (effectiveCount > authorizedCount) {
      errors.push({
        id,
        reason: "known_finding_id_reconstructed_by_markdown_noise",
        effective_count: effectiveCount,
        authorized_count: authorizedCount,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    exact_approval_lines: exactApprovals,
    approval_signal_lines: approvalSignals,
    normalized,
  };
}

function evaluateFindingContract(reviewStatus, partnerMessages, panelState) {
  const ledgerAvailable =
    panelState?.finding_ledger_version === PANEL_FINDING_LEDGER_VERSION &&
    Array.isArray(panelState?.findings) &&
    Array.isArray(panelState?.finding_occurrences) &&
    Array.isArray(panelState?.finding_protocol_ambiguities);
  const ledger = ledgerAvailable ? panelState.findings : [];
  const occurrences = ledgerAvailable ? panelState.finding_occurrences : [];
  const protocolAmbiguities = ledgerAvailable
    ? panelState.finding_protocol_ambiguities
    : [];
  const ledgerIds = new Set();
  const invalidLedgerEntries = [];
  const messageById = new Map(partnerMessages.map((message) => [message.id, message]));
  const completed = Array.isArray(panelState?.completed) ? panelState.completed : [];
  const roleForMessage = (messageId) => {
    const completion = completed.find((entry) => entry?.message_id === messageId);
    if (completion?.aspect === "__aggregate__") {
      return { phase: "consolidation", aspect: "__aggregate__" };
    }
    if (completion?.aspect && !String(completion.aspect).startsWith("__")) {
      return { phase: "specialist", aspect: completion.aspect };
    }
    return { phase: "follow_up", aspect: "__followup__" };
  };

  for (const [index, finding] of ledger.entries()) {
    const id = finding?.id;
    if (!isValidFindingId(id)) {
      invalidLedgerEntries.push({ index, id: id ?? null, reason: "invalid_id" });
      continue;
    }
    if (ledgerIds.has(id)) {
      invalidLedgerEntries.push({ index, id, reason: "duplicate_id" });
      continue;
    }
    ledgerIds.add(id);
    if (!isBlockingFindingCategory(finding?.category)) {
      invalidLedgerEntries.push({ index, id, reason: "nonblocking_or_invalid_category" });
    }
    if (typeof finding?.text !== "string" || !finding.text.trim()) {
      invalidLedgerEntries.push({ index, id, reason: "missing_text" });
    }
    if (
      !Number.isSafeInteger(finding?.origin_message_id) ||
      !messageById.has(finding.origin_message_id)
    ) {
      invalidLedgerEntries.push({ index, id, reason: "invalid_origin_message" });
    }
    const originRole = roleForMessage(finding?.origin_message_id);
    if (
      finding?.origin_phase !== originRole.phase ||
      finding?.aspect !== originRole.aspect ||
      !["normalized", "gate_readable_unindexed"].includes(finding?.source_kind)
    ) {
      invalidLedgerEntries.push({ index, id, reason: "invalid_origin_provenance" });
    }
  }
  const ledgerById = new Map(ledger.map((finding) => [finding.id, finding]));
  const occurrenceKeys = new Set();

  for (const [index, occurrence] of occurrences.entries()) {
    const key = `${occurrence?.finding_id ?? ""}:${occurrence?.message_id ?? ""}`;
    if (occurrenceKeys.has(key)) {
      invalidLedgerEntries.push({
        index,
        id: occurrence?.finding_id ?? null,
        reason: "duplicate_occurrence",
      });
    }
    occurrenceKeys.add(key);
    if (
      !isValidFindingId(occurrence?.finding_id) ||
      !Number.isSafeInteger(occurrence?.message_id) ||
      occurrence.message_id <= 0 ||
      typeof occurrence?.text !== "string" ||
      !occurrence.text.trim()
    ) {
      invalidLedgerEntries.push({
        index,
        id: occurrence?.finding_id ?? null,
        reason: "invalid_occurrence",
      });
      continue;
    }
    if (!messageById.has(occurrence.message_id)) {
      invalidLedgerEntries.push({
        index,
        id: occurrence.finding_id,
        reason: "occurrence_message_missing",
      });
    }
    const occurrenceRole = roleForMessage(occurrence.message_id);
    if (
      occurrence.phase !== occurrenceRole.phase ||
      !["normalized", "gate_readable_unindexed"].includes(occurrence.source_kind)
    ) {
      invalidLedgerEntries.push({
        index,
        id: occurrence.finding_id,
        reason: "invalid_occurrence_provenance",
      });
    }
    if (!ledgerIds.has(occurrence.finding_id)) {
      invalidLedgerEntries.push({
        index,
        id: occurrence.finding_id,
        reason: "occurrence_for_unknown_finding",
      });
    } else if (
      !isBlockingFindingCategory(occurrence.category) ||
      String(ledgerById.get(occurrence.finding_id)?.category).toUpperCase() !==
        String(occurrence.category).toUpperCase()
    ) {
      invalidLedgerEntries.push({
        index,
        id: occurrence.finding_id,
        reason: "occurrence_category_mismatch",
      });
    }
  }

  for (const [index, finding] of ledger.entries()) {
    if (!isValidFindingId(finding?.id)) continue;
    const findingOccurrences = occurrences
      .filter((occurrence) => occurrence.finding_id === finding.id)
      .sort((left, right) => left.message_id - right.message_id);
    if (
      !findingOccurrences.some(
        (occurrence) =>
          occurrence.message_id === finding.origin_message_id
      )
    ) {
      invalidLedgerEntries.push({
        index,
        id: finding.id,
        reason: "origin_occurrence_missing",
      });
    }
    const earliest = findingOccurrences[0] ?? null;
    if (
      earliest &&
      (finding.origin_message_id !== earliest.message_id ||
        finding.text !== earliest.text ||
        finding.source_kind !== earliest.source_kind)
    ) {
      invalidLedgerEntries.push({
        index,
        id: finding.id,
        reason: "origin_not_earliest_occurrence",
      });
    }
  }

  // Reconstruct the finding evidence from the durable conversation. The panel
  // sidecar is intentionally fail-closed but not trusted: a valid-looking empty
  // ledger must not erase an earlier specialist's blocking line.
  for (const message of partnerMessages) {
    const evidence = parseNormalizedFindingProtocol(message.content);
    const messageOccurrences = occurrences.filter(
      (occurrence) => occurrence.message_id === message.id
    );
    for (const error of evidence.errors) {
      invalidLedgerEntries.push({
        id: null,
        message_id: message.id,
        reason: `conversation_${error.reason}`,
        line: error.line ?? null,
      });
    }

    for (const record of evidence.records) {
      const knownFinding = record.id ? ledgerById.get(record.id) : null;
      const requiresLedger =
        isBlockingFindingCategory(record.category) || Boolean(knownFinding);
      if (!requiresLedger) continue;
      if (!record.id || !knownFinding) {
        invalidLedgerEntries.push({
          id: record.id,
          message_id: message.id,
          reason: record.id
            ? "conversation_finding_missing_from_ledger"
            : "conversation_blocking_finding_missing_id",
        });
        continue;
      }
      if (String(knownFinding.category).toUpperCase() !== record.category) {
        invalidLedgerEntries.push({
          id: record.id,
          message_id: message.id,
          reason: "conversation_finding_category_mismatch",
        });
      }
      const matchingOccurrence = messageOccurrences.find(
        (occurrence) => occurrence.finding_id === record.id
      );
      if (
        !matchingOccurrence
      ) {
        invalidLedgerEntries.push({
          id: record.id,
          message_id: message.id,
          reason: "conversation_finding_occurrence_missing",
        });
      } else if (matchingOccurrence.text !== record.text) {
        invalidLedgerEntries.push({
          id: record.id,
          message_id: message.id,
          reason: "conversation_finding_occurrence_text_mismatch",
        });
      }
      if (
        knownFinding.origin_message_id === message.id &&
        knownFinding.text !== record.text
      ) {
        invalidLedgerEntries.push({
          id: record.id,
          message_id: message.id,
          reason: "conversation_finding_origin_text_mismatch",
        });
      }
    }

    const unindexedPool = messageOccurrences.filter(
      (occurrence) => occurrence.source_kind === "gate_readable_unindexed"
    );
    for (const gateFinding of evidence.gate_unindexed) {
      const matchIndex = unindexedPool.findIndex(
        (occurrence) =>
          String(occurrence.category).toUpperCase() === gateFinding.category &&
          occurrence.text === gateFinding.text &&
          ledgerById.get(occurrence.finding_id)?.text === gateFinding.text &&
          ledgerById.get(occurrence.finding_id)?.origin_message_id === message.id &&
          ledgerById.get(occurrence.finding_id)?.source_kind ===
            "gate_readable_unindexed"
      );
      if (matchIndex === -1) {
        invalidLedgerEntries.push({
          id: null,
          message_id: message.id,
          reason: "gate_readable_finding_occurrence_missing",
          category: gateFinding.category,
        });
      } else {
        unindexedPool.splice(matchIndex, 1);
      }
    }

    // Every sidecar occurrence must be justified by the immutable partner
    // message it claims as provenance. Without this inverse check, a forged
    // harmless occurrence in an earlier clean message can become the ledger
    // origin and overwrite the meaning of a later real normalized finding.
    for (const occurrence of unindexedPool) {
      invalidLedgerEntries.push({
        id: occurrence.finding_id,
        message_id: message.id,
        reason: "occurrence_without_conversation_finding",
      });
    }

    for (const occurrence of messageOccurrences) {
      if (occurrence.source_kind === "gate_readable_unindexed") continue;
      if (
        !evidence.records.some(
          (record) =>
            record.id === occurrence.finding_id &&
            record.text === occurrence.text
        )
      ) {
        invalidLedgerEntries.push({
          id: occurrence.finding_id,
          message_id: message.id,
          reason: "occurrence_without_conversation_finding",
        });
      }
    }
  }

  const sourceMessage = reviewStatus.approved
    ? [...partnerMessages]
        .reverse()
        .find((message) => message.id === reviewStatus.source_message_id) ?? null
    : null;
  const sourceMessageTruncated = Boolean(
    sourceMessage?.content?.includes("[report truncated in the middle:")
  );
  const sourceContract = sourceMessage
    ? evaluatePanelApprovalSource(sourceMessage.content, reviewStatus, ledgerIds)
    : { valid: !reviewStatus.approved, errors: [], normalized: null };
  const parsed = sourceMessage
    ? parseFindingDispositions(sourceMessage.content)
    : { dispositions: [], invalid_lines: [] };
  const carriedFindingIds = [];
  const unknownCarriedFindingIds = [];
  const carriedCategoryMismatches = [];
  if (sourceMessage && sourceContract.normalized) {
    for (const reference of sourceContract.normalized.records) {
      if (!reference.id) continue;
      const knownFinding = ledgerById.get(reference.id);
      if (!knownFinding && !isBlockingFindingCategory(reference.category)) continue;
      if (!carriedFindingIds.includes(reference.id)) carriedFindingIds.push(reference.id);
      if (!knownFinding && !unknownCarriedFindingIds.includes(reference.id)) {
        unknownCarriedFindingIds.push(reference.id);
      }
      if (
        knownFinding &&
        String(knownFinding.category).toUpperCase() !== reference.category
      ) {
        carriedCategoryMismatches.push({
          id: reference.id,
          expected: String(knownFinding.category).toUpperCase(),
          actual: reference.category,
        });
      }
    }
    for (const occurrence of occurrences) {
      if (
        occurrence.message_id === sourceMessage.id &&
        ledgerIds.has(occurrence.finding_id) &&
        !carriedFindingIds.includes(occurrence.finding_id)
      ) {
        carriedFindingIds.push(occurrence.finding_id);
      }
    }
  }
  const dispositionById = new Map(parsed.dispositions.map((entry) => [entry.id, entry]));
  const invalidDispositions = [...parsed.invalid_lines];

  if (reviewStatus.approved) {
    for (const disposition of parsed.dispositions) {
      if (!ledgerIds.has(disposition.id)) {
        invalidDispositions.push({
          line: disposition.line,
          id: disposition.id,
          reason: "unknown_finding_id",
        });
      }
      if (
        disposition.disposition === "duplicate" &&
        (!ledgerIds.has(disposition.duplicate_of) || disposition.duplicate_of === disposition.id)
      ) {
        invalidDispositions.push({
          line: disposition.line,
          id: disposition.id,
          reason: disposition.duplicate_of === disposition.id ? "duplicate_self_reference" : "unknown_duplicate_target",
          duplicate_of: disposition.duplicate_of,
        });
      }
    }

    // Duplicate cycles dispose of nothing. Following the links here keeps a
    // pair of mutually-duplicated findings from manufacturing an approval.
    for (const disposition of parsed.dispositions) {
      if (disposition.disposition !== "duplicate") continue;
      const path = new Set([disposition.id]);
      let cursor = disposition;
      while (cursor?.disposition === "duplicate") {
        const target = cursor.duplicate_of;
        if (path.has(target)) {
          invalidDispositions.push({
            line: disposition.line,
            id: disposition.id,
            reason: "duplicate_cycle",
          });
          break;
        }
        path.add(target);
        cursor = dispositionById.get(target);
        // A known target without a disposition is already reported below as
        // undispositioned, so it needs no second diagnostic here.
        if (!cursor) break;
      }
    }
  }

  const undispositionedIds = reviewStatus.approved
    ? [...ledgerIds].filter((id) => !dispositionById.has(id))
    : [...ledgerIds];
  const valid = ledgerAvailable && invalidLedgerEntries.length === 0;
  const findingCommitPending = Boolean(panelState?.pending_finding_commit);
  const satisfied =
    valid &&
    reviewStatus.approved &&
    sourceContract.valid &&
    protocolAmbiguities.length === 0 &&
    undispositionedIds.length === 0 &&
    invalidDispositions.length === 0 &&
    carriedFindingIds.length === 0 &&
    !sourceMessageTruncated &&
    !findingCommitPending;

  return {
    available: ledgerAvailable,
    version: panelState?.finding_ledger_version ?? null,
    valid,
    required_finding_ids: [...ledgerIds],
    occurrences,
    dispositions: parsed.dispositions,
    carried_finding_ids: carriedFindingIds,
    unknown_carried_finding_ids: unknownCarriedFindingIds,
    carried_category_mismatches: carriedCategoryMismatches,
    source_contract: {
      valid: sourceContract.valid,
      errors: sourceContract.errors,
      exact_approval_lines: sourceContract.exact_approval_lines ?? [],
      approval_signal_lines: sourceContract.approval_signal_lines ?? [],
    },
    source_message_truncated: sourceMessageTruncated,
    finding_commit_pending: findingCommitPending,
    protocol_ambiguities: protocolAmbiguities,
    undispositioned_finding_ids: undispositionedIds,
    invalid_ledger_entries: invalidLedgerEntries,
    invalid_dispositions: invalidDispositions,
    satisfied,
  };
}

function extractPanelAspectResult(content) {
  if (!hasBalancedProtocolNoise(content)) return null;
  const lines = String(content || "").split("\n");
  const readable = protocolReadableLineMask(content || "");
  const values = [];
  for (const [index, line] of lines.entries()) {
    if (!readable[index]) continue;
    const match = line.match(/^\s*ASPECT_RESULT:\s*(CLEAN|FINDINGS)\s*$/i);
    if (match) values.push(match[1].toUpperCase());
  }
  return values.length === 1 ? values[0] : null;
}

/**
 * Decide whether a PR-review panel is structurally complete enough to approve.
 *
 * Prompt text is not enforcement. A failed or unverified specialist is already
 * recorded in panel_state.json, so an aggregation or follow-up turn that emits
 * APPROVE despite the prompt-level ban must not be able to turn that known hole
 * into an approved session. The same rule also closes the earlier-pass verdict
 * leak: even if a specialist manages to emit an approval token, it predates the
 * consolidation message and therefore cannot resolve the panel.
 *
 * Missing or unreadable state fails closed for approval only. Other review
 * states still flow through, and the existing no-partner-turns / hard-cap escape
 * hatches remain available for cleanup.
 */
function applyPanelIntegrity(reviewStatus, status, partnerMessages, panelState) {
  if (status?.type !== "pr_review") return reviewStatus;

  const planned = Array.isArray(status?.aspects)
    ? [...new Set(status.aspects.filter((aspect) => typeof aspect === "string"))]
    : [];
  const completed = Array.isArray(panelState?.completed) ? panelState.completed : [];
  const entriesByAspect = new Map();
  for (const entry of completed) {
    if (entry && typeof entry.aspect === "string") {
      const entries = entriesByAspect.get(entry.aspect) ?? [];
      entries.push(entry);
      entriesByAspect.set(entry.aspect, entries);
    }
  }
  const duplicateCompletedAspects = [...entriesByAspect]
    .filter(([, entries]) => entries.length !== 1)
    .map(([aspect]) => aspect);
  const unexpectedCompletedAspects = [...entriesByAspect.keys()].filter(
    (aspect) => aspect !== "__aggregate__" && !planned.includes(aspect)
  );
  const totalPassesValid = panelState?.total_passes === planned.length + 1;
  const entryFor = (aspect) =>
    entriesByAspect.get(aspect)?.length === 1 ? entriesByAspect.get(aspect)[0] : null;

  const failedAspects = planned.filter(
    (aspect) => entryFor(aspect)?.status === "failed"
  );
  const unverifiedAspects = planned.filter(
    (aspect) => entryFor(aspect)?.status === "complete_unverified"
  );
  const missingAspects = planned.filter(
    (aspect) => !["complete", "failed", "complete_unverified"].includes(
      entryFor(aspect)?.status
    )
  );

  let previousPartnerMessageId = 0;
  const invalidPartnerMessageIds = [];
  for (const message of partnerMessages) {
    if (!Number.isSafeInteger(message.id) || message.id <= previousPartnerMessageId) {
      invalidPartnerMessageIds.push(message.id ?? null);
    }
    previousPartnerMessageId = message.id;
  }
  const partnerMessageSequenceValid = invalidPartnerMessageIds.length === 0;
  const messageById = new Map(partnerMessages.map((message) => [message.id, message]));
  const aggregate = entryFor("__aggregate__");
  const specialistMessageIssues = [];
  const linkedSpecialistMessageIds = new Set();
  let previousSpecialistMessageId = 0;
  for (const [plannedIndex, aspect] of planned.entries()) {
    const entry = entryFor(aspect);
    if (!entry || !["complete", "complete_unverified"].includes(entry.status)) continue;
    const message = messageById.get(entry.message_id);
    const header = String(message?.content ?? "").match(PANEL_PASS_HEADER_RE);
    const headerPass = Number(header?.[1]);
    const headerTotal = Number(header?.[2]);
    const headerAspect = header?.[3] ?? null;
    if (
      !message ||
      headerAspect !== aspect ||
      headerPass !== plannedIndex + 1 ||
      headerTotal !== planned.length
    ) {
      specialistMessageIssues.push({
        aspect,
        message_id: entry.message_id ?? null,
        reason: message ? "aspect_header_mismatch" : "specialist_message_missing",
        expected_pass: plannedIndex + 1,
        expected_total: planned.length,
      });
      continue;
    }
    linkedSpecialistMessageIds.add(message.id);
    if (
      message.id <= previousSpecialistMessageId ||
      (Number.isSafeInteger(aggregate?.message_id) && message.id >= aggregate.message_id)
    ) {
      specialistMessageIssues.push({
        aspect,
        message_id: message.id,
        reason: "specialist_message_order_invalid",
      });
    }
    previousSpecialistMessageId = message.id;
    const parsedAspectResult = extractPanelAspectResult(message.content);
    const findingEvidence = parseNormalizedFindingProtocol(message.content);
    const reportedFindingCount =
      findingEvidence.valid_records.length + findingEvidence.gate_unindexed.length;
    const footerConsistent =
      parsedAspectResult === entry.aspect_result &&
      findingEvidence.available &&
      findingEvidence.heading_count === 1 &&
      findingEvidence.errors.length === 0 &&
      ((parsedAspectResult === "FINDINGS" &&
        reportedFindingCount > 0 &&
        findingEvidence.none_count === 0) ||
        (parsedAspectResult === "CLEAN" &&
          reportedFindingCount === 0 &&
          findingEvidence.none_count === 1));
    if (!footerConsistent) {
      specialistMessageIssues.push({
        aspect,
        message_id: entry.message_id,
        reason: "aspect_result_inconsistent",
        recorded_result: entry.aspect_result ?? null,
        parsed_result: parsedAspectResult,
        reported_finding_count: reportedFindingCount,
        normalized_heading_count: findingEvidence.heading_count,
        protocol_errors: findingEvidence.errors,
      });
    }
  }

  for (const message of partnerMessages) {
    if (
      PANEL_PASS_HEADER_RE.test(String(message.content ?? "")) &&
      !linkedSpecialistMessageIds.has(message.id)
    ) {
      specialistMessageIssues.push({
        aspect: null,
        message_id: message.id,
        reason: "unexpected_panel_header",
      });
    }
  }

  const consolidatedMessage = messageById.get(aggregate?.message_id) ?? null;
  const consolidatedHeaderMessageIds = partnerMessages
    .filter((message) =>
      String(message.content ?? "").startsWith(CONSOLIDATED_PR_REVIEW_HEADER)
    )
    .map((message) => message.id);
  const consolidationComplete =
    aggregate?.status === "complete" &&
    Number.isSafeInteger(consolidatedMessage?.id) &&
    consolidatedMessage.id > 0 &&
    aggregate.message_id === consolidatedMessage.id &&
    String(consolidatedMessage.content ?? "").startsWith(
      CONSOLIDATED_PR_REVIEW_HEADER
    ) &&
    consolidatedHeaderMessageIds.length === 1 &&
    consolidatedHeaderMessageIds[0] === consolidatedMessage.id;
  const findingContract = evaluateFindingContract(
    reviewStatus,
    partnerMessages,
    panelState
  );
  const structurallyComplete =
    panelState != null &&
    planned.length > 0 &&
    failedAspects.length === 0 &&
    unverifiedAspects.length === 0 &&
    missingAspects.length === 0 &&
    duplicateCompletedAspects.length === 0 &&
    unexpectedCompletedAspects.length === 0 &&
    totalPassesValid &&
    specialistMessageIssues.length === 0 &&
    partnerMessageSequenceValid &&
    panelState?.phase === "follow_up" &&
    Array.isArray(panelState?.pending) &&
    panelState.pending.length === 0 &&
    consolidationComplete &&
    findingContract.available &&
    findingContract.valid &&
    !findingContract.finding_commit_pending;
  const verdictAfterConsolidation =
    !reviewStatus.approved ||
    (consolidationComplete &&
      Number.isSafeInteger(reviewStatus.source_message_id) &&
      reviewStatus.source_message_id >= consolidatedMessage.id);
  const approvalAllowed =
    structurallyComplete && verdictAfterConsolidation && findingContract.satisfied;

  const blockers = [];
  if (panelState == null) blockers.push("panel_state_unavailable");
  if (planned.length === 0) blockers.push("no_planned_aspects");
  if (failedAspects.length > 0) blockers.push("failed_aspects");
  if (unverifiedAspects.length > 0) blockers.push("unverified_aspects");
  if (missingAspects.length > 0) blockers.push("pending_or_missing_aspects");
  if (duplicateCompletedAspects.length > 0) blockers.push("duplicate_completed_aspects");
  if (unexpectedCompletedAspects.length > 0) blockers.push("unexpected_completed_aspects");
  if (!totalPassesValid) blockers.push("panel_pass_count_mismatch");
  if (specialistMessageIssues.length > 0) blockers.push("specialist_message_mismatch");
  if (!partnerMessageSequenceValid) blockers.push("invalid_partner_message_sequence");
  if (panelState?.phase !== "follow_up") blockers.push("panel_phase_incomplete");
  if (!Array.isArray(panelState?.pending) || panelState.pending.length > 0) {
    blockers.push("panel_pending_inconsistent");
  }
  if (aggregate?.status === "failed") blockers.push("consolidation_failed");
  else if (!consolidationComplete) blockers.push("consolidation_incomplete");
  if (!verdictAfterConsolidation) blockers.push("verdict_before_consolidation");
  if (!findingContract.available) blockers.push("finding_ledger_unavailable");
  else if (!findingContract.valid) blockers.push("finding_ledger_invalid");
  if (reviewStatus.approved && findingContract.undispositioned_finding_ids.length > 0) {
    blockers.push("undispositioned_findings");
  }
  if (reviewStatus.approved && findingContract.invalid_dispositions.length > 0) {
    blockers.push("invalid_finding_dispositions");
  }
  if (reviewStatus.approved && findingContract.carried_finding_ids.length > 0) {
    blockers.push("carried_findings");
  }
  if (reviewStatus.approved && findingContract.carried_category_mismatches.length > 0) {
    blockers.push("finding_category_mismatch");
  }
  if (reviewStatus.approved && !findingContract.source_contract.valid) {
    blockers.push("invalid_approval_source_contract");
  }
  if (reviewStatus.approved && findingContract.source_message_truncated) {
    blockers.push("truncated_approval_source");
  }
  if (findingContract.finding_commit_pending) {
    blockers.push("finding_commit_pending");
  }
  if (findingContract.protocol_ambiguities.length > 0) {
    blockers.push("finding_protocol_ambiguity");
  }

  const integrity = {
    complete: structurallyComplete,
    approval_allowed: approvalAllowed,
    blockers,
    planned_aspects: planned,
    failed_aspects: failedAspects,
    unverified_aspects: unverifiedAspects,
    missing_aspects: missingAspects,
    duplicate_completed_aspects: duplicateCompletedAspects,
    unexpected_completed_aspects: unexpectedCompletedAspects,
    expected_total_passes: planned.length + 1,
    recorded_total_passes: panelState?.total_passes ?? null,
    specialist_message_issues: specialistMessageIssues,
    invalid_partner_message_ids: invalidPartnerMessageIds,
    panel_phase: panelState?.phase ?? null,
    panel_pending: Array.isArray(panelState?.pending) ? panelState.pending : null,
    consolidation_status: aggregate?.status ?? "missing",
    consolidation_message_id: consolidatedMessage?.id ?? null,
    finding_contract: findingContract,
    ...(reviewStatus.approved && !approvalAllowed
      ? {
          rejected_verdict: reviewStatus.verdict,
          rejected_source_message_id: reviewStatus.source_message_id,
        }
      : {}),
  };

  if (!reviewStatus.approved || approvalAllowed) {
    return { ...reviewStatus, panel_integrity: integrity };
  }

  return {
    ...reviewStatus,
    state: "needs_discussion",
    approved: false,
    close_allowed: reviewStatus.hard_cap_reached,
    close_allowed_reason: reviewStatus.hard_cap_reached ? "hard_cap" : null,
    verdict: "NEEDS_DISCUSSION",
    source: "panel_integrity",
    panel_integrity: integrity,
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
    return applyPanelIntegrity(
      {
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
      },
      status,
      partnerMessages,
      options.panelState
    );
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
    if (
      (status?.type === "pr_review"
        ? hasPanelBlockingFindings(msg.content)
        : hasBlockingFindings(msg.content))
    ) {
      return applyPanelIntegrity(
        buildReviewStatus({
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
        }),
        status,
        partnerMessages,
        options.panelState
      );
    }
  }

  if (verdictSignal) {
    return applyPanelIntegrity(
      buildReviewStatus({
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
      }),
      status,
      partnerMessages,
      options.panelState
    );
  }

  return applyPanelIntegrity(
    buildReviewStatus({
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
    }),
    status,
    partnerMessages,
    options.panelState
  );
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
