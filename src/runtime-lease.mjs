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
import {
  isValidDotNetTicks,
  processStartTime,
  probeGroup,
  probeProcess,
  probeRecordedProcess,
} from "./process-probe.mjs";
import { probeDirectoryUsageEvidence } from "./directory-usage.mjs";
import { probeTmuxSessionSync, probeWslPaneProcess } from "./tmux-runtime.mjs";
import { resolveWindowsSystem32Executable } from "./windows-process-tree.mjs";

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

// Native Windows does not expose Linux's boot UUID, but CIM does expose the
// operating system's kernel-recorded LastBootUpTime. Keep the executable and
// argv fixed: this is deletion authority, so no lease/user value may ever be
// interpolated into the PowerShell program. The result stays a string because
// .NET ticks exceed JavaScript's safe integer range.
const WINDOWS_BOOT_TIME_SCRIPT = [
  "$PSModuleAutoloadingPreference = 'None';",
  "$cimModule = [IO.Path]::Combine($PSHOME, 'Modules', 'CimCmdlets', 'CimCmdlets.psd1');",
  "Microsoft.PowerShell.Core\\Import-Module -Name $cimModule -Force -ErrorAction Stop;",
  "$os = CimCmdlets\\Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -ErrorAction Stop;",
  "$boot = $os.LastBootUpTime;",
  "if ($null -eq $boot) { exit 1 };",
  "[Console]::Out.Write($boot.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))",
].join(" ");

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

  if (process.platform === "linux") {
    // Linux: a real per-boot UUID, exact by construction.
    try {
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      if (bootId) return { host, id: bootId, bootedAtEpoch, source: "boot-id", precise: true };
    } catch {}
  } else if (["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform)) {
    // macOS/BSD: the kernel's own boot timestamp, to the microsecond.
    try {
      const out = execFileSync("sysctl", ["-n", "kern.boottime"], {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const sec = /sec\s*=\s*(\d+)/.exec(out);
      if (sec) {
        return {
          host,
          id: `kern.boottime:${sec[1]}`,
          bootedAtEpoch,
          source: "kern.boottime",
          precise: true,
        };
      }
    } catch {}
  } else if (process.platform === "win32") {
    // Windows PowerShell is present on the supported desktop Windows releases.
    // Resolve it under SystemRoot instead of PATH so a working-directory/PATH
    // shim cannot manufacture the identity that authorizes cleanup.
    const powershell = resolveWindowsSystem32Executable("powershell.exe", {
      subdirectories: ["WindowsPowerShell", "v1.0"],
    });
    if (powershell) {
      try {
        const out = execFileSync(
          powershell,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_BOOT_TIME_SCRIPT],
          {
            encoding: "utf-8",
            timeout: 5000,
            maxBuffer: 4096,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          }
        );
        if (isValidDotNetTicks(out)) {
          return {
            host,
            id: `win32.last-boot-up-time:${out}`,
            bootedAtEpoch,
            source: "win32.last-boot-up-time",
            precise: true,
          };
        }
      } catch {}
    }
  }

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
    // A precise previous boot supersedes every PID/session observation. Nothing
    // from that boot survived; an `alive` PID or same-named session now belongs
    // to a different process generation. The final directory boundary remains
    // strict on POSIX and requires the durable Windows lifecycle capability.
    if (isSameBoot(meta.boot) === false) return releasable();
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

/**
 * Is an `absent` consumer verdict strong enough to relax ONLY the classified
 * incomplete directory evidence under the documented lifecycle contract?
 *
 * A legacy tmux record with only a session name is deliberately excluded: pane
 * absence never proved the CLI process exited. The tmux probe must have checked
 * an exact persisted route and an actual pane PID; a POSIX headless probe must
 * have checked both its recorded PID and process group. Native Windows cannot
 * enumerate handles portably, so it additionally requires an explicit observed
 * wrapper exit or successful taskkill tree result. The caller still has to
 * obtain `absent` from probeConsumer immediately before using this shape check.
 */
function consumerSupportsRelaxedAbsence(consumer, platform = process.platform) {
  if (!consumer || typeof consumer !== "object") return false;
  if (consumer.kind === "tmux") {
    return Number.isSafeInteger(consumer.pane_pid) && consumer.pane_pid > 0;
  }
  if (consumer.kind === "headless" && platform === "win32") {
    return (
      Number.isSafeInteger(consumer.pid) &&
      consumer.pid > 0 &&
      ["succeeded", "wrapper-exit-observed"].includes(consumer.windows_tree_termination)
    );
  }
  if (consumer.kind === "headless") {
    return (
      Number.isSafeInteger(consumer.pid) &&
      consumer.pid > 0 &&
      Number.isSafeInteger(consumer.pgid) &&
      consumer.pgid > 0
    );
  }
  return false;
}

function metadataAfterLifecycleProof(meta) {
  if (["allocated", "projecting", "ready"].includes(meta?.state)) {
    return { ...meta, consumer_never_created: true };
  }
  return meta;
}

function releasedFromPreviousBoot(meta) {
  return (
    ["spawning", "active"].includes(meta?.released_from_state) &&
    isSameBoot(meta.boot) === false
  );
}

function currentStateFromPreviousBoot(meta) {
  return ["spawning", "active"].includes(meta?.state) && isSameBoot(meta.boot) === false;
}

function recordMayAuthorizeRelaxation(dir, record) {
  const resolved = path.resolve(dir);
  return (
    record?.state === "valid" &&
    record.metaPath === metaPathFor(resolved) &&
    record.value?.schema_version === LEASE_SCHEMA_VERSION &&
    record.value?.lease_id === path.basename(resolved)
  );
}

/**
 * Non-mutating counterpart of the durable released-tombstone authorization.
 * Used by sweep dry-run so it reports the same lifecycle and directory verdict
 * that apply will persist and independently reproduce before deletion.
 */
function prospectiveLeaseRemovalVerdict(dir, record) {
  const meta = record?.value;
  const lifecycle = proveLeaseReleasable(meta);
  if (!lifecycle.removable) return lifecycle;

  const releaseMeta = metadataAfterLifecycleProof(meta);
  // The lifecycle proof above has just established absence. Its shape decides
  // only whether the classified same-UID permission hole may be ignored; it is
  // never a substitute for the final directory scan below. Previous-boot and
  // other conservative lifecycle proofs remain useful when that scan is
  // strictly `free`, even though they cannot relax an ambiguity.
  const allowSameUidPermissionOnly =
    recordMayAuthorizeRelaxation(dir, record) &&
    releaseMeta?.release_relaxation_eligible !== false &&
    isSameBoot(releaseMeta?.boot) !== false &&
    (releaseMeta?.consumer_never_created === true ||
      consumerSupportsRelaxedAbsence(releaseMeta?.consumer));

  // Windows has no portable handle scan. It may interpret that platform-level
  // unknown only from a current-schema sibling record for this exact lease and
  // one of the same durable lifecycle proofs above (or a precise reboot). The
  // strict public removal function never receives this capability.
  const allowWindowsLifecycleProof =
    process.platform === "win32" &&
    recordMayAuthorizeRelaxation(dir, record) &&
    releaseMeta?.release_relaxation_eligible !== false &&
    (currentStateFromPreviousBoot(releaseMeta) ||
      releaseMeta?.consumer_never_created === true ||
      consumerSupportsRelaxedAbsence(releaseMeta?.consumer));

  const usage = directoryReleaseVerdict(dir, {
    allowSameUidPermissionOnly,
    allowWindowsLifecycleProof,
  });
  return usage.ok
    ? { removable: true, reason: null, releaseMeta }
    : { removable: false, reason: usage.reason };
}

function probeOwner(meta) {
  // A process from a precise previous boot cannot still be alive. If its PID is
  // occupied now, that is a different generation and must not retain the lease
  // forever merely because older owner records had no start-time field.
  if (isSameBoot(meta.boot) === false) return "absent";
  if (meta.runner_pid == null) {
    // No owner recorded. If it belongs to a previous boot nothing of it survives.
    return "unknown";
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
function directoryReleaseVerdict(
  dir,
  { allowSameUidPermissionOnly = false, allowWindowsLifecycleProof = false } = {}
) {
  const evidence = probeDirectoryUsageEvidence(dir);
  if (evidence.verdict === "free") return { ok: true, reason: null };
  if (evidence.verdict === "in-use") {
    return { ok: false, reason: "a process still has this directory open" };
  }
  if (
    allowSameUidPermissionOnly &&
    evidence.verdict === "unknown" &&
    evidence.ambiguity === "same-uid-permission-only"
  ) {
    return { ok: true, reason: null };
  }
  if (
    allowWindowsLifecycleProof &&
    process.platform === "win32" &&
    evidence.verdict === "unknown"
  ) {
    return { ok: true, reason: null };
  }
  return { ok: false, reason: "whether this directory is in use could not be determined" };
}

/**
 * Re-read a durable released tombstone and independently reproduce the proof
 * that authorizes the narrow Linux ambiguity. Nothing supplied by an earlier
 * caller survives this boundary as authority.
 */
function releasedLeaseRemovalVerdict(dir) {
  const record = readLeaseRecord(dir);
  if (record.state !== "valid") {
    return {
      ok: false,
      reason: record.reason ?? `lease metadata is ${record.state}`,
    };
  }
  const meta = record.value;
  if (meta.state !== "released") {
    return { ok: false, reason: "the lease has no durable released tombstone" };
  }

  // A strict-only quarantine is the recoverable form of the public deletion
  // path. It carries no lifecycle capability at all: it may advance only when
  // the ordinary platform usage probe says `free`. Keeping this case in the
  // same sibling-record boundary makes a crash after the namespace rename
  // recoverable without upgrading an untrusted caller into durable authority.
  if (meta.strict_usage_only === true || meta.quarantine_strict_usage_only === true) {
    const exactRecord = recordMayAuthorizeRelaxation(dir, record);
    const validCanonicalMarker =
      meta.strict_canonical_generation === true && meta.release_generation === meta.lease_id;
    const validQuarantineMarker =
      meta.quarantine_generation === true &&
      isValidLeaseId(meta.quarantined_from) &&
      isValidLeaseId(meta.release_generation);
    if (!exactRecord || (!validCanonicalMarker && !validQuarantineMarker)) {
      return { ok: false, reason: "the strict generation record is not attributable" };
    }
    return directoryReleaseVerdict(dir);
  }

  // This is the independent deletion-boundary re-proof. A tombstone preserves
  // the state it was released from because `released` alone otherwise erases the
  // previous-boot fact that authorized an identity-less spawning record or an
  // unprobeable Windows process tree. That alternate never relaxes directory
  // evidence; it only permits the strict platform check below to decide.
  const lifecycle = proveLeaseReleasable(meta);
  const previousBootLifecycle = releasedFromPreviousBoot(meta);
  if (!lifecycle.removable && !previousBootLifecycle) {
    return { ok: false, reason: lifecycle.reason };
  }

  // Only a current-schema sibling whose id names this exact directory can grant
  // the narrow relaxation. A legacy in-directory record or mismatched record can
  // still be removed on a strict `free` scan, but never on incomplete evidence.
  const trustedForRelaxation = recordMayAuthorizeRelaxation(dir, record);
  const allowSameUidPermissionOnly =
    trustedForRelaxation &&
    meta.release_relaxation_eligible !== false &&
    lifecycle.removable &&
    isSameBoot(meta.boot) !== false &&
    (meta.consumer_never_created === true || consumerSupportsRelaxedAbsence(meta.consumer));

  const allowWindowsLifecycleProof =
    process.platform === "win32" &&
    trustedForRelaxation &&
    meta.release_relaxation_eligible !== false &&
    (previousBootLifecycle ||
      (lifecycle.removable &&
        (meta.consumer_never_created === true || consumerSupportsRelaxedAbsence(meta.consumer))));

  return directoryReleaseVerdict(dir, {
    allowSameUidPermissionOnly,
    allowWindowsLifecycleProof,
  });
}

function quarantineRetentionError(quarantineDir, reason) {
  const error = new Error(
    `removeLeaseDirectory: retained the attributable generation at ${quarantineDir}: ${reason}`
  );
  error.code = "DUALOG_QUARANTINE_RETAINED";
  error.quarantineDir = quarantineDir;
  return error;
}

function cleanupClaimPathFor(dir) {
  return `${dir}.cleanup.claim`;
}

const CLEANUP_CLAIM_FILE = "claim.json";
const CLEANUP_CLAIM_SCHEMA_VERSION = 1;
const CLEANUP_CLAIM_ARTIFACT_RE =
  /^([0-9a-f]{32})\.cleanup\.claim\.(stage|retired|stale)-([0-9a-f]{32})$/u;

function readCleanupClaimAtPath(dir, claimPath) {
  let stat;
  try {
    stat = fs.lstatSync(claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", claimPath };
    return { state: "invalid", claimPath, reason: error.code || error.message };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { state: "invalid", claimPath, reason: "the cleanup claim is not a plain directory" };
  }

  const record = readJson(path.join(claimPath, CLEANUP_CLAIM_FILE));
  if (record.state !== "valid") {
    return {
      state: "invalid",
      claimPath,
      reason: record.reason ?? `cleanup claim metadata is ${record.state}`,
    };
  }
  const value = record.value;
  if (
    value.claim_schema_version !== CLEANUP_CLAIM_SCHEMA_VERSION ||
    value.lease_id !== path.basename(dir) ||
    !isValidLeaseId(value.token) ||
    !Number.isSafeInteger(value.owner_pid) ||
    value.owner_pid <= 0 ||
    !(value.owner_start_time === null ||
      (typeof value.owner_start_time === "string" &&
        value.owner_start_time.length > 0 &&
        value.owner_start_time.length <= 256)) ||
    !(value.boot === null || (typeof value.boot === "object" && !Array.isArray(value.boot)))
  ) {
    return { state: "invalid", claimPath, reason: "the cleanup claim record is malformed" };
  }
  return { state: "valid", claimPath, value };
}

function readCleanupClaim(dir) {
  return readCleanupClaimAtPath(dir, cleanupClaimPathFor(dir));
}

function cleanupClaimTakeoverVerdict(claim) {
  if (claim?.state !== "valid") {
    return { takeover: false, reason: claim?.reason ?? "the cleanup claim is unreadable" };
  }
  const sameBoot = isSameBoot(claim.value.boot);
  if (sameBoot === false) {
    return { takeover: true, reason: "the cleanup owner belongs to a previous boot" };
  }
  if (sameBoot !== true) {
    return { takeover: false, reason: "the cleanup owner's boot cannot be established" };
  }
  if (!claim.value.owner_start_time) {
    return { takeover: false, reason: "the cleanup owner's process generation is unavailable" };
  }
  const owner = probeRecordedProcess(claim.value.owner_pid, claim.value.owner_start_time);
  if (owner === "absent") {
    return { takeover: true, reason: "the cleanup owner process is absent or was reused" };
  }
  if (owner === "alive") {
    return { takeover: false, reason: "the cleanup owner process is still alive" };
  }
  return { takeover: false, reason: `the cleanup owner process could not be probed (${owner})` };
}

function stageCleanupClaim(dir) {
  const claimPath = cleanupClaimPathFor(dir);
  const token = crypto.randomBytes(16).toString("hex");
  const stagedPath = `${claimPath}.stage-${token}`;
  fs.mkdirSync(stagedPath, { mode: 0o700 });
  try {
    fs.chmodSync(stagedPath, 0o700);
    writeJsonExclusive(path.join(stagedPath, CLEANUP_CLAIM_FILE), {
      claim_schema_version: CLEANUP_CLAIM_SCHEMA_VERSION,
      lease_id: path.basename(dir),
      token,
      owner_pid: process.pid,
      owner_start_time: processStartTime(process.pid),
      boot: bootIdentity(),
      claimed_at: new Date().toISOString(),
    });
  } catch (error) {
    // An incomplete STAGED claim is never canonical authority. Keep it for the
    // artifact sweep to classify; malformed artifacts retain fail-closed.
    throw error;
  }
  return { claimPath, stagedPath, token };
}

function publishCleanupClaim(dir) {
  const staged = stageCleanupClaim(dir);
  try {
    fs.renameSync(staged.stagedPath, staged.claimPath);
  } catch (error) {
    error.cleanupClaimStage = staged;
    throw error;
  }
  return { claimPath: staged.claimPath, token: staged.token };
}

/**
 * Serialize the pre-scan -> rename linearization for one canonical pathname.
 *
 * Without this claim, two sweepers may both scan generation A, the first moves
 * A, a late writer creates generation B, and the second then moves/removes B on
 * its stale scan. The claim records both PID and process generation. A dead or
 * reused owner may be taken over, while live, unknown, and malformed claims
 * retain. A precise previous boot also settles ownership.
 *
 * TAKEOVER IS AN ATOMIC GENERATION SWITCH. The stale claim directory is renamed
 * to a permanent destination containing its unguessable token. Because that
 * destination is non-empty, a competing stale reclaimer cannot later rename a
 * newly acquired live claim over it: POSIX rename refuses to replace a non-empty
 * directory. One contender archives the exact stale token; everyone else must
 * re-read whatever claim now occupies the canonical pathname.
 */
function acquireCleanupClaim(dir) {
  const claimPath = cleanupClaimPathFor(dir);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = readCleanupClaim(dir);
    if (existing.state === "missing") {
      try {
        return publishCleanupClaim(dir);
      } catch (error) {
        // Cross-platform rename errors for an occupied destination differ. The
        // filesystem state, not the errno spelling, tells us whether another
        // complete canonical claim won publication. A failed unique stage stays
        // attributable and is later swept only on its recorded owner proof.
        if (readCleanupClaim(dir).state !== "missing") continue;
        throw error;
      }
    }
    const takeover = cleanupClaimTakeoverVerdict(existing);
    if (!takeover.takeover) {
      throw new Error(
        `removeLeaseDirectory: another cleanup owns the canonical generation (${claimPath}): ${takeover.reason}`
      );
    }

    const archivedPath = `${claimPath}.stale-${existing.value.token}`;
    try {
      fs.renameSync(claimPath, archivedPath);
    } catch (error) {
      // ENOENT means another contender already moved the stale claim. A
      // non-empty destination means it moved THIS exact token and now protects
      // any fresh canonical claim from our stale rename attempt. Re-read.
      if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) continue;
      throw error;
    }
  }
  throw new Error(
    `removeLeaseDirectory: cleanup claim contention did not settle (${claimPath})`
  );
}

function releaseCleanupClaim(claim) {
  const current = readCleanupClaim(
    claim.claimPath.slice(0, -".cleanup.claim".length)
  );
  if (current.state === "missing") return;
  if (current.state !== "valid" || current.value.token !== claim.token) {
    throw new Error("removeLeaseDirectory: refusing to release a cleanup claim owned by another generation");
  }
  const retiredPath = `${claim.claimPath}.retired-${claim.token}`;
  try {
    fs.renameSync(claim.claimPath, retiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  try {
    fs.rmSync(retiredPath, { recursive: true, force: false });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function cleanupClaimArtifact(entryName) {
  const match = CLEANUP_CLAIM_ARTIFACT_RE.exec(entryName);
  if (!match) return null;
  return { leaseId: match[1], kind: match[2], token: match[3] };
}

/**
 * Classify and, when authorized, reap an off-canonical claim artifact.
 *
 * A staged claim was never authority and a retired claim has already been
 * atomically removed from the authority pathname. Even so, neither is removed
 * until its precise boot/process generation proves that its publisher cannot
 * still publish or finish retirement. Malformed, live, and unprobeable records
 * retain. Stale takeover archives are permanent synchronization markers: their
 * non-empty token-specific destinations stop delayed reclaimers from moving a
 * fresh canonical claim.
 */
function sweepCleanupClaimArtifact(root, entry, artifact, { apply }) {
  const artifactPath = path.join(root, entry.name);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return { disposition: "retained", dir: artifactPath, reason: "not a plain directory" };
  }
  if (artifact.kind === "stale") {
    return {
      disposition: "retained",
      dir: artifactPath,
      reason: "permanent stale cleanup-claim generation marker",
    };
  }

  const ownerDir = path.join(root, artifact.leaseId);
  const claim = readCleanupClaimAtPath(ownerDir, artifactPath);
  if (claim.state !== "valid") {
    return {
      disposition: "retained",
      dir: artifactPath,
      reason: claim.reason ?? `cleanup claim artifact is ${claim.state}`,
    };
  }
  if (claim.value.token !== artifact.token) {
    return {
      disposition: "retained",
      dir: artifactPath,
      reason: "the cleanup claim artifact token is mismatched",
    };
  }
  const takeover = cleanupClaimTakeoverVerdict(claim);
  if (!takeover.takeover) {
    return { disposition: "retained", dir: artifactPath, reason: takeover.reason };
  }
  const reason = `orphaned ${artifact.kind} cleanup-claim artifact`;
  if (!apply) {
    return { disposition: "removed", dir: artifactPath, applied: false, reason };
  }
  try {
    // This is already a unique, non-canonical namespace generation. A second
    // sweeper may win the same dead-owner proof; ENOENT is equivalent success.
    fs.rmSync(artifactPath, { recursive: true, force: false });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { disposition: "error", path: artifactPath, error: error.message };
    }
  }
  return { disposition: "removed", dir: artifactPath, applied: true, reason };
}

/**
 * Give the strict public path a permanent canonical marker before rename.
 * Production lifecycle cleanup already has its released tombstone. A direct
 * caller may name an otherwise recordless valid-id directory, so without this
 * step a writer arriving after the namespace switch would recreate a canonical
 * path with no sibling attribution at all.
 */
function ensureStrictCanonicalAttribution(dir) {
  const siblingPath = metaPathFor(dir);
  const existing = readJson(siblingPath);
  if (existing.state === "valid") {
    if (
      existing.value?.schema_version === LEASE_SCHEMA_VERSION &&
      existing.value?.lease_id === path.basename(dir)
    ) {
      return;
    }
    throw new Error("removeLeaseDirectory: the canonical lease record is mismatched");
  }
  if (existing.state !== "missing") {
    throw new Error("removeLeaseDirectory: the canonical lease record is unreadable");
  }

  const id = path.basename(dir);
  const at = new Date().toISOString();
  try {
    writeJsonExclusive(siblingPath, {
      schema_version: LEASE_SCHEMA_VERSION,
      lease_id: id,
      state: "released",
      released_from_state: "strict-removal",
      release_generation: id,
      release_relaxation_eligible: false,
      strict_usage_only: true,
      strict_canonical_generation: true,
      released_at: at,
      updated_at: at,
      consumer: null,
    });
  } catch (error) {
    // An exact record that won the exclusive-create race is equally useful.
    const raced = readJson(siblingPath);
    if (
      error?.code === "EEXIST" &&
      raced.state === "valid" &&
      raced.value?.schema_version === LEASE_SCHEMA_VERSION &&
      raced.value?.lease_id === id
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Reserve a sibling record for one namespace generation before moving it.
 *
 * The random id is both an unguessable target name and an exclusive claim: the
 * record is created with `wx`, before the directory rename. A crash before the
 * rename costs one small permanent marker. A crash after it leaves the moved
 * directory fully attributable and sweepable. That conservative leak is much
 * cheaper than ever producing an unattributable credential directory.
 */
function reserveQuarantineGeneration(dir, { durableConsumerProof }) {
  const sourceId = path.basename(dir);
  const sourceRecord = durableConsumerProof ? readLeaseRecord(dir) : null;
  if (
    durableConsumerProof &&
    (sourceRecord.state !== "valid" || sourceRecord.value?.state !== "released")
  ) {
    throw new Error("removeLeaseDirectory: the released generation changed before quarantine");
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const quarantineId = crypto.randomBytes(16).toString("hex");
    const quarantineDir = path.join(path.dirname(dir), quarantineId);
    const quarantineMetaPath = metaPathFor(quarantineDir);
    const at = new Date().toISOString();
    const sourceMeta = durableConsumerProof ? sourceRecord.value : null;
    const sourceCanKeepRelaxation =
      sourceMeta != null &&
      sourceMeta.release_relaxation_eligible !== false &&
      recordMayAuthorizeRelaxation(dir, sourceRecord);
    const record = sourceMeta
      ? {
          ...sourceMeta,
          lease_id: quarantineId,
          state: "released",
          release_generation: sourceMeta.release_generation ?? sourceId,
          // Moving a legacy or mismatched source beside a fresh, matching name
          // must never upgrade it into the private ambiguity capability.
          release_relaxation_eligible: sourceCanKeepRelaxation,
          quarantined_from: sourceId,
          quarantine_generation: true,
          quarantined_at: at,
          updated_at: at,
        }
      : {
          schema_version: LEASE_SCHEMA_VERSION,
          lease_id: quarantineId,
          state: "released",
          released_from_state: "strict-removal",
          release_generation: sourceId,
          release_relaxation_eligible: false,
          quarantine_generation: true,
          strict_usage_only: true,
          quarantine_strict_usage_only: true,
          quarantined_from: sourceId,
          quarantined_at: at,
          released_at: at,
          updated_at: at,
          consumer: null,
        };
    try {
      writeJsonExclusive(quarantineMetaPath, record);
      return { dir: quarantineDir, metaPath: quarantineMetaPath };
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("removeLeaseDirectory: could not reserve an attributable quarantine generation");
}

/**
 * Atomically detach the checked generation from its canonical pathname.
 *
 * A writer that opens the canonical path before rename follows the moved inode
 * and is visible to the post-rename scan. A writer that arrives afterwards can
 * only create a new canonical generation, which this operation never removes
 * and the original tombstone still attributes. The moved generation is removed
 * only after the SAME strict/durable usage rule succeeds against its new path.
 */
function removeLeaseGeneration(dir, { durableConsumerProof }) {
  if (!durableConsumerProof) ensureStrictCanonicalAttribution(dir);
  const quarantine = reserveQuarantineGeneration(dir, { durableConsumerProof });
  try {
    fs.renameSync(dir, quarantine.dir);
  } catch (error) {
    // The reserved marker remains. Removing it would recreate the same
    // absence-to-unlink race that permanent tombstones are designed to close.
    throw new Error(
      `removeLeaseDirectory: could not atomically quarantine ${dir} (${error.code || error.message})`
    );
  }

  const usage = durableConsumerProof
    ? releasedLeaseRemovalVerdict(quarantine.dir)
    : directoryReleaseVerdict(quarantine.dir);
  if (!usage.ok) throw quarantineRetentionError(quarantine.dir, usage.reason);

  let stat;
  try {
    stat = fs.lstatSync(quarantine.dir);
  } catch (error) {
    throw quarantineRetentionError(
      quarantine.dir,
      `the quarantined generation could not be inspected (${error.code || error.message})`
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw quarantineRetentionError(
      quarantine.dir,
      "the quarantined generation is not a plain directory"
    );
  }

  try {
    fs.rmSync(quarantine.dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch (error) {
    throw quarantineRetentionError(
      quarantine.dir,
      `the quarantined generation could not be removed (${error.code || error.message})`
    );
  }
}

/**
 * Remove a lease directory, re-proving it is ours immediately before unlinking.
 *
 * The checks are repeated here rather than trusted from allocation time: a lease
 * lives for the length of a turn, and the thing being deleted is a directory
 * tree in the user's home.
 */
function removeLeaseDirectoryChecked(dir, { durableConsumerProof = false } = {}) {
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
  const claim = acquireCleanupClaim(resolved);
  try {
    // THE LAST GUARD, at the one place every deletion goes through. Callers check
    // this too, for a legible receipt; this is what makes it unskippable.
    const usage = durableConsumerProof
      ? releasedLeaseRemovalVerdict(resolved)
      : directoryReleaseVerdict(resolved);
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
    // Every platform first atomically detaches this exact checked generation.
    // On Windows, an open handle may make the rename itself fail; that retains
    // both the canonical payload and its reserved attribution marker. A late
    // canonical writer after a successful rename creates a different generation
    // and can never be reached by the recursive removal below.
    removeLeaseGeneration(resolved, { durableConsumerProof });
  } finally {
    releaseCleanupClaim(claim);
  }
}

/**
 * Strict public choke point. Callers without the runtime lifecycle proof may
 * not relax a same-UID visibility hole into permission to delete.
 */
export function removeLeaseDirectory(dir) {
  return removeLeaseDirectoryChecked(dir);
}

/**
 * Private capability used only after the recorded owner/consumer/group has
 * already been proven absent. The supplemental scan still rejects readable
 * POSIX holders and every system-wide procfs ambiguity; it relaxes only the
 * classified same-UID Linux hole or Windows' platform-level unknown under the
 * documented foreground-consumer lifecycle contract.
 */
function removeLeaseDirectoryAfterConsumerProof(dir) {
  return removeLeaseDirectoryChecked(dir, { durableConsumerProof: true });
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
      spawnConsumer.pane_pid > 0 &&
      probeConsumer(spawnConsumer) === "absent" &&
      (sleepSync(SPAWN_SETTLE_MS), probeConsumer(spawnConsumer) === "absent");
    if (preSpawn || observedSpawnFailure) {
      // The owner watched: no process-creating call ran, or headless spawn()
      // itself threw before returning a process identity.
      return finishRelease(dir, metaPath, { ...record.value, consumer_never_created: true });
    }
    if (failedSpawn) {
      // A tmux pane PID means a consumer may have existed even when both settled
      // probes now read absent. Preserve that identity in the tombstone so the
      // deletion choke point can independently re-probe it; never rewrite this
      // case as "consumer never created".
      return finishRelease(dir, metaPath, record.value);
    }
  }

  // A caller that has just PROVEN the consumer absent -- the turn loop watching
  // its own tmux pane die -- knows something the metadata cannot express yet.
  if (
    consumerAbsent === true &&
    record.value.runner_pid === process.pid &&
    ["allocated", "projecting", "ready"].includes(record.value.state)
  ) {
    return finishRelease(dir, metaPath, { ...record.value, consumer_never_created: true });
  }

  // First prove lifecycle only. finishRelease persists that result as a durable
  // tombstone, then the private choke point re-reads it and combines a fresh
  // lifecycle proof with final directory-usage evidence.
  const verdict = proveLeaseReleasable(record.value);
  if (!verdict.removable) return { released: false, reason: verdict.reason };
  return finishRelease(dir, metaPath, metadataAfterLifecycleProof(record.value));
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
  const sourceMayAuthorizeRelaxation = recordMayAuthorizeRelaxation(dir, {
    state: "valid",
    metaPath,
    value: meta,
  });
  // Once a legacy source has been marked ineligible, rewriting its new sibling
  // tombstone must not upgrade it on the next release attempt merely because the
  // record now happens to live at the current path.
  const releaseRelaxationEligible =
    meta.release_relaxation_eligible === false ? false : sourceMayAuthorizeRelaxation;
  try {
    writeJsonAtomic(metaPathFor(dir), {
      ...meta,
      state: "released",
      released_from_state: meta.released_from_state ?? meta.state,
      // Stable for the life of this lease id, including concurrent release
      // attempts. Quarantine records copy it so a moved directory can always be
      // tied back to the exact canonical generation whose lifecycle was proved.
      release_generation: meta.release_generation ?? path.basename(dir),
      release_relaxation_eligible: releaseRelaxationEligible,
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
  try {
    removeLeaseDirectoryAfterConsumerProof(dir);
  } catch (err) {
    // The tombstone deliberately remains: a usage race or visibility hole is a
    // conservative release failure, and the next sweep can retry from durable
    // evidence without losing attribution.
    return {
      released: false,
      reason: err.message,
    };
  }
  // A legacy in-directory record moved with the checked generation and was
  // removed there. Never unlink its OLD canonical pathname here: a late writer
  // may already have created a new generation at that name.
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
export function sweepLeases({ apply = false } = {}) {
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

  // This snapshot is used only to avoid reporting a sibling record separately
  // from the directory entry the same sweep will handle. It is NEVER deletion
  // authority: a directory can appear immediately after enumeration, which is
  // exactly why the record itself is permanent.
  const enumeratedDirectories = new Set(
    entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name)
  );

  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".lease.json")) {
      const ownerName = entry.name.slice(0, -".lease.json".length);
      if (enumeratedDirectories.has(ownerName)) continue;
      const held = readJson(path.join(root, entry.name));
      const reason =
        held.state === "valid" && held.value?.state === "released"
          ? "permanent released lease marker"
          : held.reason ?? `metadata is ${held.state}`;
      // There is no atomic filesystem operation that says both "the directory
      // is absent" and "unlink this sibling only if it stays absent". Deleting
      // this last marker after any age/probe check lets a late absolute-path
      // writer recreate the credential home after the check and before (or
      // after) unlink, making it permanently unattributable. Keep the marker.
      receipt.retained.push({ dir: path.join(root, ownerName), reason });
      continue;
    }
    const claimArtifact = cleanupClaimArtifact(entry.name);
    if (claimArtifact) {
      const result = sweepCleanupClaimArtifact(root, entry, claimArtifact, { apply });
      if (result.disposition === "removed") {
        receipt.removed.push({ dir: result.dir, applied: result.applied, reason: result.reason });
      } else if (result.disposition === "retained") {
        receipt.retained.push({ dir: result.dir, reason: result.reason });
      } else {
        receipt.errors.push({ path: result.path, error: result.error });
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
      const removal = releasedLeaseRemovalVerdict(dir);
      if (!removal.ok) {
        receipt.retained.push({ dir, reason: removal.reason });
        continue;
      }
      if (!apply) {
        receipt.removed.push({ dir, applied: false, reason: "recreated after the lease was released" });
        continue;
      }
      try {
        removeLeaseDirectoryAfterConsumerProof(dir);
        receipt.removed.push({ dir, applied: true, reason: "recreated after the lease was released" });
      } catch (err) {
        if (err?.code === "DUALOG_QUARANTINE_RETAINED") {
          receipt.retained.push({ dir: err.quarantineDir, reason: err.message });
        } else {
          receipt.errors.push({ path: dir, error: err.message });
        }
      }
      continue;
    }
    // Dry-run receives the same prospective lifecycle + directory decision that
    // apply will persist and independently reproduce at the deletion boundary.
    const verdict = prospectiveLeaseRemovalVerdict(dir, record);
    if (!verdict.removable) {
      receipt.retained.push({ dir, reason: verdict.reason });
      continue;
    }
    if (!apply) {
      receipt.removed.push({ dir, applied: false });
      continue;
    }
    const released = finishRelease(dir, record.metaPath, verdict.releaseMeta);
    if (released.released) {
      receipt.removed.push({ dir, applied: true });
    } else {
      receipt.retained.push({ dir, reason: released.reason });
    }
  }
  return receipt;
}
