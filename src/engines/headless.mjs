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
import { execFileSync } from "child_process";
import crossSpawn from "cross-spawn";
import { buildInvocationFromAdapter } from "../adapters/argv.mjs";
import { releaseLease, transitionLease } from "../runtime-lease.mjs";
import { processStartTime } from "../process-probe.mjs";
import { readCompletion } from "./completion.mjs";
import { resolveDiscoveryForValidation } from "../adapters/resolve-for-validation.mjs";
import { findBinary } from "../adapters/negotiate.mjs";
import { isProcessAlive } from "../shared.mjs";
import { readProcessCommandLine } from "../runner-lifecycle.mjs";
import {
  spawnWithTrustedWindowsComSpec,
  terminateWindowsProcessTree,
} from "../windows-process-tree.mjs";

export { terminateWindowsProcessTree } from "../windows-process-tree.mjs";

export function spawnHeadlessPartner(
  command,
  args,
  options,
  {
    platform = process.platform,
    spawnImpl = crossSpawn,
    systemEnv = process.env,
  } = {}
) {
  return spawnWithTrustedWindowsComSpec(
    spawnImpl,
    command,
    args,
    options,
    { platform, env: systemEnv }
  );
}

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

// Kept on the ChildProcess handle as well as in lease metadata. The in-memory
// copy protects the headless-child.json breadcrumb when taskkill fails and the
// direct cmd.exe wrapper happens to disappear anyway; without it the `close`
// handler would erase the only evidence that a descendant may still be alive.
const WINDOWS_TREE_TERMINATION = Symbol("dualog.windowsTreeTermination");
const WINDOWS_TREE_TERMINATION_RECORDER = Symbol("dualog.windowsTreeTerminationRecorder");

function rememberWindowsTreeTermination(child, result) {
  if (child && typeof child === "object") {
    child[WINDOWS_TREE_TERMINATION] = result;
  }
  return result;
}

function recordChildWindowsTreeTermination(child, status, reason = null) {
  try {
    child?.[WINDOWS_TREE_TERMINATION_RECORDER]?.(status, reason);
  } catch {
    // The recorder itself is fail-closed: it marks the owner lifecycle for
    // retention before attempting its metadata write. Termination must still be
    // attempted even when diagnostic persistence encounters an I/O failure.
  }
}

/**
 * Build the bridge between process-tree termination and lease metadata.
 * Exported so Windows behavior can be proven hermetically on non-Windows CI.
 */
export function createWindowsTreeTerminationRecorder({
  platform = process.platform,
  lease = null,
  consumer = null,
  lifecycle = { retainLease: false, retentionReason: null },
  transitionLeaseFn = transitionLease,
}) {
  let currentConsumer = consumer;

  return (status, reason = null) => {
    if (platform !== "win32") return;

    const retains = !["succeeded", "wrapper-exit-observed"].includes(status);
    lifecycle.retainLease = retains;
    lifecycle.retentionReason = retains
      ? reason || `Windows process-tree termination is ${status}`
      : null;

    if (!lease || !currentConsumer) return;
    const nextConsumer = {
      ...currentConsumer,
      windows_tree_termination: status,
    };
    try {
      transitionLeaseFn(lease, "active", { consumer: nextConsumer });
      currentConsumer = nextConsumer;
    } catch (err) {
      // A failed proof write cannot be treated as if it landed. Keep the lease
      // in this owner even when taskkill itself succeeds; a later sweep still
      // has the child breadcrumb and the previous conservative metadata.
      lifecycle.retainLease = true;
      lifecycle.retentionReason =
        `the Windows tree-termination proof could not be recorded (${err.message})`;
    }
  };
}

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
  platform = process.platform,
  terminateWindowsTreeFn = terminateWindowsProcessTree,
  recordWindowsTreeTerminationFn = recordChildWindowsTreeTermination,
} = {}) {
  const children = explicitChildren ? [...explicitChildren] : [...activeChildren];
  if (children.length === 0) return 0;

  if (platform === "win32") {
    // taskkill /T /F is synchronous. There is no useful TERM-then-KILL split on
    // native Windows, and returning only after taskkill exits is what prevents a
    // signal handler from taking an outstanding escalation timer with it.
    for (const child of children) {
      recordWindowsTreeTerminationFn(child, "pending");
      const result = rememberWindowsTreeTermination(
        child,
        terminateWindowsTreeFn(child?.pid)
      );
      recordWindowsTreeTerminationFn(
        child,
        result?.status ?? "failed",
        result?.reason ?? null
      );
    }
    return children.length;
  }

  for (const child of children) signalTree(child, "SIGTERM", { platform });

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
    if (children.every((c) => !isProcessTreeAlive(c, { platform }))) return children.length;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  for (const child of children) {
    if (isProcessTreeAlive(child, { platform })) {
      signalTree(child, "SIGKILL", { platform });
    }
  }
  return children.length;
}

/**
 * Signal a process tree and wait for it to actually die, escalating within the
 * call rather than on a timer that a departing process would take with it.
 */
async function terminateProcessTree(
  handle,
  {
    graceMs = 2000,
    pollMs = 50,
    platform = process.platform,
    terminateWindowsTreeFn = terminateWindowsProcessTree,
  } = {}
) {
  if (platform === "win32") {
    const result = rememberWindowsTreeTermination(
      handle,
      terminateWindowsTreeFn(handle?.pid)
    );
    return result?.status === "succeeded";
  }

  signalTree(handle, "SIGTERM", { platform });

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessTreeAlive(handle, { platform })) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (!isProcessTreeAlive(handle, { platform })) return true;
  signalTree(handle, "SIGKILL", { platform });

  const killDeadline = Date.now() + graceMs;
  while (Date.now() < killDeadline) {
    if (!isProcessTreeAlive(handle, { platform })) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !isProcessTreeAlive(handle, { platform });
}

/**
 * Is anything in this child's process group still running?
 *
 * On Unix a detached child leads a group of its own id, and `kill(-pgid, 0)`
 * succeeds while ANY member survives -- which is the question that matters when
 * deciding whether to escalate. Falls back to the single PID where there is no
 * group to ask about (Windows, or a child that was never detached).
 */
function isProcessTreeAlive(child, { platform = process.platform } = {}) {
  const pid = child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  if (platform !== "win32") {
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
 * Run one partner turn headlessly and return its final message, releasing its
 * runtime lease however it ends.
 *
 * The wrapper exists for the `finally`: this function has a dozen exit paths --
 * timeout, cancellation, five distinct completion diagnoses -- and the credential
 * projection has to go on every one of them. Releasing at each `return` and
 * `throw` is how the failure paths come to be the ones that leak.
 *
 * `releaseLease` only removes a lease whose consumer is PROVEN gone, so this
 * cannot reclaim a home from a process group that outlived our direct child;
 * such a lease is retained and swept once the group can be shown absent.
 */
export async function runHeadlessTurn(options) {
  // A failed native-Windows tree kill is an explicit reason NOT to call the
  // ordinary lease releaser. The direct cmd.exe pid may already be absent, but
  // taskkill's failure means that absence says nothing about its descendants.
  const lifecycle = { retainLease: false, retentionReason: null };
  try {
    return await runHeadlessTurnInner(options, lifecycle);
  } finally {
    const { lease, log } = options;
    if (lease) {
      if (lifecycle.retainLease) {
        log(
          `Runtime lease ${lease.id} retained: ${lifecycle.retentionReason || "the Windows process tree could not be proven terminated"}`
        );
      } else {
        try {
          const { released, reason } = releaseLease(lease);
          if (!released && reason) log(`Runtime lease ${lease.id} retained: ${reason}`);
        } catch (err) {
          log(`Runtime lease ${lease.id} could not be released: ${err.message}`);
        }
      }
    }
  }
}

async function runHeadlessTurnInner(
  {
    adapter,
    lease = null,
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
  },
  lifecycle
) {
  const resolvedPartnerCommand = findBinary(
    partnerCommand || adapter?.binary?.default,
    process.env,
    { excludedRoots: [projectPath] }
  );
  if (!resolvedPartnerCommand) {
    throw new HeadlessTurnError(
      `Partner command ${JSON.stringify(partnerCommand || adapter?.binary?.default)} is not an executable absolute path or on an absolute PATH entry`,
      "died"
    );
  }

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
    engine: "headless",
    partnerCommand: resolvedPartnerCommand,
    log,
  });

  // `projecting` before the call that copies credentials in; see runtime-lease.mjs
  // for why the state is an upper bound on what may have happened rather than a
  // report of what did.
  if (lease) transitionLease(lease, "projecting");
  const { command, args, env, notices } = buildInvocationFromAdapter(adapter, {
    engine: "headless",
    partnerCommand: resolvedPartnerCommand,
    projectPath,
    sessionDir,
    scratchDir: lease?.dir ?? null,
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

  if (lease) transitionLease(lease, "ready");

  const delivery = adapter.promptDelivery.headless;
  log(
    `Invoking ${adapter.displayName} headlessly (prompt via ${delivery}, ${bootstrap.length} chars)`
  );

  // Unlike tmux, this engine cannot know its consumer's identity until spawn()
  // returns, so `spawning` records only the KIND. A SIGKILL in the window
  // between these two statements leaves a live child with no recorded pid --
  // which the lease reaper reads as "retain", because there is no portable proof
  // that spawn() did not happen. That retention is released by the boot check
  // once the machine restarts, so a crash cannot make a projection permanent.
  if (lease) transitionLease(lease, "spawning", { consumer: { kind: "headless" } });
  let child;
  try {
    child = spawnPartner();
  } catch (err) {
    // THE OWNER WATCHED THE SPAWN FAIL, which is knowledge no probe can
    // reconstruct. Without recording it, the lease stays identity-less
    // `spawning` and proveLeaseReleasable retains it until the next reboot --
    // so an ordinary missing-binary failure held a credential copy for the whole
    // boot, or forever where no boot identity is available.
    if (lease) {
      try {
        transitionLease(lease, "spawning", {
          consumer: { kind: "headless", spawn_outcome: "failed" },
        });
      } catch {
        // The release below still refuses without a proof.
      }
    }
    throw err;
  }

  // Persist the child's provisional identity first, then capture its OS-owned
  // birth identity exactly once and atomically enrich that breadcrumb. On
  // native Windows the capture is a synchronous CIM query: a SIGKILL during it
  // must leave pid/command evidence rather than no durable handle at all.
  const childStartTime = persistHeadlessChildRecord(turnDir, child, command);

  function spawnPartner() {
    // cross-spawn preserves child_process.spawn semantics on POSIX while also
    // resolving npm-installed .cmd shims on native Windows. Using Node's raw
    // spawn() there makes a valid `claude.cmd` or `codex.cmd` look missing.
    return spawnHeadlessPartner(command, args, {
      cwd: projectPath,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Lead a process group so termination reaches the CLI's own children. Many
      // partner CLIs shell out; signalling only the direct PID leaves those
      // behind holding the pipes, which reads as a hang rather than a kill.
      detached: process.platform !== "win32",
    });
  }
  // NODE DOES NOT THROW FOR A MISSING BINARY. spawn() returns a ChildProcess
  // with no pid and emits `error` asynchronously, so the synchronous catch above
  // never fires for the commonest failure there is. Claiming `active` here would
  // record an identity-less consumer that the reaper then retains for the whole
  // boot -- a typo in a manifest holding a credential copy until reboot.
  const leaseConsumer = child.pid == null
    ? null
    : {
        kind: "headless",
        pid: child.pid,
        pgid: process.platform === "win32" ? null : child.pid,
        started_at: childStartTime,
        // Persist a conservative baseline before any cancellation is possible.
        // If a later `pending`/`failed` write itself fails, this older record
        // still retains once the wrapper disappears rather than authorizing a
        // sweep from metadata that never learned a tree kill was attempted.
        ...(process.platform === "win32"
          ? { windows_tree_termination: "running" }
          : {}),
      };

  if (lease && child.pid == null) {
    child.once("error", () => {
      try {
        transitionLease(lease, "spawning", {
          consumer: { kind: "headless", spawn_outcome: "failed" },
        });
      } catch {
        // The release still refuses without a proof.
      }
    });
  } else if (lease) {
    transitionLease(lease, "active", {
      consumer: leaseConsumer,
    });
  }

  // The same object is used for each termination-state transition. Keep it
  // independent of whether a lease exists so timeout/cancel remains ordinary
  // process management for adapters that do not project credentials.
  const recordWindowsTreeTermination = createWindowsTreeTerminationRecorder({
    lease,
    consumer: leaseConsumer,
    lifecycle,
  });
  child[WINDOWS_TREE_TERMINATION_RECORDER] = recordWindowsTreeTermination;
  activeChildren.add(child);
  // Both cleanups are tied to `close`, not to the turn returning. On timeout or
  // cancellation waitForExit() resolves as soon as it has SIGNALLED the child --
  // it does not wait for the process to go away -- so clearing the record there
  // would delete the only handle to a process that is still running, which is
  // precisely the orphan the record exists to catch.
  child.once("close", () => {
    activeChildren.delete(child);
    if (
      process.platform === "win32" &&
      child[WINDOWS_TREE_TERMINATION] == null
    ) {
      // Preserve the pre-existing behavior for a naturally completed command:
      // a close observed without a kill attempt is the normal completion proof.
      // Forced exits use taskkill's stronger tree proof above.
      recordWindowsTreeTermination("wrapper-exit-observed");
      if (lifecycle.retainLease) return;
    }
    // The record may only go when there is nothing left it could point at.
    //
    // `close` means OUR child ended, not that its work did: a launcher that
    // forks and exits, or a CLI that daemonizes and closes its pipes, leaves
    // descendants alive in the same group. Deleting the breadcrumb here was
    // self-erasing in exactly that case -- the one where a later sweep is the
    // only thing that could still find them.
    clearChildRecordIfGroupGone(turnDir, child);
  });
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

  const exit = await waitForExit(child, {
    timeoutMs,
    endSignalPath,
    log,
    onWindowsTreeTermination: recordWindowsTreeTermination,
  });

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
  if (sidecar?.warning) log(sidecar.warning);
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

export function waitForExit(
  child,
  {
    timeoutMs,
    endSignalPath,
    log,
    platform = process.platform,
    terminateWindowsTreeFn = terminateWindowsProcessTree,
    pathExistsFn = fs.existsSync,
    cancelPollMs = 1000,
    onWindowsTreeTermination = () => {},
  }
) {
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
            const termination = kill(child, {
              platform,
              terminateWindowsTreeFn,
              onWindowsTreeTermination,
            });
            finish({ kind: "timeout", termination });
          }, timeoutMs)
        : null;

    const cancelPoll = endSignalPath
      ? setInterval(() => {
          if (pathExistsFn(endSignalPath)) {
            const termination = kill(child, {
              platform,
              terminateWindowsTreeFn,
              onWindowsTreeTermination,
            });
            finish({ kind: "cancelled", termination });
          }
        }, cancelPollMs)
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
function signalTree(
  child,
  signal,
  {
    platform = process.platform,
    terminateWindowsTreeFn = terminateWindowsProcessTree,
  } = {}
) {
  const pid = child?.pid;
  if (platform === "win32") {
    return rememberWindowsTreeTermination(child, terminateWindowsTreeFn(pid));
  }

  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  try {
    process.kill(-pid, signal);
    return null;
  } catch {
    // No group (never detached, or already reaped) -- fall through.
  }

  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
  return null;
}

function kill(
  child,
  {
    platform = process.platform,
    terminateWindowsTreeFn = terminateWindowsProcessTree,
    onWindowsTreeTermination = () => {},
  } = {}
) {
  if (platform === "win32") {
    // Persist the uncertainty BEFORE invoking taskkill. If this process dies in
    // the call, or the call fails, a missing wrapper pid must not become cleanup
    // authorization. The succeeding transition is the proof that removes it.
    onWindowsTreeTermination("pending");
    const result = signalTree(child, "SIGKILL", {
      platform,
      terminateWindowsTreeFn,
    });
    onWindowsTreeTermination(result?.status ?? "failed", result?.reason ?? null);
    return result;
  }

  signalTree(child, "SIGTERM", { platform });
  // Escalate if the CLI ignores SIGTERM while draining.
  setTimeout(() => {
    signalTree(child, "SIGKILL", { platform });
  }, 2000).unref?.();
  return null;
}

export function persistHeadlessChildRecord(
  turnDir,
  child,
  command,
  {
    platform = process.platform,
    processStartTimeFn = processStartTime,
    nowFn = () => new Date().toISOString(),
  } = {}
) {
  const recordPath = path.join(turnDir, "headless-child.json");
  let provisionalRecord = null;
  let provisionalWritten = false;

  try {
    provisionalRecord = {
      pid: child.pid,
      // Detached children lead a group of the same id; recorded explicitly so
      // a sweeper does not have to infer the convention.
      pgid: platform === "win32" ? null : child.pid,
      // Diagnostic and negative cross-check only. Without start_time this can
      // never authorize a kill, because a recycled pid may run the same command.
      command,
      started_at: nowFn(),
    };
    writeHeadlessChildRecordAtomic(recordPath, provisionalRecord);
    provisionalWritten = true;
  } catch {
    // Best-effort breadcrumb; a turn must not fail because it could not be left.
  }

  let startTime = null;
  if (Number.isSafeInteger(child?.pid) && child.pid > 0) {
    try {
      const captured = processStartTimeFn(child.pid);
      startTime = typeof captured === "string" && captured ? captured : null;
    } catch {
      // An unreadable identity remains null and therefore cannot authorize a
      // later kill. Still persist the breadcrumb so a sweep retains evidence.
    }
  }

  if (startTime && provisionalWritten) {
    try {
      // What distinguishes one PID N from the next -- imperfectly on POSIX,
      // where `ps -o lstart=` formats to seconds, but precisely on native
      // Windows where CIM CreationDate is invariant UTC .NET ticks. Replace the
      // complete provisional JSON atomically so a crash sees either safe form,
      // never a truncated identity that could authorize the wrong process.
      writeHeadlessChildRecordAtomic(recordPath, {
        ...provisionalRecord,
        start_time: startTime,
      });
    } catch {
      // Retain the provisional record. It cannot authorize a kill, but it keeps
      // the child visible for later diagnosis/reconciliation.
    }
  }
  return startTime;
}

let headlessChildRecordWriteSequence = 0;

function writeHeadlessChildRecordAtomic(recordPath, record) {
  const tmpPath =
    `${recordPath}.${process.pid}.${Date.now()}.` +
    `${headlessChildRecordWriteSequence++}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), { flag: "wx" });
  try {
    fs.renameSync(tmpPath, recordPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
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
  // "absent" and "not-ours" are BOTH negative, and collapsing them is a bug in
  // both directions. Absent means the leader is gone, which is the whole
  // premise of the group check that follows -- its descendants may still be
  // running. Not-ours means a live process was inspected and disqualified, and
  // that verdict is final: re-asking the group about the very same pid would
  // hand back a second opinion on a question already settled.
  if (!Number.isSafeInteger(pid) || pid <= 0) return "absent";
  if (!isProcessAlive(pid)) return "absent";

  // Strongest available signal: PID plus OS start time.
  if (record.start_time) {
    const current = processStartTime(pid);
    if (!current) return "unknown"; // the OS identity probe is unavailable or denied
    if (current !== record.start_time) return "not-ours";

    // A start-time match is the authorization. The command line is consulted
    // only as a NEGATIVE discriminator on top of it -- never as identity, since
    // a wrapper or exec can legitimately change argv, and matching "node"
    // proves nothing. Used one-directionally like this it can only narrow the
    // same-birth-second residual above: a definitive mismatch downgrades to
    // "not ours", which declines to kill. That errs toward leaving an orphan
    // rather than signalling a stranger, which is the correct direction for a
    // best-effort sweep.
    const commandLine = readProcessCommandLine(pid);
    if (commandLine && typeof record.command === "string" && record.command) {
      if (!commandLine.includes(record.command)) return "not-ours";
    }
    return "yes";
  }

  // Older record with no start time. The command name alone cannot authorize a
  // kill -- a stale "node" record would match any later node process -- so the
  // most this can produce is "cannot tell".
  const commandLine = readProcessCommandLine(pid);
  if (!commandLine) return "unknown";
  return typeof record.command === "string" && commandLine.includes(record.command)
    ? "unknown"
    : "not-ours";
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
 * kill either. The only discriminator that survives scrutiny is the LEADER's
 * birth time, compared against the record's -- not member ages. "A recycled
 * group is made of processes older than the record" was the earlier rule here
 * and it is false in the direction that matters: a group recycled after the
 * record was written contains members strictly NEWER than it, so age-based
 * reasoning authorizes killing strangers.
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
  // A process's pgid equals its own pid exactly when it leads the group, so:
  //
  //   leader present -> this may be a new group wearing our number. Its start
  //                     time settles it, and a mismatch means "not ours".
  //   leader absent  -> UNPROVABLE. See below.
  //
  // "Any member newer than the record" was the obvious rule and it is wrong in
  // exactly the direction that matters: every member of a recycled group is
  // newer than an old record, so it authorizes killing strangers.
  const leader = members.find((member) => member.pid === pgid);
  if (leader) {
    if (!record.start_time) return "unknown";
    return leader.startTime === record.start_time ? "yes" : "no";
  }

  // A leaderless group used to return "yes" here, justified by POSIX fork()
  // ("The child process ID also shall not match any active process group ID")
  // plus §3.283 on group lifetime. That argument is WRONG, and this sequence is
  // the counterexample -- every step of it legal:
  //
  //   1. our group N loses its last member, so group N stops being active,
  //      while headless-child.json survives because the runner died first;
  //   2. PID N is now allocatable. An unrelated process takes it and leads a
  //      NEW group N;
  //   3. that leader exits, leaving its own descendants behind;
  //   4. group N now has members and no leader -- and none of them are ours.
  //
  // The fork() rule only reserves N while some group N is ACTIVE. A stale JSON
  // record does not keep a group active, and a newly created group going
  // leaderless is ordinary. So "leader absent" proves nothing about ownership,
  // and there is no birth time left to compare because the process that had one
  // is gone.
  //
  // "unknown" therefore: retain the record, signal nothing. That leaks a
  // genuinely orphaned descendant rather than risking an unrelated one, which
  // is the only defensible default when the evidence cannot distinguish them.
  // Recovering those descendants needs an identity the kernel owns -- a dualog
  // supervisor that stays group leader while any CLI descendant lives, or a
  // cgroup -- not a sharper reading of the standard.
  return "unknown";
}

/**
 * Combined verdict for a record: is there anything left to kill, and may we?
 */
function identifyRecordedProcess(record) {
  const leader = identifyRecordedLeader(record);
  if (leader === "yes") return "yes";

  // A live leader that was INSPECTED AND DISQUALIFIED is final, and must not be
  // re-litigated by the group check.
  //
  // On the ordinary Unix shape the recorded pid and pgid are the same number,
  // so identifyRecordedGroup() finds that very process as the group leader and
  // authorizes on its start time alone -- silently overriding the command-line
  // mismatch that just disqualified it. The group check exists to find
  // DESCENDANTS of a leader we can no longer see, not to give a second opinion
  // on the leader itself.
  //
  // "absent" is the opposite case and must fall through: a leader that is gone
  // is the entire premise of asking about its group.
  if (leader === "not-ours") return "no";

  const group = identifyRecordedGroup(record);
  if (group === "yes") return "yes";
  if (leader === "unknown" || group === "unknown") return "unknown";
  return "no";
}

/**
 * Terminate any headless partner process this session recorded and never reaped.
 *
 * A record only survives a turn that did not finish: persistHeadlessChildRecord() is
 * cleared on every normal exit, and the runner's signal handlers call
 * terminateActiveHeadlessTurnsAndWait() on SIGTERM/SIGINT. What is left is the SIGKILL
 * case -- no handler runs, and the child is left with no handle anywhere -- plus
 * a runner that crashed hard enough to skip its own cleanup.
 *
 * PID reuse is the hazard that shapes this, and the proof is BIRTH TIME, not a
 * command line. A recorded pid is signalled only when the live process's
 * `lstart` equals the one captured at spawn; the command line is consulted
 * afterwards purely as a negative discriminator, because argv is mutable and a
 * match proves nothing. (An earlier version of this comment claimed "no
 * command-line match, no signal", which described neither the code nor a sound
 * rule.)
 *
 * A record we cannot classify is RETAINED, not forgotten -- discarding it
 * throws away the only handle to a possibly-live orphan. It is dropped only
 * once its group is proven gone.
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
      const terminated = await terminateProcessTree(handle, { graceMs, pollMs });
      signalled += 1;

      if (!terminated || isProcessTreeAlive(handle)) {
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
function clearChildRecordIfGroupGone(turnDir, child) {
  // On Windows `close` belongs to the cmd.exe wrapper. If taskkill failed, its
  // absence cannot prove the Claude/Codex descendant is gone, so retain the
  // breadcrumb for diagnosis and a later conservative sweep.
  if (
    process.platform === "win32" &&
    child?.[WINDOWS_TREE_TERMINATION]?.status === "failed"
  ) {
    return;
  }
  if (isProcessTreeAlive(child)) return;
  clearChildRecord(turnDir);
}
