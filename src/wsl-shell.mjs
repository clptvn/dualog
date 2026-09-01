// WSL login-shell selection shared by runtime, discovery, and installation.
//
// The bootstrap intentionally uses /bin/sh because the user's shell is not
// known yet. It only prints a validated path; every later invocation passes
// that path and all dynamic values as distinct argv entries.

export const DEFAULT_WSL_LOGIN_SHELL = "/bin/sh";

function isAbsoluteWindowsLauncherPath(value) {
  return (
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+[\\/].+/u.test(value)
  );
}

/**
 * WSL control/liveness probes include synchronous call sites. A `.cmd`/`.bat`
 * launcher inserts cmd.exe between Dualog and wsl.exe; when a synchronous
 * probe times out, killing that wrapper does not prove its descendant stopped.
 * Partner CLIs may still be command shims -- this restriction is only for the
 * WSL transport executable itself.
 */
export function assertSafeWslLauncher(
  value,
  { platform = process.platform } = {}
) {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command) throw new Error("WSL binary path must not be empty");
  // Win32 normalizes trailing dots/spaces on ordinary paths, so classify the
  // normalized spelling too (`wsl.cmd.` can still name `wsl.cmd`).
  const extensionCandidate = command.replace(/[. ]+$/u, "");
  if (/\.(?:cmd|bat)$/iu.test(extensionCandidate)) {
    throw new Error(
      "WSL launcher must be a directly executable binary, not a .cmd/.bat wrapper; " +
        "configure wsl.exe so synchronous liveness and cleanup probes cannot orphan its process tree"
    );
  }
  // An extensionless command on native Windows is not proof of a direct
  // executable: PATHEXT may resolve it to the exact .cmd/.bat wrapper refused
  // above. Require an executable image suffix instead of reimplementing PATH
  // resolution differently in each sync and async caller.
  if (platform === "win32" && !/\.(?:exe|com)$/iu.test(extensionCandidate)) {
    throw new Error(
      "WSL launcher on Windows must end in .exe or .com; extensionless commands can resolve through PATHEXT to an unsafe .cmd/.bat wrapper"
    );
  }
  if (
    platform === "win32" &&
    command.toLocaleLowerCase("en-US") !== "wsl.exe" &&
    !isAbsoluteWindowsLauncherPath(command)
  ) {
    throw new Error(
      "custom WSL launcher on Windows must be an absolute drive or UNC path; only the system default wsl.exe may use PATH lookup"
    );
  }
  return command;
}

/**
 * Native Windows tmux overrides are used by synchronous cleanup probes too.
 * Require a direct executable image there for the same reason as the WSL
 * transport launcher.  This is deliberately Win32-only: an executable named
 * `tmux.cmd` is just an ordinary filename on macOS/Linux and remains valid.
 */
export function assertSafeTmuxLauncher(
  value,
  { platform = process.platform } = {}
) {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command) throw new Error("tmux binary path must not be empty");
  if (platform !== "win32") return command;

  const extensionCandidate = command.replace(/[. ]+$/u, "");
  if (/\.(?:cmd|bat)$/iu.test(extensionCandidate)) {
    throw new Error(
      "tmux launcher on Windows must be a directly executable binary, not a .cmd/.bat wrapper; " +
        "configure a tmux .exe or .com so synchronous liveness and cleanup probes cannot orphan its process tree"
    );
  }
  if (!/\.(?:exe|com)$/iu.test(extensionCandidate)) {
    throw new Error(
      "tmux launcher on Windows must end in .exe or .com; extensionless commands can resolve through PATHEXT to an unsafe .cmd/.bat wrapper"
    );
  }
  if (!isAbsoluteWindowsLauncherPath(command)) {
    throw new Error(
      "custom tmux launcher on Windows must be an absolute drive or UNC path so Desktop cleanup probes use the same executable regardless of cwd or PATH"
    );
  }
  return command;
}

const SUPPORTED_LOGIN_SHELLS = new Set([
  "ash",
  "bash",
  "dash",
  "ksh",
  "ksh93",
  "mksh",
  "sh",
  "zsh",
]);

export const WSL_LOGIN_SHELL_PROBE_SCRIPT = [
  "is_supported_shell() {",
  '  candidate=$1',
  '  case "$candidate" in /*) ;; *) return 1;; esac',
  '  name=${candidate##*/}',
  '  case "$name" in ash|bash|dash|ksh|ksh93|mksh|sh|zsh) ;; *) return 1;; esac',
  '  [ -x "$candidate" ] && [ ! -d "$candidate" ]',
  "}",
  "passwd_shell=",
  'account=$(id -un 2>/dev/null || true)',
  'if [ -n "$account" ] && command -v getent >/dev/null 2>&1; then',
  '  passwd_record=$(getent passwd "$account" 2>/dev/null || true)',
  '  case "$passwd_record" in *:*) passwd_shell=${passwd_record##*:};; esac',
  "fi",
  'for candidate in "$passwd_shell" "${SHELL:-}" /bin/sh; do',
  '  if is_supported_shell "$candidate"; then',
  '    printf "%s" "$candidate"',
  "    exit 0",
  "  fi",
  "done",
  'printf "%s" /bin/sh',
].join("\n");

/** Only POSIX-compatible shells can execute Dualog's fixed wrapper programs. */
export function normalizeWslLoginShell(value) {
  if (typeof value !== "string") return DEFAULT_WSL_LOGIN_SHELL;
  const candidate = value.trim();
  if (
    !candidate.startsWith("/") ||
    candidate.includes("\0") ||
    candidate.includes("\n") ||
    candidate.includes("\r") ||
    !/^\/(?:[A-Za-z0-9._+@-]+\/)*[A-Za-z0-9._+@-]+$/u.test(candidate)
  ) {
    return DEFAULT_WSL_LOGIN_SHELL;
  }
  const name = candidate.slice(candidate.lastIndexOf("/") + 1);
  return SUPPORTED_LOGIN_SHELLS.has(name)
    ? candidate
    : DEFAULT_WSL_LOGIN_SHELL;
}

export function wslLoginShellProbeArgs() {
  return [DEFAULT_WSL_LOGIN_SHELL, "-c", WSL_LOGIN_SHELL_PROBE_SCRIPT];
}

/**
 * Build `shell -lic PROGRAM arg0 ...args` without interpolating dynamic argv.
 *
 * Interactive mode is deliberate. Ubuntu's stock .bashrc returns immediately
 * for non-interactive shells, and nvm is normally installed below that guard.
 * A plain `bash -lc` therefore cannot see the Node/Claude/Codex binaries that
 * the same user sees in their terminal.
 */
export function wslLoginShellArgs(
  shell,
  program,
  { arg0 = "dualog-wsl", args = [] } = {}
) {
  if (typeof program !== "string" || !program) {
    throw new Error("A fixed WSL login-shell program is required");
  }
  return [
    normalizeWslLoginShell(shell),
    "-lic",
    program,
    String(arg0),
    ...args.map((value) => String(value)),
  ];
}

export function wslLoginShellCacheKey(route) {
  const command = route?.command ?? route?.binary ?? "wsl.exe";
  return `${command}\0${route?.distro ?? "<default>"}`;
}
