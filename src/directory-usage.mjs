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
// processes belong to this turn" but "does any process currently have this
// directory open" -- which is the question that actually governs whether
// deleting it is safe, and which the kernel can answer regardless of how the
// process came to exist. A setsid() child that is using the home is visible
// here; a supervisor tracking lineage might not even know it exists.
//
// It covers holders, not rememberers: a process that read a token into memory
// and closed the file is invisible, and no filesystem check can see that. But
// deleting a directory never creates that exposure -- the token is in memory
// either way -- so the property worth having is the one this provides.
//
// Three-valued, like every other probe here. `unknown` retains.

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const LSOF_TIMEOUT_MS = 5000;

/**
 * Linux: read it straight out of /proc, with no process spawn.
 *
 * Both `cwd` and every open descriptor count -- a partner whose working
 * directory is its config home is using it just as surely as one holding a file
 * open. Entries we cannot read belong to other users' processes; those are
 * counted as UNREADABLE rather than absent, because "I was not allowed to look"
 * is not "nothing is there".
 */
function probeViaProc(dir) {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null; // not Linux, or /proc unavailable
  }

  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  const matches = (target) =>
    typeof target === "string" && (target === dir || target.startsWith(prefix));

  let blocked = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    if (entry === String(process.pid)) continue;

    try {
      if (matches(fs.readlinkSync(`/proc/${entry}/cwd`))) return "in-use";
    } catch (err) {
      if (err.code === "EACCES" || err.code === "EPERM") blocked = true;
      // ESRCH/ENOENT: the process exited mid-scan, which contributes nothing.
    }

    let fds;
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch (err) {
      if (err.code === "EACCES" || err.code === "EPERM") blocked = true;
      continue;
    }
    for (const fd of fds) {
      try {
        if (matches(fs.readlinkSync(`/proc/${entry}/fd/${fd}`))) return "in-use";
      } catch {
        // Raced with the process closing it.
      }
    }
  }

  // Nothing found, but if some processes were unreadable the sweep did not see
  // everything -- and a partial "no" is not a "no".
  return blocked ? "unknown" : "free";
}

/**
 * macOS/BSD: ask lsof, which reports cwd and open descriptors alike.
 *
 * Exit 1 with no output means nothing matched. Any other failure -- lsof absent,
 * timed out, permission-limited -- is `unknown`, never `free`.
 */
function probeViaLsof(dir) {
  try {
    const out = execFileSync("lsof", ["-w", "-F", "pn", "+D", dir], {
      encoding: "utf-8",
      timeout: LSOF_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return hasForeignProcess(out) ? "in-use" : "free";
  } catch (err) {
    // lsof exits 1 when it simply found nothing, which is the common case for a
    // finished turn. It also exits 1 for some partial-permission runs, so treat
    // a clean empty result as free and anything else as unknown.
    if (err?.status === 1) {
      const out = typeof err.stdout === "string" ? err.stdout : "";
      return hasForeignProcess(out) ? "in-use" : "free";
    }
    return "unknown";
  }
}

/** Any process other than this one, in lsof's field-mode output. */
function hasForeignProcess(output) {
  for (const line of String(output || "").split("\n")) {
    if (!line.startsWith("p")) continue;
    const pid = Number.parseInt(line.slice(1), 10);
    if (Number.isSafeInteger(pid) && pid !== process.pid) return true;
  }
  return false;
}

/**
 * `in-use` | `free` | `unknown`.
 *
 * Windows returns `unknown` on purpose. There is no portable handle enumeration
 * without native code -- but the platform makes the check unnecessary in the
 * dangerous direction: Windows refuses to delete a directory that any process
 * has open, so the removal itself fails rather than succeeding underneath a live
 * partner. See removeLeaseDirectory, which does not force past that error.
 */
export function probeDirectoryInUse(dir) {
  if (typeof dir !== "string" || !dir) return "unknown";
  let resolved;
  try {
    resolved = fs.realpathSync(dir);
  } catch {
    // Gone already, so nothing can be holding it.
    return "free";
  }
  if (process.platform === "win32") return "unknown";

  const viaProc = probeViaProc(resolved);
  if (viaProc !== null) return viaProc;
  return probeViaLsof(resolved);
}
