import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isProcessAlive } from "./shared.mjs";
import { ENGINES } from "./adapters/schema.mjs";
import { readProcessCommandLine } from "./process-command-line.mjs";

export { readProcessCommandLine } from "./process-command-line.mjs";

const RUNNER_TOKEN_PREFIX = "--runner-token=";
const RUNNER_RUNTIME_PREFIX = "--dualog-runner-runtime=";
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Which script owns a session type's runner process.
 *
 * A table rather than a ternary chain, because the failure mode of getting this
 * wrong is silent and total. isSessionRunnerAlive() proves identity by matching
 * this path against the live process's command line, so an unmapped type falls
 * to the default, never matches, and reports a perfectly healthy runner as dead
 * forever -- which makes send_message refuse to write, wait_for_partner_response
 * return `runner_exited` before the first turn finishes, and end_dialog skip the
 * SIGTERM it exists to send.
 *
 * That is exactly what happened when `pr_review` was added as the third type: it
 * inherited the dialog default and every panel session was born unreachable. A
 * type absent from this table is a bug, not a fallback, so add the entry when
 * adding a runner.
 */
export const RUNNER_SCRIPT_BY_SESSION_TYPE = {
  dialog: "dialog-runner.mjs",
  review: "review-runner.mjs",
  pr_review: "pr-review-runner.mjs",
};
const DEFAULT_RUNNER_SCRIPT = "dialog-runner.mjs";

export function buildRunnerTokenArg(token) {
  return `${RUNNER_TOKEN_PREFIX}${token}`;
}

function lastPrefixedArgIndex(argv, prefix) {
  for (let index = argv.length - 1; index >= 0; index--) {
    if (argv[index].startsWith(prefix)) return index;
  }
  return -1;
}

export function readRunnerToken(argv = process.argv) {
  // All earlier positions include user-controlled model/command strings. The
  // server appends its real token after them, so the last token-shaped value is
  // the only one that can establish the internal-control tail.
  const index = lastPrefixedArgIndex(argv, RUNNER_TOKEN_PREFIX);
  return index >= 0 ? argv[index].slice(RUNNER_TOKEN_PREFIX.length) : null;
}

/**
 * Carry the runtime decision selected by start-tool preflight into the detached
 * runner without turning persisted state into executable-path authority.
 *
 * Engine, the preflight-resolved partner executable, and comparison-only tmux
 * identity cross the process boundary. Re-resolving a bare partner command in
 * the reviewed project would let a repository-local `.cmd` replace the PATH
 * executable preflight approved. The encoded value is an internal argv token
 * appended after the runner capability token; persisted status remains
 * descriptive and never becomes executable authority.
 */
function normalizeRunnerRuntimeDecision(decision, source) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error(`${source} runtime decision must be an object`);
  }
  if (decision.version !== 2) {
    throw new Error(
      `${source} runtime decision has unsupported version ${JSON.stringify(decision.version)}`
    );
  }
  const engine = decision.engine;
  if (!ENGINES.includes(engine)) {
    throw new Error(
      `${source} runtime decision has unknown engine ${JSON.stringify(engine)}. ` +
        `Valid engines: ${ENGINES.join(", ")}`
    );
  }
  const tmuxTransport = decision.tmuxTransport ?? null;
  const tmuxDistro =
    typeof decision.tmuxDistro === "string"
      ? decision.tmuxDistro.trim() || null
      : decision.tmuxDistro ?? null;
  const tmuxLauncher = decision.tmuxLauncher ?? null;
  const tmuxControlBinary = decision.tmuxControlBinary ?? null;
  const tmuxSocketName = decision.tmuxSocketName ?? null;
  const partnerCommand = decision.partnerCommand;
  if (
    typeof partnerCommand !== "string" ||
    !partnerCommand ||
    partnerCommand.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(partnerCommand)
  ) {
    throw new Error(`${source} runtime decision has an invalid partner command`);
  }

  if (engine === "headless") {
    if (
      tmuxTransport !== null ||
      tmuxDistro !== null ||
      tmuxLauncher !== null ||
      tmuxControlBinary !== null ||
      tmuxSocketName !== null
    ) {
      throw new Error(`${source} headless runtime decision cannot name a tmux route`);
    }
  } else if (engine === "tmux-interactive") {
    if (tmuxTransport !== "local" && tmuxTransport !== "wsl") {
      throw new Error(
        `${source} interactive runtime decision must use local or wsl tmux`
      );
    }
    if (tmuxTransport === "wsl" && !tmuxDistro) {
      throw new Error(`${source} WSL runtime decision must pin a distribution`);
    }
    if (
      tmuxTransport === "wsl" &&
      (tmuxDistro.length > 256 || /[\u0000-\u001f\u007f]/u.test(tmuxDistro))
    ) {
      throw new Error(`${source} WSL runtime decision has an invalid distribution name`);
    }
    if (tmuxTransport === "local" && tmuxDistro !== null) {
      throw new Error(`${source} local tmux runtime decision cannot name a WSL distribution`);
    }
    for (const [label, value, maxLength] of [
      ["launcher", tmuxLauncher, 4096],
      ["control binary", tmuxControlBinary, 4096],
      ["socket", tmuxSocketName, 256],
    ]) {
      if (
        typeof value !== "string" ||
        !value ||
        value.length > maxLength ||
        /[\u0000-\u001f\u007f]/u.test(value)
      ) {
        throw new Error(`${source} interactive runtime decision has an invalid tmux ${label}`);
      }
    }
    if (tmuxSocketName.includes("/")) {
      throw new Error(`${source} interactive runtime decision has an invalid tmux socket`);
    }
  }

  if (tmuxTransport === "wsl" && !path.posix.isAbsolute(partnerCommand)) {
    throw new Error(
      `${source} WSL runtime decision must pin an absolute Linux partner command`
    );
  }
  if (
    tmuxTransport !== "wsl" &&
    !(
      /^[A-Za-z]:[\\/]/u.test(partnerCommand) ||
      /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(partnerCommand) ||
      (process.platform !== "win32" && path.isAbsolute(partnerCommand))
    )
  ) {
    throw new Error(
      `${source} local runtime decision must pin an absolute partner command`
    );
  }

  return Object.freeze({
    version: 2,
    engine,
    partnerCommand,
    tmuxTransport,
    tmuxDistro,
    tmuxLauncher,
    tmuxControlBinary,
    tmuxSocketName,
  });
}

export function buildRunnerRuntimeArg(decision) {
  const normalized = normalizeRunnerRuntimeDecision(decision, "Preflight");
  const encoded = Buffer.from(JSON.stringify(normalized), "utf-8").toString("base64url");
  return `${RUNNER_RUNTIME_PREFIX}${encoded}`;
}

export function readRunnerRuntimeDecision(argv = process.argv) {
  const tokenIndex = lastPrefixedArgIndex(argv, RUNNER_TOKEN_PREFIX);
  if (tokenIndex < 0) return null;
  const args = argv
    .slice(tokenIndex + 1)
    .filter((value) => value.startsWith(RUNNER_RUNTIME_PREFIX));
  if (args.length === 0) return null;
  if (args.length > 1) {
    throw new Error("Runner received more than one runtime decision");
  }
  const encoded = args[0].slice(RUNNER_RUNTIME_PREFIX.length);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
  } catch (err) {
    throw new Error(
      `Runner received an invalid runtime decision: ${err.message}`,
      { cause: err }
    );
  }
  return normalizeRunnerRuntimeDecision(parsed, "Runner");
}

/**
 * Three-valued liveness: "alive" | "dead" | "unknown".
 *
 * isSessionRunnerAlive collapses the last two into `false`, which is right for
 * its callers -- they gate an action, and refusing to act on an unprovable
 * runner is the safe default. It is wrong for anything REPORTING liveness: a
 * caller that maps `false` to "could not determine" throws away a proven death,
 * and a proven death behind a stale `runner_state: "running"` is exactly the
 * case a host most needs told. watchRunnerExit only fires inside the server
 * process that spawned the runner, so anything OUTLIVING that process leaves the
 * stale record behind a corpse: a server restart, a reboot, or a runner
 * inherited from an earlier server. (A SIGKILL or OOM kill while that server is
 * still up does fire the watcher, which records the exit correctly.)
 */
export function probeSessionRunner(status, sessionDir) {
  const pid = status?.runner_pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    return "dead";
  }

  const commandLine = readProcessCommandLine(pid);
  // The only genuinely indeterminate case: the process exists but we could not
  // read what it is. readProcessCommandLine swallows every failure and returns
  // "" -- ps missing, sandboxed, or timing out.
  if (!commandLine) return "unknown";

  const runnerName =
    RUNNER_SCRIPT_BY_SESSION_TYPE[status?.type] ?? DEFAULT_RUNNER_SCRIPT;
  const expectedRunnerPath = path.join(SOURCE_DIR, runnerName);
  if (
    !commandLine.includes(expectedRunnerPath) ||
    !commandLine.includes(sessionDir)
  ) {
    return "dead";
  }

  if (typeof status.runner_token === "string" && status.runner_token) {
    return commandLine.includes(buildRunnerTokenArg(status.runner_token))
      ? "alive"
      : "dead";
  }

  return "alive";
}

/**
 * Defined in terms of the probe, never as a second copy of it.
 *
 * Its callers gate an action, so collapsing "dead" and "unknown" into false is
 * right for them -- refusing to act on a runner we cannot prove is exactly the
 * safe default. But that collapse is the ONLY difference, and keeping a parallel
 * copy of the identity chain to express it would make this the fourth instance
 * of one question with two implementations in this file's history. The first
 * three all became defects: the header versus its parser, the suppressor versus
 * the gate's line pattern, the suppressor versus its fence model. Adding a
 * session type or changing how the token is matched must not be a change anyone
 * can make in one place and forget in the other.
 */
export function isSessionRunnerAlive(status, sessionDir) {
  return probeSessionRunner(status, sessionDir) === "alive";
}

/**
 * Record the spawned runner's PID against a session.
 *
 * This must re-read status.json rather than rewrite a status object captured
 * before the spawn. A runner can start, fail, and record its own exit in the
 * window between spawn() returning and this write landing; replaying the stale
 * pre-spawn object would resurrect a dead session as `running` with a PID that
 * is already gone -- exactly the state that makes a session look alive forever.
 *
 * Re-reading narrows that window but does not close it: the child can still
 * write `exited` between the read below and the rename, and last-writer-wins
 * then loses the exit. That is why the caller must also attach
 * watchRunnerExit() -- the process-exit event is what makes the final state
 * correct regardless of which write landed last.
 */
export function markSessionRunnerStarted(
  sessionDir,
  { runnerToken = null, pid } = {}
) {
  const statusPath = path.join(sessionDir, "status.json");
  let status;
  try {
    status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  } catch {
    return false;
  }

  // The runner's own exit record is newer than anything we knew at spawn time.
  if (status.runner_state === "exited") return false;

  if (
    typeof status.runner_token === "string" &&
    status.runner_token &&
    runnerToken &&
    status.runner_token !== runnerToken
  ) {
    return false;
  }

  writeJsonAtomic(statusPath, {
    ...status,
    runner_pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    runner_state: "running",
  });
  return true;
}

/**
 * Make the spawned runner's exit authoritative, whichever write landed last.
 *
 * markSessionRunnerStarted() and the child's own markSessionRunnerExited() are
 * two independent whole-file writes racing on the same document, so ordering
 * cannot be established by re-reading alone: the child may record `exited`
 * between the parent's read and its rename, and the parent then overwrites a
 * newer truth with `running`.
 *
 * Rather than add locking, close the loop with the one event that is
 * unambiguously last: the process is gone. When it fires, the exit is recorded
 * again -- so a lost update self-corrects within milliseconds instead of leaving
 * a session that claims to be running behind a PID that has already exited.
 */
export function watchRunnerExit(child, sessionDir, { runnerToken = null, log } = {}) {
  if (!child || typeof child.once !== "function") return;
  const pid = child.pid;

  child.once("exit", (code, signal) => {
    try {
      // Correct a LOST write, never overwrite a recorded one.
      //
      // The runner names its own reason -- idle_shutdown,
      // partner_terminal_failure, fatal_error, SIGTERM -- and that is strictly
      // more informative than anything observable from out here, where all we
      // know is "the process ended". Reasserting unconditionally replaced
      // `idle_shutdown` with a generic `runner_exited` and made production
      // status disagree with what the direct-runner integration tests assert.
      //
      // A status that already says `exited` needs no help; this watcher exists
      // only for the case where our own "running" write landed on top of it.
      const status = readSessionStatus(sessionDir);
      if (status?.runner_state === "exited") return;

      markSessionRunnerExited(sessionDir, {
        runnerToken,
        reason: signal ? `signal_${signal}` : "runner_exited",
        exitCode: Number.isInteger(code) ? code : 0,
        pid,
      });
    } catch (err) {
      log?.(`Failed to record runner exit for pid ${pid}: ${err.message}`);
    }
  });
  // A spawn that never starts (ENOENT on the interpreter) emits `error` and no
  // `exit`, and would otherwise leave the session pinned at "starting".
  child.once("error", () => {
    try {
      markSessionRunnerExited(sessionDir, {
        runnerToken,
        reason: "spawn_failed",
        exitCode: 1,
        pid,
      });
    } catch {
      /* nothing more we can do */
    }
  });
}

function readSessionStatus(sessionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, "status.json"), "utf-8"));
  } catch {
    return null;
  }
}

export function markSessionRunnerExited(
  sessionDir,
  {
    runnerToken = null,
    reason = "runner_exited",
    exitCode = 0,
    // Whose exit this records. Defaults to the calling process, because the
    // usual caller is the runner reporting its own death -- but the server also
    // records the exit of a runner it spawned, and it must not be mistaken for
    // an unrelated process writing about someone else's session.
    pid = process.pid,
  } = {}
) {
  const statusPath = path.join(sessionDir, "status.json");
  let status;
  try {
    status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  } catch {
    return false;
  }

  if (
    typeof status.runner_token === "string" &&
    status.runner_token &&
    status.runner_token !== runnerToken
  ) {
    return false;
  }
  if (Number.isSafeInteger(status.runner_pid) && status.runner_pid !== pid) {
    return false;
  }

  const next = {
    ...status,
    last_runner_pid: pid,
    runner_pid: null,
    runner_state: "exited",
    runner_exited_at: new Date().toISOString(),
    runner_exit_reason: reason,
    runner_exit_code: exitCode,
  };
  writeJsonAtomic(statusPath, next);
  return true;
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}
