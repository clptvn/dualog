import fs from "fs";
import path from "path";
import { execFile, spawnSync } from "child_process";
import { tryGetAdapter } from "./adapters/registry.mjs";
import { isBlocked, isIdlePrompt } from "./tui/markers.mjs";

const DEFAULT_TMUX_BINARY = "tmux";
const DEFAULT_TMUX_SOCKET_NAME = "dualog";
const DEFAULT_WSL_BINARY = "wsl.exe";
const TMUX_EXEC_TIMEOUT_MS = 10000;
const DEFAULT_CAPTURE_LINES = 240;
const DEFAULT_CAPTURE_MAX_CHARS = 30000;
const DEFAULT_TAIL_LINES = 6;
const DEFAULT_TAIL_MAX_CHARS = 3000;

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

function tmuxBinary(env = process.env) {
  const configured = configuredEnvValue(TMUX_BINARY_ENV, env);
  const trimmed = (configured ?? DEFAULT_TMUX_BINARY).trim();
  if (!trimmed) {
    throw new Error("tmux binary path must not be empty");
  }
  return trimmed;
}

function wslBinary(env = process.env) {
  const configured = configuredEnvValue(WSL_BINARY_ENV, env);
  const trimmed = (configured ?? DEFAULT_WSL_BINARY).trim();
  if (!trimmed) {
    throw new Error("WSL binary path must not be empty");
  }
  return trimmed;
}

function wslDistro(env = process.env) {
  const configured = configuredEnvValue(WSL_DISTRO_ENV, env);
  return configured ? configured.trim() || null : null;
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
  const binary = tmuxBinary(env);
  if (platform === "win32" && configuredTmux == null) {
    return {
      transport: "wsl",
      command: wslBinary(env),
      distro: wslDistro(env),
      tmuxBinary: binary,
    };
  }
  return { transport: "local", command: binary, distro: null, tmuxBinary: binary };
}

function wslCommandArgs(commandArgs, env = process.env) {
  const distro = wslDistro(env);
  return [
    ...(distro ? ["--distribution", distro] : []),
    "--exec",
    ...commandArgs,
  ];
}

function tmuxCommandArgs(args, { env = process.env, platform = process.platform } = {}) {
  const route = tmuxRoute({ env, platform });
  const tmuxArgs = buildTmuxArgs(args, { env });
  return {
    route,
    command: route.command,
    args:
      route.transport === "wsl"
        ? wslCommandArgs([route.tmuxBinary, ...tmuxArgs], env)
        : tmuxArgs,
  };
}

export function isWindowsPath(value) {
  return typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value);
}

function runExecFile(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf-8",
        timeout: TMUX_EXEC_TIMEOUT_MS,
        killSignal: "SIGKILL",
        windowsHide: process.platform === "win32",
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

export async function runTmux(args, { allowFailure = false } = {}) {
  const invocation = tmuxCommandArgs(args);
  const result = await runExecFile(invocation.command, invocation.args);
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(
      `tmux ${args.join(" ")} failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}

/**
 * Can we run tmux at all? `available` | `missing` | `unknown`.
 *
 * A timeout is not proof tmux is absent, and reporting it as such tells a
 * caller to stop using a runtime that is merely slow.
 */
export async function probeTmuxAvailability() {
  const route = tmuxRoute();
  let result;
  try {
    result = await runTmux(["-V"], { allowFailure: true });
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

/** Convert a native absolute path for a WSL-hosted tmux command. */
export async function translateTmuxPath(value, { route = tmuxRoute() } = {}) {
  if (route.transport !== "wsl" || !isWindowsPath(value)) return value;
  const result = await runExecFile(
    route.command,
    wslCommandArgs(["wslpath", "-a", "-u", value])
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
 * Convert the values a Linux CLI receives while leaving filesystem setup on the
 * Windows host. Config isolation and sidecars are created before this runs, so
 * they remain the same files through WSL's /mnt/<drive> mount.
 */
export async function prepareTmuxInvocation(
  { cwd, command, args = [], env = {} },
  { route = tmuxRoute(), convertPath } = {}
) {
  if (route.transport !== "wsl") {
    return { cwd, command, args: [...args], env: { ...env }, tmuxTransport: route.transport };
  }

  const cache = new Map();
  const convert =
    convertPath ??
    (async (value) => {
      if (!isWindowsPath(value)) return value;
      if (!cache.has(value)) {
        cache.set(value, translateTmuxPath(value, { route }));
      }
      return cache.get(value);
    });

  const convertedEnv = {};
  for (const [key, value] of Object.entries(env)) {
    convertedEnv[key] = await convert(value);
  }

  return {
    cwd: await convert(cwd),
    command: await convert(command),
    args: await Promise.all(args.map((arg) => convert(arg))),
    env: convertedEnv,
    tmuxTransport: route.transport,
  };
}

/** Is the selected partner command runnable from the WSL distribution tmux uses? */
export async function probeWslPartnerCommand(command, versionArgs = []) {
  const route = tmuxRoute();
  if (route.transport !== "wsl") return "not-applicable";
  if (typeof command !== "string" || !command.trim()) return "unavailable";

  const executable = await translateTmuxPath(command, { route });
  const result = await runExecFile(
    route.command,
    // Match tmux's payload exactly. WSL's direct --exec path does not include
    // the Windows-integrated PATH that an interactive /bin/sh receives, so a
    // valid Claude installation can otherwise look absent during preflight.
    wslCommandArgs([
      "sh",
      "-lc",
      'exec "$@"',
      "dualog-wsl-probe",
      executable,
      ...versionArgs,
    ])
  );
  return result.exitCode === 0 ? "available" : "unavailable";
}

export function tmuxPaneProcessStartTime(pid, { transport = tmuxRoute().transport } = {}) {
  if (transport !== "wsl" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const route = tmuxRoute();
  if (route.transport !== "wsl") return null;
  try {
    const result = spawnSync(
      route.command,
      wslCommandArgs(["ps", "-o", "lstart=", "-p", String(pid)]),
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
export function probeWslPaneProcess(pid, recordedStartTime = null) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "invalid";
  const route = tmuxRoute();
  if (route.transport !== "wsl") return "invalid";
  let result;
  try {
    result = spawnSync(
      route.command,
      wslCommandArgs(["ps", "-o", "lstart=", "-p", String(pid)]),
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

export async function startTmuxSession({ sessionName, cwd, command, args, env }) {
  const route = tmuxRoute();
  await prepareTmuxServer();
  const payload = buildTmuxShellPayload({ command, args, env });
  try {
    await runTmux(["new-session", "-d", "-s", sessionName, "-c", cwd, payload]);
  } catch (err) {
    // The CLIENT failed; the SERVER may still act on what it was handed. A
    // timed-out client is SIGKILLed, and tmux processes commands it already has,
    // so "new-session threw" does not mean no pane will exist. Killing the name
    // is the only way to make that true, and it is ordered after the create, so
    // the server applies them in that order.
    await runTmux(["kill-session", "-t", `=${sessionName}`], { allowFailure: true });
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
      await runTmux(["display-message", "-p", "-t", paneTarget, "#{pane_pid}"])
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
    await configureTmuxSession(sessionName);
    const paneId = (
      await runTmux(["display-message", "-p", "-t", paneTarget, "#{pane_id}"])
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
      tmuxTransport: route.transport,
      startedAt: new Date().toISOString(),
    };
  } catch (err) {
    await runTmux(["kill-session", "-t", `=${sessionName}`], { allowFailure: true });
    // Carry the identity out with the failure. The pane EXISTED -- new-session
    // returned -- so a caller holding a credential lease needs the process to
    // probe, not just the session name it is about to stop trusting.
    err.panePid = panePid;
    err.panePidUnavailable = panePidUnavailable;
    err.sessionName = sessionName;
    throw err;
  }
}

export async function sendTextToTmux(handle, text, { enter = false, submitDelayMs = 0 } = {}) {
  if (text.length > 0) {
    const bufferName = `${handle.sessionName}-input`;
    await runTmux(["set-buffer", "-b", bufferName, text]);
    await runTmux([
      "paste-buffer",
      "-p",
      "-d",
      "-b",
      bufferName,
      "-t",
      handle.paneTarget,
    ]);
  }
  if (enter) {
    if (submitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    }
    await runTmux(["send-keys", "-t", handle.paneTarget, "C-m"]);
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
  ]);
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
export async function probeTmuxSession(sessionName) {
  const target = tmuxSessionTarget(sessionName);
  if (!target) return "unknown";
  let result;
  try {
    result = await runTmux(["has-session", "-t", target], { allowFailure: true });
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
export function probeTmuxSessionSync(sessionName) {
  const target = tmuxSessionTarget(sessionName);
  if (!target) return "unknown";
  let result;
  try {
    const invocation = tmuxCommandArgs(["has-session", "-t", target]);
    result = spawnSync(invocation.command, invocation.args, {
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
export async function isTmuxSessionAlive(sessionName) {
  return (await probeTmuxSession(sessionName)) === "alive";
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
  // Only a PROVEN absence ends this early. "Cannot tell" must fall through to
  // the escalation below: giving up there leaves a pane running under a partner
  // that nobody will terminate again, and the kill attempts are already
  // failure-tolerant, so trying against a session that turns out to be gone
  // costs nothing.
  const probe = () => probeTmuxSession(handle.sessionName);
  if ((await probe()) === "absent") return "absent";

  try {
    await sendTextToTmux(handle, "/exit", { enter: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {}
  if ((await probe()) === "absent") return "absent";

  try {
    await runTmux(["send-keys", "-t", handle.paneTarget, "C-c"], {
      allowFailure: true,
    });
    await runTmux(["send-keys", "-t", handle.paneTarget, "C-c"], {
      allowFailure: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {}
  if ((await probe()) === "absent") return "absent";

  await runTmux(["kill-session", "-t", handle.sessionName], {
    allowFailure: true,
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
  };
  const liveness = await probeTmuxSession(terminal.session_name);
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
  const availability = await probeTmuxAvailability();

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
export function tmuxSocketName() {
  const socketName =
    configuredEnvValue(
      ["DUALOG_TMUX_SOCKET", "CODEX_DIALOG_TMUX_SOCKET", "CONDUCTOR_TMUX_SOCKET"]
    ) ?? DEFAULT_TMUX_SOCKET_NAME;
  const trimmedSocketName = socketName.trim();
  if (!trimmedSocketName || trimmedSocketName.includes("/") || trimmedSocketName.includes("\0")) {
    throw new Error("tmux socket name must be a non-empty name, not a path");
  }
  return trimmedSocketName;
}

function buildTmuxArgs(args, { env = process.env } = {}) {
  const socketName =
    configuredEnvValue(
      ["DUALOG_TMUX_SOCKET", "CODEX_DIALOG_TMUX_SOCKET", "CONDUCTOR_TMUX_SOCKET"],
      env
    ) ?? DEFAULT_TMUX_SOCKET_NAME;
  const trimmedSocketName = socketName.trim();
  if (
    !trimmedSocketName ||
    trimmedSocketName.includes("/") ||
    trimmedSocketName.includes("\0")
  ) {
    throw new Error("tmux socket name must be a non-empty name, not a path");
  }
  return ["-f", "/dev/null", "-L", trimmedSocketName, ...args];
}

async function prepareTmuxServer() {
  await runTmux(["start-server"], { allowFailure: true });
}

async function configureTmuxSession(sessionName) {
  await runTmux(["set-option", "-t", sessionName, "default-shell", "/bin/sh"], {
    allowFailure: true,
  });
  await runTmux(["set-option", "-t", sessionName, "focus-events", "off"], {
    allowFailure: true,
  });
  await runTmux(["set-window-option", "-t", `${sessionName}:0`, "remain-on-exit", "off"], {
    allowFailure: true,
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

function buildTmuxShellPayload({ command, args, env }) {
  return `/bin/sh -lc ${shellEscape(`exec ${buildTmuxCommandPayload({ command, args, env })}`)}`;
}

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
