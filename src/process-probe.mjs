// Three-valued process liveness: `alive` | `absent` | `unknown` | `invalid`.
//
// Shared by the legacy scratch sweep and the runtime lease reaper because both
// answer the same question -- "may I delete something a process might still be
// using?" -- and a second implementation of it is a divergence waiting to
// happen. The DECISIONS stay separate: a live session runner blocks the scratch
// sweep but must not block reclaiming a completed turn's lease.

import { execFileSync } from "child_process";
import { resolveWindowsSystem32Executable } from "./windows-process-tree.mjs";

const WINDOWS_PROCESS_ID_ENV = "DUALOG_INTERNAL_PROCESS_PROBE_PID";
const WINDOWS_PROCESS_CREATION_SCRIPT = [
  "$PSModuleAutoloadingPreference = 'None';",
  "$cimModule = [IO.Path]::Combine($PSHOME, 'Modules', 'CimCmdlets', 'CimCmdlets.psd1');",
  "Microsoft.PowerShell.Core\\Import-Module -Name $cimModule -Force -ErrorAction Stop;",
  `$raw = [Environment]::GetEnvironmentVariable('${WINDOWS_PROCESS_ID_ENV}', 'Process');`,
  "[uint32]$processId = 0;",
  "if (-not [uint32]::TryParse($raw, [ref]$processId) -or $processId -eq 0) { exit 2 };",
  "$instance = CimCmdlets\\Get-CimInstance -ClassName Win32_Process -Filter (\"ProcessId = {0}\" -f $processId) -Property CreationDate -ErrorAction Stop;",
  "if ($null -eq $instance -or $null -eq $instance.CreationDate) { exit 3 };",
  "[Console]::Out.Write($instance.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))",
].join(" ");
const MAX_WINDOWS_PID = 0xffffffff;
const MAX_DOTNET_TICKS = 3155378975999999999n;

export function isValidDotNetTicks(value) {
  if (!/^[1-9][0-9]{15,18}$/u.test(value)) return false;
  try {
    return BigInt(value) <= MAX_DOTNET_TICKS;
  } catch {
    return false;
  }
}

function withExactWindowsEnvironmentValue(env, name, value) {
  const next = {};
  for (const [key, entry] of Object.entries(env ?? {})) {
    if (key.toLocaleLowerCase("en-US") !== name.toLocaleLowerCase("en-US")) {
      next[key] = entry;
    }
  }
  next[name] = value;
  return next;
}

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
 * POSIX `ps -o lstart` is second-granular, so two processes started within the
 * same second are indistinguishable. Native Windows uses CIM CreationDate as
 * invariant UTC .NET ticks. Both fail closed: an unavailable generation returns
 * null, and the recorded process is treated as still alive.
 */
export function processStartTime(
  pid,
  {
    platform = process.platform,
    env = process.env,
    execFileSyncFn = execFileSync,
  } = {}
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === "win32") {
    // Win32 process ids are DWORDs. Rejecting an impossible value here keeps it
    // out of both the environment and PowerShell, while still accepting the
    // unsigned half of the range that an `[int]` parser incorrectly rejected.
    if (pid > MAX_WINDOWS_PID) return null;
    const powershell = resolveWindowsSystem32Executable("powershell.exe", {
      env,
      subdirectories: ["WindowsPowerShell", "v1.0"],
    });
    if (!powershell) return null;
    try {
      const out = execFileSyncFn(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_CREATION_SCRIPT],
        {
          encoding: "utf-8",
          timeout: 5000,
          maxBuffer: 4096,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
          env: withExactWindowsEnvironmentValue(
            env,
            WINDOWS_PROCESS_ID_ENV,
            String(pid)
          ),
        }
      );
      return isValidDotNetTicks(out) ? out : null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSyncFn("ps", ["-o", "lstart=", "-p", String(pid)], {
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
