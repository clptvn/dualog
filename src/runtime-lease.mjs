// Per-turn runtime leases: where a partner CLI's credentials actually live.
//
// THE PROBLEM THIS EXISTS FOR. Config isolation pointed a partner CLI's home at
// `<sessionDir>/<agent>-home` and seeded it with that CLI's real credentials. A
// session directory is an ARCHIVE -- transcript, status, diagnostics, kept so a
// conversation can be reread months later -- so every session ever run retained
// a live credential copy. 176 of them, 12 GiB, one of which reached a public
// repository's working tree. Containment stopped new copies landing OUTSIDE a
// session; it left every copy INSIDE one, forever, because the directory holding
// them is one whose whole purpose is to be kept.
//
// Separating the roots is the actual fix. A lease is disposable by construction:
// nothing under `~/.dualog/runtime` is ever worth reading later, so it can be
// removed the moment its process is proven gone.
//
// WHY PER TURN, NOT PER SESSION. runPartnerCommand() starts a fresh partner
// process for every turn and takes its tmux pane down when the turn completes.
// The runner then sits idle -- for up to 24 hours -- with no partner CLI running
// at all. A session-scoped lease would hold credentials on disk across that
// entire idle window for a process that exited hours earlier. Per-turn scope
// makes the lease lifetime equal the lifetime of the thing that needs it.
//
// THE STATE MACHINE IS A CONSERVATIVE UPPER BOUND on what may already have
// happened, never an optimistic description written afterwards. Each state is
// recorded BEFORE the hazard it describes, so a crash is read as "this may have
// occurred" rather than "this did not":
//
//   allocated   directory + metadata + turn pointer exist; nothing copied yet
//   projecting  written BEFORE the first seed copy; secrets may be partially there
//   ready       projection finished; no process-creating call has been made
//   spawning    written BEFORE tmux new-session / spawn(); a consumer may exist
//               with no recorded identity yet
//   active      a consumer identity is recorded (tmux session name, or pid/pgid)
//   released    consumer proven absent; removal authorized
//
// Writing `projecting` only after the copies complete would leave a
// crash-during-copy lease labelled `allocated`, which claims no secret can be
// present when one can. Deletion would still be process-safe, but the accounting
// would lie -- and the accounting is what a person reads when deciding whether
// this machine is clean.

import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
  assertManagedLeasePath,
  assertManagedRootPath,
  isValidLeaseId,
  leaseDir,
  runtimeDir,
} from "./platform.mjs";
import { probeGroup, probeProcess } from "./process-probe.mjs";
import { probeTmuxSessionSync } from "./tmux-runtime.mjs";

const LEASE_SCHEMA_VERSION = 1;
const META_FILE = "lease.json";
/** The turn directory's only record of its lease: an opaque id, nothing else. */
const POINTER_FILE = "runtime-lease.json";

export const LEASE_STATES = [
  "allocated",
  "projecting",
  "ready",
  "spawning",
  "active",
  "released",
];

/**
 * WHY A BOOT IDENTITY EXISTS AT ALL.
 *
 * The `spawning` window is unavoidable: there is no portable proof that a
 * spawn() did not happen, so a lease that dies there must be retained. Without
 * an escape hatch that retention is PERMANENT, and "a crash cannot make a
 * credential projection permanent" would be false. No tmux pane and no child
 * process survives a reboot, so identifying the boot is what turns conservative
 * retention into something that eventually clears.
 */

/**
 * How far two UPTIME-DERIVED boot epochs may differ and still be one boot.
 *
 * Wide on purpose. `Date.now() - os.uptime()` is arithmetic over the wall clock,
 * so an NTP correction or a suspend/resume moves it -- and the unsafe direction
 * is concluding "different boot", which authorizes deletion. A minute of slop
 * was not enough margin for that. Being too generous only costs self-healing
 * speed; being too strict deletes a live turn's credentials.
 */
const IMPRECISE_BOOT_TOLERANCE_SECONDS = 3600;

let cachedBootIdentity;

/**
 * Identify this boot, preferring something the OS actually tracks.
 *
 * Cached because it cannot change within a process, and a sweep would otherwise
 * spawn a sysctl per lease.
 */
export function bootIdentity() {
  if (cachedBootIdentity !== undefined) return cachedBootIdentity;
  cachedBootIdentity = computeBootIdentity();
  return cachedBootIdentity;
}

function computeBootIdentity() {
  let host;
  try {
    host = os.hostname();
  } catch {
    return null;
  }

  // Carried by EVERY form, precise or not. A lease recorded before precise
  // identities existed has only this field, and without a counterpart on the
  // current identity there would be nothing to compare it against -- so those
  // records would answer `null` forever and never heal.
  let bootedAtEpoch = null;
  try {
    const uptime = os.uptime();
    if (Number.isFinite(uptime) && uptime >= 0) {
      bootedAtEpoch = Math.round(Date.now() / 1000 - uptime);
    }
  } catch {}

  // Linux: a real per-boot UUID, exact by construction.
  try {
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    if (bootId) return { host, id: bootId, bootedAtEpoch, source: "boot-id", precise: true };
  } catch {}

  // macOS/BSD: the kernel's own boot timestamp, to the microsecond.
  try {
    const out = execFileSync("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sec = /sec\s*=\s*(\d+)/.exec(out);
    if (sec) {
      return { host, id: `kern.boottime:${sec[1]}`, bootedAtEpoch, source: "kern.boottime", precise: true };
    }
  } catch {}

  // Fallback: derived from the wall clock, so NOT precise. Both calls can THROW
  // rather than return something unusable -- a restricted host raises
  // `uv_uptime returned EPERM` from os.uptime(), which propagated out of
  // allocateLease() and made every lease-backed adapter unstartable there.
  if (bootedAtEpoch == null) return null;
  return { host, bootedAtEpoch, source: "uptime", precise: false };
}

/**
 * Same machine, same boot? `null` when it cannot be established.
 *
 * `false` is the answer that authorizes deletion, so every uncertain case has to
 * resolve to `true` or `null` instead. Two identities compare exactly only when
 * BOTH came from something the OS tracks; a wall-clock-derived one on either
 * side falls back to a wide tolerance, because the difference between "rebooted"
 * and "the clock was corrected" is not visible in that number.
 */
export function isSameBoot(recorded, current = bootIdentity()) {
  if (!recorded || !current) return null;
  if (recorded.host !== current.host) return false;

  if (recorded.precise === true && current.precise === true) {
    return recorded.id === current.id;
  }

  // Records written before this carried no `source`, so an absent one is the
  // imprecise form rather than an unknown one.
  const recordedEpoch = recorded.bootedAtEpoch;
  const currentEpoch = current.bootedAtEpoch;
  if (!Number.isFinite(recordedEpoch) || !Number.isFinite(currentEpoch)) return null;
  return Math.abs(recordedEpoch - currentEpoch) <= IMPRECISE_BOOT_TOLERANCE_SECONDS;
}

function writeJsonExclusive(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

/**
 * Replace a metadata file atomically.
 *
 * The temp file carries the mode explicitly. A 0600 destination is no protection
 * if the temp it was renamed from was briefly created as 0644 under the process
 * umask -- the window is short, but it is a window in which a credential-bearing
 * record is world-readable.
 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid", value: null, reason: `${path.basename(file)} is not a JSON object` };
    }
    return { state: "valid", value: parsed };
  } catch (err) {
    if (err.code === "ENOENT") return { state: "missing", value: null };
    return {
      state: "invalid",
      value: null,
      reason: `${path.basename(file)} could not be read (${err.code || err.message})`,
    };
  }
}

/**
 * Create a lease for one turn.
 *
 * The directory is created with EXCLUSIVE semantics (no `recursive`), so two
 * callers can never believe they own the same lease, and the pointer is written
 * with `wx` for the same reason -- silently overwriting a turn's existing
 * pointer would orphan the lease it referred to, which is precisely how an
 * unowned credential copy comes to exist.
 *
 * Metadata and pointer are written BEFORE any secret is copied. A lease that
 * exists with no metadata is unattributable, and an unattributable directory
 * holding credentials is the state this whole module exists to prevent.
 */
export function allocateLease({ sessionId, turnId, agent, engine, turnDir, runnerPid = process.pid }) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("allocateLease: sessionId is required");
  }
  if (!turnDir || typeof turnDir !== "string") {
    throw new Error("allocateLease: turnDir is required");
  }

  // BEFORE the mkdir: `recursive: true` would happily create through a
  // symlinked `~/.dualog`, and every later per-path assertion measures against
  // a root it has already been redirected by.
  const root = runtimeDir();
  assertManagedRootPath(root, { fn: "allocateLease", label: "runtime root" });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Re-prove the root AFTER creating it. The check above and this mkdir are two
  // syscalls, and `recursive: true` follows whatever it finds -- so a root
  // swapped for a symlink in between would already have been followed. Node
  // exposes no openat/O_NOFOLLOW, so the window cannot be closed outright; this
  // makes it detectable before anything is written INTO the root, which is the
  // part that matters. Every later write re-checks through assertManagedLeasePath.
  assertManagedRootPath(root, { fn: "allocateLease", label: "runtime root" });
  // mkdir's mode is masked by the umask, so an existing or freshly created root
  // can still be group/world readable. Say it explicitly.
  try {
    fs.chmodSync(root, 0o700);
  } catch {}

  const id = crypto.randomBytes(16).toString("hex");
  const dir = leaseDir(id);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const meta = {
    schema_version: LEASE_SCHEMA_VERSION,
    lease_id: id,
    state: "allocated",
    session_id: sessionId,
    turn_id: turnId ?? null,
    turn_dir: turnDir,
    agent: agent ?? null,
    engine: engine ?? null,
    runner_pid: Number.isSafeInteger(runnerPid) ? runnerPid : null,
    boot: bootIdentity(),
    consumer: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(dir, META_FILE), meta);

  // The pointer is the durable side's ONLY knowledge of the lease. Everything
  // needed to reap it lives in the lease's own metadata, so a deleted session
  // archive cannot strand a live projection.
  try {
    writeJsonExclusive(path.join(turnDir, POINTER_FILE), {
      schema_version: LEASE_SCHEMA_VERSION,
      lease_id: id,
    });
  } catch (err) {
    // Roll the lease back: it has no secrets yet and nothing points at it.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    throw new Error(
      `allocateLease: could not record the lease pointer in ${turnDir} (${err.code || err.message}). ` +
        `Refusing to leave a lease nothing references.`
    );
  }

  // `owned` marks a handle this process created, which is authority that
  // survives the metadata becoming unreadable. Deliberately not persisted: it is
  // a fact about this process, and a flag on disk would let any reader claim it.
  return { id, dir, metaPath: path.join(dir, META_FILE), turnDir, owned: true };
}

/** Advance a lease's state, optionally recording its consumer's identity. */
export function transitionLease(lease, state, { consumer = undefined } = {}) {
  if (!LEASE_STATES.includes(state)) {
    throw new Error(`transitionLease: ${JSON.stringify(state)} is not a lease state`);
  }
  const metaPath = lease.metaPath ?? path.join(lease.dir, META_FILE);
  const record = readJson(metaPath);
  if (record.state !== "valid") {
    throw new Error(`transitionLease: ${metaPath} is unreadable (${record.reason ?? record.state})`);
  }
  const next = {
    ...record.value,
    state,
    ...(consumer === undefined ? {} : { consumer }),
    updated_at: new Date().toISOString(),
  };
  writeJsonAtomic(metaPath, next);
  return next;
}

/**
 * Resolve a path inside a lease, proving containment first.
 *
 * The same boundary configIsolation gets against a session directory. A lease is
 * created by us and named by us, so an escape here would have to come from a
 * manifest template -- which is exactly the input this cannot trust.
 */
export function leasePath(lease, candidate, { fn = "leasePath" } = {}) {
  return assertManagedLeasePath(lease.dir, candidate, { fn });
}

/**
 * Is this lease's consumer PROVEN gone?
 *
 * Returns `{ removable, reason }`. As everywhere else in this codebase, the
 * unprovable answer is the retaining one -- but the reasons differ from the
 * session sweep's, which is why this is not proveSessionInactive(). A live,
 * idle session runner does not block reclaiming a completed turn's lease; a
 * `spawning` lease with no identity does, even though nothing can be shown to
 * be running.
 */
export function proveLeaseReleasable(meta, { now = Date.now() } = {}) {
  const keep = (reason) => ({ removable: false, reason });
  if (!meta || typeof meta !== "object") return keep("lease metadata is unreadable");

  const state = meta.state;
  if (!LEASE_STATES.includes(state)) {
    return keep(`lease state ${JSON.stringify(state)} is not one this version understands`);
  }

  // Nothing has been spawned, by the API's own invariant: `spawning` is written
  // before any process-creating call. These are safe to remove regardless of
  // who owns them -- but only once the owner is gone, or we would delete a
  // projection out from under a turn that is still setting itself up.
  if (state === "allocated" || state === "projecting" || state === "ready") {
    const owner = probeOwner(meta);
    if (owner === "alive") return keep(`the owning runner (pid ${meta.runner_pid}) is still alive`);
    if (owner !== "absent") return keep(`the owning runner could not be probed (${owner})`);
    return { removable: true, reason: null };
  }

  if (state === "released") return { removable: true, reason: null };

  // `spawning` or `active`: a consumer may exist. Its identity decides.
  //
  // A consumer RECORD without a usable identity is not an identity -- it is the
  // identity-less case wearing an object. The headless engine writes
  // `{kind: "headless"}` before spawn() and fills in the pid after, so a crash
  // in between left a record that probed `unknown` forever: it never reached the
  // boot check below, so it was retained across reboots and on any host where a
  // boot identity cannot be established. Falling through fixes that.
  const consumer = hasUsableIdentity(meta.consumer) ? meta.consumer : null;
  if (consumer) {
    const verdict = probeConsumer(consumer);
    if (verdict === "alive") return keep("the lease's consumer is still running");
    if (verdict !== "absent") {
      return keep(`the lease's consumer could not be probed (${verdict})`);
    }

    // ABSENT MEANS DIFFERENT THINGS IN THE TWO STATES.
    //
    // In `active` it is proof the consumer finished: that state is written only
    // after the process-creating call RETURNED, so the pane or process
    // definitely existed and is now gone.
    //
    // In `spawning` it is ambiguous, and reading it as proof was a real defect.
    // The tmux identity is deliberately recorded BEFORE startTmuxSession() --
    // that is what removes the identity-less crash window -- so between those
    // two statements the session name is legitimately absent because the pane
    // has not been created YET. A sweep landing in that window found "consumer
    // absent", deleted the lease with its freshly seeded credentials, and left
    // the partner launching against a home that no longer existed.
    //
    // So a spawning lease additionally requires its OWNER to be gone -- and
    // then one more thing, because the owner is not the only process that can
    // still create the pane. See below.
    if (state === "spawning") {
      const owner = probeOwner(meta);
      if (owner === "alive") {
        return keep("the owning runner is still spawning this lease's consumer");
      }
      if (owner !== "absent") {
        return keep(`a spawn may be in progress and the owning runner could not be probed (${owner})`);
      }
      // OWNER GONE, CONSUMER ABSENT -- and that is still not proof.
      //
      // startTmuxSession() creates the pane by running tmux through an
      // execFile child, which is NOT the runner and outlives a SIGKILLed one.
      // Kill the runner in that window and both probes read absent while a
      // helper is about to create the pane; deleting here hands the partner a
      // home that no longer exists. Nothing observable distinguishes "the
      // helper died too" from "the helper is a millisecond away", so on this
      // boot the answer is retain. A previous boot settles it: no helper and no
      // pane survives a reboot.
      if (isSameBoot(meta.boot) !== false) {
        return keep(
          "the owning runner is gone but a spawn helper it started may still be in flight on this boot"
        );
      }
    }
    return { removable: true, reason: null };
  }

  // `spawning` with no identity: the unavoidable crash window. A spawn may have
  // happened and we have no handle on what it produced, so on this boot the only
  // safe answer is to retain.
  const sameBoot = isSameBoot(meta.boot);
  if (sameBoot === false) {
    // A previous boot. Nothing it started can still exist, which is what makes
    // conservative retention self-healing rather than permanent.
    return { removable: true, reason: null };
  }
  if (sameBoot === null) {
    return keep("the lease records no usable boot identity, so a spawn cannot be ruled out");
  }
  return keep("a spawn may have begun and no consumer identity was recorded");
}

/**
 * Does this consumer record actually name something probeable?
 *
 * A record is written BEFORE the thing it describes exists -- that is what makes
 * the state machine a conservative upper bound -- so "there is a consumer object"
 * and "there is something to probe" are different questions, and treating them
 * as one is how a kind-only headless record came to be retained forever.
 */
function hasUsableIdentity(consumer) {
  if (!consumer || typeof consumer !== "object") return false;
  if (consumer.kind === "tmux") {
    return typeof consumer.session_name === "string" && consumer.session_name.length > 0;
  }
  if (consumer.kind === "headless") {
    return Number.isSafeInteger(consumer.pid) && consumer.pid > 0;
  }
  // A kind this version does not know cannot be probed, so it is not an
  // identity. The boot check still reclaims it after a restart.
  return false;
}

function probeOwner(meta) {
  if (meta.runner_pid == null) {
    // No owner recorded. If it belongs to a previous boot nothing of it survives.
    return isSameBoot(meta.boot) === false ? "absent" : "unknown";
  }
  const verdict = probeProcess(meta.runner_pid);
  if (verdict === "invalid") return "unknown";
  return verdict;
}

/**
 * Is this lease's consumer still running?
 *
 * KNOWN LIMITATION, stated rather than implied. The process group is the widest
 * boundary reachable without a supervisor, and it is not the same thing as "no
 * descendant survives":
 *
 *   - a child that calls setsid() leaves the group and becomes invisible here;
 *   - on Windows there is no group at all. The headless engine spawns with
 *     `detached: false` there, so the direct pid is the only handle that exists,
 *     and a launcher which forks and exits reads as absent.
 *
 * In both cases a descendant could still hold the isolated home when the lease
 * is released. This is not a regression introduced by leases -- the pre-existing
 * headless orphan reaping has the identical boundary -- and closing it properly
 * needs a Job Object on Windows and a supervisor process on Unix, which is an
 * architectural change rather than a check. Recorded here so the next person
 * reads this as a known edge rather than as an oversight.
 *
 * The blast radius is bounded by what a released lease actually is: a partner
 * CLI whose config home vanishes fails its own turn. It does not affect the
 * user's real credentials, which are never moved, only copied from.
 */
function probeConsumer(consumer) {
  if (consumer.kind === "tmux") {
    if (typeof consumer.session_name !== "string" || !consumer.session_name) return "unknown";
    const session = probeTmuxSessionSync(consumer.session_name);
    if (session !== "absent") return session;
    // THE PANE BEING GONE IS NOT THE PROGRAM BEING GONE, and the difference was
    // observable on every single turn: codex flushes its models cache during
    // shutdown, after its pane has closed. Releasing on the session alone
    // deleted the home and the partner then recreated it, leaving a directory
    // with a valid lease name and no metadata that nothing could reclaim.
    //
    // pane_pid is that program -- the shell payload execs into the CLI -- so it
    // answers the question the session name cannot. Records written before this
    // existed carry no pane_pid; for those the session remains the only
    // available evidence, which is the previous behaviour rather than a new gap.
    if (consumer.pane_pid == null) return "absent";
    const pane = probeProcess(consumer.pane_pid);
    if (pane === "invalid") return "unknown";
    return pane;
  }
  if (consumer.kind === "headless") {
    const pidVerdict = probeProcess(consumer.pid);
    if (pidVerdict === "invalid") return "unknown";
    if (pidVerdict !== "absent") return pidVerdict;
    if (process.platform === "win32") return "absent";
    // The leader is gone, but a TERM-ignoring descendant can keep the group --
    // and the group is what holds the CLI that has our credentials open.
    const groupVerdict = probeGroup(consumer.pgid);
    if (groupVerdict === "invalid") return "unknown";
    return groupVerdict;
  }
  return "unknown";
}

/**
 * Remove a lease directory, re-proving it is ours immediately before unlinking.
 *
 * The checks are repeated here rather than trusted from allocation time: a lease
 * lives for the length of a turn, and the thing being deleted is a directory
 * tree in the user's home.
 */
export function removeLeaseDirectory(dir) {
  const resolved = path.resolve(dir);
  const id = path.basename(resolved);
  if (path.dirname(resolved) !== path.resolve(runtimeDir())) {
    throw new Error(`removeLeaseDirectory: ${resolved} is not directly under the runtime root`);
  }
  // Re-prove the ROOT here, in the operation that deletes, rather than trusting
  // a check made by whoever called us. The parent comparison above is lexical --
  // it says the path is SPELLED under the runtime root, not that it resolves
  // there -- so a root swapped for a symlink after the caller validated it would
  // send this rmSync into whatever the link points at, judging its target only
  // on whether the leaf name looks like a lease id.
  assertManagedRootPath(runtimeDir(), {
    fn: "removeLeaseDirectory",
    label: "runtime root",
  });
  if (!isValidLeaseId(id)) {
    throw new Error(`removeLeaseDirectory: ${JSON.stringify(id)} is not a lease id`);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`removeLeaseDirectory: ${resolved} is a symbolic link, not a lease`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`removeLeaseDirectory: ${resolved} is not a directory`);
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * Release a lease whose consumer is proven gone.
 *
 * Returns `{ released, reason }`. Never throws for the ordinary "still in use"
 * case: releasing is best-effort cleanup on paths that must not fail because a
 * pane outlived its turn.
 */
export function releaseLease(lease, { consumerAbsent = null } = {}) {
  const dir = lease?.dir;
  if (!dir || !fs.existsSync(dir)) return { released: false, reason: "lease directory is already gone" };

  const metaPath = lease.metaPath ?? path.join(dir, META_FILE);
  const record = readJson(metaPath);
  if (record.state !== "valid") {
    // NO METADATA, AND WE ARE THE OWNER. Observed in production: a partner CLI
    // outlived its own tmux pane, and after the lease was removed it recreated
    // `$CODEX_HOME` to flush a models cache -- leaving a directory with a valid
    // lease name, mode 0755, and no metadata. releaseLease() then reported
    // "lease metadata is unreadable" and retained it, and sweepLeases() retains
    // an unreadable lease forever, so nothing could ever reclaim it.
    //
    // A handle from allocateLease() in THIS process is proof of ownership that
    // does not depend on the metadata being readable, which is exactly the case
    // where the metadata is not. Anything else still refuses.
    if (lease.owned === true) {
      removeLeaseDirectory(dir);
      return { released: true, reason: null };
    }
    return { released: false, reason: record.reason ?? `lease metadata is ${record.state}` };
  }

  // THE OWNER RELEASING ITS OWN PRE-SPAWN LEASE IS AUTHORITATIVE.
  //
  // proveLeaseReleasable() retains a pre-spawn lease while its owner lives,
  // which is right for a sweep running in another process and exactly wrong
  // here: the owner IS the live runner, so it would refuse to clean up after
  // itself. A turn that failed during projection therefore left its partial
  // credential copy on disk for the rest of the session -- the runner only exits
  // at session end -- which is the condition per-turn leases exist to end.
  //
  // Sound because the API invariant says `spawning` is written before any
  // process-creating call, so in these three states nothing was started, and the
  // owner is the authority on whether it is giving up.
  if (record.state === "valid" && record.value.runner_pid === process.pid) {
    const preSpawn = ["allocated", "projecting", "ready"].includes(record.value.state);
    // `spawning` too, but only once the consumer is provably absent. The owner
    // has AWAITED its own spawn call by the time it releases, so unlike a
    // third-party sweep it knows no helper of its own is still in flight -- which
    // is the only thing that made "owner gone + consumer absent" unsafe. Without
    // this, a failed startTmuxSession() retained its lease until the next reboot.
    const failedSpawn =
      record.value.state === "spawning" &&
      probeConsumer(record.value.consumer ?? {}) === "absent";
    if (preSpawn || failedSpawn) {
      removeLeaseDirectory(dir);
      return { released: true, reason: null };
    }
  }

  // A caller that has just PROVEN the consumer absent -- the turn loop watching
  // its own tmux pane die -- knows something the metadata cannot express yet.
  if (consumerAbsent === true && record.state === "valid") {
    try {
      transitionLease({ dir, metaPath }, "released");
    } catch {
      // Metadata is advisory at this point; the proof came from the caller.
    }
    removeLeaseDirectory(dir);
    return { released: true, reason: null };
  }

  const verdict = proveLeaseReleasable(record.value);
  if (!verdict.removable) return { released: false, reason: verdict.reason };
  removeLeaseDirectory(dir);
  return { released: true, reason: null };
}

/** Read a lease's metadata by id, without trusting what is on disk. */
export function readLease(leaseId) {
  if (!isValidLeaseId(leaseId)) return null;
  const dir = leaseDir(leaseId);
  const metaPath = path.join(dir, META_FILE);
  const record = readJson(metaPath);
  if (record.state !== "valid") return null;
  return { id: leaseId, dir, metaPath, meta: record.value };
}

/** The lease a turn directory points at, if it recorded one. */
export function readTurnLease(turnDir) {
  const record = readJson(path.join(turnDir, POINTER_FILE));
  if (record.state !== "valid") return null;
  return readLease(record.value.lease_id);
}

/**
 * Sweep every lease whose consumer is proven gone.
 *
 * Reports rather than throws, and retains anything it cannot classify: an
 * unknown directory under the runtime root, malformed metadata, or a consumer
 * that cannot be probed are all left in place and named in the receipt.
 */
/**
 * How old an unattributable directory must be before the sweep may remove it.
 *
 * Deliberately far longer than any turn's setup: metadata is written
 * immediately after the mkdir, so a directory without it is not a lease being
 * allocated right now, and a day of margin means no ordinary operation can be
 * mistaken for an abandoned one.
 */
const UNATTRIBUTABLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Age of a lease directory in ms, or null when it cannot be established. */
function leaseDirectoryAge(dir, now) {
  try {
    const stat = fs.lstatSync(dir);
    // birthtime is unreliable on some filesystems (reported as 0 or as the
    // epoch); mtime is the conservative fallback because a directory being
    // written to keeps looking young, which retains rather than removes.
    const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    if (!Number.isFinite(born) || born <= 0) return null;
    return Math.max(0, now - born);
  } catch {
    return null;
  }
}

export function sweepLeases({
  apply = false,
  now = Date.now(),
  unattributableMaxAgeMs = UNATTRIBUTABLE_MAX_AGE_MS,
} = {}) {
  const root = runtimeDir();
  const receipt = { root, removed: [], retained: [], errors: [] };

  // This function DELETES directory trees, so it must prove the root it is
  // enumerating is the one we own and not a link pointing at someone's data.
  try {
    assertManagedRootPath(root, { fn: "sweepLeases", label: "runtime root" });
  } catch (err) {
    receipt.errors.push({ path: root, error: err.message });
    return receipt;
  }

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") receipt.errors.push({ path: root, error: err.message });
    return receipt;
  }

  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      receipt.retained.push({ dir, reason: "not a plain directory" });
      continue;
    }
    if (!isValidLeaseId(entry.name)) {
      receipt.retained.push({ dir, reason: "name is not a lease id" });
      continue;
    }
    const record = readJson(path.join(dir, META_FILE));
    if (record.state !== "valid") {
      // AN UNATTRIBUTABLE DIRECTORY NEEDS AN EXPIRY, or "retain what you cannot
      // classify" becomes "accumulate forever".
      //
      // This is not hypothetical: a partner CLI that outlived its pane recreated
      // its home after the lease was released, producing a directory with a
      // valid lease name and no metadata. Nothing could then reclaim it, because
      // every rule here keys off metadata that does not exist.
      //
      // Age is the only evidence available. The threshold is long enough that no
      // live turn can reach it -- a turn holding a lease this old has been
      // running for a day -- and metadata is written immediately after the mkdir,
      // so a directory that has none for that long is not a lease being set up.
      // `null` age means the directory could not be stat'd -- it vanished
      // between readdir and here, or the filesystem reports no usable times. It
      // is folded into the retaining branch rather than given its own: both
      // answers are "not old enough to be sure", and the unsafe direction would
      // be to treat an unknown age as expired. Reachable only through a
      // filesystem race, so no test drives it; the `||` is what keeps the
      // conservative direction from depending on that.
      const age = leaseDirectoryAge(dir, now);
      if (age == null || age < unattributableMaxAgeMs) {
        receipt.retained.push({
          dir,
          reason: `${record.reason ?? `metadata is ${record.state}`}; retained until it is ${Math.round(unattributableMaxAgeMs / 3600000)}h old`,
        });
        continue;
      }
      if (!apply) {
        receipt.removed.push({ dir, applied: false, reason: "unattributable and past its age limit" });
        continue;
      }
      try {
        removeLeaseDirectory(dir);
        receipt.removed.push({ dir, applied: true, reason: "unattributable and past its age limit" });
      } catch (err) {
        receipt.errors.push({ path: dir, error: err.message });
      }
      continue;
    }
    const verdict = proveLeaseReleasable(record.value);
    if (!verdict.removable) {
      receipt.retained.push({ dir, reason: verdict.reason });
      continue;
    }
    if (!apply) {
      receipt.removed.push({ dir, applied: false });
      continue;
    }
    try {
      removeLeaseDirectory(dir);
      receipt.removed.push({ dir, applied: true });
    } catch (err) {
      receipt.errors.push({ path: dir, error: err.message });
    }
  }
  return receipt;
}
