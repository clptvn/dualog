// Native Windows process-tree termination shared by headless execution and
// short-lived CLI probes. cross-spawn launches `.cmd` shims through cmd.exe;
// killing only that wrapper can leave the actual vendor CLI running.

import { execFileSync } from "node:child_process";

/**
 * Force-stop one exact, validated native Windows process tree.
 *
 * No shell is involved and the pid is a separate argv item. Invalid or
 * attacker-controlled values therefore never reach taskkill.exe.
 */
export function terminateWindowsProcessTree(
  pid,
  { execFileSyncFn = execFileSync } = {}
) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    return {
      status: "failed",
      attempted: false,
      reason: "the spawned process did not provide a valid Windows pid",
    };
  }

  try {
    execFileSyncFn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 15000,
    });
    return { status: "succeeded", attempted: true, reason: null };
  } catch (err) {
    return {
      status: "failed",
      attempted: true,
      reason: `taskkill.exe could not terminate process tree ${pid} (${err?.code || err?.message || "unknown error"})`,
    };
  }
}
