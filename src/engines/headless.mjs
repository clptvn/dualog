// Headless engine: run a partner CLI's one-shot mode to completion.
//
// Simpler than driving a TUI -- no readiness race, no paste, no screen
// scraping -- but it gives up the live pane, so check_partner_alive can only
// report progress from the output stream. Adapters choose per CLI.
//
// The four outcomes (done / stuck / hung / died) are reported distinctly on
// purpose. Collapsing them into "timeout" is what makes these systems feel
// flaky: "the partner could not write files" and "the partner is still
// thinking" need completely different responses from the host.

import fs from "fs";
import path from "path";
import { spawn, execFileSync } from "child_process";
import { buildInvocationFromAdapter } from "../adapters/argv.mjs";
import { readCompletion } from "./completion.mjs";
import { resolveDiscoveryForValidation } from "../adapters/resolve-for-validation.mjs";
import { isProcessAlive } from "../shared.mjs";
import { readProcessCommandLine } from "../runner-lifecycle.mjs";

export class HeadlessTurnError extends Error {
  constructor(message, outcome) {
    super(message);
    this.name = "HeadlessTurnError";
    this.partnerTerminalFailed = true;
    this.failureCode = outcome;
    this.outcome = outcome;
  }
}

// A headless child has no pane and no entry in current_terminal.json, so unlike
// a tmux turn there is nothing for end_dialog or the orphan sweep to find it by.
// Track live children here so the runner's signal handlers can take them down on
// the way out; without this a SIGTERM'd runner leaves a partner CLI running with
// no record that it ever existed.
const activeChildren = new Set();

/**
 * Terminate every headless partner process and WAIT for it to actually die,
 * escalating to SIGKILL rather than scheduling it.
 *
 * This is what a signal handler needs. `kill()` sends SIGTERM and sets a 2s
 * timer for SIGKILL, but a handler that calls process.exit() immediately
 * afterwards takes the timer with it -- so a CLI that blocks or ignores SIGTERM
 * survives its own runner's shutdown, which is the orphan we were trying to
 * prevent.
 */
export async function terminateActiveHeadlessTurnsAndWait({
  graceMs = 2000,
  pollMs = 50,
  // Defaults to everything this runner owns. Overridable so the escalation
  // behavior can be tested against a process the test controls, rather than by
  // exporting a backdoor that mutates the live set.
  children: explicitChildren = null,
} = {}) {
  const children = explicitChildren ? [...explicitChildren] : [...activeChildren];
  if (children.length === 0) return 0;

  for (const child of children) signalTree(child, "SIGTERM");

  // Liveness is a property of the GROUP, not of its leader.
  //
  // Polling isProcessAlive(child.pid) asks only whether the process we spawned
  // is still there, and the common shape of a partner CLI is a launcher that
  // execs or forks the real work. A leader that exits cleanly on SIGTERM while
  // a descendant ignores it therefore read as "everything died" -- this
  // function returned in ~26ms with the descendant still running, and the
  // escalation it promises never happened.
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (children.every((c) => !isProcessTreeAlive(c))) return children.length;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  for (const child of children) {
    if (isProcessTreeAlive(child)) signalTree(child, "SIGKILL");
  }
  return children.length;
}

/**
 * Signal a process tree and wait for it to actually die, escalating within the
 * call rather than on a timer that a departing process would take with it.
 */
async function terminateProcessTree(handle, { graceMs = 2000, pollMs = 50 } = {}) {
  signalTree(handle, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessTreeAlive(handle)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (!isProcessTreeAlive(handle)) return true;
  signalTree(handle, "SIGKILL");

  const killDeadline = Date.now() + graceMs;
  while (Date.now() < killDeadline) {
    if (!isProcessTreeAlive(handle)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !isProcessTreeAlive(handle);
}

/**
 * Is anything in this child's process group still running?
 *
 * On Unix a detached child leads a group of its own id, and `kill(-pgid, 0)`
 * succeeds while ANY member survives -- which is the question that matters when
 * deciding whether to escalate. Falls back to the single PID where there is no
 * group to ask about (Windows, or a child that was never detached).
 */
function isProcessTreeAlive(child) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (err) {
      // ESRCH: the whole group is gone. EPERM: it exists but is not ours to
      // signal, which still means "alive" for this decision.
      if (err?.code === "EPERM") return true;
      if (err?.code === "ESRCH") return false;
    }
  }

  return isProcessAlive(pid);
}

// Only a 1,500-character tail is ever surfaced in diagnostics, but an adapter
// with stdoutTrustworthy parses the whole stream, so the buffer cannot simply be
// a tail. Keep a generous head and tail and elide the middle: a hung CLI that
// chatters for the full timeout is then bounded by these limits instead of by
// how long the turn ran.
const OUTPUT_HEAD_CHARS = 1024 * 1024;
const OUTPUT_TAIL_CHARS = 1024 * 1024;

function createBoundedOutput(
  headLimit = OUTPUT_HEAD_CHARS,
  tailLimit = OUTPUT_TAIL_CHARS
) {
  let head = "";
  let tailBuffer = "";
  let dropped = 0;

  return {
    push(chunk) {
      let text = String(chunk);
      if (head.length < headLimit) {
        const room = headLimit - head.length;
        if (text.length <= room) {
          head += text;
          return;
        }
        head += text.slice(0, room);
        text = text.slice(room);
      }
      tailBuffer += text;
      if (tailBuffer.length > tailLimit) {
        const excess = tailBuffer.length - tailLimit;
        tailBuffer = tailBuffer.slice(excess);
        dropped += excess;
      }
    },
    value() {
      if (!dropped) return head + tailBuffer;
      return (
        `${head}\n...[dualog elided ${dropped} characters of partner output]...\n` +
        tailBuffer
      );
    },
    get dropped() {
      return dropped;
    },
  };
}

function getPath(object, dottedPath) {
  if (!dottedPath) return undefined;
  return dottedPath
    .split(".")
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

/**
 * Extract the final message from a completed run's stdout, per the adapter's
 * declared shape. Returns null when nothing usable is present -- the caller
 * decides whether that is fatal.
 */
export function extractStdoutResult(adapter, stdout) {
  const spec = adapter.completion.stdout;
  if (!spec) return null;

  if (spec.format === "text") {
    const trimmed = stdout.trim();
    return trimmed || null;
  }

  if (spec.format === "json") {
    try {
      const parsed = JSON.parse(stdout);
      const value = getPath(parsed, spec.resultPath ?? "");
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  // stream-json: NDJSON. Scan from the end -- the terminal event is last, and
  // an earlier event of the same type (a nested/sub-agent result) must not win.
  const lines = stdout.split(/\r?\n/u).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue; // Non-JSON chatter interleaved in the stream is normal.
    }
    if (event?.type !== spec.resultEventType) continue;
    const value = getPath(event, spec.resultPath ?? "");
    return typeof value === "string" ? value : null;
  }
  return null;
}

/**
 * Run one partner turn headlessly and return its final message.
 */
export async function runHeadlessTurn({
  adapter,
  partnerCommand,
  bootstrap,
  projectPath,
  sessionDir,
  turnDir,
  resultPath,
  donePath,
  model,
  reasoningEffort,
  toolProfile,
  timeoutMs,
  log,
  endSignalPath,
  allowUnknownModel = false,
}) {
  // Self-heal before adding another child. A record still on disk belongs to a
  // turn that never finished, and by definition it is over now -- a session runs
  // one partner turn at a time. This is what closes the SIGKILL gap in practice:
  // the runner that was killed cannot clean up, but its successor can, and it
  // gets here before doing anything else.
  try {
    const reaped = await reapOrphanedHeadlessChildren(sessionDir, { log });
    if (reaped) log(`Reaped ${reaped} orphaned headless partner process(es) from a previous turn`);
  } catch (err) {
    log(`Orphan sweep failed (continuing): ${err.message}`);
  }

  // Same catalog the preflight used, so a live entry that widened a model's
  // effort set cannot be accepted at start and then refused every turn here.
  const discoveredModels = await resolveDiscoveryForValidation(adapter, {
    model,
    projectPath,
    log,
  });

  const { command, args, env, notices } = buildInvocationFromAdapter(adapter, {
    engine: "headless",
    partnerCommand,
    projectPath,
    sessionDir,
    model,
    reasoningEffort,
    toolProfile,
    initialPrompt: bootstrap,
    discoveredModels,
    applyOperatorDefault: true,
    allowUnknownModel,
  });

  for (const notice of notices) {
    log(`Adapter "${adapter.id}": ${notice.message}`);
  }

  // Same rule as the tmux path: an error-severity finding means the turn would
  // run with something the caller asked for silently missing, and the runner's
  // log never reaches the host to say so.
  const blocking = notices.filter((notice) => notice.severity === "error");
  if (blocking.length) {
    throw new HeadlessTurnError(
      `Adapter "${adapter.id}" cannot run this turn as requested: ` +
        blocking.map((notice) => notice.message).join("; "),
      "died"
    );
  }

  const delivery = adapter.promptDelivery.headless;
  log(
    `Invoking ${adapter.displayName} headlessly (prompt via ${delivery}, ${bootstrap.length} chars)`
  );

  const child = spawn(command, args, {
    cwd: projectPath,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Lead a process group so termination reaches the CLI's own children. Many
    // partner CLIs shell out; signalling only the direct PID leaves those behind
    // holding the pipes, which reads as a hang rather than a kill.
    detached: process.platform !== "win32",
  });
  activeChildren.add(child);
  // Both cleanups are tied to `close`, not to the turn returning. On timeout or
  // cancellation waitForExit() resolves as soon as it has SIGNALLED the child --
  // it does not wait for the process to go away -- so clearing the record there
  // would delete the only handle to a process that is still running, which is
  // precisely the orphan the record exists to catch.
  child.once("close", () => {
    activeChildren.delete(child);
    // The record may only go when there is nothing left it could point at.
    //
    // `close` means OUR child ended, not that its work did: a launcher that
    // forks and exits, or a CLI that daemonizes and closes its pipes, leaves
    // descendants alive in the same group. Deleting the breadcrumb here was
    // self-erasing in exactly that case -- the one where a later sweep is the
    // only thing that could still find them.
    clearChildRecordIfGroupGone(turnDir, child.pid);
  });
  // Leave a breadcrumb a later sweep can act on: SIGKILL gives this process no
  // chance to clean up, and without a persisted identity the child is invisible.
  writeChildRecord(turnDir, child, command);

  const stdoutBuffer = createBoundedOutput();
  const stderrBuffer = createBoundedOutput();
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => stdoutBuffer.push(chunk));
  child.stderr.on("data", (chunk) => stderrBuffer.push(chunk));

  if (delivery === "stdin") {
    child.stdin.write(bootstrap);
    child.stdin.end();
  } else {
    // The prompt went in via argv; closing stdin tells CLIs that check for
    // piped input that there is none, rather than leaving them waiting on it.
    child.stdin.end();
  }

  const exit = await waitForExit(child, { timeoutMs, endSignalPath, log });

  const stdout = stdoutBuffer.value();
  const stderr = stderrBuffer.value();
  if (stdoutBuffer.dropped || stderrBuffer.dropped) {
    log(
      `${adapter.displayName} produced more output than dualog retains; ` +
        `elided ${stdoutBuffer.dropped} stdout and ${stderrBuffer.dropped} stderr characters`
    );
  }

  // Persist raw output next to the turn for diagnosis.
  try {
    fs.writeFileSync(path.join(turnDir, "stdout.log"), stdout);
    if (stderr) fs.writeFileSync(path.join(turnDir, "stderr.log"), stderr);
  } catch {
    // Diagnostics only; never fail a completed turn over them.
  }

  if (exit.kind === "timeout") {
    throw new HeadlessTurnError(
      `${adapter.displayName} headless turn exceeded ${timeoutMs}ms with no completion` +
        tail(stderr || stdout),
      "hung"
    );
  }
  if (exit.kind === "cancelled") {
    throw new HeadlessTurnError(
      `${adapter.displayName} headless turn was cancelled by end_dialog`,
      "cancelled"
    );
  }

  const sidecar = readCompletion({ turnDir, resultPath, donePath });
  const policy = adapter.completion.sidecar;

  if (sidecar?.status === "error") {
    throw new HeadlessTurnError(
      `${adapter.displayName} reported a turn error: ${sidecar.error || sidecar.result}`,
      "died"
    );
  }
  if (sidecar) {
    return sidecar.result;
  }

  // No sidecar. A process that died is diagnosed as having died -- the
  // write-access diagnosis below is only right for a CLEAN exit that produced
  // nothing, and applying it to a crash sends people hunting in the wrong place.
  const exitedCleanly = exit.code === 0 && !exit.signal;
  if (!exitedCleanly && !adapter.completion.stdoutTrustworthy) {
    throw new HeadlessTurnError(
      `${adapter.displayName} exited ${describeExit(exit)} without completing the turn.` +
        tail(stderr || stdout),
      "died"
    );
  }

  if (policy === "always" && exitedCleanly) {
    throw new HeadlessTurnError(
      `${adapter.displayName} exited cleanly without writing its completion files. ` +
        `This usually means the partner could not write files -- check that the adapter's ` +
        `auto-approve flag is present, since several CLIs silently deny write tools otherwise.` +
        tail(stderr || stdout),
      "stuck"
    );
  }
  if (policy === "always") {
    throw new HeadlessTurnError(
      `${adapter.displayName} exited ${describeExit(exit)} without writing its completion files.` +
        tail(stderr || stdout),
      "died"
    );
  }

  const fromStdout = adapter.completion.stdoutTrustworthy
    ? extractStdoutResult(adapter, stdout)
    : null;

  if (fromStdout) {
    if (policy === "fallback") {
      // Loud, because it is the signature of silently-revoked write access.
      log(
        `${adapter.displayName} completed via stdout but wrote no done.json; ` +
          `the partner may not have had file-write access this turn.`
      );
    }
    return fromStdout;
  }

  throw new HeadlessTurnError(
    `${adapter.displayName} exited ${describeExit(exit)} with no completion sidecar and ` +
      `no recognizable result on stdout.` + tail(stderr || stdout),
    exit.code === 0 ? "stuck" : "died"
  );
}

function describeExit(exit) {
  if (exit.signal) return `on signal ${exit.signal}`;
  return `with code ${exit.code}`;
}

function tail(text, max = 1500) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  return `\nLast output:\n${trimmed.slice(-max)}`;
}

function waitForExit(child, { timeoutMs, endSignalPath, log }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      resolve(value);
    };

    const timer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            log?.(`Headless turn exceeded ${timeoutMs}ms; terminating the partner process`);
            kill(child);
            finish({ kind: "timeout" });
          }, timeoutMs)
        : null;

    const cancelPoll = endSignalPath
      ? setInterval(() => {
          if (fs.existsSync(endSignalPath)) {
            kill(child);
            finish({ kind: "cancelled" });
          }
        }, 1000)
      : null;

    child.on("error", (err) =>
      finish({ kind: "exit", code: null, signal: null, error: err })
    );
    child.on("close", (code, signal) => finish({ kind: "exit", code, signal }));
  });
}

/**
 * Signal the partner's whole process group where the platform supports it, so a
 * CLI that shelled out does not leave descendants behind holding the pipes.
 * Falls back to the direct PID when there is no group to address.
 */
function signalTree(child, signal) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No group (never detached, or already reaped) -- fall through.
    }
  }

  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

function kill(child) {
  signalTree(child, "SIGTERM");
  // Escalate if the CLI ignores SIGTERM while draining.
  setTimeout(() => {
    signalTree(child, "SIGKILL");
  }, 2000).unref?.();
}

function writeChildRecord(turnDir, child, command) {
  try {
    fs.writeFileSync(
      path.join(turnDir, "headless-child.json"),
      JSON.stringify(
        {
          pid: child.pid,
          // Detached children lead a group of the same id; recorded explicitly
          // so a sweeper does not have to infer the convention.
          pgid: process.platform === "win32" ? null : child.pid,
          // The executable, kept for diagnostics and as a weak cross-check.
          // NOT sufficient on its own to authorize a kill: matching "node" or
          // "opencode" proves only that the recycled PID is running the same
          // program, not that it is this turn's process.
          command,
          // The identity that actually distinguishes one PID N from the next.
          // A PID is reused; a (pid, start time) pair is not. Read from the OS
          // at spawn so a later sweep can demand an exact match.
          start_time: readProcessStartTime(child.pid),
          started_at: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch {
    // Best-effort breadcrumb; a turn must not fail because it could not be left.
  }
}

/**
 * The OS's start timestamp for a PID, as an opaque string, or null.
 *
 * Opaque on purpose: it is only ever compared for equality against a value read
 * the same way on the same machine, so its format does not need parsing.
 */
function readProcessStartTime(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") return null;
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Can we PROVE this PID is still the process the record describes?
 *
 * Three-valued on purpose: "yes", "no", and "cannot tell" are different, and
 * collapsing the third into either of the others is a bug in opposite
 * directions -- treating it as "yes" kills strangers, treating it as "no"
 * discards the only handle to a live orphan.
 */
function identifyRecordedLeader(record) {
  const pid = record?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return "no";
  if (!isProcessAlive(pid)) return "no";

  // Strongest available signal: PID plus OS start time.
  if (record.start_time) {
    const current = readProcessStartTime(pid);
    if (current) return current === record.start_time ? "yes" : "no";
    return "unknown"; // ps unavailable or denied
  }

  // Older record with no start time. The command name alone cannot authorize a
  // kill -- a stale "node" record would match any later node process -- so the
  // most this can produce is "cannot tell".
  const commandLine = readProcessCommandLine(pid);
  if (!commandLine) return "unknown";
  return typeof record.command === "string" && commandLine.includes(record.command)
    ? "unknown"
    : "no";
}

/**
 * All processes currently in `pgid`, or null when the group cannot be listed.
 *
 * `ps -g` does not enumerate a group on macOS, so ask for everything and filter.
 * Null means "could not tell", which callers must treat as indeterminate rather
 * than as an empty group.
 */
function readProcessGroupMembers(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return null;
  if (process.platform === "win32") return null;

  let out;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,pgid=,lstart="], {
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }

  const members = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    if (Number(match[2]) !== pgid) continue;
    members.push({ pid: Number(match[1]), startTime: match[3].trim() });
  }
  return members;
}

/**
 * Does this record's process group still hold anything that is plausibly OURS?
 *
 * The leader dying does not mean the work stopped: a launcher that execs or
 * forks and then exits, or a CLI that daemonizes and closes its pipes, leaves
 * descendants behind in the same group. Classifying on the leader alone
 * therefore declared success while a descendant kept running -- reproduced with
 * a detached launcher whose child outlived it by design.
 *
 * PGID is reused just as PID is, so group membership alone cannot authorize a
 * kill either. A member that STARTED BEFORE this turn did cannot be ours, so
 * the record's own timestamp is the discriminator: a recycled group is made of
 * processes older than the record, a real orphan of processes no older than it.
 *
 * Three-valued for the same reason as the leader check.
 */
function identifyRecordedGroup(record) {
  const pgid = Number.isSafeInteger(record?.pgid) ? record.pgid : record?.pid;

  // Ask the cheap, always-available question first: does this group exist at
  // all? `kill(-pgid, 0)` needs no external tool, and a definitive ESRCH is
  // proof there is nothing here -- which must resolve to "no", not "unknown".
  //
  // Going straight to `ps` inverted that: where `ps` is denied, a provably
  // absent group came back "unknown", so its record was retained and rewritten
  // on every sweep, forever. Absence is knowable without `ps`; only OWNERSHIP
  // needs it.
  if (!isProcessTreeAlive({ pid: pgid })) return "no";

  const members = readProcessGroupMembers(pgid);
  if (members === null) return "unknown";
  if (members.length === 0) return "no";

  // Whether a LEADER is present is what distinguishes our surviving descendants
  // from a group whose id has been reused.
  //
  // A process's pgid equals its own pid exactly when it leads the group, and
  // reusing a group id REQUIRES some new process to take that pid and become a
  // leader. So:
  //
  //   leader present -> this may be a new group wearing our number. Its start
  //                     time settles it, and a mismatch means "not ours".
  //   leader absent  -> the id cannot have been recycled, because recycling
  //                     would have produced one. What is left are the
  //                     descendants our dead leader spawned.
  //
  // "Any member newer than the record" was the obvious rule and it is wrong in
  // exactly the direction that matters: every member of a recycled group is
  // newer than an old record, so it authorizes killing strangers.
  const leader = members.find((member) => member.pid === pgid);
  if (leader) {
    if (!record.start_time) return "unknown";
    return leader.startTime === record.start_time ? "yes" : "no";
  }

  return "yes";
}

/**
 * Combined verdict for a record: is there anything left to kill, and may we?
 */
function identifyRecordedProcess(record) {
  const leader = identifyRecordedLeader(record);
  if (leader === "yes") return "yes";

  // The leader is gone or unrecognizable -- ask the group before giving up.
  const group = identifyRecordedGroup(record);
  if (group === "yes") return "yes";
  if (leader === "unknown" || group === "unknown") return "unknown";
  return "no";
}

/**
 * Terminate any headless partner process this session recorded and never reaped.
 *
 * A record only survives a turn that did not finish: writeChildRecord() is
 * cleared on every normal exit, and the runner's signal handlers call
 * terminateActiveHeadlessTurnsAndWait() on SIGTERM/SIGINT. What is left is the SIGKILL
 * case -- no handler runs, and the child is left with no handle anywhere -- plus
 * a runner that crashed hard enough to skip its own cleanup.
 *
 * PID reuse is the hazard that shapes this. isSessionRunnerAlive() already
 * refuses to treat a recycled PID as a live runner by checking the process's
 * command line, and a stale child record is if anything more likely to have been
 * recycled, so the same proof is required here: no command-line match, no
 * signal. An unrecognized PID is not killed, only forgotten.
 *
 * Returns the number of processes actually signalled.
 */
export async function reapOrphanedHeadlessChildren(
  sessionDir,
  { log = () => {}, graceMs = 2000, pollMs = 50 } = {}
) {
  const turnsDir = path.join(sessionDir, "turns");
  let turnIds;
  try {
    turnIds = fs.readdirSync(turnsDir);
  } catch {
    return 0; // No turns directory: nothing was ever spawned here.
  }

  let signalled = 0;
  for (const turnId of turnIds) {
    const recordPath = path.join(turnsDir, turnId, "headless-child.json");
    let record;
    try {
      record = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    } catch {
      continue; // Absent (the normal case) or unreadable.
    }

    const identity = identifyRecordedProcess(record);

    if (identity === "unknown") {
      // We cannot prove this PID is ours, and we cannot prove it is not. Do not
      // signal -- and do not delete either. Deleting is irreversible: it throws
      // away the only handle to what may be a live orphan, and the cause is
      // often environmental (a sandbox denying `ps`) rather than permanent.
      // Keep the record and count the attempt so it can be retried later.
      const attempts = Number.isSafeInteger(record.reap_attempts) ? record.reap_attempts : 0;
      log(
        `Cannot establish the identity of pid ${record.pid} from turn ${turnId}; ` +
          `leaving the record in place for a later attempt (attempt ${attempts + 1})`
      );
      try {
        fs.writeFileSync(
          recordPath,
          JSON.stringify({ ...record, reap_attempts: attempts + 1 }, null, 2)
        );
      } catch {
        /* the record is advisory; failing to annotate it changes nothing */
      }
      continue;
    }

    if (identity === "yes") {
      log(`Reaping orphaned headless partner process ${record.pid} from turn ${turnId}`);
      const handle = { pid: record.pid };

      // Escalate HERE, not on a timer, and prove the group is gone before
      // dropping the record.
      //
      // Signalling TERM, scheduling an unref'd KILL, and unlinking immediately
      // reproduced the exact timer-lifetime bug the active shutdown path was
      // changed to avoid: a TERM-ignoring group stayed alive and, once the
      // record was gone, unfindable. If this process exited inside that
      // two-second window the escalation went with it and nothing could ever
      // locate the orphan again.
      await terminateProcessTree(handle, { graceMs, pollMs });
      signalled += 1;

      if (isProcessTreeAlive(handle)) {
        // Survived TERM and KILL. The record is the only handle to it, so it
        // stays for the next sweep rather than being thrown away.
        const attempts = Number.isSafeInteger(record.reap_attempts) ? record.reap_attempts : 0;
        log(
          `Process group ${record.pgid ?? record.pid} survived TERM and KILL; ` +
            `retaining its record for another attempt (attempt ${attempts + 1})`
        );
        try {
          fs.writeFileSync(
            recordPath,
            JSON.stringify({ ...record, reap_attempts: attempts + 1 }, null, 2)
          );
        } catch {
          /* advisory */
        }
        continue;
      }
    }

    // Either identity === "no" (the process is gone, or the number now belongs
    // to something else) or the group has been proven dead just above. Only now
    // does the record describe nothing.
    try {
      fs.unlinkSync(recordPath);
    } catch {
      /* already gone */
    }
  }

  return signalled;
}

function clearChildRecord(turnDir) {
  try {
    fs.unlinkSync(path.join(turnDir, "headless-child.json"));
  } catch {
    /* never written, or already cleaned */
  }
}

/**
 * Drop the breadcrumb only once the child's whole process group is gone.
 *
 * Keeping it costs one small file until the next sweep looks at it; dropping it
 * early costs the only means of ever finding a surviving descendant.
 */
function clearChildRecordIfGroupGone(turnDir, pid) {
  if (isProcessTreeAlive({ pid })) return;
  clearChildRecord(turnDir);
}
