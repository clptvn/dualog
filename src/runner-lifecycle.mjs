import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { isProcessAlive } from "./shared.mjs";

const RUNNER_TOKEN_PREFIX = "--runner-token=";
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

export function readRunnerToken(argv = process.argv) {
  const arg = argv.find((value) => value.startsWith(RUNNER_TOKEN_PREFIX));
  return arg ? arg.slice(RUNNER_TOKEN_PREFIX.length) : null;
}

export function isSessionRunnerAlive(status, sessionDir) {
  const pid = status?.runner_pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    return false;
  }

  const commandLine = readProcessCommandLine(pid);
  if (!commandLine) return false;

  // A session written before `type` was recorded has none; those are all
  // dialogs, which is what the default covers.
  const runnerName =
    RUNNER_SCRIPT_BY_SESSION_TYPE[status?.type] ?? DEFAULT_RUNNER_SCRIPT;
  const expectedRunnerPath = path.join(SOURCE_DIR, runnerName);
  if (
    !commandLine.includes(expectedRunnerPath) ||
    !commandLine.includes(sessionDir)
  ) {
    return false;
  }

  if (typeof status.runner_token === "string" && status.runner_token) {
    return commandLine.includes(buildRunnerTokenArg(status.runner_token));
  }

  return true;
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

export function readProcessCommandLine(pid) {
  try {
    if (process.platform === "win32") {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        "if ($null -ne $p) { $p.CommandLine }",
      ].join("; ");
      return execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf-8",
          windowsHide: true,
          timeout: 5000,
        }
      ).trim();
    }

    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
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
