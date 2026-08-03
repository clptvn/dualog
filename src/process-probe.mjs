// Three-valued process liveness: `alive` | `absent` | `unknown` | `invalid`.
//
// Shared by the legacy scratch sweep and the runtime lease reaper because both
// answer the same question -- "may I delete something a process might still be
// using?" -- and a second implementation of it is a divergence waiting to
// happen. The DECISIONS stay separate: a live session runner blocks the scratch
// sweep but must not block reclaiming a completed turn's lease.

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
