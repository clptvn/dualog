// Is anything actually USING this directory?
//
// WHY THIS EXISTS, AND WHY IT IS NOT A PROCESS SUPERVISOR.
//
// The lease reaper's hard problem is proving that nothing still holds a
// partner's credential home before deleting it. Every identity-based answer --
// pid, process group, even a supervisor -- reasons about LINEAGE, and lineage is
// exactly what a determined child escapes: `setsid()` leaves the group, a
// launcher that forks and exits gets its child reparented to init, and Windows
// has no group to speak of. Closing that with ownership requires cgroups or a
// Job Object, which means native code and a supervisor process.
//
// So this asks a different and more directly relevant question. Not "which
// processes belong to this turn" but "does any visible process currently have
// this directory open" -- which is the question that actually governs whether
// deleting it is safe. A readable setsid() child is found regardless of lineage;
// restricted Linux visibility stays `unknown`, with one narrow cause classified
// for the runtime to interpret only after its foreground lifecycle proof.
//
// It covers holders, not rememberers: a process that read a token into memory
// and closed the file is invisible, and no filesystem check can see that. But
// deleting a directory never creates that exposure -- the token is in memory
// either way -- so the property worth having is the one this provides.
//
// Three-valued, like every other probe here. `unknown` retains.

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const LSOF_TIMEOUT_MS = 5000;
const SAME_UID_PERMISSION_ONLY = "same-uid-permission-only";

function usageEvidence(verdict, ambiguity = null) {
  return { verdict, ambiguity };
}

/**
 * Can this procfs mount enumerate every process visible to this PID namespace?
 *
 * `hidepid=2` and `hidepid=4` remove processes from directory enumeration
 * instead of returning EACCES for them. A scan of the remaining entries can
 * therefore look complete while omitting the process that holds `dir`. Linux
 * normalizes the named forms below in mountinfo, but accept only the documented
 * unrestricted values so an unfamiliar future value fails closed too.
 */
function procEnumerationIsComplete() {
  let mountInfo;
  try {
    mountInfo = fs.readFileSync("/proc/self/mountinfo", "utf-8");
  } catch {
    return false;
  }

  let foundProcMount = false;
  for (const line of String(mountInfo).split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields[4] !== "/proc") continue;
    const separator = fields.indexOf("-");
    if (
      separator < 6 ||
      fields[3] !== "/" ||
      fields[separator + 1] !== "proc" ||
      typeof fields[separator + 3] !== "string"
    ) return false;

    foundProcMount = true;
    const options = [fields[5], fields[separator + 3]]
      .filter((value) => typeof value === "string")
      .flatMap((value) => value.split(","));
    for (const option of options) {
      if (!/^hidepid(?:=|$)/u.test(option)) continue;
      const value = option.includes("=") ? option.slice(option.indexOf("=") + 1) : "";
      if (value !== "0" && value !== "off") return false;
    }
  }

  return foundProcMount;
}

/**
 * Linux: read it straight out of /proc, with no process spawn.
 *
 * Both `cwd` and every open descriptor count -- a partner whose working
 * directory is its config home is using it just as surely as one holding a file
 * open.
 *
 * Linux commonly makes another user's cwd/fds unreadable even on an unrestricted
 * procfs. That must not make every non-root Dualog cleanup permanently unknown.
 * Lease directories are created current-user 0700, and Dualog launches consumers
 * without changing UID, so a process whose real/effective/saved/fs UIDs are all
 * proven different cannot be a normal Dualog consumer. This is a scoped lease
 * invariant, not a claim that a privileged or UID-changing process cannot hold
 * the directory. If the directory has drifted from that invariant, a status is
 * ambiguous, or a potentially matching process is unreadable, retain it.
 */
// Focused tests emulate Linux procfs and mountinfo even when the suite itself is
// running on macOS or Windows, so the incomplete-enumeration branches stay
// covered without weakening this production probe.
function probeViaProc(dir) {
  if (process.platform !== "linux") return null;

  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!Number.isSafeInteger(currentUid) || currentUid < 0) return usageEvidence("unknown");
  try {
    const stat = fs.statSync(dir);
    if (stat.uid !== currentUid || (stat.mode & 0o777) !== 0o700) {
      return usageEvidence("unknown");
    }
  } catch {
    return usageEvidence("unknown");
  }

  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    // Linux lsof reads this same procfs, so an unavailable /proc cannot be
    // repaired by a warning-free lsof no-match.
    return usageEvidence("unknown");
  }

  // A filtered procfs can silently omit exactly the process we need to find.
  // Do not ask lsof to complete this proof: Linux lsof reads the same procfs
  // and can return status 1 with empty output and no warning for an omitted or
  // ptrace-inaccessible process.
  if (!procEnumerationIsComplete()) return usageEvidence("unknown");

  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const matches = (target) =>
    typeof target === "string" && (target === dir || target.startsWith(prefix));

  let blocked = false;
  let sameUidPermissionBlocked = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;

    let status;
    try {
      status = fs.readFileSync(`/proc/${entry}/status`, "utf-8");
    } catch (err) {
      if (err.code === "ESRCH" || err.code === "ENOENT") continue;
      blocked = true;
      continue;
    }
    const uidFields = String(status).match(
      /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/mu
    );
    if (!uidFields) {
      blocked = true;
      continue;
    }
    const processUids = uidFields.slice(1).map((value) => Number.parseInt(value, 10));
    if (processUids.some((uid) => !Number.isSafeInteger(uid) || uid < 0)) {
      blocked = true;
      continue;
    }
    // Skip only when ALL four kernel-reported identities are proven disjoint.
    // Any match (including a saved or filesystem UID) must take the full scan.
    if (processUids.every((uid) => uid !== currentUid)) continue;

    try {
      if (matches(fs.readlinkSync(`/proc/${entry}/cwd`))) return usageEvidence("in-use");
    } catch (err) {
      if (err.code === "EACCES" || err.code === "EPERM") sameUidPermissionBlocked = true;
      else if (err.code !== "ESRCH" && err.code !== "ENOENT") blocked = true;
      // ESRCH/ENOENT: the process exited mid-scan, which contributes nothing.
    }

    let fds;
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch (err) {
      if (err.code === "EACCES" || err.code === "EPERM") sameUidPermissionBlocked = true;
      else if (err.code !== "ESRCH" && err.code !== "ENOENT") blocked = true;
      continue;
    }
    for (const fd of fds) {
      try {
        if (matches(fs.readlinkSync(`/proc/${entry}/fd/${fd}`))) {
          return usageEvidence("in-use");
        }
      } catch (err) {
        // A closed descriptor contributes nothing; a descriptor we were not
        // ALLOWED to read is a hole in the scan, and a partial look must not
        // report "free".
        if (err.code === "EACCES" || err.code === "EPERM") {
          sameUidPermissionBlocked = true;
        }
        else if (err.code !== "ESRCH" && err.code !== "ENOENT") blocked = true;
      }
    }
  }

  // Nothing found, but a partial "no" is never a strict "no". Keep the one
  // narrow Linux ambiguity classified so the runtime can decide what it means
  // only after independently re-proving its foreground consumer absent. This
  // module itself still reports `unknown`.
  if (blocked) return usageEvidence("unknown");
  if (sameUidPermissionBlocked) {
    return usageEvidence("unknown", SAME_UID_PERMISSION_ONLY);
  }
  return usageEvidence("free");
}

/**
 * macOS/BSD: ask lsof, which reports cwd and open descriptors alike.
 *
 * Exit 1 with no output means nothing matched. Any other failure -- lsof absent,
 * timed out, permission-limited -- is `unknown`, never `free`.
 */
function probeViaLsof(dir) {
  try {
    // NO `-w`. It suppresses lsof's warnings -- including "can't opendir",
    // which is exactly how an INCOMPLETE scan came to look like a clean
    // no-match. Reproduced: a lease containing an unreadable subdirectory with a
    // held file beneath it answered `free`, and the removal then unlinked that
    // held file before failing on the non-empty parent. On POSIX, unlink
    // succeeds on open files, so this probe is the only thing standing between a
    // live process and its credentials; it has to see what it could not read.
    const proc = spawnSync("lsof", ["-F", "pn", "+D", dir], {
      encoding: "utf-8",
      timeout: LSOF_TIMEOUT_MS,
    });
    return classifyLsof(proc);
  } catch {
    return "unknown";
  }
}

/**
 * lsof exit 1 means BOTH "found nothing" and "could not fully look".
 *
 * Only a run that found nothing AND complained about nothing is evidence of
 * `free`. Any warning, any spawn failure, any timeout leaves the question open.
 */
function classifyLsof(proc) {
  if (!proc || proc.error) return "unknown";
  const out = typeof proc.stdout === "string" ? proc.stdout : "";
  if (hasProcess(out)) return "in-use";
  // lsof's documented no-match shape is status 1 with no output. Status 0 says
  // it found something, so a status-0 response with no valid process field is a
  // malformed/partial answer, not proof of absence. Likewise, arbitrary stdout
  // on status 1 must not be discarded merely because it did not parse as `pN`.
  if (proc.status !== 1 || out !== "") return "unknown";
  const noise = typeof proc.stderr === "string" ? proc.stderr.trim() : "";
  return noise ? "unknown" : "free";
}

/** Any process, including this caller, in lsof's field-mode output. */
function hasProcess(output) {
  for (const line of String(output || "").split("\n")) {
    if (!line.startsWith("p")) continue;
    const pid = Number.parseInt(line.slice(1), 10);
    if (Number.isSafeInteger(pid) && pid > 0) return true;
  }
  return false;
}

/**
 * `in-use` | `free` | `unknown`.
 *
 * Windows returns `unknown` on purpose. There is no portable handle enumeration
 * without native code, and Windows sharing flags can permit deletion even while
 * a handle is open. The runtime may interpret this only after independently
 * proving its durable foreground lifecycle ended; the standalone probe never
 * grants deletion authority.
 */
export function probeDirectoryUsageEvidence(dir) {
  if (typeof dir !== "string" || !dir) return usageEvidence("unknown");
  let resolved;
  try {
    resolved = fs.realpathSync(dir);
  } catch (error) {
    // Only absence establishes absence. EACCES, EIO, EMFILE, and every other
    // resolution failure are holes in the evidence and must retain.
    return error?.code === "ENOENT" ? usageEvidence("free") : usageEvidence("unknown");
  }
  if (process.platform === "win32") return usageEvidence("unknown");

  const viaProc = probeViaProc(resolved);
  if (viaProc !== null) return viaProc;
  return usageEvidence(probeViaLsof(resolved));
}

/** Strict standalone probe: every same-UID visibility hole retains. */
export function probeDirectoryInUse(dir) {
  return probeDirectoryUsageEvidence(dir).verdict;
}
