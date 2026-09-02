// Side-effect-free process command-line inspection.
//
// Keep this module independent of session/runtime initialization: cleanup and
// smoke-test callers need process identity without creating ~/.dualog merely by
// importing the probe.

import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";

import { resolveWindowsSystem32Executable } from "./windows-process-tree.mjs";

const WINDOWS_COMMAND_LINE_PID_ENV = "DUALOG_INTERNAL_COMMAND_LINE_PID";
const WINDOWS_COMMAND_LINE_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const WINDOWS_COMMAND_LINE_SCRIPT = [
  `$raw = [Environment]::GetEnvironmentVariable('${WINDOWS_COMMAND_LINE_PID_ENV}', 'Process');`,
  "[uint32]$processId = 0;",
  "if (-not [uint32]::TryParse($raw, [ref]$processId) -or $processId -eq 0) { exit 2 };",
  "$cimManifest = [IO.Path]::Combine($PSHOME, 'Modules', 'CimCmdlets', 'CimCmdlets.psd1');",
  "Microsoft.PowerShell.Core\\Import-Module -Name $cimManifest -Force -ErrorAction Stop;",
  "$instance = CimCmdlets\\Get-CimInstance -ClassName Win32_Process -Filter (\"ProcessId = {0}\" -f $processId) -Property CommandLine -ErrorAction Stop;",
  "if ($null -eq $instance) { exit 3 };",
  "$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$instance.CommandLine);",
  "[Console]::Out.Write([System.Convert]::ToBase64String($bytes))",
].join(" ");

function withExactWindowsEnvironmentValue(env, name, value) {
  const next = {};
  for (const [key, entry] of Object.entries(env ?? {})) {
    // Windows environment names are case-insensitive. Leaving a differently
    // cased copy lets Node's Windows env-block sorting choose the stale value.
    if (key.toLowerCase() !== name.toLowerCase()) next[key] = entry;
  }
  next[name] = value;
  return next;
}

function decodeWindowsCommandLine(encoded) {
  // Windows PowerShell 5.1 writes text through a legacy console code page by
  // default. Returning the command line directly therefore corrupts runner and
  // session paths containing characters outside that page. PowerShell emits
  // only ASCII Base64; Node performs the one strict UTF-8 decode here.
  if (typeof encoded !== "string" || !WINDOWS_COMMAND_LINE_BASE64.test(encoded)) {
    return "";
  }

  try {
    const bytes = Buffer.from(encoded, "base64");
    // Buffer.from(base64) accepts several non-canonical/malformed spellings.
    // Re-encoding makes malformed helper output ignorance, never identity.
    if (bytes.toString("base64") !== encoded) return "";
    const commandLine = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return commandLine.includes("\u0000") ? "" : commandLine;
  } catch {
    return "";
  }
}

export function readProcessCommandLine(
  pid,
  {
    platform = process.platform,
    env = process.env,
    execFileSyncFn = execFileSync,
  } = {}
) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) return "";

  try {
    if (platform === "win32") {
      const powershell = resolveWindowsSystem32Executable("powershell.exe", {
        env,
        subdirectories: ["WindowsPowerShell", "v1.0"],
      });
      if (!powershell) return "";
      const encoded = execFileSyncFn(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_COMMAND_LINE_SCRIPT],
        {
          // The helper's output alphabet is deliberately ASCII-only so this is
          // independent of Windows PowerShell 5.1's console encoding.
          encoding: "ascii",
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 128 * 1024,
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          env: withExactWindowsEnvironmentValue(
            env,
            WINDOWS_COMMAND_LINE_PID_ENV,
            String(pid)
          ),
        }
      );
      return decodeWindowsCommandLine(encoded);
    }

    return execFileSyncFn("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 128 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
