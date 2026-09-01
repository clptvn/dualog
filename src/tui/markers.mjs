// Terminal marker matching, driven by adapter data instead of per-agent code.
//
// MARKER SYNTAX
//   "literal"         -> case-sensitive substring match
//   "re:pattern"      -> regex with flags `iu`
//   "re:/pattern/f"   -> regex with explicit flags `f`
//
// The default deliberately omits `m`. With `m`, `$` anchors to end-of-LINE, so
// a prompt-glyph marker like `[❯›]\s*$` would match a glyph anywhere in the
// tail rather than only at the very bottom of the pane -- which is the whole
// point of an idle check. Markers that genuinely need per-line anchoring (menu
// options in an interstitial) opt in with explicit flags.
//
// MATCH SCOPE is per marker class, and the differences are load-bearing rather
// than incidental:
//
//   ready*     literals scan the whole snapshot (a banner printed at startup
//              stays true); regexes scan the tail, since they anchor on layout.
//   notReady   tail only. A "Booting MCP server" line left in scrollback must
//              not pin the adapter to not-ready forever -- that would hang
//              every turn after the first.
//   idle       last few non-empty lines only, because an idle prompt is a
//              property of the CURRENT bottom of the pane. Regexes see raw
//              text (they anchor on the prompt glyph at end-of-line); literals
//              see whitespace-normalized lowercase text.
//   blocked    same scope as idle. A pane parked on a plan-approval or
//              ask-the-human step looks idle to a naive classifier, so this is
//              checked first and reported distinctly.
//
// Getting these scopes wrong does not produce a loud failure. It produces a
// driver that waits forever, which is why they are spelled out here.

const READY_REGEX_TAIL = 4000;
const NOT_READY_TAIL = 2000;
const STARTUP_TAIL = 4000;
const IDLE_TAIL_LINES = 8;

const compiled = new Map();

function isRegexMarker(marker) {
  return typeof marker === "string" && marker.startsWith("re:");
}

function toRegex(marker) {
  if (compiled.has(marker)) return compiled.get(marker);
  const body = marker.slice(3);
  // `/pattern/flags` form, else the whole body with default flags.
  const explicit = /^\/(.*)\/([a-z]*)$/su.exec(body);
  const source = explicit ? explicit[1] : body;
  const flags = explicit ? explicit[2] : "iu";
  let re;
  try {
    re = new RegExp(source, flags);
  } catch (err) {
    throw new Error(`Invalid regex marker ${JSON.stringify(marker)}: ${err.message}`);
  }
  compiled.set(marker, re);
  return re;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function normalizeForLiteral(text) {
  return stripAnsi(text)
    .replace(/[^\x20-\x7E]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function tailLines(text, count) {
  return String(text || "")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .slice(-count)
    .join("\n");
}

/** Match one marker against pre-computed scopes. */
function markerMatches(marker, scopes) {
  return isRegexMarker(marker)
    ? toRegex(marker).test(scopes.regex)
    : scopes.literal.includes(marker);
}

function anyMatches(markers, scopes) {
  return (markers ?? []).some((m) => markerMatches(m, scopes));
}

function allMatch(markers, scopes) {
  return (markers ?? []).every((m) => markerMatches(m, scopes));
}

function readyScopes(snapshot) {
  return {
    // Literals see the full snapshot; regexes only the tail.
    literal: stripAnsi(snapshot),
    regex: stripAnsi(snapshot).slice(-READY_REGEX_TAIL),
  };
}

function notReadyScopes(snapshot) {
  const tail = stripAnsi(snapshot).slice(-NOT_READY_TAIL);
  return { literal: tail, regex: tail };
}

function startupScopes(snapshot) {
  return {
    literal: stripAnsi(snapshot),
    regex: stripAnsi(snapshot).slice(-STARTUP_TAIL),
  };
}

function idleScopes(snapshot) {
  const raw = tailLines(snapshot, IDLE_TAIL_LINES);
  return { literal: normalizeForLiteral(raw), regex: raw };
}

/**
 * Is the partner's input prompt ready to receive a turn?
 *
 * `notReady` wins over `ready`: a CLI can print its banner while still booting,
 * and pasting into it at that moment silently drops the prompt.
 */
export function isReady(tui, snapshot) {
  if (!tui || !snapshot) return false;
  if (anyMatches(tui.notReady, notReadyScopes(snapshot))) return false;

  const scopes = readyScopes(snapshot);
  const hasAll = allMatch(tui.readyAll, scopes);
  // readyAny is a disjunction only when non-empty; an adapter may rely solely
  // on readyAll.
  const hasAny = (tui.readyAny?.length ?? 0) === 0 || anyMatches(tui.readyAny, scopes);
  return hasAll && hasAny;
}

/** Is the partner parked waiting on a human decision? */
export function isBlocked(tui, snapshot) {
  if (!tui?.blocked?.length || !snapshot) return false;
  return anyMatches(tui.blocked, idleScopes(snapshot));
}

/** Is the partner sitting at an idle input prompt? */
export function isIdlePrompt(tui, snapshot) {
  if (!tui?.idle?.length || !snapshot) return false;
  return anyMatches(tui.idle, idleScopes(snapshot));
}

/**
 * Find the first startup interstitial visible in the pane.
 *
 * Adapters whose ready state is unambiguous declare `readyWins`, which
 * suppresses interstitial detection once the prompt is up -- otherwise a
 * ready pane whose scrollback still shows the trust dialog would be answered
 * a second time.
 */
export function detectStartupPrompt(tui, snapshot, { readyWins = false } = {}) {
  if (!tui?.startupPrompts?.length || !snapshot) return null;
  if (readyWins && isReady(tui, snapshot)) return null;

  const scopes = startupScopes(snapshot);
  for (const prompt of tui.startupPrompts) {
    const hasAll = allMatch(prompt.matchAll, scopes);
    const hasAny =
      (prompt.matchAny?.length ?? 0) === 0 || anyMatches(prompt.matchAny, scopes);
    if (hasAll && hasAny) {
      return {
        kind: prompt.kind,
        input: prompt.input,
        keys: prompt.keys ? [...prompt.keys] : undefined,
        description: prompt.description,
      };
    }
  }
  return null;
}
