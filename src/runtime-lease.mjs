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
  sleepSync,
} from "./platform.mjs";
import { probeGroup, probeProcess, probeRecordedProcess } from "./process-probe.mjs";
import { probeDirectoryInUse } from "./directory-usage.mjs";
import { probeTmuxSessionSync, probeWslPaneProcess } from "./tmux-runtime.mjs";

const LEASE_SCHEMA_VERSION = 1;
/**
 * The lease record lives BESIDE the lease directory, not inside it.
 *
 * `<runtime>/<id>/` is the partner's; `<runtime>/<id>.lease.json` is ours. That
 * separation is the whole point: a partner that outlived its pane recreated
 * `$CODEX_HOME` after the lease was removed, and with the record inside the
 * directory that recreation produced something with no metadata at all -- which
 * no rule could classify, so nothing could reclaim it and ownership and age had
 * to stand in for a consumer proof. A record the consumer cannot reach means
 * there is always a real identity to probe.
 *
 * `LEGACY_META_FILE` is still read so leases created before this layout remain
 * judgeable rather than becoming unattributable by the upgrade itself.
 */
function metaPathFor(dir) {
  return `${dir}.lease.json`;
}
const LEGACY_META_FILE = "lease.json";

/**
 * Read a lease record, preferring the sibling and falling back to the legacy
 * in-directory copy.
 */
function readLeaseRecord(dir) {
  const sibling = readJson(metaPathFor(dir));
  if (sibling.state !== "missing") return { ...sibling, metaPath: metaPathFor(dir) };
  const legacy = readJson(path.join(dir, LEGACY_META_FILE));
  return { ...legacy, metaPath: path.join(dir, LEGACY_META_FILE) };
}
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

/**
 * How long to let a killed tmux client's queued work land before believing
 * "no pane exists". The tmux server is a separate process from the client we
 * ran, so the command can outlive the call that issued it.
 */
const SPAWN_SETTLE_MS = 400;

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

  // ONLY TWO PRECISE IDENTITIES MAY ANSWER `false`.
  //
  // `false` is the verdict that authorizes deletion, and wall-clock arithmetic
  // cannot support it: a suspend or an NTP step moves the derived epoch by an
  // arbitrary amount, and a hostname can change on a DHCP lease without any
  // reboot at all. Either would have read as "previous boot" and released a
  // lease whose child was alive. An imprecise or mixed comparison is now `null`
  // -- unknown, therefore retained -- which costs self-healing on hosts with no
  // OS boot identity and never costs a live turn its credentials.
  if (recorded.precise === true && current.precise === true) {
    // THE BOOT ID DECIDES, and it is checked FIRST.
    //
    // Putting the hostname test ahead of it made a rename read as a reboot: a
    // DHCP lease change leaves Linux `boot_id` and macOS `kern.boottime`
    // untouched, but `host !== host` returned `false` -- the verdict that
    // authorizes deletion -- so an identity-less lease could be reclaimed on the
    // current boot with its child still alive.
    if (recorded.id === current.id) return true;
    // Different ids on the same host is a genuine reboot. Different ids on a
    // DIFFERENT host says nothing about ours, so it is unknown rather than
    // false.
    return recorded.host === current.host ? false : null;
  }

  // The wall-clock epoch is still compared, but only to answer `true`: two
  // values close together are one boot, and two far apart establish nothing.
  const recordedEpoch = recorded.bootedAtEpoch;
  const currentEpoch = current.bootedAtEpoch;
  if (!Number.isFinite(recordedEpoch) || !Number.isFinite(currentEpoch)) return null;
  if (recorded.host !== current.host) return null;
  const sameWindow =
    Math.abs(recordedEpoch - currentEpoch) <= IMPRECISE_BOOT_TOLERANCE_SECONDS;
  return sameWindow ? true : null;
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
  writeJsonAtomic(metaPathFor(dir), meta);

  // The pointer is the durable side's ONLY knowledge of the lease. Everything
  // needed to reap it lives in the lease's own metadata, so a deleted session
  // archive cannot strand a live projection.
  try {
    writeJsonExclusive(path.join(turnDir, POINTER_FILE), {
      schema_version: LEASE_SCHEMA_VERSION,
      lease_id: id,
    });
  } catch (err) {
    // Roll the lease back: it has no secrets yet and nothing points at it. BOTH
    // halves go -- the record lives beside the directory now, so removing only
    // the directory would leave an orphan record describing a lease that never
    // existed.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    try {
      fs.unlinkSync(metaPathFor(dir));
    } catch {}
    throw new Error(
      `allocateLease: could not record the lease pointer in ${turnDir} (${err.code || err.message}). ` +
        `Refusing to leave a lease nothing references.`
    );
  }

  // `owned` marks a handle this process created, which is authority that
  // survives the metadata becoming unreadable. Deliberately not persisted: it is
  // a fact about this process, and a flag on disk would let any reader claim it.
  return { id, dir, metaPath: metaPathFor(dir), turnDir, owned: true };
}

/** Advance a lease's state, optionally recording its consumer's identity. */
export function transitionLease(lease, state, { consumer = undefined } = {}) {
  if (!LEASE_STATES.includes(state)) {
    throw new Error(`transitionLease: ${JSON.stringify(state)} is not a lease state`);
  }
  const record = readLeaseRecord(lease.dir);
  const metaPath = record.metaPath;
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
export function proveLeaseReleasable(meta, { now = Date.now(), dir = null } = {}) {
  const keep = (reason) => ({ removable: false, reason });

  /**
   * Every `removable` answer passes through here.
   *
   * Process identity reasons about LINEAGE, and lineage is what a determined
   * child escapes -- setsid() leaves the group, a forked launcher's child gets
   * reparented, Windows has no group. So the last question before authorizing a
   * deletion is not "whose process was this" but "is anything using this
   * directory", which the kernel can answer whatever the ancestry. A setsid()
   * child holding the home is visible to that; it is invisible to every identity
   * check in this file.
   */
  const releasable = () => {
    if (!dir) return { removable: true, reason: null };
    const usage = directoryReleaseVerdict(dir);
    return usage.ok ? { removable: true, reason: null } : keep(usage.reason);
  };
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
    return releasable();
  }

  if (state === "released") {
    // A TOMBSTONE IS RE-PROBED HERE TOO, not only in the sweep.
    //
    // "Released" records that the consumer was proven gone at some past moment.
    // Between then and now a late pane can have started -- a tmux client killed
    // after handing `new-session` to the server -- and a failed turn calls the
    // owner cleanup twice, so the second call would delete a directory the first
    // one released and something has since recreated. The sweep already
    // re-probed; this is the same rule, in the path the owner actually takes.
    if (hasUsableIdentity(meta.consumer)) {
      const verdict = probeConsumer(meta.consumer);
      if (verdict === "alive") return keep("a released lease's consumer is running again");
      if (verdict !== "absent") {
        return keep(`a released lease's consumer could not be probed (${verdict})`);
      }
      return releasable();
    }
    // NO PROBEABLE CONSUMER. Falling through to the usage check here let a null,
    // partial, or unknown-kind consumer record authorize deletion whenever usage
    // happened to be `free` -- and usage cannot see a process that closed the
    // file and kept the token. Only an owner that PROVED no consumer was ever
    // created may reclaim without one.
    if (meta.consumer_never_created === true) return releasable();
    return keep("a released lease records no consumer that can be probed");
  }

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
      // A failed/interrupted Windows taskkill deliberately records `unknown`
      // after its cmd.exe wrapper disappears. That must retain on THIS boot,
      // but it must not turn one failed cleanup into a permanent credential
      // copy: a precise boot change proves every process from the recorded tree
      // is gone, even though no descendant identity survived the wrapper.
      if (
        verdict === "unknown" &&
        consumer.kind === "headless" &&
        consumer.windows_tree_termination != null &&
        isSameBoot(meta.boot) === false
      ) {
        return releasable();
      }
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
    return releasable();
  }

  // `spawning` with no identity: the unavoidable crash window. A spawn may have
  // happened and we have no handle on what it produced, so on this boot the only
  // safe answer is to retain.
  const sameBoot = isSameBoot(meta.boot);
  if (sameBoot === false) {
    // A previous boot. Nothing it started can still exist, which is what makes
    // conservative retention self-healing rather than permanent.
    return releasable();
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
 *   - on Windows there is no POSIX group. The headless engine therefore uses
 *     taskkill.exe /T /F for timeout/cancellation and records whether that tree
 *     operation succeeded. A failed or interrupted tree kill is retained even
 *     after the direct cmd.exe wrapper disappears.
 *
 * In both cases a descendant could still hold the isolated home when the lease
 * is released. Closing it properly needs a Job Object on Windows and a cgroup
 * on Linux; macOS has neither, and once a process calls setsid() there is no
 * supported unprivileged way to identify it as ours.
 *
 * DECIDED, NOT OVERLOOKED. This was reviewed at length and shipped deliberately.
 * The reasoning, recorded so it does not get relitigated from scratch:
 *
 * A supervisor answers "is a process from this turn still alive". It does NOT
 * stop that process from reading auth.json and keeping the token in memory. So a
 * process that read the credential has it either way -- supervised or not -- and
 * the supervisor changes only whether the DIRECTORY survives. Handing a readable
 * credential to a partner is inherent to the job: it has to authenticate.
 *
 * What a supervisor would genuinely buy is narrower than it first appears:
 * not deleting a directory a live descendant still needs, and not leaving a
 * recreated one behind. Both real, both bounded, neither a disclosure. Weighed
 * against native dependencies on two platforms and no benefit at all on the one
 * this ships from, the residual was accepted.
 *
 * ON THE BLAST RADIUS, corrected. This comment used to say the cost was bounded
 * to "that partner's own turn fails", and that was too comfortable. The one case
 * that actually occurred -- a codex process outliving its pane and rewriting its
 * home -- produced an unattributable directory on EVERY turn, which nothing
 * could reclaim. It was not a self-contained failure; it accumulated. That case
 * is now closed at the source (pane_pid), and the recreated-directory case is
 * handled by tombstones, but the general shape is a real limitation and the
 * honest summary is: deleting a live descendant's home is a behaviour the
 * pre-lease design did not have.
 *
 * What remains bounded is the credential itself. The user's real auth is never
 * moved, only copied from, so nothing here can damage the source.
 */
export function probeLeaseConsumer(
  consumer,
  {
    probeTmuxSessionFn = probeTmuxSessionSync,
    probeWslPaneProcessFn = probeWslPaneProcess,
    probeRecordedProcessFn = probeRecordedProcess,
    probeGroupFn = probeGroup,
    platform = process.platform,
  } = {}
) {
  if (consumer.kind === "tmux") {
    if (typeof consumer.session_name !== "string" || !consumer.session_name) return "unknown";
    const session = probeTmuxSessionFn(consumer.session_name, {
      transport: consumer.tmux_transport ?? null,
      distro: consumer.tmux_distro ?? null,
      tmuxLauncher: consumer.tmux_launcher ?? null,
      tmuxControlBinary: consumer.tmux_control_binary ?? null,
      tmuxSocketName: consumer.tmux_socket_name ?? null,
      requireExactIdentity: true,
      platform,
    });
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
    if (consumer.pane_pid == null) {
      // A pane we KNOW existed and could not identify is UNKNOWN, not absent.
      // Only a record written before pane identities existed may fall back to
      // the session name -- and even then only because that is the behaviour it
      // was written under, never because session absence proves anything about
      // the process.
      if (consumer.pane_pid_unavailable === true) return "unknown";
      return "absent";
    }
    // The RECORDED process, not merely its pid: after a crash and pid reuse an
    // unrelated long-lived process would otherwise make this lease look alive
    // forever, retaining a credential copy permanently.
    const pane =
      consumer.tmux_transport === "wsl"
        ? probeWslPaneProcessFn(
            consumer.pane_pid,
            consumer.pane_started_at ?? null,
            {
              transport: "wsl",
              distro: consumer.tmux_distro ?? null,
              tmuxLauncher: consumer.tmux_launcher ?? null,
              tmuxControlBinary: consumer.tmux_control_binary ?? null,
              tmuxSocketName: consumer.tmux_socket_name ?? null,
              requireExactIdentity: true,
              platform,
            }
          )
        : probeRecordedProcessFn(consumer.pane_pid, consumer.pane_started_at ?? null);
    if (pane === "invalid") return "unknown";
    return pane;
  }
  if (consumer.kind === "headless") {
    const pidVerdict = probeRecordedProcessFn(consumer.pid, consumer.started_at ?? null);
    if (pidVerdict === "invalid") return "unknown";
    if (pidVerdict !== "absent") return pidVerdict;
    if (platform === "win32") {
      // A missing cmd.exe wrapper normally means a naturally completed turn.
      // New records start as `running` and transition either to a naturally
      // observed wrapper exit or to taskkill's result. Starting conservative is
      // important: even if persisting `pending` fails, the older `running`
      // record still retains. `pending`, `failed`, `running`, or a future status
      // this version does not understand all retain rather than turning wrapper
      // absence into permission to delete the isolated home.
      const treeTermination = consumer.windows_tree_termination;
      const authorizesAbsence =
        treeTermination == null ||
        treeTermination === "succeeded" ||
        treeTermination === "wrapper-exit-observed";
      if (!authorizesAbsence) return "unknown";
      return "absent";
    }
    // The leader is gone, but a TERM-ignoring descendant can keep the group --
    // and the group is what holds the CLI that has our credentials open.
    const groupVerdict = probeGroupFn(consumer.pgid);
    if (groupVerdict === "invalid") return "unknown";
    return groupVerdict;
  }
  return "unknown";
}

function probeConsumer(consumer) {
  return probeLeaseConsumer(consumer);
}

/**
 * May this directory be deleted, as far as CURRENT USE is concerned?
 *
 * One rule, shared by the verdict and by the deletion choke point. They used to
 * differ: the verdict retained on `unknown`, the choke point rejected only
 * `in-use` -- so a host with no lsof answered `unknown` and the directory was
 * removed anyway, through paths that bypass the verdict entirely (the owner's
 * failed-spawn shortcut, the released-tombstone branch). Reproduced before it
 * was fixed. `free` is now required everywhere.
 */
function directoryReleaseVerdict(dir) {
  const usage = probeDirectoryInUse(dir);
  if (usage === "free") return { ok: true, reason: null };
  if (usage === "in-use") return { ok: false, reason: "a process still has this directory open" };
  // Windows cannot enumerate handles without native code, but it enforces this
  // in the platform: removing a directory any process has open FAILS there, and
  // the rmSync below does not force past that. Everywhere else, unanswerable
  // means retained.
  if (process.platform === "win32") return { ok: true, reason: null };
  return { ok: false, reason: "whether this directory is in use could not be determined" };
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
  // THE LAST GUARD, at the one place every deletion goes through. Callers check
  // this too, for a legible receipt; this is what makes it unskippable.
  const usage = directoryReleaseVerdict(resolved);
  if (!usage.ok) {
    throw new Error(`removeLeaseDirectory: refusing to remove ${resolved}: ${usage.reason}`);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`removeLeaseDirectory: ${resolved} is a symbolic link, not a lease`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`removeLeaseDirectory: ${resolved} is not a directory`);
  }
  // `force` suppresses "does not exist", not "is busy". On Windows the platform
  // refuses to remove a directory any process has open, and that refusal is the
  // whole safety story there -- so the error propagates rather than being
  // retried into submission.
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
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

  const record = readLeaseRecord(dir);
  const metaPath = record.metaPath;
  if (record.state !== "valid") {
    // UNREADABLE METADATA RETAINS, again.
    //
    // This used to fall back to `lease.owned === true` and delete anyway, which
    // was ownership standing in for a consumer proof: it establishes that this
    // process allocated the path, not that nothing is using what is there now.
    // The reason it was needed has been removed instead -- the record lives
    // beside the directory rather than inside it, so a partner recreating its
    // home can no longer destroy the evidence needed to judge it.
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
    //
    // TWO probes, separated by a settle. `startTmuxSession()` drives tmux
    // through an execFile CLIENT, and the tmux SERVER is a separate process: a
    // client that timed out and was SIGKILLed can already have handed
    // `new-session` over, so the pane may appear just after the client call
    // settles. One probe reads that as "no pane, safe to delete" and removes the
    // home the pane is about to start against. The settle is short because the
    // gap being covered is the server acting on a command it already has.
    // A PROCESS HANDLE IS REQUIRED, not just a session name.
    //
    // In `spawning` the tmux consumer may be nothing but the name recorded
    // before new-session ran. Session absence there is not evidence: the server
    // is a separate process from the client we drove, so a client that timed out
    // or was killed can still have handed the command over, and the pane can
    // appear after any number of probes. Only a pane we identified -- and can
    // therefore watch exit -- lets the owner take this shortcut; everything else
    // falls through to the boot-scoped retention below.
    const spawnConsumer = record.value.consumer ?? {};
    // A headless spawn the owner WATCHED throw. That is knowledge no probe can
    // reconstruct -- spawn() never returned, so no process exists -- and without
    // it an ordinary missing-binary failure retained its credential copy until
    // the next reboot.
    const observedSpawnFailure =
      record.value.state === "spawning" &&
      spawnConsumer.kind === "headless" &&
      spawnConsumer.spawn_outcome === "failed";
    const failedSpawn =
      record.value.state === "spawning" &&
      spawnConsumer.kind === "tmux" &&
      Number.isSafeInteger(spawnConsumer.pane_pid) &&
      probeConsumer(spawnConsumer) === "absent" &&
      (sleepSync(SPAWN_SETTLE_MS), probeConsumer(spawnConsumer) === "absent");
    if (preSpawn || failedSpawn || observedSpawnFailure) {
      // The owner watched: nothing was started, or the spawn it watched failed.
      return finishRelease(dir, metaPath, { ...record.value, consumer_never_created: true });
    }
  }

  // A caller that has just PROVEN the consumer absent -- the turn loop watching
  // its own tmux pane die -- knows something the metadata cannot express yet.
  if (consumerAbsent === true && record.state === "valid") {
    return finishRelease(dir, metaPath, record.value);
  }

  const verdict = proveLeaseReleasable(record.value, { dir });
  if (!verdict.removable) return { released: false, reason: verdict.reason };
  return finishRelease(dir, metaPath, record.value);
}

/**
 * Remove a released lease's directory and leave a TOMBSTONE in its place.
 *
 * The record outlives the directory deliberately. If a partner that was proven
 * gone nonetheless recreates its home afterwards, the recreated directory is
 * still attributable -- the tombstone says this lease was released, and when --
 * so the sweep can reclaim it on evidence rather than on age or ownership. Every
 * previous attempt to handle that case had to guess, because the only record of
 * what the directory was lived inside the directory.
 */
function finishRelease(dir, metaPath, meta) {
  // THE RECORD IS PERSISTED BEFORE THE DESTRUCTIVE STEP, not after it.
  //
  // Removing first left a window: a crash or a failed write between the rmSync
  // and the tombstone leaves no sibling record at all, and if a late consumer
  // then recreates the home the sweep sees a valid-looking lease directory with
  // no metadata -- unattributable, therefore retained forever. That is exactly
  // the attribution the tombstone redesign exists to preserve, lost to the order
  // of two statements.
  //
  // Writing first is safe in the other direction: a crash after the record and
  // before the removal leaves a `released` record WITH its directory, which is
  // the state the sweep already handles -- it re-probes the recorded consumer
  // and reclaims only if that consumer is gone.
  try {
    writeJsonAtomic(metaPathFor(dir), {
      ...meta,
      state: "released",
      consumer: meta.consumer ?? null,
      released_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    // WITHOUT A DURABLE RECORD, DO NOT DESTROY. Removing anyway leaves the
    // credential directory gone AND no tombstone, so a late recreation is
    // unattributable and retained forever -- losing the exact evidence this
    // redesign exists to preserve. Reporting failure keeps both.
    return {
      released: false,
      reason: `the release record could not be persisted (${err.code || err.message}), so the directory was kept`,
    };
  }
  removeLeaseDirectory(dir);
  // A legacy in-directory record went with the directory; nothing to clean.
  if (metaPath !== metaPathFor(dir)) {
    try {
      fs.unlinkSync(metaPath);
    } catch {}
  }
  return { released: true, reason: null };
}

/** Read a lease's metadata by id, without trusting what is on disk. */
export function readLease(leaseId) {
  if (!isValidLeaseId(leaseId)) return null;
  const dir = leaseDir(leaseId);
  const record = readLeaseRecord(dir);
  const metaPath = record.metaPath;
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

/**
 * How long since ANYTHING in this directory changed, or null if unknowable.
 *
 * Deliberately the newest mtime in the tree rather than the directory's own
 * birth time. Age-since-creation says nothing about whether something is still
 * using the directory -- and the case this exists for is precisely a partner
 * that outlived its pane and is writing into a home it recreated. A live writer
 * keeps this number small, which retains; only a tree nothing has touched for
 * the full window is reclaimed.
 *
 * Bounded so a pathological tree cannot stall the sweep. Hitting the bound
 * returns null, which retains -- the conservative direction.
 */
const ACTIVITY_SCAN_MAX_ENTRIES = 2000;

function msSinceLastActivity(dir, now) {
  let newest = 0;
  let budget = ACTIVITY_SCAN_MAX_ENTRIES;

  const visit = (target) => {
    if (budget-- <= 0) return false;
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return true; // vanished mid-scan; it contributes nothing
    }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    if (stat.birthtimeMs > newest) newest = stat.birthtimeMs;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    let entries;
    try {
      entries = fs.readdirSync(target);
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (!visit(path.join(target, entry))) return false;
    }
    return true;
  };

  if (!visit(dir)) return null;
  if (!Number.isFinite(newest) || newest <= 0) return null;
  return Math.max(0, now - newest);
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
    if (entry.isFile() && entry.name.endsWith(".lease.json")) {
      // A record, not a lease. Reap it once the directory it described is gone
      // and it has been released long enough that no recreation is coming --
      // this is file housekeeping, so age is the right measure here, unlike for
      // anything holding credentials.
      const owner = path.join(root, entry.name.slice(0, -".lease.json".length));
      if (fs.existsSync(owner)) continue;
      const held = readJson(path.join(root, entry.name));
      const releasedAt = held.state === "valid" ? Date.parse(held.value.released_at ?? "") : NaN;
      if (!Number.isFinite(releasedAt) || now - releasedAt < unattributableMaxAgeMs) continue;
      // AGE IS NOT ABSENCE. A tombstone is the only thing that can attribute a
      // directory a late consumer recreates, so discarding one on elapsed time
      // alone re-opens the hole the sibling record closed: the consumer keeps a
      // token, touches nothing for a day, then recreates the home, and what it
      // leaves is unattributable forever. The record may only go once the
      // consumer it names is proven gone -- and a record naming nothing
      // probeable is kept, because it can never earn that proof.
      const consumer = held.value.consumer;
      // The safe no-consumer case, honoured here as it is everywhere else.
      // Without this, a marker record -- written when the owner PROVED nothing
      // was ever started -- had no probeable consumer, failed the check below,
      // and could never be reaped. Every projection failure and every
      // missing-binary turn then left a permanent metadata file behind: the
      // credentials went, the bookkeeping accumulated forever.
      if (held.value.consumer_never_created !== true) {
        if (!hasUsableIdentity(consumer)) continue;
        if (probeConsumer(consumer) !== "absent") continue;
      }
      if (!apply) {
        receipt.removed.push({ dir, applied: false, reason: "spent lease record" });
        continue;
      }
      try {
        fs.unlinkSync(path.join(root, entry.name));
        receipt.removed.push({ dir, applied: true, reason: "spent lease record" });
      } catch (err) {
        receipt.errors.push({ path: dir, error: err.message });
      }
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      receipt.retained.push({ dir, reason: "not a plain directory" });
      continue;
    }
    if (!isValidLeaseId(entry.name)) {
      receipt.retained.push({ dir, reason: "name is not a lease id" });
      continue;
    }
    const record = readLeaseRecord(dir);
    if (record.state !== "valid") {
      // UNATTRIBUTABLE MEANS RETAIN. No age heuristic, no ownership shortcut.
      //
      // Both of those were substitutes for a consumer proof, and both were
      // reachable while a consumer was alive: an idle process can hold a
      // directory open for a day without touching a file, and ownership says
      // only that this process once allocated the path. What made them tempting
      // was that the record lived INSIDE the directory, so a partner recreating
      // its home destroyed the only evidence. It lives beside the directory now,
      // and a released lease leaves a tombstone, so the recreated-home case is
      // handled below on evidence rather than guessed at here.
      receipt.retained.push({ dir, reason: record.reason ?? `metadata is ${record.state}` });
      continue;
    }
    if (record.value.state === "released") {
      // A TOMBSTONE with a directory still present: the lease was released after
      // its consumer was proven gone, and something recreated the directory
      // afterwards. Reclaimable on that record rather than on age -- this is the
      // production case, now attributable.
      //
      // But the consumer is RE-PROBED first, because "was proven gone" is a
      // statement about the past. If a spawn that was thought to have failed
      // later succeeded -- a tmux client killed after handing `new-session` to
      // the server -- the pane is alive and this directory is its home. The
      // tombstone identifies what to check; it does not by itself authorize
      // deletion.
      const consumer = record.value.consumer;
      if (hasUsableIdentity(consumer)) {
        const verdict = probeConsumer(consumer);
        if (verdict !== "absent") {
          receipt.retained.push({
            dir,
            reason: `released, but its recorded consumer is ${verdict === "alive" ? "running again" : `unprobeable (${verdict})`}`,
          });
          continue;
        }
      } else if (record.value.consumer_never_created !== true) {
        // Same rule as proveLeaseReleasable: without a probeable consumer, only
        // an owner-proven "nothing was ever started" authorizes reclaiming.
        receipt.retained.push({ dir, reason: "released, but records no probeable consumer" });
        continue;
      }
      if (!apply) {
        receipt.removed.push({ dir, applied: false, reason: "recreated after the lease was released" });
        continue;
      }
      try {
        removeLeaseDirectory(dir);
        receipt.removed.push({ dir, applied: true, reason: "recreated after the lease was released" });
      } catch (err) {
        receipt.errors.push({ path: dir, error: err.message });
      }
      continue;
    }
    const verdict = proveLeaseReleasable(record.value, { dir });
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
