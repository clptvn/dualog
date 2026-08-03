// Three-valued process liveness: `alive` | `absent` | `unknown` | `invalid`.
//
// Shared by the legacy scratch sweep and the runtime lease reaper because both
// answer the same question -- "may I delete something a process might still be
// using?" -- and a second implementation of it is a divergence waiting to
// happen. The DECISIONS stay separate: a live session runner blocks the scratch
// sweep but must not block reclaiming a completed turn's lease.

import { execFileSync } from "child_process";

/**
 * `isProcessAlive()` is not usable at this boundary.
 *
 * It catches every error as "dead", so a process that exists but belongs to
 * another user answers `false` -- verified: `isProcessAlive(1)` returns false on
 * this machine even though pid 1 obviously exists, because `kill(1, 0)` raises
 * EPERM. For deciding whether to SIGNAL something that conservatism is fine. For
 * deciding whether to DELETE a live CLI's home it is exactly backwards: EPERM
 * means the process is THERE.
 */
export function probeProcess(pid) {
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

/**
 * When a process was born, to second granularity, or null.
 *
 * `kill(pid, 0)` answers "something has this pid", not "the thing I recorded
 * still has it". After a crash and pid reuse an unrelated long-lived process
 * makes an old lease look alive indefinitely -- which retains a credential copy
 * forever, the failure this whole design exists to bound.
 *
 * `ps -o lstart` is second-granular, so two processes started within the same
 * second are indistinguishable. That residual is real and documented here rather
 * than papered over: it makes reuse detection very likely, not certain, and it
 * errs toward "still alive", which retains.
 */
export function processStartTime(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Is the process we RECORDED still running -- not merely something with its pid?
 *
 * `absent` when the pid is gone, or when it is held by something born at a
 * different time. Anything unverifiable stays `alive`, because retaining a
 * credential copy is the safe error and deleting a live partner's home is not.
 */
export function probeRecordedProcess(pid, recordedStartTime) {
  const verdict = probeProcess(pid);
  if (verdict !== "alive") return verdict;
  if (!recordedStartTime) return "alive";
  const current = processStartTime(pid);
  if (!current) return "alive";
  return current === recordedStartTime ? "alive" : "absent";
}

export function probeGroup(pgid) {
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
