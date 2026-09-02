// Native Windows process-tree termination shared by headless execution and
// short-lived CLI probes. cross-spawn launches `.cmd` shims through cmd.exe;
// killing only that wrapper can leave the actual vendor CLI running.

import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Resolve one fixed Windows system executable without consulting PATH.
 *
 * SystemRoot is supplied by Windows, but it is still inherited process input.
 * Supported Windows installations use a top-level `Windows` or legacy `WinNT`
 * directory. Accept only those ordinary drive-absolute roots. In particular,
 * a caller-controlled nested directory such as `C:\\Users\\me\\Windows` must
 * not turn its own `System32` child into executable authority. The executable
 * is a basename, so the constructed path cannot escape the validated root.
 */
export function resolveWindowsSystem32Executable(
  executable,
  { env = process.env, subdirectories = [] } = {}
) {
  if (
    typeof executable !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/iu.test(executable) ||
    path.win32.basename(executable) !== executable
  ) {
    return null;
  }
  if (
    !Array.isArray(subdirectories) ||
    subdirectories.some(
      (segment) =>
        typeof segment !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment) ||
        segment === "." ||
        segment === ".."
    )
  ) {
    return null;
  }

  const systemRoot = env?.SystemRoot;
  if (
    typeof systemRoot !== "string" ||
    systemRoot !== systemRoot.trim() ||
    !/^[A-Za-z]:[\\/](?:Windows|WinNT)[\\/]*$/iu.test(systemRoot)
  ) {
    return null;
  }

  const normalizedRoot = path.win32.normalize(systemRoot).replace(/[\\/]+$/u, "");
  if (
    !path.win32.isAbsolute(normalizedRoot) ||
    !/^[A-Za-z]:\\(?:Windows|WinNT)$/iu.test(normalizedRoot)
  ) {
    return null;
  }

  const systemRelative = path.win32.join(
    "System32",
    ...subdirectories,
    executable
  );
  const resolved = path.win32.join(normalizedRoot, systemRelative);
  const relative = path.win32.relative(normalizedRoot, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.win32.isAbsolute(relative) ||
    relative.toLowerCase() !== systemRelative.toLowerCase()
  ) {
    return null;
  }
  return resolved;
}

function exactWindowsComSpecEnvironment(env, cmd) {
  const sanitized = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key.toLocaleLowerCase("en-US") !== "comspec") sanitized[key] = value;
  }
  sanitized.ComSpec = cmd;
  return sanitized;
}

/**
 * Invoke a cross-spawn-compatible function through one trusted Windows shell
 * boundary while preserving its command and argv as separate values.
 *
 * cross-spawn resolves `.cmd` shims synchronously before it creates the child,
 * and that parser reads the parent process's lowercase `comspec` rather than
 * `options.env`. Scope the validated System32 path across that synchronous call
 * as well as the child environment, then restore the parent exactly. POSIX does
 * not enter this boundary and receives the caller's original options object.
 */
export function spawnWithTrustedWindowsComSpec(
  spawnFn,
  command,
  args,
  options = {},
  {
    platform = process.platform,
    env = options?.env ?? process.env,
  } = {}
) {
  if (platform !== "win32") return spawnFn(command, args, options);

  const cmd = resolveWindowsSystem32Executable("cmd.exe", { env });
  if (!cmd) {
    throw new Error(
      "SystemRoot did not resolve to a trusted top-level Windows System32 directory for cmd.exe"
    );
  }
  const childOptions = {
    ...options,
    env: exactWindowsComSpecEnvironment(options?.env ?? env, cmd),
  };
  const previous = Object.entries(process.env).filter(
    ([key]) => key.toLocaleLowerCase("en-US") === "comspec"
  );
  for (const [key] of previous) delete process.env[key];
  process.env.comspec = cmd;
  try {
    return spawnFn(command, args, childOptions);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.toLocaleLowerCase("en-US") === "comspec") delete process.env[key];
    }
    for (const [key, value] of previous) process.env[key] = value;
  }
}

/**
 * Force-stop one exact, validated native Windows process tree.
 *
 * No shell is involved and the pid is a separate argv item. Invalid or
 * attacker-controlled values therefore never reach taskkill.exe.
 */
export function terminateWindowsProcessTree(
  pid,
  { execFileSyncFn = execFileSync, env = process.env } = {}
) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    return {
      status: "failed",
      attempted: false,
      reason: "the spawned process did not provide a valid Windows pid",
    };
  }

  const taskkill = resolveWindowsSystem32Executable("taskkill.exe", { env });
  if (!taskkill) {
    return {
      status: "failed",
      attempted: false,
      reason: "SystemRoot did not resolve to a validated Windows System32 directory",
    };
  }

  try {
    execFileSyncFn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 4096,
      shell: false,
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
