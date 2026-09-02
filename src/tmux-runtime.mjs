import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import crossSpawn from "cross-spawn";
import { tryGetAdapter } from "./adapters/registry.mjs";
import { isBlocked, isIdlePrompt } from "./tui/markers.mjs";
import {
  resolveWindowsSystem32Executable,
  terminateWindowsProcessTree,
} from "./windows-process-tree.mjs";
import {
  assertSafeTmuxLauncher,
  assertSafeWslLauncher,
  DEFAULT_WSL_LOGIN_SHELL,
  normalizeWslLoginShell,
  wslLoginShellArgs,
  wslLoginShellCacheKey,
  wslLoginShellProbeArgs,
} from "./wsl-shell.mjs";

const DEFAULT_TMUX_BINARY = "tmux";
const DEFAULT_TMUX_SOCKET_NAME = "dualog";
const DEFAULT_WSL_BINARY = "wsl.exe";
const TMUX_EXEC_TIMEOUT_MS = 10000;
const TMUX_EXEC_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_CAPTURE_LINES = 240;
const DEFAULT_CAPTURE_MAX_CHARS = 30000;
const DEFAULT_TAIL_LINES = 6;
const DEFAULT_TAIL_MAX_CHARS = 3000;
const WSL_LOGIN_SHELL_CACHE = new Map();

const TMUX_KEY_CODES = Object.freeze({
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "BSpace",
  delete: "DC",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  page_up: "PPage",
  page_down: "NPage",
});

export const TMUX_NAMED_KEYS = Object.freeze(Object.keys(TMUX_KEY_CODES));

const TMUX_BINARY_ENV = [
  "DUALOG_TMUX_BINARY",
  "CODEX_DIALOG_TMUX_BINARY",
  "CONDUCTOR_TMUX_BINARY",
];
const WSL_BINARY_ENV = [
  "DUALOG_WSL_BINARY",
  "CODEX_DIALOG_WSL_BINARY",
  "CONDUCTOR_WSL_BINARY",
];
const WSL_DISTRO_ENV = [
  "DUALOG_WSL_DISTRO",
  "CODEX_DIALOG_WSL_DISTRO",
  "CONDUCTOR_WSL_DISTRO",
];

function configuredEnvValue(names, env = process.env) {
  for (const name of names) {
    const value = env[name];
    if (value != null && value !== "") return value;
  }
  return null;
}

function tmuxBinary(env = process.env, { platform = process.platform } = {}) {
  const configured = configuredEnvValue(TMUX_BINARY_ENV, env);
  const trimmed = (configured ?? DEFAULT_TMUX_BINARY).trim();
  if (!trimmed) {
    throw new Error("tmux binary path must not be empty");
  }
  return configured == null
    ? trimmed
    : assertSafeTmuxLauncher(trimmed, { platform });
}

function wslBinary(env = process.env, { platform = process.platform } = {}) {
  const configured = configuredEnvValue(WSL_BINARY_ENV, env);
  const trimmed = (configured ?? DEFAULT_WSL_BINARY).trim();
  if (
    platform === "win32" &&
    trimmed.toLocaleLowerCase("en-US") === DEFAULT_WSL_BINARY
  ) {
    const systemWsl = resolveWindowsSystem32Executable(DEFAULT_WSL_BINARY, { env });
    if (!systemWsl) {
      throw new Error(
        "SystemRoot did not resolve to a trusted top-level Windows System32 directory for wsl.exe"
      );
    }
    return systemWsl;
  }
  return assertSafeWslLauncher(trimmed, { platform });
}

function wslDistro(env = process.env) {
  const configured = configuredEnvValue(WSL_DISTRO_ENV, env);
  return configured ? configured.trim() || null : null;
}

function sameWslDistro(left, right) {
  return String(left).toLocaleLowerCase("en-US") === String(right).toLocaleLowerCase("en-US");
}

/**
 * Parse the two UNC spellings Windows exposes for a WSL filesystem.
 *
 * These paths are already inside a Linux distribution. Sending them through
 * `wslpath` in some other (possibly default) distribution is both unnecessary
 * and unsafe: the same-looking path can name a different filesystem. Keeping
 * the distro beside the translated path lets the caller pin every later tmux
 * and process probe to the owner of that filesystem.
 */
export function parseWslUncPath(value) {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const match = value.match(
    /^(?:\\\\|\/\/)(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/iu
  );
  if (!match) return null;
  const distro = match[1].trim();
  if (!distro) return null;
  const remainder = String(match[2] ?? "").replace(/[\\/]+/gu, "/");
  return {
    distro,
    linuxPath: remainder ? `/${remainder}` : "/",
  };
}

/**
 * Which tmux process owns sessions created from this host?
 *
 * Native Windows has no usable tmux runtime of its own. When no explicit tmux
 * binary override is configured, use the user's default WSL distribution. An
 * explicit DUALOG_TMUX_BINARY retains its historic meaning: the operator owns
 * that executable and dualog invokes it directly.
 */
export function tmuxRoute({ env = process.env, platform = process.platform } = {}) {
  const configuredTmux = configuredEnvValue(TMUX_BINARY_ENV, env);
  const binary = tmuxBinary(env, { platform });
  const socketName = tmuxSocketName(env);
  if (platform === "win32" && configuredTmux == null) {
    return {
      transport: "wsl",
      command: wslBinary(env, { platform }),
      distro: wslDistro(env),
      tmuxBinary: binary,
      tmuxSocketName: socketName,
    };
  }
  return {
    transport: "local",
    command: binary,
    distro: null,
    tmuxBinary: binary,
    tmuxSocketName: socketName,
  };
}

function wslCommandArgs(
  commandArgs,
  route = tmuxRoute(),
  { platform = process.platform } = {}
) {
  if (route?.transport === "wsl") {
    assertSafeWslLauncher(route.command, { platform });
  }
  const distro = route?.distro ?? null;
  return [
    ...(distro ? ["--distribution", distro] : []),
    "--exec",
    ...commandArgs,
  ];
}

function tmuxCommandArgs(
  args,
  { env = process.env, platform = process.platform, route = null } = {}
) {
  const selectedRoute = route ?? tmuxRoute({ env, platform });
  if (selectedRoute.transport === "local") {
    assertSafeTmuxLauncher(selectedRoute.command, { platform });
  }
  const tmuxArgs = buildTmuxArgs(args, {
    env,
    socketName: selectedRoute.tmuxSocketName ?? null,
  });
  return {
    route: selectedRoute,
    command: selectedRoute.command,
    args:
      selectedRoute.transport === "wsl"
        ? wslCommandArgs([selectedRoute.tmuxBinary, ...tmuxArgs], selectedRoute, {
            platform,
          })
        : tmuxArgs,
  };
}

export function isWindowsPath(value) {
  return (
    typeof value === "string" &&
    (/^[A-Za-z]:[\\/]/u.test(value) || parseWslUncPath(value) !== null)
  );
}

/**
 * Bind a WSL route to every explicit distro named by the paths it will receive.
 * One invocation cannot safely span two WSL filesystems, and an operator-picked
 * distro must never be silently replaced by a UNC path's distro.
 */
export function resolveTmuxRouteForPaths(route, values) {
  if (route?.transport !== "wsl") return route;
  const distros = new Map();
  for (const value of values ?? []) {
    const unc = parseWslUncPath(value);
    if (!unc) continue;
    const key = unc.distro.toLocaleLowerCase("en-US");
    if (!distros.has(key)) distros.set(key, unc.distro);
  }
  if (distros.size > 1) {
    throw new Error(
      `A single WSL tmux invocation cannot use paths from multiple distributions: ${[
        ...distros.values(),
      ].join(", ")}`
    );
  }
  const [pathDistro = null] = distros.values();
  if (route.distro && pathDistro && !sameWslDistro(route.distro, pathDistro)) {
    throw new Error(
      `WSL path belongs to distribution ${JSON.stringify(pathDistro)}, but Dualog is routed to ${JSON.stringify(route.distro)}`
    );
  }
  return pathDistro && !route.distro ? { ...route, distro: pathDistro } : route;
}

function routeForIdentity(
  identity,
  fallbackRoute = tmuxRoute(),
  { platform = process.platform } = {}
) {
  // `tmuxRoute` exists only on in-memory handles built from trusted runtime
  // configuration. Persisted JSON never hydrates it: disk fields are
  // partner-writable and may only be compared with the current trusted route.
  if (identity?.tmuxRoute && identity?.tmuxIdentityRequired !== true) {
    const trustedRoute = identity.tmuxRoute;
    return {
      ...trustedRoute,
      tmuxSocketName:
        trustedRoute.tmuxSocketName ?? identity.tmuxSocketName ?? tmuxSocketName(),
    };
  }
  const transport = identity?.tmuxTransport ?? identity?.tmux_transport ?? null;
  const distro = identity?.tmuxDistro ?? identity?.tmux_distro ?? null;
  const requireExact = identity?.tmuxIdentityRequired === true;
  const trustedRoute = {
    ...fallbackRoute,
    tmuxSocketName: fallbackRoute.tmuxSocketName ?? tmuxSocketName(),
  };
  if (!transport) {
    if (requireExact) throw new Error("Recorded tmux route has no exact transport identity");
    return trustedRoute;
  }
  if (transport !== trustedRoute.transport) {
    throw new Error(
      `Recorded tmux transport ${JSON.stringify(transport)} is unavailable through the current ${JSON.stringify(trustedRoute.transport)} route`
    );
  }
  if (!requireExact) {
    if (transport === "wsl") {
      return { ...trustedRoute, distro: distro ?? trustedRoute.distro };
    }
    return trustedRoute;
  }

  const recordedLauncher = identity?.tmuxLauncher ?? identity?.tmux_launcher ?? null;
  const recordedControlBinary =
    identity?.tmuxControlBinary ?? identity?.tmux_control_binary ?? null;
  const recordedSocket = identity?.tmuxSocketName ?? identity?.tmux_socket_name ?? null;
  if (
    typeof recordedLauncher !== "string" ||
    !recordedLauncher ||
    typeof recordedControlBinary !== "string" ||
    !recordedControlBinary ||
    typeof recordedSocket !== "string" ||
    !recordedSocket
  ) {
    throw new Error("Recorded tmux route is missing its exact launcher or socket identity");
  }
  const currentIdentity = tmuxRouteIdentity(trustedRoute);
  const normalizeCommand = (value, { hostLauncher = false } = {}) => {
    const normalized = String(value).trim();
    const isWindowsHostCommand =
      platform === "win32" &&
      ((hostLauncher && transport === "wsl") || transport === "local");
    return isWindowsHostCommand
      ? normalized.replace(/\//gu, "\\").toLocaleLowerCase("en-US")
      : normalized;
  };
  const normalizeDistro = (value) =>
    value == null ? null : String(value).toLocaleLowerCase("en-US");
  if (
    normalizeDistro(distro) !== normalizeDistro(trustedRoute.distro ?? null) ||
    normalizeCommand(recordedLauncher, { hostLauncher: true }) !==
      normalizeCommand(currentIdentity.tmuxLauncher, { hostLauncher: true }) ||
    normalizeCommand(recordedControlBinary) !==
      normalizeCommand(currentIdentity.tmuxControlBinary) ||
    recordedSocket !== currentIdentity.tmuxSocketName
  ) {
    throw new Error("Recorded tmux route does not match the current trusted route");
  }
  return trustedRoute;
}

/**
 * Non-secret comparison identity for a trusted route. Persisted copies must
 * never be executed; routeForIdentity compares them to a freshly trusted route.
 */
export function tmuxRouteIdentity(route, { env = process.env } = {}) {
  if (!route || (route.transport !== "local" && route.transport !== "wsl")) {
    throw new Error("A trusted tmux route is required");
  }
  const launcher = typeof route.command === "string" ? route.command.trim() : "";
  const controlBinary =
    typeof route.tmuxBinary === "string" && route.tmuxBinary.trim()
      ? route.tmuxBinary.trim()
      : route.transport === "wsl"
        ? DEFAULT_TMUX_BINARY
        : launcher;
  if (!launcher || !controlBinary) {
    throw new Error("A trusted tmux route must name its launcher and control binary");
  }
  return Object.freeze({
    tmuxLauncher: launcher,
    tmuxControlBinary: controlBinary,
    tmuxSocketName: route.tmuxSocketName ?? tmuxSocketName(env),
  });
}

function recordedTmuxIdentity(record) {
  return {
    tmuxTransport: record?.tmux_transport ?? null,
    tmuxDistro: record?.tmux_distro ?? null,
    tmuxLauncher: record?.tmux_launcher ?? null,
    tmuxControlBinary: record?.tmux_control_binary ?? null,
    tmuxSocketName: record?.tmux_socket_name ?? null,
    tmuxIdentityRequired: true,
  };
}

function appendBoundedUtf8(chunks, size, chunk, maxBytes) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const available = Math.max(0, maxBytes - size);
  if (available > 0) chunks.push(bytes.subarray(0, available));
  return {
    size: size + Math.min(bytes.length, available),
    overflowed: bytes.length > available,
  };
}

function truncateUtf8(value, maxBytes) {
  const encoded = Buffer.from(String(value));
  if (encoded.length <= maxBytes) return String(value);
  let end = maxBytes;
  // Never cut between a UTF-8 leading byte and its continuation bytes.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf-8");
}

function decodeChunks(chunks, maxBytes) {
  return truncateUtf8(Buffer.concat(chunks).toString("utf-8"), maxBytes);
}

function boundedDiagnostic(existing, message, maxBytes) {
  const diagnostic = truncateUtf8(message, maxBytes);
  const diagnosticBytes = Buffer.byteLength(diagnostic);
  if (diagnosticBytes >= maxBytes) return diagnostic;
  const keep = Math.max(0, maxBytes - diagnosticBytes - 1);
  const current = truncateUtf8(existing, keep);
  return current ? `${current}\n${diagnostic}` : diagnostic;
}

/**
 * Run one short tmux/WSL control command with execFile-compatible bounds.
 * Native Windows may need a cmd.exe wrapper, so timeout and overflow must stop
 * the wrapper's entire process tree rather than only its visible child object.
 */
export function runExecFile(
  command,
  args,
  {
    env = process.env,
    platform = process.platform,
    crossSpawnFn = crossSpawn,
    execFileFn = execFile,
    terminateTreeFn = terminateWindowsProcessTree,
    timeoutMs = TMUX_EXEC_TIMEOUT_MS,
    maxBuffer = TMUX_EXEC_MAX_BUFFER_BYTES,
  } = {}
) {
  const outputLimit =
    Number.isSafeInteger(maxBuffer) && maxBuffer > 0
      ? maxBuffer
      : TMUX_EXEC_MAX_BUFFER_BYTES;
  if (platform === "win32") {
    return new Promise((resolve) => {
      let child;
      try {
        // Native Windows tmux overrides are commonly `.cmd` test doubles or
        // package shims. Raw execFile cannot launch those, while cross-spawn
        // preserves argv boundaries and resolves the fixed cmd.exe wrapper.
        child = crossSpawnFn(command, args, {
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({ stdout: "", stderr: error.message, exitCode: 127 });
        return;
      }

      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const currentOutput = () => ({
        stdout: decodeChunks(stdoutChunks, outputLimit),
        stderr: decodeChunks(stderrChunks, outputLimit),
      });
      const terminateAndFinish = (exitCode, diagnostic) => {
        const output = currentOutput();
        // Walk the exact live wrapper tree before touching its streams or
        // ChildProcess reference. Detaching first can let cmd.exe exit and
        // reparent the vendor child before taskkill /T enumerates descendants.
        const termination = terminateTreeFn(child.pid);
        // Detach all local handles even if taskkill fails. The failed tree kill
        // remains explicit in the result, but a resolved control probe must not
        // keep its own Node process alive through abandoned wrapper pipes.
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try {
            stream?.destroy?.();
          } catch {}
        }
        try {
          child.unref?.();
        } catch {}
        const terminationFailure =
          termination?.status === "succeeded"
            ? ""
            : `; ${termination?.reason || "Windows process-tree termination failed"}`;
        finish({
          stdout: output.stdout,
          stderr: boundedDiagnostic(
            output.stderr,
            `${diagnostic}${terminationFailure}`,
            outputLimit
          ),
          exitCode,
        });
      };
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        const appended = appendBoundedUtf8(
          stdoutChunks,
          stdoutBytes,
          chunk,
          outputLimit
        );
        stdoutBytes = appended.size;
        if (appended.overflowed) {
          terminateAndFinish(
            125,
            `tmux command stdout exceeded the ${outputLimit}-byte limit`
          );
        }
      });
      child.stderr.on("data", (chunk) => {
        if (settled) return;
        const appended = appendBoundedUtf8(
          stderrChunks,
          stderrBytes,
          chunk,
          outputLimit
        );
        stderrBytes = appended.size;
        if (appended.overflowed) {
          terminateAndFinish(
            125,
            `tmux command stderr exceeded the ${outputLimit}-byte limit`
          );
        }
      });
      child.once("error", (error) =>
        finish({
          ...currentOutput(),
          stderr: currentOutput().stderr || error.message,
          exitCode: 127,
        })
      );
      child.once("close", (code) => {
        finish({
          ...currentOutput(),
          exitCode: Number.isInteger(code) ? code : 124,
        });
      });
      timer = setTimeout(() => {
        terminateAndFinish(124, `tmux command timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  return new Promise((resolve) => {
    execFileFn(
      command,
      args,
      {
        encoding: "utf-8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: outputLimit,
        windowsHide: platform === "win32",
        env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof error.code === "number"
              ? error.code
              : error.killed
                ? 124
                : 127;
          resolve({
            stdout,
            stderr: stderr || error.message,
            exitCode: code,
          });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      }
    );
  });
}

export async function runTmux(args, { allowFailure = false, route = null } = {}) {
  const invocation = tmuxCommandArgs(args, { route });
  const result = await runExecFile(invocation.command, invocation.args);
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(
      `tmux ${args.join(" ")} failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}

/** Resolve one exact distro user's POSIX-compatible login shell. */
export async function resolveWslLoginShell(
  route,
  { runExecFileFn = runExecFile, cache = WSL_LOGIN_SHELL_CACHE } = {}
) {
  if (route?.transport !== "wsl") return DEFAULT_WSL_LOGIN_SHELL;
  if (route.loginShell) return normalizeWslLoginShell(route.loginShell);

  const cacheKey = wslLoginShellCacheKey(route);
  const cached = cache?.get(cacheKey);
  if (cached) return normalizeWslLoginShell(cached);

  let result;
  try {
    result = await runExecFileFn(
      route.command,
      wslCommandArgs(wslLoginShellProbeArgs(), route)
    );
  } catch {
    return DEFAULT_WSL_LOGIN_SHELL;
  }
  if (result?.exitCode !== 0) return DEFAULT_WSL_LOGIN_SHELL;
  const loginShell = normalizeWslLoginShell(String(result.stdout ?? ""));
  cache?.set(cacheKey, loginShell);
  return loginShell;
}

/**
 * Can we run tmux at all? `available` | `missing` | `unknown`.
 *
 * A timeout is not proof tmux is absent, and reporting it as such tells a
 * caller to stop using a runtime that is merely slow.
 */
export async function probeTmuxAvailability({ route = tmuxRoute() } = {}) {
  let result;
  try {
    result = await runTmux(["-V"], { allowFailure: true, route });
  } catch {
    return "unknown";
  }
  if (result.exitCode === 0) return "available";
  // execFile reports a binary that will not spawn as 127 and a killed call as
  // 124; only the former proves tmux is not there.
  if (result.exitCode === 127) return "missing";
  if (
    route.transport === "wsl" &&
    /(?:execvpe\(tmux\)|tmux: .*not found|no installed distributions)/i.test(
      `${result.stderr}\n${result.stdout}`
    )
  ) {
    return "missing";
  }
  return "unknown";
}

export async function isTmuxAvailable() {
  return (await probeTmuxAvailability()) === "available";
}

/** Resolve WSL's current default once so the rest of a turn can pin it by name. */
export async function resolveWslRouteDistro(
  route,
  { runExecFileFn = runExecFile } = {}
) {
  if (route?.transport !== "wsl" || route.distro) return route;
  const result = await runExecFileFn(
    route.command,
    wslCommandArgs(
      ["/bin/sh", "-c", 'printf "%s" "${WSL_DISTRO_NAME:-}"'],
      route
    )
  );
  const distro = String(result.stdout || "").trim();
  if (result.exitCode !== 0 || !distro) {
    throw new Error("WSL did not report the distribution selected for this Dualog turn");
  }
  return { ...route, distro };
}

/** Convert a native absolute path for a WSL-hosted tmux command. */
export async function translateTmuxPath(
  value,
  { route = tmuxRoute(), runExecFileFn = runExecFile } = {}
) {
  if (route.transport !== "wsl" || !isWindowsPath(value)) return value;
  const unc = parseWslUncPath(value);
  if (unc) {
    if (route.distro && !sameWslDistro(route.distro, unc.distro)) {
      throw new Error(
        `WSL path ${JSON.stringify(value)} belongs to distribution ${JSON.stringify(unc.distro)}, but Dualog is routed to ${JSON.stringify(route.distro)}`
      );
    }
    return unc.linuxPath;
  }
  const result = await runExecFileFn(
    route.command,
    wslCommandArgs(["wslpath", "-a", "-u", value], route)
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `WSL could not translate path ${value}: ${result.stderr || result.stdout}`
    );
  }
  const translated = result.stdout.trim();
  if (!translated) throw new Error(`WSL returned no translation for path ${value}`);
  return translated;
}

/**
 * Read-only project context for prompt builders and the eventual tmux launch.
 * The returned route is the exact route that translated the partner path.
 */
export async function resolveTmuxProjectContext(
  projectPath,
  {
    route = tmuxRoute(),
    convertPath = null,
    runExecFileFn = runExecFile,
  } = {}
) {
  let selectedRoute = resolveTmuxRouteForPaths(route, [projectPath]);
  selectedRoute = await resolveWslRouteDistro(selectedRoute, { runExecFileFn });
  const partnerProjectPath =
    selectedRoute.transport === "wsl"
      ? await (convertPath
          ? convertPath(projectPath, { route: selectedRoute })
          : translateTmuxPath(projectPath, {
              route: selectedRoute,
              runExecFileFn,
            }))
      : projectPath;
  const routeIdentity = tmuxRouteIdentity(selectedRoute);
  return Object.freeze({
    hostProjectPath: projectPath,
    partnerProjectPath,
    tmuxTransport: selectedRoute.transport,
    tmuxDistro: selectedRoute.distro ?? null,
    tmuxRoute: Object.freeze({ ...selectedRoute }),
    ...routeIdentity,
  });
}

/**
 * Convert the values a Linux CLI receives while leaving filesystem setup on the
 * Windows host. Config isolation and sidecars are created before this runs, so
 * they remain the same files through WSL's /mnt/<drive> mount.
 */
export async function prepareTmuxInvocation(
  { cwd, command, args = [], env = {} },
  { route = tmuxRoute(), convertPath } = {}
) {
  const selectedRoute = resolveTmuxRouteForPaths(route, [
    cwd,
    command,
    ...args,
    ...Object.values(env),
  ]);
  if (selectedRoute.transport !== "wsl") {
    const routeIdentity = tmuxRouteIdentity(selectedRoute);
    return {
      cwd,
      command,
      args: [...args],
      env: { ...env },
      tmuxTransport: selectedRoute.transport,
      tmuxDistro: null,
      tmuxRoute: selectedRoute,
      ...routeIdentity,
    };
  }

  const cache = new Map();
  const convert =
    convertPath ??
    (async (value) => {
      if (!isWindowsPath(value)) return value;
      if (!cache.has(value)) {
        cache.set(value, translateTmuxPath(value, { route: selectedRoute }));
      }
      return cache.get(value);
    });

  const convertedEnv = {};
  for (const [key, value] of Object.entries(env)) {
    convertedEnv[key] = await convert(value, { route: selectedRoute });
  }

  const routeIdentity = tmuxRouteIdentity(selectedRoute);
  return {
    cwd: await convert(cwd, { route: selectedRoute }),
    command: await convert(command, { route: selectedRoute }),
    args: await Promise.all(args.map((arg) => convert(arg, { route: selectedRoute }))),
    env: convertedEnv,
    tmuxTransport: selectedRoute.transport,
    tmuxDistro: selectedRoute.distro ?? null,
    tmuxRoute: selectedRoute,
    ...routeIdentity,
  };
}

// Resolve inside the same interactive login shell that will launch the partner,
// but pass every dynamic value as argv. `command -v` therefore sees the user's
// real WSL PATH without granting the reviewed project any shell-program text.
// Both the lexical path and its symlink-resolved target are checked: a shim
// physically inside the project is unsafe even when it points out, and a trusted
// looking path is unsafe when its final target points back in.
export const WSL_PARTNER_EXECUTABLE_RESOLVE_SCRIPT = [
  "candidate=$1",
  "project_root=$2",
  "reader=",
  "for tool in /usr/bin/readlink /bin/readlink; do",
  '  if [ -x "$tool" ] && [ ! -d "$tool" ]; then reader=$tool; break; fi',
  "done",
  '[ -n "$reader" ] || exit 67',
  'case "$project_root" in /*) ;; *) exit 67;; esac',
  'project_root=${project_root%/}',
  '[ -n "$project_root" ] || project_root=/',
  'project_canonical=$("$reader" -f -- "$project_root" 2>/dev/null) || exit 67',
  '[ -n "$project_canonical" ] && [ -d "$project_canonical" ] || exit 67',
  'cd "$project_canonical" || exit 67',
  'case "$candidate" in',
  '  /*) resolved=$candidate ;;',
  '  *) resolved=$(command -v "$candidate" 2>/dev/null) || exit 127 ;;',
  "esac",
  '[ -n "$resolved" ] || exit 127',
  'case "$resolved" in /*) lexical=$resolved ;; *) lexical=$PWD/$resolved ;; esac',
  'if [ "$project_root" = / ] || [ "$project_canonical" = / ]; then exit 66; fi',
  'case "$candidate" in "$project_root"|"$project_root"/*) exit 66;; esac',
  'case "$lexical" in "$project_root"|"$project_root"/*) exit 66;; esac',
  'case "$lexical" in "$project_canonical"|"$project_canonical"/*) exit 66;; esac',
  '[ -f "$resolved" ] && [ -x "$resolved" ] || exit 127',
  'canonical=$("$reader" -f -- "$resolved" 2>/dev/null) || exit 67',
  '[ -n "$canonical" ] && [ -f "$canonical" ] && [ -x "$canonical" ] || exit 67',
  'case "$canonical" in "$project_canonical"|"$project_canonical"/*) exit 68;; esac',
  "printf '\\000%s\\000' \"$canonical\"",
].join("\n");

/**
 * Pin one native-Windows -> WSL partner command to its exact canonical Linux
 * executable outside the reviewed project. A missing command returns null so
 * automatic engine selection can retain its documented native-headless
 * fallback; unsafe or unprovable commands are refused.
 */
export async function resolveWslPartnerExecutable(
  command,
  {
    projectPath,
    route = tmuxRoute(),
    runExecFileFn = runExecFile,
    resolveWslLoginShellFn = resolveWslLoginShell,
  } = {}
) {
  if (route?.transport !== "wsl") {
    throw new Error("A WSL partner executable can only be resolved on a WSL route");
  }
  if (
    typeof command !== "string" ||
    !command ||
    command.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(command)
  ) {
    throw new Error("WSL partner command is invalid");
  }
  if (
    typeof projectPath !== "string" ||
    !projectPath ||
    projectPath.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(projectPath)
  ) {
    throw new Error("WSL reviewed project path is invalid");
  }

  let selectedRoute = resolveTmuxRouteForPaths(route, [command, projectPath]);
  selectedRoute = await resolveWslRouteDistro(selectedRoute, { runExecFileFn });
  const [translatedCommand, translatedProjectPath] = await Promise.all([
    translateTmuxPath(command, { route: selectedRoute, runExecFileFn }),
    translateTmuxPath(projectPath, { route: selectedRoute, runExecFileFn }),
  ]);
  const normalizedProjectPath = path.posix.normalize(translatedProjectPath);
  if (!path.posix.isAbsolute(normalizedProjectPath)) {
    throw new Error("WSL reviewed project path did not resolve to an absolute Linux path");
  }
  if (!path.posix.isAbsolute(translatedCommand)) {
    if (
      translatedCommand.startsWith("-") ||
      translatedCommand.includes("/") ||
      translatedCommand.includes("\\")
    ) {
      throw new Error(
        `WSL partner command ${JSON.stringify(command)} is relative; use a bare command name or an absolute Linux path`
      );
    }
  }

  const loginShell = await resolveWslLoginShellFn(selectedRoute, { runExecFileFn });
  const result = await runExecFileFn(
    selectedRoute.command,
    wslCommandArgs(
      wslLoginShellArgs(loginShell, WSL_PARTNER_EXECUTABLE_RESOLVE_SCRIPT, {
        arg0: "dualog-wsl-resolve-partner",
        args: [translatedCommand, normalizedProjectPath],
      }),
      selectedRoute
    )
  );
  if (result.exitCode === 127) return null;
  if (result.exitCode === 66 || result.exitCode === 68) {
    throw new Error(
      `WSL partner command ${JSON.stringify(command)} resolves inside the reviewed project ${JSON.stringify(translatedProjectPath)}`
    );
  }
  if (result.exitCode === 67) {
    throw new Error(
      `WSL could not safely canonicalize partner command ${JSON.stringify(command)} outside the reviewed project`
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `WSL could not safely resolve partner command ${JSON.stringify(command)} (exit ${result.exitCode})`
    );
  }

  const stdout = String(result.stdout ?? "");
  const end = stdout.lastIndexOf("\0");
  const start = end > 0 ? stdout.lastIndexOf("\0", end - 1) : -1;
  const executable = start >= 0 && end > start ? stdout.slice(start + 1, end) : "";
  if (
    !path.posix.isAbsolute(executable) ||
    executable.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(executable)
  ) {
    throw new Error(
      `WSL returned an invalid canonical path for partner command ${JSON.stringify(command)}`
    );
  }
  return executable;
}

/**
 * Probe one exact partner executable in the selected WSL distribution while
 * retaining its bounded first version line for status callers.
 */
export async function inspectWslPartnerCommand(
  command,
  versionArgs = [],
  { route = tmuxRoute(), runExecFileFn = runExecFile } = {}
) {
  if (route.transport !== "wsl") {
    return { availability: "not-applicable", version: null };
  }
  if (typeof command !== "string" || !command.trim()) {
    return { availability: "unavailable", version: null };
  }

  const executable = await translateTmuxPath(command, { route, runExecFileFn });
  const loginShell = await resolveWslLoginShell(route, { runExecFileFn });
  const result = await runExecFileFn(
    route.command,
    // Match tmux's payload exactly. WSL's direct --exec path does not include
    // the PATH that the selected interactive login shell receives, so a
    // valid Claude installation can otherwise look absent during preflight.
    wslCommandArgs(
      wslLoginShellArgs(loginShell, 'exec "$@"', {
        arg0: "dualog-wsl-probe",
        args: [executable, ...versionArgs],
      }),
      route
    )
  );
  if (result.exitCode !== 0) {
    return { availability: "unavailable", version: null };
  }
  const version = String(result.stdout || result.stderr || "")
    .trim()
    .split(/\r?\n/u)[0] || null;
  return { availability: "available", version };
}

/** Is the selected partner command runnable from the WSL distribution tmux uses? */
export async function probeWslPartnerCommand(command, versionArgs = [], options = {}) {
  return (await inspectWslPartnerCommand(command, versionArgs, options)).availability;
}

/**
 * Seed a WSL Codex login only when native config isolation found no auth.
 * The source never crosses stdout: WSL copies it directly into the already
 * validated lease path, and the shell refuses to replace a native seed.
 */
export async function seedWslCodexAuth(
  { nativeCodexHome, wslCodexHome, route },
  { runExecFileFn = runExecFile } = {}
) {
  if (route?.transport !== "wsl") return { seeded: false, reason: "not-wsl" };
  if (typeof nativeCodexHome !== "string" || typeof wslCodexHome !== "string") {
    return { seeded: false, reason: "missing-home" };
  }
  const nativeAuthPath = path.join(nativeCodexHome, "auth.json");
  if (fs.existsSync(nativeAuthPath)) {
    return { seeded: false, reason: "native-seed-present" };
  }
  const script = [
    "set -eu",
    'target_dir=$1',
    'target=$target_dir/auth.json',
    'source_home=${CODEX_HOME:-"$HOME/.codex"}',
    'case "$source_home" in [A-Za-z]:[\\\\/]*) source_home=$(wslpath -a -u "$source_home") || exit 4;; esac',
    'source=$source_home/auth.json',
    '[ -d "$target_dir" ] && [ ! -L "$target_dir" ] || exit 4',
    'if [ -e "$target" ] || [ -L "$target" ]; then [ -f "$target" ] && [ ! -L "$target" ] || exit 4; exit 0; fi',
    'if [ ! -f "$source" ]; then exit 3; fi',
    "umask 077",
    'tmp=$(mktemp "$target_dir/.auth.json.dualog.XXXXXX") || exit 4',
    'trap \'rm -f -- "$tmp"\' EXIT HUP INT TERM',
    'dd if="$source" of="$tmp" bs=1048577 count=1 2>/dev/null || exit 4',
    // BSD wc pads counts with spaces while GNU wc commonly does not. Strip
    // whitespace before the numeric check so this bounded copy is itself
    // portable even though it normally executes inside WSL.
    'size=$(wc -c < "$tmp" | tr -d \'[:space:]\') || exit 4',
    'case "$size" in ""|*[!0-9]*) exit 4;; esac',
    '[ "$size" -le 1048576 ] || exit 5',
    'chmod 600 "$tmp" || exit 4',
    'if [ -e "$target" ] || [ -L "$target" ]; then [ -f "$target" ] && [ ! -L "$target" ] || exit 4; exit 0; fi',
    'mv -n -- "$tmp" "$target" || exit 4',
    '[ -f "$target" ] && [ ! -L "$target" ] || exit 4',
  ].join("; ");
  const wslHostEnv = { ...process.env };
  for (const name of Object.keys(wslHostEnv)) {
    if (name.toUpperCase() === "CODEX_HOME") delete wslHostEnv[name];
  }
  const result = await runExecFileFn(
    route.command,
    wslCommandArgs(
      wslLoginShellArgs(await resolveWslLoginShell(route, { runExecFileFn }), script, {
        arg0: "dualog-wsl-codex-auth",
        args: [wslCodexHome],
      }),
      route
    ),
    { env: wslHostEnv }
  );
  if (result.exitCode === 3) return { seeded: false, reason: "wsl-auth-missing" };
  if (result.exitCode === 5) return { seeded: false, reason: "wsl-auth-too-large" };
  if (result.exitCode !== 0) return { seeded: false, reason: "wsl-copy-failed" };
  const seeded = fs.existsSync(nativeAuthPath);
  return { seeded, reason: seeded ? null : "wsl-copy-unconfirmed" };
}

export function tmuxPaneProcessStartTime(
  pid,
  {
    transport = null,
    distro = null,
    route = null,
    spawnSyncFn = crossSpawn.sync,
    platform = process.platform,
    tmuxLauncher = null,
    tmuxControlBinary = null,
    tmuxSocketName = null,
    requireExactIdentity = false,
  } = {}
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let selectedRoute;
  try {
    selectedRoute = routeForIdentity(
      {
        tmuxTransport: transport,
        tmuxDistro: distro,
        tmuxLauncher,
        tmuxControlBinary,
        tmuxSocketName,
        tmuxIdentityRequired: requireExactIdentity,
        ...(requireExactIdentity ? {} : { tmuxRoute: route }),
      },
      route ?? tmuxRoute({ platform }),
      { platform }
    );
  } catch {
    return null;
  }
  if (selectedRoute.transport !== "wsl") return null;
  try {
    const result = spawnSyncFn(
      selectedRoute.command,
      wslCommandArgs(["ps", "-o", "lstart=", "-p", String(pid)], selectedRoute, {
        platform,
      }),
      {
        encoding: "utf-8",
        timeout: 2000,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: process.platform === "win32",
      }
    );
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/** Probe a WSL pane PID from native Windows without mistaking it for a Win32 PID. */
export function probeWslPaneProcess(
  pid,
  recordedStartTime = null,
  {
    transport = "wsl",
    distro = null,
    route = null,
    spawnSyncFn = crossSpawn.sync,
    platform = process.platform,
    tmuxLauncher = null,
    tmuxControlBinary = null,
    tmuxSocketName = null,
    requireExactIdentity = false,
  } = {}
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "invalid";
  let selectedRoute;
  try {
    selectedRoute = routeForIdentity(
      {
        tmuxTransport: transport,
        tmuxDistro: distro,
        tmuxLauncher,
        tmuxControlBinary,
        tmuxSocketName,
        tmuxIdentityRequired: requireExactIdentity,
        ...(requireExactIdentity ? {} : { tmuxRoute: route }),
      },
      route ?? tmuxRoute({ platform }),
      { platform }
    );
  } catch {
    return "unknown";
  }
  if (selectedRoute.transport !== "wsl") return "unknown";
  let result;
  try {
    result = spawnSyncFn(
      selectedRoute.command,
      wslCommandArgs(["ps", "-o", "lstart=", "-p", String(pid)], selectedRoute, {
        platform,
      }),
      {
        encoding: "utf-8",
        timeout: 2000,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: process.platform === "win32",
      }
    );
  } catch {
    return "unknown";
  }
  if (result.error || result.status == null) return "unknown";
  const startedAt = String(result.stdout || "").trim();
  if (result.status === 1 && !startedAt && !String(result.stderr || "").trim()) {
    return "absent";
  }
  if (result.status !== 0 || !startedAt) return "unknown";
  return recordedStartTime && startedAt !== recordedStartTime ? "absent" : "alive";
}

export function buildTmuxSessionName(sessionId, label) {
  const raw = `dlg-${sessionId}-${label}`;
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 180);
  if (!sanitized) {
    throw new Error(`Invalid tmux session name derived from ${raw}`);
  }
  return sanitized;
}

export async function startTmuxSession({
  sessionName,
  cwd,
  command,
  args,
  env,
  route = tmuxRoute(),
  socketName = null,
}) {
  const loginShell = await resolveWslLoginShell(route);
  const selectedRoute = {
    ...route,
    ...(route.transport === "wsl" ? { loginShell } : {}),
    tmuxSocketName: socketName ?? route.tmuxSocketName ?? tmuxSocketName(),
  };
  const routeIdentity = tmuxRouteIdentity(selectedRoute);
  await prepareTmuxServer(selectedRoute);
  const payload = buildTmuxShellPayload(
    { command, args, env },
    loginShell,
    { interactiveLogin: selectedRoute.transport === "wsl" }
  );
  try {
    await runTmux(["new-session", "-d", "-s", sessionName, "-c", cwd, payload], {
      route: selectedRoute,
    });
  } catch (err) {
    // The CLIENT failed; the SERVER may still act on what it was handed. A
    // timed-out client is SIGKILLed, and tmux processes commands it already has,
    // so "new-session threw" does not mean no pane will exist. Killing the name
    // is the only way to make that true, and it is ordered after the create, so
    // the server applies them in that order.
    await runTmux(["kill-session", "-t", `=${sessionName}`], {
      allowFailure: true,
      route: selectedRoute,
    });
    err.sessionName = sessionName;
    err.tmuxTransport = selectedRoute.transport;
    err.tmuxDistro = selectedRoute.distro ?? null;
    Object.assign(err, routeIdentity);
    throw err;
  }
  const paneTarget = `${sessionName}:0.0`;

  // THE PROCESS IDENTITY IS CAPTURED FIRST, before anything else that can fail.
  //
  // A tmux session going away does not prove the program it was running has
  // exited -- a partner CLI flushes caches during shutdown, after its pane is
  // gone -- so whatever decides "is this partner finished" needs a handle on the
  // process. The shell payload `exec`s into the CLI, so pane_pid IS that process.
  //
  // Order matters as much as the value. This used to run after
  // configureTmuxSession() and the pane_id query, so a failure in either left a
  // LIVE pane whose process was never recorded; cleanup then fell back to
  // session-only probes and could remove the home while that process ran. It is
  // now the first thing asked after the pane exists, and a failure to read it is
  // survivable -- the caller still gets a handle, just without the stronger
  // identity.
  let panePid = null;
  let panePidUnavailable = false;
  try {
    const raw = (
      await runTmux(["display-message", "-p", "-t", paneTarget, "#{pane_pid}"], {
        route: selectedRoute,
      })
    ).stdout.trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) panePid = parsed;
    else panePidUnavailable = true;
  } catch {
    panePidUnavailable = true;
  }
  // A FAILED capture is recorded as such, not left to look like a record from
  // before pane_pid existed. Those two are indistinguishable by the value alone
  // -- both are null -- but they mean opposite things: a legacy record falls back
  // to the session name, while a pane we KNOW exists and could not identify must
  // never let session absence stand in for the process having exited. That is
  // the production incident with no descendant and no setsid() required.

  try {
    await configureTmuxSession(sessionName, selectedRoute, loginShell);
    const paneId = (
      await runTmux(["display-message", "-p", "-t", paneTarget, "#{pane_id}"], {
        route: selectedRoute,
      })
    ).stdout.trim();
    return {
      sessionName,
      paneTarget,
      paneId,
      panePid,
      panePidUnavailable,
      cwd,
      command,
      args: [...args],
      env: env ? { ...env } : undefined,
      tmuxTransport: selectedRoute.transport,
      tmuxDistro: selectedRoute.distro ?? null,
      tmuxRoute: selectedRoute,
      ...routeIdentity,
      startedAt: new Date().toISOString(),
    };
  } catch (err) {
    await runTmux(["kill-session", "-t", `=${sessionName}`], {
      allowFailure: true,
      route: selectedRoute,
    });
    // Carry the identity out with the failure. The pane EXISTED -- new-session
    // returned -- so a caller holding a credential lease needs the process to
    // probe, not just the session name it is about to stop trusting.
    err.panePid = panePid;
    err.panePidUnavailable = panePidUnavailable;
    err.sessionName = sessionName;
    err.tmuxTransport = selectedRoute.transport;
    err.tmuxDistro = selectedRoute.distro ?? null;
    Object.assign(err, routeIdentity);
    throw err;
  }
}

export async function sendTextToTmux(handle, text, { enter = false, submitDelayMs = 0 } = {}) {
  const route = routeForIdentity(handle);
  if (text.length > 0) {
    const bufferName = `${handle.sessionName}-input`;
    await runTmux(["set-buffer", "-b", bufferName, text], { route });
    await runTmux([
      "paste-buffer",
      "-p",
      "-d",
      "-b",
      bufferName,
      "-t",
      handle.paneTarget,
    ], { route });
  }
  if (enter) {
    if (submitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    }
    await runTmux(["send-keys", "-t", handle.paneTarget, "C-m"], { route });
  }
}

/**
 * Send one literal or named key to an already-identified tmux pane.
 *
 * Printable characters use tmux's literal mode so a value such as `Enter` is
 * typed as text rather than interpreted as tmux's Enter key name. Named keys
 * come only from the closed map above; callers cannot smuggle tmux syntax or a
 * second command through this API.
 */
export async function sendKeyToTmux(handle, key, { submit = false } = {}) {
  const target = handle?.paneId || handle?.paneTarget;
  if (typeof target !== "string" || !target) {
    throw new Error("A tmux pane target is required");
  }

  const literal = typeof key === "string" && /^[\x20-\x7E]$/u.test(key);
  const keyCode = typeof key === "string" ? TMUX_KEY_CODES[key] : null;
  if (!literal && !keyCode) {
    throw new Error(
      `Unsupported tmux key ${JSON.stringify(key)}. Use one printable ASCII character or one of: ${TMUX_NAMED_KEYS.join(", ")}`
    );
  }
  if (submit === true && key === "enter") {
    throw new Error("submit cannot be used when key is already enter");
  }

  const route = routeForIdentity(handle);
  await runTmux(
    literal
      ? ["send-keys", "-l", "-t", target, key]
      : ["send-keys", "-t", target, keyCode],
    { route }
  );
  if (submit === true) {
    await runTmux(["send-keys", "-t", target, TMUX_KEY_CODES.enter], { route });
  }
}

export async function captureTmuxPane(handleOrSessionName, options = {}) {
  const handle =
    typeof handleOrSessionName === "string"
      ? {
          sessionName: handleOrSessionName,
          paneTarget: `${handleOrSessionName}:0.0`,
        }
      : handleOrSessionName;
  const route = routeForIdentity(handle);
  const lines = Number.isSafeInteger(options.lines)
    ? options.lines
    : DEFAULT_CAPTURE_LINES;
  const result = await runTmux([
    "capture-pane",
    "-p",
    "-J",
    "-S",
    `-${Math.max(1, lines)}`,
    "-t",
    handle.paneTarget,
  ], { route });
  return result.stdout;
}

/**
 * A tmux target that can only ever name the session it spells out.
 *
 * `-t name` is NOT an exact lookup: tmux matches a bare target as a prefix or
 * fnmatch pattern, so `has-session -t real` succeeds against a session called
 * `realone` (verified against tmux 3.5a). `=` forces exact matching.
 *
 * The colon rejection is separate and equally load-bearing: `=realone:0` is a
 * WINDOW target and still exits 0, so a name carrying a colon could report a
 * window as though it were the session.
 */
function tmuxSessionTarget(sessionName) {
  if (typeof sessionName !== "string") return null;
  if (!sessionName || sessionName.includes(":") || sessionName.includes("\0")) {
    return null;
  }
  return `=${sessionName}`;
}

// A non-zero tmux exit that PROVES no such session exists. Everything outside
// these two shapes is a failure to ask the question, not an answer to it.
//
//   - the server declined to find the session  -> it is not there
//   - there is no server to ask                -> nothing is there
//
// `error connecting to` is matched only for the two errnos that mean the socket
// leads nowhere. `(Permission denied)` is deliberately excluded: a socket we may
// not open is one somebody else's server is very likely still listening on.
const TMUX_NO_SUCH_SESSION = /can't find session|session not found/i;
const TMUX_NO_SERVER =
  /no server running|error connecting to .*\((?:no such file or directory|connection refused)\)/i;

/**
 * What a failed tmux probe actually proves: `absent` or `unknown`.
 *
 * Exported so the two probes below cannot drift apart in the one judgement that
 * matters. A verdict of `unknown` covers the tmux binary being missing (exit
 * 127), the call timing out (124), and any message this version does not
 * recognise -- none of which are evidence that a pane died.
 */
export function classifyTmuxProbeFailure({ stdout = "", stderr = "" } = {}) {
  const text = `${stderr}\n${stdout}`;
  if (TMUX_NO_SUCH_SESSION.test(text)) return "absent";
  if (TMUX_NO_SERVER.test(text)) return "absent";
  return "unknown";
}

/**
 * Is this tmux session there? `alive` | `absent` | `unknown`.
 *
 * The three-valued answer is the point. Collapsing `unknown` into "gone" is how
 * a ten-second tmux timeout during a long turn became "the partner's pane
 * exited", aborting a turn that was running perfectly well.
 */
export async function probeTmuxSession(sessionName, identity = null) {
  const target = tmuxSessionTarget(sessionName);
  if (!target) return "unknown";
  let result;
  try {
    const route = routeForIdentity(identity);
    result = await runTmux(["has-session", "-t", target], {
      allowFailure: true,
      route,
    });
  } catch {
    // tmuxBinary()/tmuxSocketName() reject unusable configuration by throwing.
    // That is a broken question, not a dead pane.
    return "unknown";
  }
  if (result.exitCode === 0) return "alive";
  return classifyTmuxProbeFailure(result);
}

/**
 * `probeTmuxSession()` for callers that cannot await.
 *
 * `proveSessionInactive()` is synchronous and decides whether to DELETE a
 * partner home, so it needs this exact question answered on the same terms --
 * through the same binary and socket as everything else here. It previously
 * carried a private copy that shelled out to a bare `tmux`, ignoring
 * DUALOG_TMUX_BINARY: with that override set, cleanup probed a different tmux
 * than the one holding the session and read a live pane as absent.
 */
export function probeTmuxSessionSync(
  sessionName,
  {
    route = null,
    transport = null,
    distro = null,
    spawnSyncFn = crossSpawn.sync,
    platform = process.platform,
    tmuxLauncher = null,
    tmuxControlBinary = null,
    tmuxSocketName = null,
    requireExactIdentity = false,
  } = {}
) {
  const target = tmuxSessionTarget(sessionName);
  if (!target) return "unknown";
  let result;
  try {
    const selectedRoute = routeForIdentity(
      {
        tmuxTransport: transport,
        tmuxDistro: distro,
        tmuxLauncher,
        tmuxControlBinary,
        tmuxSocketName,
        tmuxIdentityRequired: requireExactIdentity,
        ...(requireExactIdentity ? {} : { tmuxRoute: route }),
      },
      route ?? tmuxRoute({ platform }),
      { platform }
    );
    const invocation = tmuxCommandArgs(["has-session", "-t", target], {
      route: selectedRoute,
      platform,
    });
    result = spawnSyncFn(invocation.command, invocation.args, {
      encoding: "utf-8",
      timeout: TMUX_EXEC_TIMEOUT_MS,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: process.platform === "win32",
    });
  } catch {
    return "unknown";
  }
  if (result.error) return "unknown";
  if (result.status === 0) return "alive";
  // A null status means killed by signal -- our own timeout, most likely.
  if (result.status == null) return "unknown";
  return classifyTmuxProbeFailure({
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  });
}

/**
 * Boolean liveness, for callers where "cannot tell" and "gone" are the same
 * decision. Anything that must not act on a guess wants probeTmuxSession().
 */
export async function isTmuxSessionAlive(sessionName, identity = null) {
  return (await probeTmuxSession(sessionName, identity)) === "alive";
}

/**
 * Confirm that a stable pane id belongs to one exact Dualog tmux session.
 *
 * Pane ids are server-global. Trusting a pane id and a session name merely
 * because they appeared beside each other in current_terminal.json would let a
 * stale or modified record address another pane on the same socket. list-panes
 * against an exact session target binds the two identities before input is
 * delivered.
 */
export async function tmuxPaneBelongsToSession(sessionName, paneId, identity = null) {
  const target = tmuxSessionTarget(sessionName);
  if (!target || typeof paneId !== "string" || !/^%\d+$/u.test(paneId)) {
    return false;
  }
  let result;
  try {
    const route = routeForIdentity(identity);
    result = await runTmux(
      ["list-panes", "-t", target, "-F", "#{pane_id}"],
      { allowFailure: true, route }
    );
  } catch {
    return false;
  }
  if (result.exitCode !== 0) return false;
  return result.stdout.split(/\r?\n/u).some((id) => id.trim() === paneId);
}

export async function terminateTmuxSession(handleOrSessionName) {
  const handle =
    typeof handleOrSessionName === "string"
      ? {
          sessionName: handleOrSessionName,
          paneTarget: `${handleOrSessionName}:0.0`,
        }
      : handleOrSessionName;
  if (!handle?.sessionName) return "unknown";
  let route;
  try {
    route = routeForIdentity(handle);
  } catch {
    return "unknown";
  }
  // Only a PROVEN absence ends this early. "Cannot tell" must fall through to
  // the escalation below: giving up there leaves a pane running under a partner
  // that nobody will terminate again, and the kill attempts are already
  // failure-tolerant, so trying against a session that turns out to be gone
  // costs nothing.
  const probe = () => probeTmuxSession(handle.sessionName, { tmuxRoute: route });
  if ((await probe()) === "absent") return "absent";

  try {
    await sendTextToTmux(handle, "/exit", { enter: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {}
  if ((await probe()) === "absent") return "absent";

  try {
    await runTmux(["send-keys", "-t", handle.paneTarget, "C-c"], {
      allowFailure: true,
      route,
    });
    await runTmux(["send-keys", "-t", handle.paneTarget, "C-c"], {
      allowFailure: true,
      route,
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {}
  if ((await probe()) === "absent") return "absent";

  await runTmux(["kill-session", "-t", handle.sessionName], {
    allowFailure: true,
    route,
  });
  // Probe AFTER the kill rather than assuming it worked. `kill-session` runs
  // with allowFailure, so its own result says nothing, and a caller about to
  // release a credential lease needs the verdict rather than the attempt.
  return await probe();
}

export function currentTerminalStatePath(sessionDir) {
  return path.join(sessionDir, "current_terminal.json");
}

export function lastTerminalStatePath(sessionDir) {
  return path.join(sessionDir, "last_terminal.json");
}

export function readTerminalState(sessionDir) {
  const current = readJson(currentTerminalStatePath(sessionDir));
  const last = readJson(lastTerminalStatePath(sessionDir));
  return { current, last };
}

export function writeTerminalState(sessionDir, state, { active = true } = {}) {
  const next = {
    schema_version: 1,
    ...state,
    updated_at: new Date().toISOString(),
  };
  writeJsonAtomic(lastTerminalStatePath(sessionDir), next);
  if (active) {
    writeJsonAtomic(currentTerminalStatePath(sessionDir), next);
  } else {
    try {
      fs.unlinkSync(currentTerminalStatePath(sessionDir));
    } catch {}
  }
  return next;
}

export async function inspectPartnerTerminal(sessionDir, options = {}) {
  const { current, last } = readTerminalState(sessionDir);
  const terminal = current || last;
  if (!terminal?.session_name) {
    const availability = await probeTmuxAvailability();
    return {
      active: false,
      available: availability === "available",
      tmux_availability: availability,
      message: "No tmux-backed partner turn has been started for this session yet.",
    };
  }

  const handle = {
    sessionName: terminal.session_name,
    paneTarget: terminal.pane_target || `${terminal.session_name}:0.0`,
    ...recordedTmuxIdentity(terminal),
  };
  const liveness = await probeTmuxSession(terminal.session_name, handle);
  const alive = liveness === "alive";
  let captureText = null;
  let captureSource = null;
  let captureError = null;
  let captureTruncated = false;
  let fullCapture = null;
  let fullCaptureTruncated = false;
  const maxChars = Number.isSafeInteger(options.maxChars)
    ? options.maxChars
    : DEFAULT_CAPTURE_MAX_CHARS;
  const tailLines = Number.isSafeInteger(options.tailLines)
    ? Math.max(1, Math.min(40, options.tailLines))
    : DEFAULT_TAIL_LINES;
  const tailMaxChars = Number.isSafeInteger(options.tailMaxChars)
    ? Math.max(500, options.tailMaxChars)
    : DEFAULT_TAIL_MAX_CHARS;
  const includeFullCapture = options.includeFullCapture === true;

  // Attempt the live pane unless the session is PROVEN gone. Under `unknown`
  // the pane may well be there, and a capture that succeeds settles the
  // question far better than the probe did.
  if (liveness !== "absent") {
    try {
      captureText = await captureTmuxPane(handle, { lines: options.lines });
      captureSource = "live";
    } catch (err) {
      captureError = err.message;
    }
  }
  // Fall back to the last persisted capture whenever no live text was obtained
  // -- including when the live attempt threw, which previously returned no text
  // at all despite a perfectly readable capture sitting on disk.
  if (captureText == null) {
    const fallbackCapturePath = getTerminalCapturePath(terminal);
    if (fallbackCapturePath && fs.existsSync(fallbackCapturePath)) {
      try {
        captureText = fs.readFileSync(fallbackCapturePath, "utf-8");
        captureSource = "persisted";
        captureError = null;
      } catch (err) {
        captureError = captureError || err.message;
      }
    }
  }

  if (captureText && captureText.length > maxChars) {
    fullCapture = captureText.slice(-maxChars);
    fullCaptureTruncated = true;
  } else {
    fullCapture = captureText;
  }
  const tailText = buildTailText(captureText, tailLines, tailMaxChars);
  captureTruncated = Boolean(
    captureText && tailText && captureText.length > tailText.length
  );
  const activity = analyzeTerminalActivity(captureText, terminal.agent, {
    liveness,
  });
  const fallbackCapturePath = getTerminalCapturePath(terminal);
  let availability = "unknown";
  try {
    availability = await probeTmuxAvailability({
      route: routeForIdentity(handle),
    });
  } catch {}

  return {
    active: Boolean(current),
    available: availability === "available",
    tmux_availability: availability,
    alive,
    // `alive` cannot distinguish "the pane is gone" from "tmux did not answer".
    // Callers deciding whether a turn died must read this instead.
    liveness,
    status: terminal.status || "unknown",
    agent: terminal.agent || null,
    session_name: terminal.session_name,
    pane_target: handle.paneTarget,
    pane_id: terminal.pane_id || null,
    tmux_transport: terminal.tmux_transport ?? null,
    tmux_distro: terminal.tmux_distro ?? null,
    tmux_launcher: terminal.tmux_launcher ?? null,
    tmux_control_binary: terminal.tmux_control_binary ?? null,
    tmux_socket_name: terminal.tmux_socket_name ?? null,
    cwd: terminal.cwd || null,
    command: terminal.command || null,
    args: Array.isArray(terminal.args) ? terminal.args : [],
    turn_dir: terminal.turn_dir || null,
    prompt_path: terminal.prompt_path || null,
    result_path: terminal.result_path || null,
    done_path: terminal.done_path || null,
    started_at: terminal.started_at || null,
    completed_at: terminal.completed_at || null,
    updated_at: terminal.updated_at || null,
    last_capture_path: terminal.last_capture_path || fallbackCapturePath || null,
    activity,
    capture: {
      text: tailText,
      tail_text: tailText,
      full_text: includeFullCapture ? fullCapture : undefined,
      captured_at: captureText ? new Date().toISOString() : null,
      source: captureSource,
      truncated: captureTruncated,
      full_truncated: includeFullCapture ? fullCaptureTruncated : undefined,
      error: captureError,
    },
  };
}

/**
 * Classify what a pane is doing.
 *
 * Liveness arrives three-valued via `options.liveness`; `options.alive` remains
 * accepted as the boolean form. `unknown` deliberately does NOT produce
 * `not_running`: reporting a pane as exited because tmux timed out is a claim
 * this function has no grounds to make, and drivers act on it.
 */
export function analyzeTerminalActivity(captureText, agent, options = {}) {
  const liveness =
    options.liveness ?? (options.alive === false ? "absent" : "alive");
  const alive = liveness === "alive";
  const provenGone = liveness === "absent";
  const text = captureText || "";
  if (!text.trim()) {
    return {
      state: provenGone ? "not_running" : "unknown",
      confidence: "low",
      summary: provenGone
        ? "No live tmux session."
        : alive
          ? "No terminal text captured yet."
          : "tmux could not be reached, and no terminal text was captured.",
    };
  }

  const lines = splitLines(text);
  const nonEmptyLines = lines.filter((line) => line.trim());
  const statusLine = findStatusLine(nonEmptyLines);
  const normalizedStatus = statusLine ? normalizeTerminalText(statusLine) : "";
  const lowerStatus = normalizedStatus.toLowerCase();
  const recentText = nonEmptyLines.slice(-8).join("\n");
  const normalizedRecent = normalizeTerminalText(recentText);
  const lowerRecent = normalizedRecent.toLowerCase();
  const tokens = normalizedStatus ? extractTokenCount(normalizedStatus) : null;
  const elapsed = normalizedStatus ? extractElapsed(normalizedStatus) : null;
  const verb = extractVerb(normalizedStatus);
  const model = extractModelLabel(nonEmptyLines);
  const hasIdlePrompt = detectIdlePrompt(nonEmptyLines, agent);
  const hasBlockedPrompt = detectBlockedPrompt(nonEmptyLines, agent);

  let state = "unknown";
  let confidence = "low";

  if (provenGone) {
    state = "not_running";
    confidence = "high";
  } else if (/\b(thinking|reasoning|warping|pondering|working)\b/u.test(lowerStatus) || tokens != null) {
    state = "thinking";
    confidence = tokens != null || /\bthinking\b/u.test(lowerStatus) ? "high" : "medium";
  } else if (/bash\(|shell\(|running command|command running/u.test(lowerStatus)) {
    state = "running_command";
    confidence = "high";
  } else if (/\b(reading|read \d+ file|grep|searching|listing)\b/u.test(lowerStatus)) {
    state = "reading";
    confidence = "medium";
  } else if (/\b(writing|edit|patch|applying)\b/u.test(lowerStatus)) {
    state = "writing";
    confidence = "medium";
  } else if (/\b(starting mcp servers|booting|loading)\b/u.test(lowerStatus)) {
    state = "starting";
    confidence = "medium";
  } else if (hasBlockedPrompt) {
    // Checked ahead of idle: a blocked pane looks idle, and treating it as idle
    // is what makes a driver send the next prompt into a parked turn.
    state = "blocked";
    confidence = "high";
  } else if (hasIdlePrompt) {
    state = "idle_prompt";
    confidence = "medium";
  } else if (/bash\(|shell\(|running command|command running/u.test(lowerRecent)) {
    state = "running_command";
    confidence = "medium";
  } else if (/\b(reading|read \d+ file|grep|searching|listing)\b/u.test(lowerRecent)) {
    state = "reading";
    confidence = "low";
  } else if (/\b(writing|edit|patch|applying)\b/u.test(lowerRecent)) {
    state = "writing";
    confidence = "low";
  }

  // Under `unknown` the text above is still the best available reading, but it
  // may have come from a persisted capture rather than the live pane, so no
  // conclusion drawn from it is better than low confidence.
  if (liveness === "unknown") {
    confidence = "low";
  }

  const parts = [];
  if (model) parts.push(model);
  if (verb) parts.push(verb);
  if (tokens != null) parts.push(`${formatTokenCount(tokens)} tokens`);
  if (elapsed) parts.push(elapsed);

  return {
    state,
    confidence,
    liveness,
    summary:
      buildActivitySummary(state, parts) +
      (liveness === "unknown"
        ? " tmux could not confirm the pane is still running, so this reading may be stale."
        : ""),
    model,
    verb,
    tokens,
    elapsed,
    idle_prompt_visible: hasIdlePrompt,
    blocked_prompt_visible: hasBlockedPrompt,
    status_line: normalizedStatus || null,
  };
}

function getTerminalCapturePath(terminal) {
  if (terminal?.last_capture_path) return terminal.last_capture_path;
  if (terminal?.turn_dir) return path.join(terminal.turn_dir, "terminal-capture.txt");
  return null;
}

function buildTailText(captureText, tailLines, maxChars) {
  if (!captureText) return null;
  const tail = splitLines(captureText).slice(-tailLines).join("\n");
  if (tail.length <= maxChars) return tail;
  return tail.slice(-maxChars);
}

function splitLines(text) {
  return String(text || "").split(/\r?\n/u);
}

function normalizeTerminalText(text) {
  return String(text || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[^\x20-\x7E]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function findStatusLine(lines) {
  return [...lines]
    .slice(-16)
    .reverse()
    .find((line) => {
      const normalized = normalizeTerminalText(line).toLowerCase();
      const hasElapsed = Boolean(extractElapsed(normalized));
      return (
        hasElapsed &&
        (
          normalized.includes("tokens") ||
          normalized.includes("thinking") ||
          normalized.includes("working") ||
          normalized.includes("running") ||
          normalized.includes("reading") ||
          normalized.includes("writing") ||
          normalized.includes("effort")
        )
      );
    }) || null;
}

function extractTokenCount(text) {
  const match = String(text || "").match(/(\d+(?:\.\d+)?)\s*([km])?\s*tokens?/iu);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const multiplier =
    match[2]?.toLowerCase() === "m"
      ? 1_000_000
      : match[2]?.toLowerCase() === "k"
        ? 1_000
        : 1;
  return Math.round(value * multiplier);
}

function formatTokenCount(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function extractElapsed(text) {
  const match = String(text || "").match(/\b(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s\b/u);
  if (!match) return null;
  const parts = [];
  if (match[1]) parts.push(`${match[1]}h`);
  if (match[2]) parts.push(`${match[2]}m`);
  parts.push(`${match[3]}s`);
  return parts.join(" ");
}

function extractVerb(text) {
  const source = String(text || "");
  const explicit = source.match(/([A-Za-z][A-Za-z -]{1,40})(?:\.\.\.|\u2026)\s*\(/u);
  if (explicit) return explicit[1].trim();
  const generic = source.match(/\b(thinking|working|running|reading|writing|searching|listing)\b/iu);
  return generic ? generic[1].toLowerCase() : null;
}

function extractModelLabel(lines) {
  for (const line of lines.slice(0, 16)) {
    const normalized = normalizeTerminalText(line);
    if (/\b(Fable|Opus|Sonnet|Haiku|GPT|gpt-)\b/iu.test(normalized)) {
      return normalized.slice(0, 120);
    }
  }
  for (const line of lines.slice(0, 12)) {
    const normalized = normalizeTerminalText(line);
    if (
      /\b(Claude Code|OpenAI Codex)\b/iu.test(normalized)
    ) {
      return normalized.slice(0, 120);
    }
  }
  return null;
}

function detectIdlePrompt(lines, agent) {
  return isIdlePrompt(tryGetAdapter(agent)?.tui ?? null, lines.join("\n"));
}

// A pane parked on a plan-approval or ask-the-human step reads as idle to the
// classifier above, which would make a driver send the next prompt into a turn
// that can never advance. Adapters declaring `blocked` markers get it reported
// as its own state instead.
function detectBlockedPrompt(lines, agent) {
  return isBlocked(tryGetAdapter(agent)?.tui ?? null, lines.join("\n"));
}

function buildActivitySummary(state, parts) {
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  if (state === "thinking") return `Partner appears to be thinking${detail}.`;
  if (state === "running_command") return `Partner appears to be running a shell command${detail}.`;
  if (state === "reading") return `Partner appears to be reading or searching files${detail}.`;
  if (state === "writing") return `Partner appears to be writing or editing${detail}.`;
  if (state === "working") return `Partner appears to be working${detail}.`;
  if (state === "starting") return `Partner appears to be starting up${detail}.`;
  if (state === "blocked")
    return `Partner is waiting on a human decision and will not advance on its own${detail}.`;
  if (state === "idle_prompt") return `Partner appears to be at an idle prompt${detail}.`;
  if (state === "not_running") return `Partner tmux session is not running${detail}.`;
  return `Partner activity is unclear${detail}.`;
}

/**
 * Terminate this session's current pane and report what is actually true.
 *
 * Returns `{ found, verdict, status }`. The verdict, not a boolean, is the
 * point: this used to record "terminated" and clear current_terminal.json
 * unconditionally, so a pane that survived termination was filed as gone. That
 * is the wrong direction for every consumer -- the host is told the partner is
 * down, and the cleanup path loses the one record that would have kept it from
 * reclaiming a live partner's home.
 *
 * `current_terminal.json` is now cleared ONLY on a proven absence. Under `alive`
 * or `unknown` the record is preserved, which keeps the pane discoverable by
 * end_dialog and by the scratch sweep until something can prove it gone.
 */
export async function terminateCurrentPartnerTerminal(sessionDir) {
  const { current } = readTerminalState(sessionDir);
  if (!current?.session_name) return { found: false, verdict: null, status: null };
  const handle = {
    sessionName: current.session_name,
    paneTarget: current.pane_target || `${current.session_name}:0.0`,
    ...recordedTmuxIdentity(current),
  };
  const verdict = await terminateTmuxSession(handle);
  const status =
    verdict === "absent"
      ? "terminated"
      : verdict === "alive"
        ? "error_terminal_leaked"
        : "termination_unknown";
  writeTerminalState(
    sessionDir,
    {
      ...current,
      status,
      ...(verdict === "absent" ? { completed_at: new Date().toISOString() } : {}),
    },
    { active: verdict !== "absent" }
  );
  return { found: true, verdict, status };
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * The socket every tmux call in this process must use.
 *
 * Exported because a caller outside this module needs to ask tmux the same
 * question this one does -- and asking on the DEFAULT socket instead of ours
 * would report "session absent" for a session that is running perfectly well
 * on the dualog socket. Any second implementation of this lookup is a bug
 * waiting to happen, so there is one.
 */
export function tmuxSocketName(env = process.env) {
  const socketName =
    configuredEnvValue(
      ["DUALOG_TMUX_SOCKET", "CODEX_DIALOG_TMUX_SOCKET", "CONDUCTOR_TMUX_SOCKET"],
      env
    ) ?? DEFAULT_TMUX_SOCKET_NAME;
  const trimmedSocketName = socketName.trim();
  if (!trimmedSocketName || trimmedSocketName.includes("/") || trimmedSocketName.includes("\0")) {
    throw new Error("tmux socket name must be a non-empty name, not a path");
  }
  return trimmedSocketName;
}

function buildTmuxArgs(args, { env = process.env, socketName = null } = {}) {
  const selectedSocketName =
    socketName ??
    configuredEnvValue(
      ["DUALOG_TMUX_SOCKET", "CODEX_DIALOG_TMUX_SOCKET", "CONDUCTOR_TMUX_SOCKET"],
      env
    ) ??
    DEFAULT_TMUX_SOCKET_NAME;
  const trimmedSocketName = selectedSocketName.trim();
  if (
    !trimmedSocketName ||
    trimmedSocketName.includes("/") ||
    trimmedSocketName.includes("\0")
  ) {
    throw new Error("tmux socket name must be a non-empty name, not a path");
  }
  return ["-f", "/dev/null", "-L", trimmedSocketName, ...args];
}

async function prepareTmuxServer(route) {
  await runTmux(["start-server"], { allowFailure: true, route });
}

async function configureTmuxSession(sessionName, route, loginShell) {
  await runTmux(["set-option", "-t", sessionName, "default-shell", loginShell], {
    allowFailure: true,
    route,
  });
  await runTmux(["set-option", "-t", sessionName, "focus-events", "off"], {
    allowFailure: true,
    route,
  });
  await runTmux(["set-window-option", "-t", `${sessionName}:0`, "remain-on-exit", "off"], {
    allowFailure: true,
    route,
  });
}

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function buildTmuxCommandPayload({ command, args, env }) {
  const parts = [];
  const envEntries = Object.entries(env || {})
    .filter(([, value]) => value != null)
    .sort(([a], [b]) => a.localeCompare(b));

  if (envEntries.length > 0) {
    parts.push("env");
    for (const [key, value] of envEntries) {
      parts.push(`${key}=${shellEscape(String(value))}`);
    }
  }

  parts.push(shellEscape(command));
  for (const arg of args || []) {
    parts.push(shellEscape(String(arg)));
  }
  return parts.join(" ");
}

function buildTmuxShellPayload(
  { command, args, env },
  loginShell = DEFAULT_WSL_LOGIN_SHELL,
  { interactiveLogin = false } = {}
) {
  const commandPayload = shellEscape(
    `exec ${buildTmuxCommandPayload({ command, args, env })}`
  );
  if (!interactiveLogin) return `/bin/sh -lc ${commandPayload}`;
  return `${shellEscape(normalizeWslLoginShell(loginShell))} -lic ${commandPayload}`;
}

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
