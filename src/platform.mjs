import fs from "fs";
import os from "os";
import path from "path";

// dualog platform helpers. Keep this file dependency-light because
// Claude hook scripts import it from the user-level hooks directory.
//
// This module is the shared trust boundary for those hook scripts, so it owns
// its own preconditions rather than trusting each caller to remember them. Every
// function that builds a filesystem path from a session id validates that id
// here; every function that reads untrusted input reports failure rather than
// throwing past the caller's error handling.

export function homeDir() {
  return os.homedir();
}

// Sessions written from now on live here.
export function dialogsDir() {
  return path.join(homeDir(), ".dualog", "sessions");
}

// Where sessions lived before the rename. Still read so that in-flight and
// historical sessions remain visible; never written to.
export function legacyDialogsDir() {
  return path.join(homeDir(), ".claude", "dialogs");
}

/**
 * The runtime root: disposable per-turn state, never an archive.
 *
 * A session directory is durable -- transcript, status, prompts, diagnostics --
 * and config isolation quietly made it a partner CLI's live home as well, seeded
 * with that CLI's real credentials. Nothing removed those, which is how 176
 * credential copies and 12 GiB accumulated under directories whose whole purpose
 * was to be kept.
 *
 * Separating the roots is what makes the lifetimes separable. Everything under
 * here belongs to exactly one turn and is removable the moment that turn's
 * process is proven gone; nothing under here is ever worth reading later.
 */
export function runtimeDir() {
  return path.join(homeDir(), ".dualog", "runtime");
}

/**
 * The only shape a lease id may have.
 *
 * Opaque and generated, never derived from a session id or a partner name. A
 * lease directory is created with exclusive semantics under a root this module
 * chooses, so the id needs no meaning -- and giving it none keeps a caller from
 * constructing one that collides with another turn's.
 */
const LEASE_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isValidLeaseId(leaseId) {
  return typeof leaseId === "string" && LEASE_ID_PATTERN.test(leaseId);
}

export function leaseDir(leaseId) {
  if (!isValidLeaseId(leaseId)) {
    throw new Error(`leaseDir: ${JSON.stringify(leaseId)} is not a valid lease id.`);
  }
  return path.join(runtimeDir(), leaseId);
}

/**
 * The only shape a session id may have.
 *
 * `\w` is [A-Za-z0-9_], so this admits no `.`, `/`, or `\` -- which is what
 * makes the path.join() calls below incapable of escaping their root. Real ids
 * are `dialog-<ms>-<hex>` / `review-<ms>-<hex>`; the server applies a stricter
 * pattern on top at its own boundary, and that remains its business.
 */
const SESSION_ID_PATTERN = /^[\w-]+$/;

export function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Refuse to build a path from an id that could leave the sessions root.
 *
 * Validation used to live only in callers -- four of them, plus a fifth that
 * open-coded the join, using two different regexes. That worked only for as
 * long as every caller remembered, and nothing here said it was required. A
 * single `..` segment is enough to escape: path.join(root, "../../etc") lands
 * on /etc. (A leading slash is NOT a hazard; path.join normalizes it into a
 * relative segment.)
 */
function assertValidSessionId(sessionId, fn) {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `${fn}: refusing to build a path from an invalid session id ${JSON.stringify(sessionId)}. ` +
        `Session ids must match ${SESSION_ID_PATTERN}.`
    );
  }
}

/** Prefer the current root, fall back to the legacy one for existing sessions. */
export function resolveExistingSessionDir(sessionId) {
  assertValidSessionId(sessionId, "resolveExistingSessionDir");
  const current = path.join(dialogsDir(), sessionId);
  if (fs.existsSync(current)) return current;
  const legacy = path.join(legacyDialogsDir(), sessionId);
  if (fs.existsSync(legacy)) return legacy;
  return current;
}

/**
 * Read an environment variable under its current name, falling back to any
 * pre-rename aliases. Keeps existing setups working without a flag day.
 */
export function envWithAliases(names, fallback = undefined) {
  // Strings are iterable, so a dropped pair of brackets would not fail here --
  // it would iterate CHARACTERS. Every env name in this codebase contains "_",
  // and POSIX shells set $_ to the last executed binary, so
  // envWithAliases("DUALOG_IDLE_SHUTDOWN_MS") returned a path to the node
  // binary where a millisecond count was expected. A wrong value that looks
  // plausible is worse than a crash, so this is a hard error.
  if (!Array.isArray(names)) {
    throw new TypeError(
      `envWithAliases: names must be an array of variable names, received ${typeof names}. ` +
        `A bare string would be iterated character by character.`
    );
  }
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value !== "") return value;
  }
  return fallback;
}

export function dialogSessionDir(sessionId) {
  assertValidSessionId(sessionId, "dialogSessionDir");
  return path.join(dialogsDir(), sessionId);
}

/**
 * Is `child` lexically inside `parent`? Never a startsWith test.
 *
 * `startsWith` says /a/bc is inside /a/b. path.relative gives "" for the
 * directory itself, a `..` segment for anything above it, and an absolute path
 * when the two live on different roots -- all three of which are rejections.
 */
function isLexicallyInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Reject any path component that already exists as a symlink.
 *
 * A lexical containment check answers "does this path SPELL a child", not
 * "does this path RESOLVE to one". Those differ the moment a component is a
 * link: a planted `<session>/codex-home -> /Users/me/.codex` is lexically
 * beneath the session and writes straight into the user's real config. Walked
 * with lstat from the root down, because realpath on the full path would
 * silently follow the very link this exists to catch, and a component that does
 * not exist yet cannot be a link.
 */
function assertNoSymlinkComponents(root, target, fn) {
  const rel = path.relative(root, target);
  if (!rel) return;
  let current = root;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return; // Does not exist yet: nothing to follow, and nothing below it can.
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `${fn}: refusing to use ${target} because ${current} is a symbolic link. ` +
          `A link inside a session directory can redirect writes outside it.`
      );
    }
  }
}

/**
 * Prove a path is a dualog-managed scratch location before anything writes to it.
 *
 * This exists because `prepareConfigIsolation()` rendered a manifest template
 * and `mkdirSync`'d the result with no check of any kind. Whatever a caller
 * passed as `sessionDir` became a place to create directories and copy
 * credentials into -- which is how a live `auth.json` was deposited into a
 * public repository's working tree, from a test that passed the repo root as a
 * session directory.
 *
 * BOTH boundaries are checked, because either alone is insufficient:
 *
 *   - only "inside a managed root" still admits `{{sessionDir}}/../other-session`;
 *   - only "inside the caller's sessionDir" still admits the repo, because the
 *     caller is the one claiming the repo is a session.
 *
 * So the session directory must itself be a direct, validly-named child of a
 * root THIS MODULE chooses, never one the caller supplies. The legacy root is
 * accepted only for a session that already exists there, matching
 * resolveExistingSessionDir(): pre-rename sessions must keep working, but
 * nothing new may be created under a root we no longer write to.
 */
export function assertManagedSessionPath(sessionDir, candidate, { fn = "assertManagedSessionPath" } = {}) {
  if (typeof sessionDir !== "string" || !sessionDir) {
    throw new Error(`${fn}: sessionDir must be a non-empty string, received ${typeof sessionDir}.`);
  }
  if (typeof candidate !== "string" || !candidate) {
    throw new Error(`${fn}: candidate must be a non-empty string, received ${typeof candidate}.`);
  }

  const resolvedSession = path.resolve(sessionDir);
  const sessionId = path.basename(resolvedSession);
  const parent = path.dirname(resolvedSession);

  const current = path.resolve(dialogsDir());
  const legacy = path.resolve(legacyDialogsDir());
  const underCurrent = parent === current;
  const underLegacy = parent === legacy && fs.existsSync(resolvedSession);

  if (!underCurrent && !underLegacy) {
    throw new Error(
      `${fn}: refusing to use ${resolvedSession} as a session directory. ` +
        `It must be a direct child of ${current}` +
        `${parent === legacy ? ` (or of the legacy root ${legacy}, for a session that already exists there)` : ""}.`
    );
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `${fn}: refusing to use ${resolvedSession}: ${JSON.stringify(sessionId)} is not a valid session id.`
    );
  }

  // The root the session was matched against must itself be real, or the
  // "direct child of a root we chose" proof above is a statement about strings
  // rather than about where writes land.
  assertManagedRoot(underCurrent ? current : legacy, fn, "sessions root");

  const resolvedCandidate = path.resolve(candidate);
  if (!isLexicallyInside(resolvedSession, resolvedCandidate) || resolvedCandidate === resolvedSession) {
    throw new Error(
      `${fn}: refusing to use ${resolvedCandidate}; it is not inside the session directory ${resolvedSession}.`
    );
  }

  // The SESSION DIRECTORY ITSELF must be a real directory.
  //
  // assertNoSymlinkComponents() walks from the session dir DOWNWARD, so it
  // never inspected the session dir -- and a symlink planted there is lexically
  // a direct child of the managed root, carries a valid session id, and passes
  // every check above. Demonstrated: `~/.dualog/sessions/dialog-...-0000 ->
  // /victim/repo` was accepted, and mkdirSync then created `codex-home` inside
  // the victim. Everything below this point is only as trustworthy as the
  // directory it is relative to.
  assertRealDirectory(resolvedSession, fn, "session directory");
  assertNoSymlinkComponents(resolvedSession, resolvedCandidate, fn);
  return resolvedCandidate;
}

/**
 * The MANAGED ROOT itself, and everything we own above it, must be real.
 *
 * assertNoSymlinkComponents() walks DOWNWARD from the session or lease
 * directory, so nothing ever inspected `~/.dualog`, `~/.dualog/sessions` or
 * `~/.dualog/runtime`. Planting either root as a symlink therefore passed every
 * check -- the lexical parent comparison is a string test, and `path.resolve`
 * does not resolve links -- and writes followed it. Demonstrated: with
 * `~/.dualog/runtime` linked elsewhere, a lease path was accepted and its
 * `codex-home` resolved inside the link target. That is the same defect as the
 * symlinked session directory, one level up.
 *
 * The walk starts at the HOME DIRECTORY, not at `/`. A home behind a symlink is
 * the user's own arrangement and common enough that rejecting it would break
 * legitimate setups; `.dualog` and below is what dualog creates and therefore
 * what it can insist on.
 */
function assertManagedRoot(root, fn, label) {
  const resolved = path.resolve(root);
  const home = path.resolve(homeDir());
  if (isLexicallyInside(home, resolved)) {
    assertNoSymlinkComponents(home, resolved, `${fn} (${label})`);
  }
  assertRealDirectory(resolved, fn, label);
}

/**
 * The container a candidate is measured against must be a real directory.
 *
 * Shared by both boundaries because the hole it closes was found in one and
 * applies identically to the other: assertNoSymlinkComponents() walks DOWNWARD
 * from the container, so it never inspects the container itself, and a symlink
 * planted there is lexically a direct child of the managed root and passes every
 * other check. Everything below such a directory resolves somewhere else.
 */
function assertRealDirectory(resolved, fn, label) {
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    return; // not yet created: nothing to redirect through
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `${fn}: refusing to use ${resolved} because the ${label} itself is a ` +
        `symbolic link. Everything inside it would resolve somewhere else.`
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`${fn}: refusing to use ${resolved}; it is not a directory.`);
  }
}

/**
 * Prove a path is inside a dualog-owned runtime lease before anything writes to it.
 *
 * The runtime counterpart of assertManagedSessionPath, and deliberately a
 * separate function rather than a parameterized one: the two roots have
 * different rules. A session may live under the legacy root and must survive; a
 * lease is always freshly created under the current runtime root, so there is no
 * legacy case to admit and the id grammar is exact rather than permissive.
 *
 * Both boundaries are checked for the same reason as sessions -- "inside the
 * runtime root" alone still admits `{{scratchDir}}/../<other lease>`, which
 * would let one turn write into another turn's credential projection.
 */
export function assertManagedLeasePath(leasePath, candidate, { fn = "assertManagedLeasePath" } = {}) {
  if (typeof leasePath !== "string" || !leasePath) {
    throw new Error(`${fn}: leasePath must be a non-empty string, received ${typeof leasePath}.`);
  }
  if (typeof candidate !== "string" || !candidate) {
    throw new Error(`${fn}: candidate must be a non-empty string, received ${typeof candidate}.`);
  }

  const resolvedLease = path.resolve(leasePath);
  const leaseId = path.basename(resolvedLease);
  const parent = path.dirname(resolvedLease);
  const root = path.resolve(runtimeDir());

  if (parent !== root) {
    throw new Error(
      `${fn}: refusing to use ${resolvedLease} as a lease directory. ` +
        `It must be a direct child of ${root}.`
    );
  }
  if (!isValidLeaseId(leaseId)) {
    throw new Error(
      `${fn}: refusing to use ${resolvedLease}: ${JSON.stringify(leaseId)} is not a valid lease id.`
    );
  }

  assertManagedRoot(root, fn, "runtime root");

  const resolvedCandidate = path.resolve(candidate);
  if (!isLexicallyInside(resolvedLease, resolvedCandidate) || resolvedCandidate === resolvedLease) {
    throw new Error(
      `${fn}: refusing to use ${resolvedCandidate}; it is not inside the lease directory ${resolvedLease}.`
    );
  }

  assertRealDirectory(resolvedLease, fn, "lease directory");
  assertNoSymlinkComponents(resolvedLease, resolvedCandidate, fn);
  return resolvedCandidate;
}

/**
 * A seed filename must name one entry in a directory, not a path.
 *
 * `copyIfMissing` / `copyIfExists` join manifest strings onto both the seed
 * directory (the user's REAL config) and the isolated one, so a value like
 * `../../.ssh/id_ed25519` reads outside the source and writes outside the
 * destination in a single step. Manifests are user-supplyable, so this is an
 * input boundary rather than a typo check.
 */
/**
 * Prove a managed root is safe to create in or delete from.
 *
 * Exported for the two callers that touch a root DIRECTLY rather than through a
 * contained path: lease allocation (which mkdirs the root) and the lease sweep
 * (which enumerates and removes beneath it). Both would otherwise follow a
 * symlinked root before any per-path assertion could run.
 */
export function assertManagedRootPath(root, { fn = "assertManagedRootPath", label = "managed root" } = {}) {
  assertManagedRoot(root, fn, label);
  return path.resolve(root);
}

export function assertSeedFileName(name, { fn = "assertSeedFileName" } = {}) {
  if (typeof name !== "string" || !name) {
    throw new Error(`${fn}: seed name must be a non-empty string, received ${typeof name}.`);
  }
  if (name !== path.basename(name) || name === "." || name === "..") {
    throw new Error(
      `${fn}: refusing to seed ${JSON.stringify(name)}; a seed name must be a single filename ` +
        `with no path separators.`
    );
  }
  return name;
}

/**
 * How long to keep retrying a not-yet-ready stdin before giving up.
 *
 * EAGAIN on fd 0 means "not ready, try again", not "no data" -- it happens when
 * stdin is a non-blocking pty, which is reachable in real hook invocations.
 *
 * Expressed as a TIME budget rather than an attempt count on purpose: an
 * attempt count silently encodes an assumption about how fast the writer is. A
 * first pass here used 50 attempts x 2ms and would therefore have abandoned any
 * payload that took longer than 100ms to arrive -- reintroducing the very
 * data-loss it was meant to fix, just on a slower writer. The budget is also
 * reset by any successful read, so a slow but progressing stream is never cut
 * off partway.
 */
const STDIN_EAGAIN_SLEEP_MS = 2;
/**
 * Once bytes have arrived, wait only this long for more.
 *
 * The initial budget answers "has the writer started yet". After progress the
 * question is different -- "is there more coming" -- and reusing the full
 * budget there meant a hook on a still-open pty read its entire payload and
 * then sat for the remaining two seconds waiting for an EOF that was never
 * going to come. That is a latency regression on every such invocation, for no
 * information gained.
 */
const STDIN_QUIESCENCE_MS = 150;
const STDIN_EAGAIN_BUDGET_MS = (() => {
  // Overridable so tests can exercise budget expiry without a multi-second
  // wait, and so an operator on a pathologically slow pipe can raise it.
  const raw = Number.parseInt(process.env.DUALOG_STDIN_BUDGET_MS ?? "", 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 2000;
})();

/**
 * Read the hook payload from stdin. NEVER THROWS, and NEVER DISCARDS BYTES.
 *
 * Every hook calls this as its first statement, before any try/catch of its own
 * exists, so an exception here escapes as an uncaught error: Node prints a
 * stack trace and exits 1. For a Claude Code PreToolUse hook, exit 1 is a
 * NON-BLOCKING error, so the tool call proceeds -- an EAGAIN silently disabled
 * the guard the hook exists to enforce.
 *
 * The byte-preservation requirement is the subtle half, and the first attempt
 * at this fix got it wrong. `fs.readFileSync(0)` CONSUMES whatever is available
 * and only then raises EAGAIN while it waits for EOF; the consumed bytes die
 * with the thrown call. Retrying `readFileSync` therefore resumes AFTER the
 * payload, returns "", and the hook treats a perfectly good message as
 * unparseable -- the same fail-open as before, minus the stack trace that made
 * it visible. Verified: a parent writing "PAYLOAD\n" into a non-blocking pty
 * produced `RESULT:""`.
 *
 * So this reads incrementally with `fs.readSync` and accumulates. EAGAIN
 * retries keep everything already read, and any progress resets the retry
 * budget so a slow writer cannot exhaust it.
 *
 * Known limitation: a BLOCKING fd 0 with no writer and no EOF still blocks
 * here, because there is no synchronous read with a timeout. That happens when
 * a hook is invoked by hand without stdin attached; the harness always pipes.
 */
export function readStdin() {
  return readStdinDetailed().text;
}

/**
 * The same read, with the outcome the caller cannot infer from the text alone.
 *
 * `complete` is true only when the stream reached EOF. An empty string with
 * `complete: false` means "we never got the payload", which is a different
 * situation from "the payload was legitimately empty" and the only one worth
 * complaining about.
 */
export function readStdinDetailed({ isComplete = null } = {}) {
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  let deadline = Date.now() + STDIN_EAGAIN_BUDGET_MS;
  let sawBytes = false;

  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (err) {
      if (err?.code === "EAGAIN") {
        if (Date.now() >= deadline) {
          // Bytes already in hand plus a quiet stream is a complete read as far
          // as anything here can tell; only a total absence of input is a
          // failure the caller must act on.
          if (sawBytes) return finish(chunks, true, null);
          return finish(
            chunks,
            false,
            `stdin produced nothing within ${STDIN_EAGAIN_BUDGET_MS}ms`
          );
        }
        sleepSync(STDIN_EAGAIN_SLEEP_MS);
        continue;
      }
      // EOF is reported as an exception by some platforms/fd types.
      if (err?.code === "EOF") return finish(chunks, true, null);
      return finish(chunks, false, `stdin could not be read (${err?.code || err?.message})`);
    }

    if (bytesRead === 0) return finish(chunks, true, null); // clean EOF
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    sawBytes = true;

    // A caller that can recognize a finished message does not have to wait for
    // EOF at all. Hook payloads are a single JSON document, so this turns the
    // open-pty case from "read everything, then stall for the whole budget"
    // into an immediate return.
    if (isComplete) {
      const soFar = Buffer.concat(chunks).toString("utf-8");
      if (isComplete(soFar)) return finish(chunks, true, null);
    }

    // Progress means the stream is alive, but the question has changed from
    // "has anything arrived" to "is there more", so the shorter window applies.
    deadline = Date.now() + STDIN_QUIESCENCE_MS;
  }
}

function finish(chunks, complete, warning) {
  const text = Buffer.concat(chunks).toString("utf-8");
  // Never silent. A guard that cannot read its input and says nothing is how
  // this failed the first time; at minimum the operator sees why.
  if (!complete && warning) {
    try {
      process.stderr.write(`dualog hook: ${warning}; read ${text.length} byte(s) before giving up\n`);
    } catch {
      /* stderr unavailable -- nothing further to do */
    }
  }
  return { text, complete };
}

/**
 * Block for `ms` without pulling in a dependency or going async.
 *
 * Atomics.wait on a SharedArrayBuffer is the only way to sleep synchronously,
 * and these hooks are synchronous top to bottom.
 */
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable: spin briefly rather than fail.
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* nothing to do but wait */
    }
  }
}

/**
 * Read and parse a hook's JSON payload, classifying how the read ended.
 *
 * Returns `{ payload, outcome }` with outcome one of:
 *
 *   "ok"          -- a complete, valid JSON document.
 *   "empty"       -- the stream ended cleanly with nothing in it. There is
 *                    nothing to check, so this is benign.
 *   "invalid"     -- bytes arrived but are not valid JSON. A truncated write or
 *                    a corrupted payload lands here.
 *   "unreadable"  -- stdin never produced anything within the budget, or the
 *                    read failed outright.
 *
 * "empty" and "invalid" were previously collapsed into a single null payload,
 * and every gate exited 0 for both. That left the unparseable half of the
 * fail-open intact: piping a truncated `{"tool_input":` disabled all three
 * PreToolUse gates with no diagnostic at all. They are different situations and
 * warrant different answers, so the caller is given the distinction.
 *
 * Recognizing a complete JSON document also lets the read return the instant
 * the payload lands, instead of waiting out the budget for an EOF that a
 * still-open pty will never send.
 */
export function readHookPayload() {
  const { text, complete } = readStdinDetailed({ isComplete: looksLikeCompleteJson });
  if (!complete) return { payload: null, outcome: "unreadable", raw: text };
  if (!text.trim()) return { payload: null, outcome: "empty", raw: text };
  try {
    return { payload: JSON.parse(text), outcome: "ok", raw: text };
  } catch {
    return { payload: null, outcome: "invalid", raw: text };
  }
}

function looksLikeCompleteJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
