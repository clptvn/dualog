// Removing partner scratch homes from archived sessions.
//
// A session directory is an ARCHIVE: transcript, status, diagnostics, kept so a
// conversation can be reread later. Config isolation quietly made it something
// else as well -- the live runtime home of a partner CLI, seeded with that
// CLI's real credentials. Nothing ever removed those, so every session ever run
// still holds a copy of the auth it was given.
//
// Containment (assertManagedSessionPath) stops new copies landing outside a
// session. It removes exactly zero of the ones already written. This module is
// the other half.
//
// Three rules shape it:
//
//   1. DELETE THE WHOLE HOME, not just the credential file. A CLI writes
//      refreshed tokens, caches, logs and databases into its home; unlinking
//      `auth.json` and leaving the rest is a guess about where secrets live.
//      The directory has no archival value -- it is scratch that was never
//      meant to persist.
//
//   2. NAMES COME FROM A VERSIONED LEDGER, never from current manifests and
//      never from scanning. A manifest can change or be user-supplied, so
//      "whatever codex.json says today" is not a description of what was
//      written a month ago; and recursively hunting the filesystem for
//      `auth.json` is how you delete someone's real credentials.
//
//   3. UNKNOWN LIVENESS RETAINS. A session whose runner, terminal, or headless
//      group cannot be proven gone is skipped, not cleaned. Deleting a home out
//      from under a running CLI is a worse failure than keeping a stale copy
//      one more day.

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

import { dialogsDir, legacyDialogsDir } from "./platform.mjs";
import { tmuxSocketName } from "./tmux-runtime.mjs";

/**
 * The exact shape the server generates. Not `isValidSessionId()` plus a prefix.
 *
 * That looser check also authorizes `dialog-personal` -- a directory a user
 * could plausibly have created by hand inside the sessions root. Deletion
 * authority should match what dualog itself produces and nothing else, so this
 * pins the generated form: prefix, millisecond timestamp, 8 hex characters.
 */
const GENERATED_SESSION_ID = /^(dialog|review)-\d+-[0-9a-f]{8}$/;

/**
 * Three-valued liveness. `isProcessAlive()` is not usable at this boundary.
 *
 * It catches every error as "dead", so a process that exists but belongs to
 * another user answers `false` -- verified: `isProcessAlive(1)` returns false
 * on this machine even though pid 1 obviously exists, because `kill(1, 0)`
 * raises EPERM. For deciding whether to SIGNAL something that conservatism is
 * fine. For deciding whether to DELETE a live CLI's home it is exactly
 * backwards: EPERM means the process is THERE.
 */
function probeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "invalid";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    if (err.code === "ESRCH") return "absent";
    if (err.code === "EPERM") return "alive";
    return "unknown";
  }
}

function probeGroup(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return "invalid";
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (err) {
    if (err.code === "ESRCH") return "absent";
    if (err.code === "EPERM") return "alive";
    return "unknown";
  }
}

/**
 * Is this tmux session still there? Three-valued, deliberately.
 *
 * `isTmuxSessionAlive()` collapses "tmux is not installed" and "that session is
 * gone" into the same `false`, which is safe for its own callers and unsafe
 * here: it would let a machine without tmux declare every preserved pane dead.
 */
function probeTmuxSession(sessionName) {
  if (typeof sessionName !== "string" || !sessionName) return "unknown";
  try {
    const out = execFileSync("tmux", ["-L", tmuxSocketName(), "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").some((line) => line.trim() === sessionName) ? "alive" : "absent";
  } catch (err) {
    // "no server running" is a definitive absence; anything else (tmux missing,
    // permission denied, timeout) is not knowledge.
    const text = `${err?.stderr ?? ""}${err?.message ?? ""}`;
    if (/no server running|no such file or directory.*tmux/i.test(text)) return "absent";
    if (err?.code === "ENOENT") return "unknown";
    return "unknown";
  }
}

/**
 * Every directory name dualog has ever generated inside a session as a partner
 * home, by version.
 *
 * Append-only and exact -- no globs, no patterns. Version 1 permanently
 * describes the layout shipped before the runtime-root change; if a later
 * layout ships during the transition it becomes version 2 rather than editing
 * this list, because a name that was removed from a manifest is exactly the
 * name still sitting on disk from before.
 *
 * `opencode-data` is here even though it was declared in `extraEnv` rather than
 * `configIsolation.dir`, and `codex-home` predates the manifest refactor
 * entirely. Deriving this list from the schema would have missed both.
 */
export const SCRATCH_LEDGER = [
  {
    version: 1,
    description: "per-session partner homes created by configIsolation before the runtime-root change",
    // Sensitive files are declared PER HOME, not as one global filename list.
    // A global list gets both halves wrong: it invented `credentials.json` and
    // `.credentials`, which no adapter here seeds, while missing qwen's
    // `oauth_creds.json`, which is real auth material.
    //
    //   auth   -> direct authentication material
    //   config -> not a credential, but capable of carrying one (a codex
    //             config.toml can define MCP servers whose env blocks hold API
    //             keys, which is the original threat in this whole design)
    // Derived from what the producer manifests actually seed or write, checked
    // entry by entry against src/adapters/builtin/*.json. Two entries here were
    // empty while their manifests plainly seed auth -- opencode-config and
    // grok-home -- which left unlink ordering and auth counts wrong on any
    // machine that had used those adapters.
    homes: {
      // seeds auth.json (if-missing) + version.json (if-exists); config.toml is
      // written by codex itself and can define MCP servers whose env blocks
      // carry API keys.
      "codex-home": { "auth.json": "auth", "config.toml": "config" },
      // seeds oauth_creds.json; settings.json is written by our own
      // effort-delivery path.
      "qwen-home": { "oauth_creds.json": "auth", "settings.json": "config" },
      // seeds auth.json (if-exists).
      "opencode-config": { "auth.json": "auth" },
      "opencode-data": {},
      // seeds nothing, but we set GOOSE_DISABLE_KEYRING=1, which is precisely
      // what pushes goose to keep secrets in its config file instead.
      "goose-root": { "config.yaml": "config" },
      // seeds auth.json (if-missing) + trusted_folders.toml (if-exists); the
      // latter is a path allowlist, not secret-bearing, so it stays ordinary.
      "grok-home": { "auth.json": "auth" },
    },
  },
];
// NOTE: `claude-home` is deliberately absent. Nothing in this repository or its
// history ever generated it -- the claude adapter has `configIsolation: null`
// and isolates via an empty MCP config instead. An exact-name ledger is only
// safe while every name is one dualog actually wrote; a plausible-looking
// invention is a licence to delete a directory somebody else created.

/** Flattened view of the ledger: name -> { version, sensitive }. */
export function ledgerNames() {
  const out = new Map();
  for (const entry of SCRATCH_LEDGER) {
    for (const [name, sensitive] of Object.entries(entry.homes)) {
      if (!out.has(name)) out.set(name, { version: entry.version, sensitive });
    }
  }
  return out;
}

/** Both roots a session can live under. The legacy one is read, never written. */
export function scratchRoots() {
  return [dialogsDir(), legacyDialogsDir()];
}

/**
 * Read a record as `missing | valid | invalid`, never as "null".
 *
 * A single null for "absent", "unreadable" and "corrupt" is how this module
 * broke its own rule: a malformed `status.json` parsed to null, the runner
 * check found no pid, and the session was declared inactive and cleaned. A file
 * that EXISTS but cannot be understood is the strongest possible signal that
 * something was mid-write or crashed -- the one case where deleting is least
 * safe.
 */
function readRecord(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { state: "missing", value: null };
    return { state: "invalid", value: null, reason: `${path.basename(file)} could not be read (${err.code})` };
  }
  try {
    const value = JSON.parse(text);
    // Arrays are objects to `typeof`, and every reader below indexes named
    // fields -- so `[]` parsed cleanly, produced `undefined` for runner_pid,
    // and read as "no runner recorded". A record that is not a plain object is
    // not a record we understand.
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { state: "invalid", value: null, reason: `${path.basename(file)} is not a JSON object` };
    }
    return { state: "valid", value };
  } catch {
    return { state: "invalid", value: null, reason: `${path.basename(file)} is not valid JSON` };
  }
}

/**
 * Can every process this session recorded be PROVEN gone?
 *
 * Returns `{ inactive, reason }`. `inactive: false` with a reason is the answer
 * for both "something is alive" and "cannot tell" -- the caller treats them
 * identically, and the reason distinguishes them in the receipt.
 */
export function proveSessionInactive(sessionDir) {
  const block = (reason) => ({ inactive: false, reason });

  // --- the runner ------------------------------------------------------------
  //
  // Deliberately NOT isSessionRunnerAlive(): that predicate answers "not alive"
  // whenever it cannot read a process command line, which is right for deciding
  // whether to SIGNAL something and wrong for deciding whether to DELETE. A
  // live pid blocks here regardless of whether we can prove it is ours.
  const status = readRecord(path.join(sessionDir, "status.json"));
  if (status.state === "invalid") return block(status.reason);
  // Every producer writes status.json BEFORE spawning anything, so a session
  // holding a scratch home with no status is not a session that finished
  // cleanly -- it is one we have no evidence about at all.
  if (status.state === "missing") return block("status.json is absent, so nothing can be proven about this session");

  {
    const { runner_state: runnerState, runner_pid: runnerPid } = status.value;

    // THE STARTUP RACE, and the reason a pid check alone is not enough.
    //
    // start_dialog/start_code_review write `runner_state: "starting"` with no
    // pid, THEN spawn the detached runner, and only then record its pid. The
    // runner reaches runPartnerCommand() -- which creates and seeds the config
    // home with real credentials -- inside that window. A sweep that reads
    // `starting` + null pid, finds no terminal record and no headless record
    // yet, and concludes "inactive" will delete a live partner's home moments
    // after it was created. Re-proving before deletion returns the same wrong
    // answer, because the status has not changed.
    // runner_state is an ENUM, and anything outside it is unknown -- therefore
    // blocking. Special-casing the states we recognize and letting the rest
    // fall through inverted that: `{runner_state: "paused"}`, `null` and `42`
    // all reached the pid check, found none, and read as inactive. Producers
    // write exactly three values; a fourth means either a future version wrote
    // this file or the file is not what we think it is, and neither is grounds
    // to delete.
    if (runnerState === "starting") {
      return block('runner_state is "starting": a runner may be spawning right now');
    }
    if (runnerState === "running") {
      if (!Number.isSafeInteger(runnerPid) || runnerPid <= 0) {
        return block('runner_state is "running" but no usable runner_pid is recorded');
      }
    } else if (runnerState === "exited") {
      // The recorded exit is the evidence; runner_pid is cleared on this path,
      // so a lingering non-null value contradicts the state.
      if (runnerPid != null && !Number.isSafeInteger(runnerPid)) {
        return block(`runner_state is "exited" with an unusable runner_pid ${JSON.stringify(runnerPid)}`);
      }
    } else if (runnerState === undefined) {
      // A pre-`runner_state` status is only trusted when it carries the field
      // the old rule depends on. Without it there is nothing to check.
      if (!("runner_pid" in status.value)) {
        return block("status.json records neither runner_state nor runner_pid");
      }
    } else {
      return block(`runner_state ${JSON.stringify(runnerState)} is not a state this version understands`);
    }

    if (runnerPid != null) {
      const probe = probeProcess(runnerPid);
      if (probe === "alive") return block(`pid ${runnerPid} is alive`);
      if (probe !== "absent") {
        return block(`recorded runner_pid ${JSON.stringify(runnerPid)} could not be probed (${probe})`);
      }
    }
  }

  // --- the tmux terminal -----------------------------------------------------
  //
  // A runner's SIGTERM path deliberately PRESERVES an active pane, so "the
  // runner is gone" does not imply the partner is. The handle is
  // `session_name`: the record is FLAT and carries no pid, which is why an
  // earlier version of this check -- looking for `terminal.current.pid` -- was
  // inert against every file the product actually writes.
  const terminal = readRecord(path.join(sessionDir, "current_terminal.json"));
  if (terminal.state === "invalid") return block(terminal.reason);
  if (terminal.state === "valid") {
    const sessionName = terminal.value.session_name;
    const probe = probeTmuxSession(sessionName);
    if (probe === "alive") return block(`tmux session ${sessionName} is still running`);
    if (probe !== "absent") {
      // Includes tmux being unavailable, which is NOT evidence the pane is gone.
      return block(
        sessionName
          ? `tmux session ${sessionName} could not be checked (${probe})`
          : "a current terminal is recorded with no session_name to check"
      );
    }
  }

  // --- headless children -----------------------------------------------------
  //
  // Inspected, never signalled.
  const headless = readHeadlessRecords(sessionDir);
  if (headless.blocked) return block(headless.blocked);
  for (const record of headless.records) {
    const { pid, pgid } = record;

    // A record that EXISTS must describe a process. `{}` is not "no child
    // record" -- writeChildRecord() always writes a pid, so an entry without
    // one is a partial or corrupt write, which is the state where a child is
    // most likely to be running.
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return block(`a headless-child record has no usable pid (${JSON.stringify(pid)})`);
    }
    const probe = probeProcess(pid);
    if (probe === "alive") return block(`headless child ${pid} is alive`);
    if (probe !== "absent") return block(`headless child pid ${pid} could not be probed (${probe})`);

    if (process.platform !== "win32") {
      if (!Number.isSafeInteger(pgid) || pgid <= 0) {
        return block(`a headless-child record has no usable pgid (${JSON.stringify(pgid)})`);
      }
      const groupProbe = probeGroup(pgid);
      if (groupProbe === "alive") return block(`headless group ${pgid} still has members`);
      if (groupProbe !== "absent") return block(`headless group ${pgid} could not be probed (${groupProbe})`);
    }
  }

  return { inactive: true, reason: null };
}

/**
 * Every recorded headless child, or the reason we must not proceed.
 *
 * An unreadable `turns` directory used to look identical to a session that
 * never ran a headless turn. It is not: it is a directory we cannot enumerate,
 * which may contain records of processes that are still running.
 */
function readHeadlessRecords(sessionDir) {
  const turnsDir = path.join(sessionDir, "turns");
  const records = [];
  let entries;
  try {
    entries = fs.readdirSync(turnsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return { records, blocked: null };
    return { records, blocked: `turns/ could not be listed (${err.code})` };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = readRecord(path.join(turnsDir, entry.name, "headless-child.json"));
    if (record.state === "invalid") {
      return { records, blocked: `turns/${entry.name}/${record.reason}` };
    }
    if (record.state === "valid") records.push(record.value);
  }
  return { records, blocked: null };
}

function directorySize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // lstat, and never descend a link: a link's target is somebody else's
      // data and must not be counted, let alone removed.
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        files += 1;
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else {
        bytes += stat.size;
        files += 1;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/**
 * The sensitive files this home holds, as exact paths. DIRECT CHILDREN ONLY.
 *
 * Two reasons it is not recursive, both learned the hard way.
 *
 * The ledger describes files dualog SEEDED, and seeding writes direct children.
 * A recursive basename match invents authority the ledger never granted -- it
 * would nominate any nested `config.toml` a CLI happened to write, at a path
 * nobody declared.
 *
 * And these paths are used for the unlink-first pass, which runs after the
 * target has been re-`lstat`ed. Re-checking the top level cannot vouch for an
 * intermediate directory: if `codex-home/sessions` became a symlink between
 * planning and applying, unlinking a recorded path beneath it would follow that
 * link out of the target. Direct children have no intermediate component to
 * subvert.
 *
 * The whole-directory removal that follows is the actual secret guarantee; this
 * pass only orders the work so an interruption leaves the worst part done.
 */
function findSensitiveFiles(dir, sensitive) {
  const found = { auth: [], config: [] };
  if (!sensitive || Object.keys(sensitive).length === 0) return found;

  for (const [name, kind] of Object.entries(sensitive)) {
    if (kind !== "auth" && kind !== "config") continue;
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue; // a link or a directory is not a seeded file
    found[kind].push(full);
  }
  return found;
}

/**
 * Everything the sweep would touch, with nothing touched.
 *
 * This is the whole of the dry run: `sweepScratch()` acts on exactly this plan
 * and computes nothing extra, so what a report shows is what a deletion does.
 */
export function planScratchSweep({ roots = scratchRoots() } = {}) {
  const names = ledgerNames();
  const plan = {
    roots: [],
    sessions: [],
    totals: { sessions: 0, targets: 0, bytes: 0, files: 0, auth: 0, config: 0, skipped: 0 },
  };

  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      plan.roots.push({ root, present: false, sessions: 0 });
      continue;
    }
    plan.roots.push({ root, present: true, sessions: entries.length });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionId = entry.name;
      // Only the exact shape the server generates. A directory that is not
      // recognizably ours is left alone even inside our own root.
      if (!GENERATED_SESSION_ID.test(sessionId)) continue;

      const sessionDir = path.join(root, sessionId);
      const targets = [];
      for (const [name, { version, sensitive }] of names) {
        const full = path.join(sessionDir, name);
        let stat;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        // A symlink where a generated home should be is not something this
        // sweep created, and following it would delete elsewhere.
        if (stat.isSymbolicLink()) {
          targets.push({
            name, path: full, version, symlink: true,
            bytes: 0, files: 0, sensitiveFiles: { auth: [], config: [] },
          });
          continue;
        }
        if (!stat.isDirectory()) continue;
        const { bytes, files } = directorySize(full);
        targets.push({
          name,
          path: full,
          version,
          symlink: false,
          bytes,
          files,
          sensitiveFiles: findSensitiveFiles(full, sensitive),
        });
      }
      if (targets.length === 0) continue;

      const { inactive, reason } = proveSessionInactive(sessionDir);
      const record = { sessionId, sessionDir, root, inactive, reason, targets };
      plan.sessions.push(record);

      plan.totals.sessions += 1;
      if (!inactive) {
        plan.totals.skipped += 1;
        continue;
      }
      for (const target of targets) {
        if (target.symlink) continue;
        plan.totals.targets += 1;
        plan.totals.bytes += target.bytes;
        plan.totals.files += target.files;
        plan.totals.auth += target.sensitiveFiles.auth.length;
        plan.totals.config += target.sensitiveFiles.config.length;
      }
    }
  }

  return plan;
}

/**
 * Execute a plan. `apply` must be passed explicitly -- there is no default that
 * deletes.
 *
 * Returns a receipt: what was removed, what was skipped and why, and what
 * failed. Auditable and re-runnable; the sweep is idempotent because a target
 * that no longer exists simply drops out of the next plan.
 */
export function sweepScratch({ apply = false, roots = scratchRoots(), plan: given = null, log } = {}) {
  // The caller may pass the plan it already built and displayed. It used to
  // build its own unconditionally, which meant the CLI walked 12 GiB to print a
  // report and this walked it again to act -- and, worse, acted on a DIFFERENT
  // snapshot from the one the operator was shown. The per-session re-proof
  // below is what makes acting on an older plan safe.
  const plan = given ?? planScratchSweep({ roots });
  const receipt = {
    applied: Boolean(apply),
    started_at: new Date().toISOString(),
    removed: [],
    skipped: [],
    errors: [],
    // `planned` is what the snapshot found; `removed_*` is what actually
    // happened. Reporting one as the other lets a failed rmSync be announced as
    // a deletion.
    planned: { ...plan.totals },
    totals: { removed_bytes: 0, removed_targets: 0, removed_auth: 0, removed_config: 0 },
  };

  for (const session of plan.sessions) {
    if (!session.inactive) {
      receipt.skipped.push({
        sessionId: session.sessionId,
        reason: session.reason,
        targets: session.targets.map((t) => t.name),
      });
      continue;
    }

    // A PLAN IS A SNAPSHOT, NOT A LEASE.
    //
    // Sizing 12 GiB takes real time, during which a session that was idle can
    // acquire a runner or have a pane reattached. Acting on liveness measured
    // before that walk is acting on a claim that has since expired, so it is
    // re-proved here, immediately before the first unlink of this session.
    if (apply) {
      const recheck = proveSessionInactive(session.sessionDir);
      if (!recheck.inactive) {
        receipt.skipped.push({
          sessionId: session.sessionId,
          reason: `became active after the plan was built: ${recheck.reason}`,
          targets: session.targets.map((t) => t.name),
        });
        continue;
      }
    }

    for (const target of session.targets) {
      if (target.symlink) {
        receipt.skipped.push({
          sessionId: session.sessionId,
          reason: `${target.name} is a symbolic link; refusing to follow it`,
          targets: [target.name],
        });
        continue;
      }

      if (!apply) {
        receipt.removed.push({ ...target, sessionId: session.sessionId, dryRun: true });
        receipt.totals.removed_bytes += target.bytes;
        receipt.totals.removed_targets += 1;
        receipt.totals.removed_auth += target.sensitiveFiles.auth.length;
        receipt.totals.removed_config += target.sensitiveFiles.config.length;
        continue;
      }

      // And re-check the target itself: it may have been replaced by a link, or
      // removed, since it was sized.
      let stat;
      try {
        stat = fs.lstatSync(target.path);
      } catch (err) {
        if (err.code !== "ENOENT") {
          receipt.errors.push({ sessionId: session.sessionId, path: target.path, error: err.message });
        }
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        receipt.skipped.push({
          sessionId: session.sessionId,
          reason: `${target.name} is no longer a plain directory; refusing to remove it`,
          targets: [target.name],
        });
        continue;
      }

      try {
        // REDISCOVERED here, not reused from the plan. The plan's paths were
        // valid when it was built; between then and now the home may have been
        // rearranged, and unlinking a remembered path is acting on a claim
        // about the filesystem that is no longer being checked. Rediscovery is
        // cheap -- it is a handful of lstat calls on direct children.
        const sensitive = findSensitiveFiles(
          target.path,
          ledgerNames().get(target.name)?.sensitive
        );
        // Sensitive files first, so an interrupted removal has already dealt
        // with the part that matters. Then the directory -- which is the actual
        // guarantee, because a CLI writes secrets in more places than any list
        // enumerates.
        for (const file of [...sensitive.auth, ...sensitive.config]) {
          try {
            fs.unlinkSync(file);
          } catch {
            /* already gone, or not a plain file */
          }
        }
        fs.rmSync(target.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        receipt.removed.push({ ...target, sessionId: session.sessionId, dryRun: false });
        receipt.totals.removed_bytes += target.bytes;
        receipt.totals.removed_targets += 1;
        receipt.totals.removed_auth += target.sensitiveFiles.auth.length;
        receipt.totals.removed_config += target.sensitiveFiles.config.length;
        log?.(`removed ${target.path} (${formatBytes(target.bytes)})`);
      } catch (err) {
        receipt.errors.push({ sessionId: session.sessionId, path: target.path, error: err.message });
      }
    }
  }

  receipt.finished_at = new Date().toISOString();
  return receipt;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
