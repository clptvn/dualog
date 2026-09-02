// Per-turn runtime leases.
//
// The headline property is the last test in this file: a partner's credentials
// land in the lease and NOT in the session directory. Everything above it exists
// to make that safe -- because the moment credentials live somewhere disposable,
// something has to decide when to dispose of them, and that decision is made
// against a live process.
//
// So the cases here are written from the deletion side. Every state of the
// machine is checked for what it authorizes, and the bias is uniform: anything
// that cannot be proven finished is RETAINED. A stale credential copy costs disk;
// deleting a home out from under a running CLI breaks a turn and can destroy
// refreshed tokens.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crossSpawn from "cross-spawn";

import { managedSession } from "./helpers/session.mjs";

const { home: ROOT, dir: SESSION_DIR } = managedSession("lease");

const {
  allocateLease,
  bootIdentity,
  isSameBoot,
  leasePath,
  probeLeaseConsumer,
  proveLeaseReleasable,
  readTurnLease,
  releaseLease,
  removeLeaseDirectory,
  sweepLeases,
  transitionLease,
} = await import("../src/runtime-lease.mjs");
const { assertManagedLeasePath, runtimeDir } = await import("../src/platform.mjs");
const { processStartTime } = await import("../src/process-probe.mjs");

// Most lease-state tests need one deterministic fact from tmux: the synthetic
// session name is absent. They still exercise the real exact-route boundary --
// launcher, transport, distro, control binary, and socket must all match before
// this process call is reached -- but do not require native Windows to provide
// a tmux binary it cannot have. The dedicated lifecycle test below restores the
// operator/default binary and drives a real POSIX tmux server.
const ORIGINAL_TMUX_BINARY = process.env.DUALOG_TMUX_BINARY;
const FIXTURE_TMUX_BINARY = path.join(
  ROOT,
  process.platform === "win32" ? "tmux-fixture.exe" : "tmux-fixture"
);
const ORIGINAL_CROSS_SPAWN_SYNC = crossSpawn.sync;
process.env.DUALOG_TMUX_BINARY = FIXTURE_TMUX_BINARY;
crossSpawn.sync = (command, args, options) => {
  if (
    command === FIXTURE_TMUX_BINARY &&
    Array.isArray(args) &&
    args.includes("has-session")
  ) {
    const target = args[args.indexOf("-t") + 1] || "=fixture";
    return {
      pid: 0,
      output: [null, "", `can't find session: ${target}`],
      stdout: "",
      stderr: `can't find session: ${target}`,
      status: 1,
      signal: null,
    };
  }
  return ORIGINAL_CROSS_SPAWN_SYNC(command, args, options);
};

const UNKNOWN_DIRECTORY_USAGE = /whether this directory is in use could not be determined/u;

function releaseAllowingUnknownDirectory(lease) {
  try {
    return releaseLease(lease);
  } catch (error) {
    if (!UNKNOWN_DIRECTORY_USAGE.test(String(error?.message || error))) throw error;
    assert.equal(
      fs.existsSync(lease.dir),
      true,
      "an unanswerable directory-usage probe must fail before deletion"
    );
    return { released: false, reason: String(error.message) };
  }
}

function releasedOrRetainedUnknown(t, lease, result, successOnlyDescription) {
  if (result.released === true) return true;
  assert.match(result.reason, UNKNOWN_DIRECTORY_USAGE);
  assert.equal(fs.existsSync(lease.dir), true, "unknown directory usage must retain the lease");
  t.diagnostic(`${successOnlyDescription} requires a host that can prove the lease is free`);
  return false;
}

function sweepRemovedOrRetainedUnknown(t, lease, receipt, successOnlyDescription) {
  const removed = receipt.removed.find((entry) => entry.dir === lease.dir);
  const retained = receipt.retained.find((entry) => entry.dir === lease.dir);
  assert.notEqual(
    Boolean(removed),
    Boolean(retained),
    "a sweep must report the lease exactly once as removed or retained"
  );
  if (removed) return removed;
  assert.match(retained.reason, UNKNOWN_DIRECTORY_USAGE);
  assert.equal(fs.existsSync(lease.dir), true, "unknown directory usage must retain the lease");
  t.diagnostic(`${successOnlyDescription} requires a host that can prove the lease is free`);
  return null;
}

let turnCounter = 0;
function freshTurnDir() {
  const dir = path.join(SESSION_DIR, "turns", `turn-${++turnCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newLease(overrides = {}) {
  return allocateLease({
    sessionId: path.basename(SESSION_DIR),
    turnId: `turn-${turnCounter}`,
    agent: "codex",
    engine: "tmux-interactive",
    turnDir: freshTurnDir(),
    ...overrides,
  });
}

function meta(lease) {
  return JSON.parse(fs.readFileSync(lease.metaPath, "utf-8"));
}

function localTmuxIdentity() {
  const launcher = process.env.DUALOG_TMUX_BINARY?.trim() || "tmux";
  const socket =
    process.env.DUALOG_TMUX_SOCKET?.trim() ||
    process.env.CODEX_DIALOG_TMUX_SOCKET?.trim() ||
    process.env.CONDUCTOR_TMUX_SOCKET?.trim() ||
    "dualog";
  return {
    tmux_transport: "local",
    tmux_distro: null,
    tmux_launcher: launcher,
    tmux_control_binary: launcher,
    tmux_socket_name: socket,
  };
}

/**
 * A previous boot, expressed the only way that may authorize deletion.
 *
 * Wall-clock arithmetic is no longer allowed to answer "different boot": a
 * suspend or an NTP step moves it, and that verdict releases leases. So a test
 * that wants a previous boot has to produce a PRECISE identity with a different
 * id, exactly as a real reboot would.
 */
function previousBoot() {
  const current = bootIdentity();
  if (!current?.precise) return null;
  return { ...current, id: `${current.id}-previous` };
}

/**
 * Only a host with a precise identity can express "a previous boot" at all.
 *
 * That is the design, not a test limitation: a mixed or wall-clock comparison
 * resolves to `null`, so on such a host an identity-less lease is retained
 * rather than healed. Cases that assert healing therefore have to establish
 * precision first -- and this is not merely theoretical, because the sysctl
 * probe can time out under a fully parallel test run, which is exactly how this
 * suite first went intermittently red.
 */
function requirePreciseBoot(t) {
  const boot = previousBoot();
  if (!boot) t.skip("this host has no precise boot identity, so nothing can heal");
  return boot;
}

function installCleanupClaim(
  lease,
  {
    ownerPid,
    ownerStartTime,
    boot = bootIdentity(),
    token = crypto.randomBytes(16).toString("hex"),
    value = {},
  }
) {
  const claimPath = `${lease.dir}.cleanup.claim`;
  fs.mkdirSync(claimPath, { mode: 0o700 });
  fs.chmodSync(claimPath, 0o700);
  fs.writeFileSync(
    path.join(claimPath, "claim.json"),
    JSON.stringify({
      claim_schema_version: 1,
      lease_id: lease.id,
      token,
      owner_pid: ownerPid,
      owner_start_time: ownerStartTime,
      boot,
      claimed_at: new Date().toISOString(),
      ...value,
    }),
    { mode: 0o600 }
  );
  return { claimPath, token, archivedPath: `${claimPath}.stale-${token}` };
}

function cleanupClaimArtifacts(lease) {
  const prefix = `${path.basename(lease.dir)}.cleanup.claim`;
  for (const entry of fs.readdirSync(runtimeDir())) {
    if (entry === prefix || entry.startsWith(`${prefix}.`)) {
      fs.rmSync(path.join(runtimeDir(), entry), { recursive: true, force: true });
    }
  }
}

function cleanupLeaseFamilyArtifacts(lease) {
  for (const entry of fs.readdirSync(runtimeDir())) {
    if (!entry.endsWith(".lease.json")) continue;
    const target = path.join(runtimeDir(), entry);
    try {
      const value = JSON.parse(fs.readFileSync(target, "utf-8"));
      if (value.lease_id !== lease.id && value.release_generation !== lease.id) continue;
      const owner = path.join(runtimeDir(), entry.slice(0, -".lease.json".length));
      fs.rmSync(owner, { recursive: true, force: true });
      fs.rmSync(target, { force: true });
    } catch {}
  }
  fs.rmSync(lease.dir, { recursive: true, force: true });
  fs.rmSync(lease.metaPath, { force: true });
  cleanupClaimArtifacts(lease);
}

/** A process that is genuinely alive for the duration of one test. */
function liveProcess(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  });
  return child.pid;
}

// --- allocation ---------------------------------------------------------------

test("a lease is created private, attributable, and pointed at before anything is copied", () => {
  const turnDir = freshTurnDir();
  const lease = allocateLease({
    sessionId: path.basename(SESSION_DIR),
    turnId: "turn-alloc",
    agent: "codex",
    engine: "tmux-interactive",
    turnDir,
  });

  assert.equal(path.dirname(lease.dir), path.resolve(runtimeDir()));
  assert.match(path.basename(lease.dir), /^[0-9a-f]{32}$/);

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(lease.dir).mode & 0o777, 0o700, "lease directory must be private");
    assert.equal(fs.statSync(lease.metaPath).mode & 0o777, 0o600, "metadata must be private");
    assert.equal(fs.statSync(runtimeDir()).mode & 0o777, 0o700, "runtime root must be private");
  }

  // Attributable BEFORE any secret exists. An unattributable directory holding
  // credentials is the exact state this module exists to prevent.
  const m = meta(lease);
  assert.equal(m.state, "allocated");
  assert.equal(m.session_id, path.basename(SESSION_DIR));
  assert.equal(m.turn_dir, turnDir);
  assert.equal(m.runner_pid, process.pid);
  // `boot` is recorded when it CAN be established. A restricted host raises
  // EPERM from os.uptime(), where null is the documented answer -- asserting a
  // host unconditionally would fail there for the right behaviour.
  assert.ok(m.boot === null || typeof m.boot.host === "string");

  // And discoverable from the durable side by an opaque id, nothing more.
  const pointer = JSON.parse(fs.readFileSync(path.join(turnDir, "runtime-lease.json"), "utf-8"));
  assert.deepEqual(Object.keys(pointer).sort(), ["lease_id", "schema_version"]);
  assert.equal(readTurnLease(turnDir).id, lease.id);
});

test("a turn that already has a lease pointer refuses a second one", () => {
  // Silently overwriting the pointer would orphan the lease it referred to --
  // a credential copy nothing references and nothing will ever reap.
  const turnDir = freshTurnDir();
  const first = newLease({ turnDir });
  const before = fs.readdirSync(runtimeDir()).length;

  assert.throws(() => newLease({ turnDir }), /could not record the lease pointer/);

  assert.equal(readTurnLease(turnDir).id, first.id, "the original pointer is untouched");
  assert.equal(
    fs.readdirSync(runtimeDir()).length,
    before,
    "the rejected lease is rolled back, not left behind"
  );
});

test("a lease path is contained, exactly as a session path is", () => {
  const lease = newLease();
  assert.equal(leasePath(lease, path.join(lease.dir, "codex-home")), path.join(lease.dir, "codex-home"));
  for (const escape of ["..", "../other", "/etc", path.join(lease.dir, "..", "elsewhere")]) {
    assert.throws(
      () => leasePath(lease, path.resolve(lease.dir, escape)),
      /not inside the lease directory|not a valid lease id|direct child/,
      escape
    );
  }
});

test("only a directory the runtime root owns may act as a lease", (t) => {
  // BOTH boundaries, for the same reason sessions check both: "inside the
  // candidate's own lease" alone still lets a caller nominate any directory on
  // the machine as a lease and write a credential home inside it -- which is
  // precisely how a live auth.json reached a repository working tree the last
  // time only one half of this was checked.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-fake-lease-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  assert.throws(
    () => assertManagedLeasePath(outside, path.join(outside, "codex-home")),
    /must be a direct child of/,
    "an arbitrary temp directory is not a lease"
  );
  assert.throws(
    () => assertManagedLeasePath(SESSION_DIR, path.join(SESSION_DIR, "codex-home")),
    /must be a direct child of/,
    "and neither is a session directory"
  );

  // A correctly-rooted directory whose name is not a generated id is also not a
  // lease: the id grammar is what makes removal safe later.
  const misnamed = path.join(runtimeDir(), "not-a-generated-id");
  fs.mkdirSync(misnamed, { recursive: true });
  t.after(() => fs.rmSync(misnamed, { recursive: true, force: true }));
  assert.throws(
    () => assertManagedLeasePath(misnamed, path.join(misnamed, "codex-home")),
    /is not a valid lease id/
  );
});

// --- what each state authorizes ------------------------------------------------

test("a pre-spawn lease is removable only once its owner is gone", (t) => {
  for (const state of ["allocated", "projecting", "ready"]) {
    // The API invariant is that `spawning` is written before any
    // process-creating call, so in these states nothing was ever started. The
    // only thing that can still be using the directory is the owner setting it up.
    const alive = proveLeaseReleasable({ state, runner_pid: liveProcess(t), boot: bootIdentity() });
    assert.equal(alive.removable, false, state);
    assert.match(alive.reason, /still alive/);

    const gone = proveLeaseReleasable({ state, runner_pid: 999999, boot: bootIdentity() });
    assert.equal(gone.removable, true, `${state} with a dead owner`);
  }
});

test("a precise previous boot supersedes a reused owner pid", (t) => {
  const rebooted = requirePreciseBoot(t);
  if (!rebooted) return;
  for (const state of ["allocated", "projecting", "ready"]) {
    const verdict = proveLeaseReleasable({
      state,
      runner_pid: process.pid,
      boot: rebooted,
    });
    assert.equal(verdict.removable, true, `${state}: the prior-boot owner cannot survive`);
  }
});

test("a lease mid-spawn is not mistaken for one whose consumer exited", (t) => {
  const rebooted = requirePreciseBoot(t);
  if (!rebooted) return;
  // FOUND IN REVIEW. The tmux identity is recorded BEFORE startTmuxSession(),
  // so between those two statements the session name is legitimately absent --
  // the pane does not exist YET. Reading that as "the consumer finished" let a
  // concurrent sweep delete the lease, with its freshly seeded credentials,
  // while the partner was still launching against it.
  const spawning = {
    state: "spawning",
    runner_pid: liveProcess(t),
    boot: bootIdentity(),
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-not-created-yet",
    },
  };
  const midSpawn = proveLeaseReleasable(spawning);
  assert.equal(midSpawn.removable, false, "a live runner mid-spawn must keep its lease");
  assert.match(midSpawn.reason, /still spawning/);

  // A DEAD runner with no pane is still not proof, which the first version of
  // this fix got wrong. startTmuxSession() creates the pane via an execFile
  // child that is not the runner and outlives a SIGKILLed one, so both probes
  // read absent while a helper is a millisecond from creating the pane.
  // Deleting there hands the partner a home that no longer exists.
  const crashed = proveLeaseReleasable({ ...spawning, runner_pid: 999999 });
  assert.equal(crashed.removable, false, "a spawn helper may still be in flight on this boot");
  assert.match(crashed.reason, /in flight/);

  // The counterweight, or this would retain forever: no helper and no pane
  // survives a reboot, so a previous boot settles it.
  assert.equal(
    proveLeaseReleasable({
      ...spawning,
      runner_pid: 999999,
      boot: rebooted,
    }).removable,
    true,
    "a previous boot's abandoned spawn is reclaimable"
  );

  // And `active` is unaffected: it is written only after the process-creating
  // call returned, so there the consumer definitely existed.
  assert.equal(
    proveLeaseReleasable({
      state: "active",
      runner_pid: liveProcess(t),
      consumer: {
        kind: "tmux",
        ...localTmuxIdentity(),
        session_name: "dualog-lease-test-no-such-session",
      },
    }).removable,
    true,
    "an active lease whose pane is gone is still removable while its runner lives"
  );
});

test("a lease with a live consumer is never removable", () => {
  const live = { state: "active", consumer: { kind: "headless", pid: process.pid, pgid: process.pid } };
  const verdict = proveLeaseReleasable(live);
  assert.equal(verdict.removable, false);
  assert.match(verdict.reason, /consumer is still running/);
});

test("a headless consumer whose leader died but whose group survives is retained", (t) => {
  // The group is what holds the CLI that has our credentials open. A dead direct
  // child says nothing about a launcher that forked and exited.
  //
  // `detached` is what makes this a real test: an undetached child sits in the
  // RUNNER's process group, so `kill(-pid, 0)` finds no group by that id and the
  // probe correctly answers "absent" -- which would have made this pass against a
  // group check that does not exist. The headless engine spawns detached for
  // exactly this reason, so the fixture has to as well.
  if (process.platform === "win32") {
    t.skip("POSIX process-group fixture; Windows tree-lifecycle proof is covered separately");
    return;
  }
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  });

  const verdict = proveLeaseReleasable({
    state: "active",
    consumer: { kind: "headless", pid: 999999, pgid: child.pid },
  });
  assert.equal(verdict.removable, false, "a surviving group must retain the lease");
  assert.match(verdict.reason, /still running/);
});

test("a precise previous boot supersedes a reused live pid", (t) => {
  const rebooted = requirePreciseBoot(t);
  if (!rebooted) return;
  for (const state of ["spawning", "active"]) {
    const verdict = proveLeaseReleasable({
      state,
      runner_pid: process.pid,
      boot: rebooted,
      consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
    });
    assert.equal(
      verdict.removable,
      true,
      `${state}: a current live process can only be reuse after a precise reboot`
    );
  }
});

test("a closed pane does not prove the partner process exited", (t) => {
  // FOUND IN PRODUCTION. codex flushes its models cache during shutdown, after
  // its pane has closed. Releasing on the tmux session alone therefore deleted
  // the home while the partner was still running, and it recreated the directory
  // on the way out -- an unattributable orphan on every single turn.
  //
  // pane_pid is that process (the shell payload execs into the CLI), so it
  // answers what the session name cannot.
  const shuttingDown = {
    state: "active",
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
      pane_pid: liveProcess(t),
    },
  };
  const verdict = proveLeaseReleasable(shuttingDown);
  assert.equal(verdict.removable, false, "a live pane process must keep the lease");
  assert.match(verdict.reason, /still running/);

  // Once the process is gone, both facts agree and the lease goes.
  assert.equal(
    proveLeaseReleasable({
      ...shuttingDown,
      consumer: { ...shuttingDown.consumer, pane_pid: 999999 },
    }).removable,
    true
  );

  // A record written before pane_pid existed still resolves on the session
  // alone -- the previous behaviour, not a new gap.
  assert.equal(
    proveLeaseReleasable({
      state: "active",
      consumer: {
        kind: "tmux",
        ...localTmuxIdentity(),
        session_name: "dualog-lease-test-no-such-session",
      },
    }).removable,
    true,
    "a legacy record without pane_pid keeps working"
  );

  // And a live SESSION still short-circuits, without needing the pid at all.
  assert.equal(
    proveLeaseReleasable({
      state: "active",
      consumer: { kind: "tmux", session_name: "", pane_pid: 999999 },
    }).removable,
    false
  );
});

test("a WSL tmux consumer is probed only in its recorded distribution", () => {
  let nativePaneCalls = 0;
  let wslPaneCalls = 0;
  const consumer = {
    kind: "tmux",
    session_name: "dlg-wsl-consumer",
    tmux_transport: "wsl",
    tmux_distro: "Ubuntu",
    tmux_launcher: "wsl.exe",
    tmux_control_binary: "tmux",
    tmux_socket_name: "dualog",
    pane_pid: 42,
    pane_started_at: "started",
  };
  const verdict = probeLeaseConsumer(consumer, {
    probeTmuxSessionFn: (sessionName, options) => {
      assert.equal(sessionName, "dlg-wsl-consumer");
      assert.deepEqual(options, {
        transport: "wsl",
        distro: "Ubuntu",
        tmuxLauncher: "wsl.exe",
        tmuxControlBinary: "tmux",
        tmuxSocketName: "dualog",
        requireExactIdentity: true,
        platform: process.platform,
      });
      return "absent";
    },
    probeWslPaneProcessFn: (pid, startedAt, options) => {
      wslPaneCalls += 1;
      assert.equal(pid, 42);
      assert.equal(startedAt, "started");
      assert.deepEqual(options, {
        transport: "wsl",
        distro: "Ubuntu",
        tmuxLauncher: "wsl.exe",
        tmuxControlBinary: "tmux",
        tmuxSocketName: "dualog",
        requireExactIdentity: true,
        platform: process.platform,
      });
      return "alive";
    },
    probeRecordedProcessFn: () => {
      nativePaneCalls += 1;
      return "absent";
    },
  });
  assert.equal(verdict, "alive");
  assert.equal(wslPaneCalls, 1);
  assert.equal(nativePaneCalls, 0);
});

test("a different host or legacy missing route identity can never release a tmux lease", () => {
  const previousSocket = process.env.DUALOG_TMUX_SOCKET;
  process.env.DUALOG_TMUX_SOCKET = "dualog-host-b";
  try {
    const hostA = proveLeaseReleasable({
      state: "active",
      consumer: {
        kind: "tmux",
        session_name: "dualog-lease-test-no-such-session",
        tmux_transport: "local",
        tmux_distro: null,
        tmux_launcher: "tmux",
        tmux_control_binary: "tmux",
        tmux_socket_name: "dualog-host-a",
      },
    });
    assert.equal(hostA.removable, false);
    assert.match(hostA.reason, /could not be probed \(unknown\)/u);

    const legacy = proveLeaseReleasable({
      state: "active",
      consumer: {
        kind: "tmux",
        session_name: "dualog-lease-test-no-such-session",
        tmux_transport: "local",
        tmux_distro: null,
      },
    });
    assert.equal(legacy.removable, false);
    assert.match(legacy.reason, /could not be probed \(unknown\)/u);
  } finally {
    if (previousSocket === undefined) delete process.env.DUALOG_TMUX_SOCKET;
    else process.env.DUALOG_TMUX_SOCKET = previousSocket;
  }
});

test("a reused pid does not keep a lease alive forever", async () => {
  // `kill(pid, 0)` answers "something has this pid", not "the thing I recorded
  // still has it". After a crash and pid reuse, an unrelated long-lived process
  // made an old lease look alive indefinitely -- retaining a credential copy
  // permanently, which is the failure this whole design exists to bound. The
  // recorded generation is what tells the two apart.
  const { processStartTime } = await import("../src/process-probe.mjs");
  const mine = processStartTime(process.pid);
  assert.ok(mine, "this platform must be able to report a process start time");

  for (const consumer of [
    {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
      pane_pid: process.pid,
    },
    { kind: "headless", pid: process.pid, pgid: process.pid },
  ]) {
    // Same pid, the generation we recorded: alive, so the lease is kept.
    const key = consumer.kind === "tmux" ? "pane_started_at" : "started_at";
    assert.equal(
      proveLeaseReleasable({ state: "active", consumer: { ...consumer, [key]: mine } }).removable,
      false,
      `${consumer.kind}: the recorded process is still running`
    );

    // Same pid, a DIFFERENT generation: the pid was reused, so the consumer we
    // recorded is gone and its lease may be reclaimed.
    assert.equal(
      proveLeaseReleasable({
        state: "active",
        consumer: { ...consumer, [key]: "Thu Jan  1 00:00:00 1970" },
      }).removable,
      true,
      `${consumer.kind}: a reused pid must not retain the lease`
    );

    // No generation recorded -- a lease written before this existed -- falls back
    // to the pid alone, which retains. Previous behaviour, not a new gap.
    assert.equal(
      proveLeaseReleasable({ state: "active", consumer }).removable,
      false,
      `${consumer.kind}: a legacy record still resolves on the pid`
    );
  }
});

test("native Windows process generations use a fixed, bounded CIM query", () => {
  const script = `
    const cp = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    const calls = [];
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.SystemRoot = "C:\\\\Windows";
    cp.execFileSync = (file, args, options) => {
      calls.push({ file, args, options: {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        shell: options.shell,
        windowsHide: options.windowsHide,
        stdio: options.stdio,
        probePid: options.env.DUALOG_INTERNAL_PROCESS_PROBE_PID,
      } });
      return "638923456789012345";
    };
    syncBuiltinESMExports();
    import(${JSON.stringify(new URL("../src/process-probe.mjs", import.meta.url).href)}).then((m) => {
      console.log(JSON.stringify({
        pid: process.pid,
        startedAt: m.processStartTime(process.pid),
        same: m.probeRecordedProcess(process.pid, "638923456789012345"),
        reused: m.probeRecordedProcess(process.pid, "638923456789012346"),
        calls,
      }));
    });
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.equal(out.startedAt, "638923456789012345");
  assert.equal(out.same, "alive");
  assert.equal(out.reused, "absent");
  assert.equal(out.calls.length, 3);
  for (const call of out.calls) {
    assert.equal(
      call.file.toLowerCase(),
      "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe"
    );
    assert.deepEqual(call.args.slice(0, 4), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    assert.match(call.args[4], /Get-CimInstance -ClassName Win32_Process/u);
    assert.match(call.args[4], /CreationDate/u);
    assert.match(call.args[4], /\$PSModuleAutoloadingPreference = 'None'/u);
    assert.match(
      call.args[4],
      /\[IO\.Path\]::Combine\(\$PSHOME, 'Modules', 'CimCmdlets', 'CimCmdlets\.psd1'\)/u
    );
    assert.match(call.args[4], /Microsoft\.PowerShell\.Core\\Import-Module/u);
    assert.match(call.args[4], /CimCmdlets\\Get-CimInstance/u);
    assert.doesNotMatch(call.args[4], /(?:^|[;\s])Get-CimInstance(?:\s|$)/u);
    assert.match(call.args[4], /\[uint32\]\$processId/u);
    assert.match(call.args[4], /\[uint32\]::TryParse/u);
    assert.equal(call.options.probePid, String(out.pid));
    assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.stdio, ["ignore", "pipe", "ignore"]);
  }
});

test("native Windows rejects malformed process generation output", () => {
  const script = `
    const cp = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.SystemRoot = "C:\\\\Windows";
    cp.execFileSync = () => "638923456789012345\\nforged";
    syncBuiltinESMExports();
    import(${JSON.stringify(new URL("../src/process-probe.mjs", import.meta.url).href)}).then((m) => {
      console.log(JSON.stringify({
        startedAt: m.processStartTime(process.pid),
        verdict: m.probeRecordedProcess(process.pid, "638923456789012345"),
      }));
    });
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.equal(out.startedAt, null);
  assert.equal(out.verdict, "alive", "unverifiable generation must retain");
});

test("native Windows rejects impossible process ids before launching PowerShell", () => {
  const script = `
    const cp = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    const calls = [];
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.SystemRoot = "C:\\\\Windows";
    cp.execFileSync = (file, args, options) => {
      calls.push({ file, args, probePid: options.env.DUALOG_INTERNAL_PROCESS_PROBE_PID });
      return "638923456789012345";
    };
    syncBuiltinESMExports();
    import(${JSON.stringify(new URL("../src/process-probe.mjs", import.meta.url).href)}).then((m) => {
      const invalid = [-1, 0, 1.5, Number.NaN, 4294967296, Number.MAX_SAFE_INTEGER]
        .map((pid) => m.processStartTime(pid));
      const unsigned = m.processStartTime(4294967295);
      console.log(JSON.stringify({ invalid, unsigned, calls }));
    });
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.deepEqual(out.invalid, [null, null, null, null, null, null]);
  assert.equal(out.unsigned, "638923456789012345");
  assert.equal(out.calls.length, 1, "an impossible PID must never reach the identity command");
  assert.equal(out.calls[0].probePid, "4294967295");
  assert.match(out.calls[0].args[4], /\[uint32\]\$processId/u);
  assert.match(out.calls[0].args[4], /\[uint32\]::TryParse/u);
});

test("a generation that cannot be read retains, rather than reading as reuse", () => {
  // The reuse check needs `ps` or Windows CIM. Where that is unavailable -- a
  // restricted host or stripped container -- an unreadable generation must NOT
  // be taken as proof the pid was recycled, because that verdict deletes a live
  // partner's home.
  // Unverifiable resolves to "still running", the same direction every other
  // unknown in this module takes.
  const script = `
    if (process.platform === "win32") process.env.SystemRoot = "";
    else process.env.PATH = "";
    import(${JSON.stringify(new URL("../src/process-probe.mjs", import.meta.url).href)}).then((m) => {
      console.log(JSON.stringify({
        startTime: m.processStartTime(process.pid),
        verdict: m.probeRecordedProcess(process.pid, "Thu Jan  1 00:00:00 1970"),
      }));
    });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim());
  assert.equal(out.startTime, null, "precondition: the OS generation source must be unreachable");
  assert.equal(out.verdict, "alive", "an unverifiable generation must not authorize deletion");
});

test("a pane we could not identify is not the same as one that never had an identity", () => {
  // Both record `pane_pid: null`, and they mean opposite things.
  //
  // A record written BEFORE pane identities existed falls back to the session
  // name -- the behaviour it was written under. A pane we KNOW existed and
  // merely failed to identify must not do that, because session absence has
  // never proven the process exited: that is the production incident, and it
  // needs no descendant and no setsid() to happen.
  const unidentified = proveLeaseReleasable({
    state: "active",
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
      pane_pid: null,
      pane_pid_unavailable: true,
    },
  });
  assert.equal(unidentified.removable, false, "an unidentified pane must retain its lease");
  assert.match(unidentified.reason, /could not be probed/);

  const legacy = proveLeaseReleasable({
    state: "active",
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
      pane_pid: null,
    },
  });
  assert.equal(legacy.removable, true, "a pre-pane_pid record still resolves on the session");
});

test("a lease whose consumer is proven absent is removable", () => {
  assert.equal(
    proveLeaseReleasable({
      state: "active",
      consumer: { kind: "headless", pid: 999999, pgid: 999999 },
    }).removable,
    true
  );
  assert.equal(
    proveLeaseReleasable({
      state: "active",
      consumer: {
        kind: "tmux",
        ...localTmuxIdentity(),
        session_name: "dualog-lease-test-no-such-session",
      },
    }).removable,
    true
  );
});

test("a consumer record with no usable identity retains, and heals on reboot", (t) => {
  const rebooted = requirePreciseBoot(t);
  if (!rebooted) return;
  // A record is written BEFORE the thing it describes exists, so "there is a
  // consumer object" and "there is something to probe" are different questions.
  // Conflating them left a kind-only headless record -- what the headless engine
  // writes before spawn() -- probing `unknown` forever: it never reached the
  // boot check, so it survived reboots and any host without a boot identity.
  for (const consumer of [
    { kind: "tmux", session_name: "" },
    { kind: "headless", pid: null, pgid: null },
    { kind: "headless" },
    { kind: "something-a-future-version-writes" },
  ]) {
    const onThisBoot = proveLeaseReleasable({ state: "spawning", consumer, boot: bootIdentity() });
    assert.equal(onThisBoot.removable, false, JSON.stringify(consumer));

    // ...but it is now reachable by the boot check, which is what makes the
    // conservative retention self-healing rather than permanent.
    assert.equal(
      proveLeaseReleasable({
        state: "spawning",
        consumer,
        boot: rebooted,
      }).removable,
      true,
      `${JSON.stringify(consumer)} must be reclaimable after a reboot`
    );
  }
});

test("the identity-less spawning window retains on this boot and heals on the next", (t) => {
  const rebooted = requirePreciseBoot(t);
  if (!rebooted) return;
  // There is no portable proof that spawn() did not happen, so a lease that
  // crashed here must be kept.
  const thisBoot = proveLeaseReleasable({ state: "spawning", consumer: null, boot: bootIdentity() });
  assert.equal(thisBoot.removable, false);
  assert.match(thisBoot.reason, /a spawn may have begun/);

  // But nothing that lease started can outlive a reboot, which is what stops
  // conservative retention from being permanent.
  const afterReboot = proveLeaseReleasable({
    state: "spawning",
    consumer: null,
    boot: rebooted,
  });
  assert.equal(afterReboot.removable, true);

  // A lease from another machine is not ours to reason about at all -- so it is
  // UNKNOWN, and unknown retains. This used to answer "removable", which reads a
  // foreign record as permission to delete; on a synced or shared home that is a
  // deletion authorized by a fact about someone else's machine.
  const otherHost = proveLeaseReleasable({
    state: "spawning",
    consumer: null,
    boot: { host: "some-other-host", id: "boot-elsewhere", precise: true },
  });
  assert.equal(otherHost.removable, false, "another host's record establishes nothing about ours");

  // And a HOSTNAME RENAME is not a reboot: boot_id and kern.boottime are
  // untouched by one, so the id has to decide before the host is consulted.
  const currentBoot = bootIdentity();
  if (currentBoot?.precise) {
    assert.equal(
      proveLeaseReleasable({
        state: "spawning",
        consumer: null,
        boot: { ...currentBoot, host: `${currentBoot.host}-renamed` },
      }).removable,
      false,
      "a renamed host with the same boot id is still this boot"
    );
  }

  // And no boot identity at all is not evidence of anything.
  const noBoot = proveLeaseReleasable({ state: "spawning", consumer: null, boot: null });
  assert.equal(noBoot.removable, false);
  assert.match(noBoot.reason, /no usable boot identity/);
});

test("boot identity is stable within one boot", () => {
  assert.equal(isSameBoot(bootIdentity()), true);
  assert.equal(isSameBoot(null), null);
  // A precise identity with a different id is a reboot. A wall-clock epoch far
  // in the past is NOT -- it is equally consistent with a clock correction, and
  // `false` is the verdict that deletes.
  assert.equal(isSameBoot(previousBoot() ?? bootIdentity()), previousBoot() ? false : true);
  assert.equal(isSameBoot({ host: os.hostname(), bootedAtEpoch: 1 }), null);
});

test("a state this version does not understand blocks", () => {
  for (const state of ["paused", null, 42, undefined]) {
    const verdict = proveLeaseReleasable({ state });
    assert.equal(verdict.removable, false, JSON.stringify(state));
    assert.match(verdict.reason, /not one this version understands/);
  }
  assert.equal(proveLeaseReleasable(null).removable, false);
});

test("a symlinked managed ROOT is refused, not just a symlinked leaf", () => {
  // FOUND IN REVIEW, and the same defect as the symlinked session directory
  // fixed previously -- one level up. assertNoSymlinkComponents() walks DOWNWARD
  // from the session or lease directory, so neither root was ever inspected;
  // `path.resolve` does not resolve links and the parent comparison is a string
  // test. Planting `~/.dualog/runtime` as a link was accepted and writes landed
  // in the link target.
  const script = `
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-rootlink-"));
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-victim-"));
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.HOMEDRIVE = ""; process.env.HOMEPATH = home;
    import(${JSON.stringify(new URL("../src/platform.mjs", import.meta.url).href)}).then((m) => {
      const out = [];
      // Both roots, and both SHAPES: the root itself linked, and an ANCESTOR of
      // it linked with a real directory inside. The second is what the component
      // walk is for -- checking only the root would pass a real runtime
      // directory sitting inside a symlinked .dualog one.
      for (const [label, rootRel, leafName, linkAt] of [
        ["runtime", path.join(".dualog", "runtime"), "a".repeat(32), path.join(".dualog", "runtime")],
        ["sessions", path.join(".dualog", "sessions"), "dialog-x-0000", path.join(".dualog", "sessions")],
        ["runtime-via-ancestor", path.join(".dualog", "runtime"), "a".repeat(32), ".dualog"],
        ["sessions-via-ancestor", path.join(".dualog", "sessions"), "dialog-x-0000", ".dualog"],
      ]) {
        // Each case starts from a clean ~/.dualog: an earlier case leaves it
        // behind as a real directory, and the ancestor cases need to put a link
        // exactly where that directory is.
        const dualog = path.join(home, ".dualog");
        if (fs.existsSync(dualog) || fs.lstatSync(dualog, { throwIfNoEntry: false })) {
          const st = fs.lstatSync(dualog, { throwIfNoEntry: false });
          if (st && st.isSymbolicLink()) fs.unlinkSync(dualog);
          else if (st) fs.rmSync(dualog, { recursive: true, force: true });
        }
        const root = path.join(home, rootRel);
        const link = path.join(home, linkAt);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        // A junction is still reported as a symbolic link by lstat, but unlike
        // a Windows directory symlink it does not require Developer Mode.
        fs.symlinkSync(
          victim,
          link,
          process.platform === "win32" ? "junction" : "dir"
        );
        fs.mkdirSync(root, { recursive: true });
        const container = path.join(root, leafName);
        fs.mkdirSync(container, { recursive: true });
        const assertFn = label.startsWith("runtime")
          ? m.assertManagedLeasePath
          : m.assertManagedSessionPath;
        try {
          assertFn(container, path.join(container, "codex-home"));
          out.push({ label, refused: false });
        } catch (err) {
          out.push({ label, refused: true, message: err.message.split("\\n")[0] });
        }
        // unlink, NOT rm: the link must go, its target must not.
        fs.unlinkSync(link);
        for (const leftover of fs.readdirSync(victim)) {
          fs.rmSync(path.join(victim, leftover), { recursive: true, force: true });
        }
      }
      // The whole point -- the victim must still be there, and empty of ours
      // only if the assertion refused before anything was created.
      out.push({ victimSurvives: fs.existsSync(victim) });
      console.log(JSON.stringify(out));
    });
  `;
  const stdout = execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" });
  const results = JSON.parse(stdout.trim());
  const roots = results.filter((r) => r.label);
  assert.equal(roots.length, 4, "both roots, linked directly and via an ancestor");
  for (const r of roots) {
    assert.equal(r.refused, true, `a symlinked ${r.label} root must be refused`);
    assert.match(r.message, /symbolic link/, r.label);
  }
  assert.equal(results.at(-1).victimSurvives, true, "the link target is never touched");
});

test("allocation refuses a symlinked runtime root, before and after its mkdir", () => {
  // allocateLease() mkdirs the root itself with `recursive: true`, which follows
  // whatever it finds -- so the per-path assertions could not have protected it.
  // Validated before the mkdir, and again after: those are two syscalls, and a
  // root swapped in between would already have been followed. Node exposes no
  // openat/O_NOFOLLOW, so the second check makes the swap detectable before
  // anything is written INTO the root rather than closing the window outright.
  const script = `
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-alloclink-"));
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-allocvictim-"));
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.HOMEDRIVE = ""; process.env.HOMEPATH = home;
    // The link goes at .dualog, NOT at .dualog/runtime, so that the
    // \`recursive: true\` mkdir would actually CREATE runtime/ inside the target.
    // Linking the leaf directly makes the mkdir a no-op and the test then passes
    // whether or not the pre-check exists.
    fs.symlinkSync(
      victim,
      path.join(home, ".dualog"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const turnDir = path.join(os.tmpdir(), "dualog-alloc-turn-" + process.pid);
    fs.mkdirSync(turnDir, { recursive: true });
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      let refused = false, message = null;
      try {
        m.allocateLease({ sessionId: "dialog-x-0000", turnId: "t1", agent: "codex", turnDir });
      } catch (err) { refused = true; message = err.message.split("\\n")[0]; }
      console.log(JSON.stringify({
        refused,
        message,
        victimIsEmpty: fs.readdirSync(victim).length === 0,
      }));
    });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim());
  assert.equal(out.refused, true, "a symlinked runtime root must refuse allocation");
  assert.match(out.message, /symbolic link/);
  assert.equal(out.victimIsEmpty, true, "and nothing may be created in the link target");
});

test("the sweep refuses to enumerate a symlinked runtime root", () => {
  // The sweep DELETES directory trees. Following a linked root would let it
  // reap whatever the link points at, judging each entry only by whether it
  // looks like a lease -- so this is the most dangerous place the root check
  // could have been missing.
  const script = `
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-sweeplink-"));
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-sweepvictim-"));
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.HOMEDRIVE = ""; process.env.HOMEPATH = home;
    // A directory in the victim that looks exactly like a reapable lease.
    const decoy = path.join(victim, "b".repeat(32));
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "lease.json"), JSON.stringify({
      schema_version: 1, state: "active", consumer: { kind: "headless", pid: 999999, pgid: 999999 },
    }));
    fs.mkdirSync(path.join(home, ".dualog"), { recursive: true });
    fs.symlinkSync(
      victim,
      path.join(home, ".dualog", "runtime"),
      process.platform === "win32" ? "junction" : "dir"
    );
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const receipt = m.sweepLeases({ apply: true });
      console.log(JSON.stringify({
        removed: receipt.removed.length,
        errors: receipt.errors.map((e) => e.error.split("\\n")[0]),
        decoySurvives: fs.existsSync(decoy),
      }));
    });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim());
  assert.equal(out.removed, 0, "a linked root must yield no removals");
  assert.equal(out.decoySurvives, true, "and nothing behind the link may be deleted");
  assert.match(out.errors.join(" "), /symbolic link/);
});

test("boot identity prefers what the OS tracks over wall-clock arithmetic", () => {
  const identity = bootIdentity();
  assert.ok(identity, "this host must be able to identify its boot");
  assert.equal(typeof identity.host, "string");

  // Every supported host exposes a real boot identity -- /proc/.../boot_id on
  // Linux, kern.boottime on macOS, and CIM LastBootUpTime on Windows -- so a
  // wall-clock fallback here is a regression, not an environment difference.
  if (["linux", "darwin", "win32"].includes(process.platform)) {
    assert.equal(identity.precise, true, `${process.platform} must yield a precise boot identity`);
    assert.ok(
      ["boot-id", "kern.boottime", "win32.last-boot-up-time"].includes(identity.source),
      `unexpected boot identity source: ${identity.source}`
    );
  }

  if (identity.precise) {
    // Exact, so two identities compare by value and an NTP correction cannot
    // make one boot look like two.
    assert.ok(identity.id, "a precise identity must carry an id");
    assert.equal(isSameBoot({ ...identity }), true);
    assert.equal(isSameBoot({ ...identity, id: `${identity.id}-different` }), false);
  }

  // Whatever the source, the wall-clock epoch is carried too -- a lease recorded
  // before precise identities existed has only that field, and without a
  // counterpart to compare against it would answer `null` forever and never heal.
  assert.ok(Number.isFinite(identity.bootedAtEpoch));
  assert.equal(
    isSameBoot({ host: identity.host, bootedAtEpoch: identity.bootedAtEpoch }),
    true,
    "a legacy record from this boot must still resolve as this boot"
  );

  // AND the tolerance has to absorb a clock correction. At 120s it did not: a
  // suspend or an NTP step made a live lease look like a previous boot, which is
  // the verdict that authorizes deletion.
  assert.equal(
    isSameBoot({ host: identity.host, bootedAtEpoch: identity.bootedAtEpoch - 600 }),
    true,
    "ten minutes of clock movement is not a reboot"
  );
  assert.equal(
    isSameBoot({ host: identity.host, bootedAtEpoch: 1 }),
    null,
    "an ancient wall-clock epoch establishes nothing; only a precise id may say 'reboot'"
  );
  if (identity.precise) assert.equal(isSameBoot(previousBoot()), false, "a precise mismatch does say it");

  // A hostname change without a reboot -- a DHCP lease -- must not read as one.
  assert.equal(
    isSameBoot({ host: `${identity.host}-renamed`, bootedAtEpoch: identity.bootedAtEpoch }),
    null
  );
});

test("native Windows boot identity uses a fixed CIM query and strict output", () => {
  const script = `
    const fs = require("node:fs"), cp = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    const originalReadFileSync = fs.readFileSync;
    const calls = [];
    let procReads = 0;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.SystemRoot = "C:\\\\Windows";
    fs.readFileSync = (target, ...args) => {
      if (String(target) === "/proc/sys/kernel/random/boot_id") {
        procReads += 1;
        throw new Error("the Windows source must not probe Linux boot_id");
      }
      return originalReadFileSync(target, ...args);
    };
    cp.execFileSync = (file, args, options) => {
      calls.push({ file, args, options });
      if (!String(file).endsWith("\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe")) {
        throw new Error("unexpected executable: " + file);
      }
      return "638923456789012345";
    };
    syncBuiltinESMExports();
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const identity = m.bootIdentity();
      console.log(JSON.stringify({
        identity,
        same: m.isSameBoot({ ...identity }),
        different: m.isSameBoot({ ...identity, id: identity.id + "-different" }),
        calls,
        procReads,
      }));
    });
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.equal(out.identity.precise, true);
  assert.equal(out.identity.source, "win32.last-boot-up-time");
  assert.equal(out.identity.id, "win32.last-boot-up-time:638923456789012345");
  assert.equal(out.same, true, "the same Windows boot must retain ambiguous leases");
  assert.equal(out.different, false, "only a different precise Windows boot may authorize healing");
  assert.equal(out.calls.length, 1);
  assert.equal(out.procReads, 0, "native Windows must not probe Linux boot_id");
  assert.equal(
    out.calls[0].file.toLowerCase(),
    "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe"
  );
  assert.deepEqual(out.calls[0].args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.match(out.calls[0].args[4], /Get-CimInstance -ClassName Win32_OperatingSystem/u);
  assert.match(out.calls[0].args[4], /LastBootUpTime/u);
  assert.match(out.calls[0].args[4], /\$PSModuleAutoloadingPreference = 'None'/u);
  assert.match(
    out.calls[0].args[4],
    /\[IO\.Path\]::Combine\(\$PSHOME, 'Modules', 'CimCmdlets', 'CimCmdlets\.psd1'\)/u
  );
  assert.match(out.calls[0].args[4], /Microsoft\.PowerShell\.Core\\Import-Module/u);
  assert.match(out.calls[0].args[4], /CimCmdlets\\Get-CimInstance/u);
  assert.doesNotMatch(out.calls[0].args[4], /(?:^|[;\s])Get-CimInstance(?:\s|$)/u);
  assert.equal(out.calls[0].options.windowsHide, true);
  assert.equal(out.calls[0].options.timeout, 5000);
  assert.equal(out.calls[0].options.maxBuffer, 4096);
  assert.equal(out.calls[0].options.shell, false);
});

test("native Windows rejects malformed CIM boot identity output", () => {
  const script = `
    const cp = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.SystemRoot = "C:\\\\Windows";
    cp.execFileSync = () => "638923456789012345\\nforged";
    syncBuiltinESMExports();
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const identity = m.bootIdentity();
      console.log(JSON.stringify(identity));
    });
  `;
  const identity = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.equal(identity.precise, false, "unvalidated command output must never authorize deletion");
  assert.equal(identity.source, "uptime");
});

test("native Windows boot identity uses the shared strict SystemRoot resolver", () => {
  for (const systemRoot of [
    "C:\\Windows\\..\\Temp",
    "C:\\Windows ",
    "C:\\Windows:stream",
    "\\\\server\\share\\Windows",
  ]) {
    const script = `
      const cp = require("node:child_process");
      const { syncBuiltinESMExports } = require("node:module");
      let calls = 0;
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      process.env.SystemRoot = ${JSON.stringify(systemRoot)};
      cp.execFileSync = () => { calls += 1; return "638923456789012345"; };
      syncBuiltinESMExports();
      import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
        console.log(JSON.stringify({ identity: m.bootIdentity(), calls }));
      });
    `;
    const out = JSON.parse(
      execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
    );
    assert.equal(out.calls, 0, `${systemRoot}: an invalid root must never launch PowerShell`);
    assert.equal(out.identity.precise, false, `${systemRoot}: invalid resolution must fail closed`);
    assert.equal(out.identity.source, "uptime");
  }
});

test("native Windows rejects .NET ticks beyond DateTime.MaxValue everywhere", () => {
  const script = `
    const cp = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    let calls = 0;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.SystemRoot = "C:\\\\Windows";
    cp.execFileSync = () => {
      calls += 1;
      return "3155378976000000000";
    };
    syncBuiltinESMExports();
    Promise.all([
      import(${JSON.stringify(new URL("../src/process-probe.mjs", import.meta.url).href)}),
      import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}),
    ]).then(([probe, lease]) => {
      const startedAt = probe.processStartTime(process.pid);
      const verdict = probe.probeRecordedProcess(process.pid, "638923456789012345");
      const identity = lease.bootIdentity();
      console.log(JSON.stringify({ startedAt, verdict, identity, calls }));
    });
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.equal(out.startedAt, null, "an impossible process generation is unavailable");
  assert.equal(out.verdict, "alive", "an impossible generation must retain the live process");
  assert.equal(out.identity.precise, false, "impossible boot ticks cannot authorize deletion");
  assert.equal(out.identity.source, "uptime");
  assert.equal(out.calls, 3);
});

test("native Windows CIM failures and timeouts remain fail-closed", () => {
  for (const errorCode of ["ENOENT", "ETIMEDOUT"]) {
    const script = `
      const cp = require("node:child_process");
      const { syncBuiltinESMExports } = require("node:module");
      let calls = 0;
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      process.env.SystemRoot = "C:\\\\Windows";
      cp.execFileSync = () => {
        calls += 1;
        const error = new Error(${JSON.stringify(errorCode)});
        error.code = ${JSON.stringify(errorCode)};
        throw error;
      };
      syncBuiltinESMExports();
      Promise.all([
        import(${JSON.stringify(new URL("../src/process-probe.mjs", import.meta.url).href)}),
        import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}),
      ]).then(([probe, lease]) => {
        const startedAt = probe.processStartTime(process.pid);
        const verdict = probe.probeRecordedProcess(process.pid, "638923456789012345");
        const identity = lease.bootIdentity();
        const bootMismatch = lease.isSameBoot(
          { host: identity.host, id: "previous-boot", precise: true },
          identity
        );
        console.log(JSON.stringify({ startedAt, verdict, identity, bootMismatch, calls }));
      });
    `;
    const out = JSON.parse(
      execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
    );
    assert.equal(out.startedAt, null, `${errorCode}: process generation must be unavailable`);
    assert.equal(out.verdict, "alive", `${errorCode}: an unverified process must be retained`);
    assert.equal(out.identity.precise, false, `${errorCode}: boot identity must be imprecise`);
    assert.equal(out.identity.source, "uptime");
    assert.equal(out.bootMismatch, null, `${errorCode}: failure cannot establish a reboot`);
    assert.equal(out.calls, 3);
  }
});

test("boot identity reports unavailable rather than throwing", () => {
  // FOUND IN REVIEW, on a restricted host: os.uptime() raises
  // `uv_uptime returned EPERM` rather than returning something unusable, and it
  // propagated out of allocateLease() -- so no lease-backed adapter could start
  // there at all. An unavailable identity only costs the self-healing of
  // identity-less spawning leases, which is a retention, not a failure.
  // Everything unavailable at once: emulate Linux on every host, make uptime
  // raise EPERM (the reviewer's host), and hide the boot-id file explicitly.
  const script = `
    const os = require("node:os");
    const fs = require("node:fs");
    const originalReadFileSync = fs.readFileSync;
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    os.uptime = () => { throw new Error("uv_uptime returned EPERM"); };
    fs.readFileSync = (target, ...args) => {
      if (String(target) === "/proc/sys/kernel/random/boot_id") {
        const err = new Error("boot id is unavailable");
        err.code = "ENOENT";
        throw err;
      }
      return originalReadFileSync(target, ...args);
    };
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const identity = m.bootIdentity();
      // And a lease must still be judgeable, with the identity recorded absent.
      const verdict = m.proveLeaseReleasable({ state: "spawning", consumer: null, boot: identity });
      console.log(JSON.stringify({ identity, removable: verdict.removable, reason: verdict.reason }));
    });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim());
  assert.equal(out.identity, null, "an unobtainable boot identity is null, not an exception");
  assert.equal(out.removable, false, "and without one, conservative retention still applies");
  assert.match(out.reason, /no usable boot identity/);
});

// --- removal -------------------------------------------------------------------

test("removal refuses anything that is not a lease", (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-not-a-lease-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => removeLeaseDirectory(outside), /not directly under the runtime root/);

  const named = path.join(runtimeDir(), "not-a-lease-id");
  fs.mkdirSync(named, { recursive: true });
  assert.throws(() => removeLeaseDirectory(named), /not a lease id/);
  assert.ok(fs.existsSync(named), "the refusal must not have deleted it anyway");
  fs.rmSync(named, { recursive: true, force: true });

  if (process.platform !== "win32") {
    const link = path.join(runtimeDir(), "b".repeat(32));
    fs.symlinkSync(outside, link);
    t.after(() => fs.rmSync(link, { force: true }));
    assert.throws(
      () => removeLeaseDirectory(link),
      /symbolic link|whether this directory is in use could not be determined/u,
      "a linked lease path must be refused whether the host proves it is free or fails closed"
    );
    assert.ok(fs.existsSync(outside), "the link target must survive");
  }
});

test("deletion revalidates the root itself, not just what its caller checked", () => {
  // The parent comparison inside removeLeaseDirectory is LEXICAL: it says the
  // path is spelled under the runtime root, not that it resolves there. A root
  // swapped for a symlink after the caller validated it would therefore send
  // rmSync into whatever the link points at, judging the target only on whether
  // its leaf name looks like a lease id. So the deleting operation re-proves the
  // root itself.
  const script = `
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-dellink-"));
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-delvictim-"));
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.HOMEDRIVE = ""; process.env.HOMEPATH = home;
    const id = "c".repeat(32);
    // A directory in the victim with a perfectly valid lease name.
    fs.mkdirSync(path.join(victim, id), { recursive: true });
    fs.mkdirSync(path.join(home, ".dualog"), { recursive: true });
    fs.symlinkSync(
      victim,
      path.join(home, ".dualog", "runtime"),
      process.platform === "win32" ? "junction" : "dir"
    );
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      let refused = false, message = null;
      try {
        m.removeLeaseDirectory(path.join(home, ".dualog", "runtime", id));
      } catch (err) { refused = true; message = err.message.split("\\n")[0]; }
      console.log(JSON.stringify({
        refused,
        message,
        targetSurvives: fs.existsSync(path.join(victim, id)),
      }));
    });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim());
  assert.equal(out.refused, true, "removal through a linked root must be refused");
  assert.match(out.message, /symbolic link/);
  assert.equal(out.targetSurvives, true, "and the link target must be untouched");
});

test("strict POSIX removal leaves canonical attribution for late recreation", (t) => {
  if (process.platform === "win32") {
    t.skip("strict native Windows removal fails closed on unavailable handle evidence");
    return;
  }
  const id = crypto.randomBytes(16).toString("hex");
  const dir = path.join(runtimeDir(), id);
  fs.mkdirSync(path.join(dir, "codex-home"), { recursive: true });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, "codex-home", "auth.json"), "secret");

  removeLeaseDirectory(dir);
  assert.equal(fs.existsSync(dir), false);
  const markerPath = `${dir}.lease.json`;
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
  assert.equal(marker.strict_usage_only, true);
  assert.equal(marker.strict_canonical_generation, true);
  assert.equal(marker.release_relaxation_eligible, false);

  fs.mkdirSync(path.join(dir, "codex-home"), { recursive: true });
  fs.writeFileSync(path.join(dir, "codex-home", "late.json"), "{}");
  const receipt = sweepLeases({ apply: true });
  assert.ok(receipt.removed.some((entry) => entry.dir === dir));
  assert.equal(fs.existsSync(dir), false, "a fresh strict scan may reclaim the recreation");
  assert.equal(fs.existsSync(markerPath), true, "the canonical marker remains permanent");

  for (const entry of fs.readdirSync(runtimeDir())) {
    if (!entry.endsWith(".lease.json")) continue;
    const target = path.join(runtimeDir(), entry);
    try {
      const value = JSON.parse(fs.readFileSync(target, "utf-8"));
      if (value.lease_id === id || value.release_generation === id) {
        fs.rmSync(target, { force: true });
      }
    } catch {}
  }
});

test("releasing takes the credentials with it", (t) => {
  const lease = newLease();
  transitionLease(lease, "projecting");
  const home = path.join(lease.dir, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), '{"token":"secret"}');
  transitionLease(lease, "active", {
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
    },
  });

  const result = releaseAllowingUnknownDirectory(lease);
  if (!releasedOrRetainedUnknown(t, lease, result, "successful credential cleanup")) {
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
    return;
  }
  assert.equal(fs.existsSync(lease.dir), false, "the whole lease goes, auth.json included");
});

test("a runner can clean up after its own failed pre-spawn turn", (t) => {
  // FOUND BY SELF-REVIEW, not by the reviewer. proveLeaseReleasable() retains a
  // pre-spawn lease while its owner lives -- correct for a sweep in another
  // process, and exactly wrong for the owner itself, which is that live runner.
  // A turn failing during projection therefore kept its partial credential copy
  // for the REST OF THE SESSION, since the runner only exits at session end.
  // That is the condition per-turn leases exist to end.
  const lease = newLease();
  transitionLease(lease, "projecting");
  const home = path.join(lease.dir, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), '{"token":"partial-projection"}');

  const ownerRelease = releaseAllowingUnknownDirectory(lease);
  if (releasedOrRetainedUnknown(t, lease, ownerRelease, "successful owner cleanup")) {
    assert.equal(fs.existsSync(lease.dir), false);
  } else {
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
  }

  // A FAILED SPAWN too, once the consumer is provably absent. The owner has
  // awaited its own spawn call by the time it releases, so unlike a third-party
  // sweep it knows no helper of its own is still in flight. Without this, a
  // failed startTmuxSession() retained its credentials until the next reboot,
  // because the sweep's rule for that state is deliberately boot-scoped.
  const failed = newLease();
  transitionLease(failed, "spawning", {
    // A pane we IDENTIFIED and then watched fail. The pid is what makes this a
    // proof rather than a guess.
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
      pane_pid: 999999,
    },
  });
  const failedRelease = releaseAllowingUnknownDirectory(failed);
  const failedTombstone = meta(failed);
  assert.equal(failedTombstone.state, "released");
  assert.equal(failedTombstone.released_from_state, "spawning");
  assert.equal(
    failedTombstone.consumer_never_created,
    undefined,
    "an identified tmux pane must never be rewritten as a never-created consumer"
  );
  assert.equal(failedTombstone.consumer.pane_pid, 999999, "the pane identity stays durable");
  if (releasedOrRetainedUnknown(t, failed, failedRelease, "successful failed-spawn cleanup")) {
    assert.equal(fs.existsSync(failed.dir), false);
  } else {
    fs.rmSync(failed.dir, { recursive: true, force: true });
    fs.rmSync(failed.metaPath, { force: true });
  }

  const unidentifiedPane = newLease();
  transitionLease(unidentifiedPane, "spawning", {
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
      pane_pid: null,
      pane_pid_unavailable: true,
    },
  });
  const unidentifiedRelease = releaseLease(unidentifiedPane);
  assert.equal(
    unidentifiedRelease.released,
    false,
    "a failed setup after pane creation retains when the pane pid was unreadable"
  );
  assert.match(unidentifiedRelease.reason, /could not be probed \(unknown\)/u);
  fs.rmSync(unidentifiedPane.dir, { recursive: true, force: true });
  fs.rmSync(unidentifiedPane.metaPath, { force: true });

  // But NOT on a session name alone. In `spawning` the name may have been
  // recorded before new-session ran, and the tmux server is a separate process
  // from the client we drove -- so a client that timed out can still have handed
  // the command over and the pane can appear after any number of probes.
  const nameless = newLease();
  transitionLease(nameless, "spawning", {
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
    },
  });
  const refusedNameless = releaseLease(nameless);
  assert.equal(
    refusedNameless.released,
    false,
    "session absence is not proof when no pane process was ever identified"
  );
  fs.rmSync(nameless.dir, { recursive: true, force: true });
  fs.rmSync(nameless.metaPath, { force: true });

  // But not one whose pane actually came up -- that is a live consumer.
  const live = newLease();
  transitionLease(live, "spawning", {
    consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
  });
  assert.equal(releaseLease(live).released, false, "a spawn that succeeded is not reclaimable");
  fs.rmSync(live.dir, { recursive: true, force: true });

  // The counterweight: this must be about being the OWNER, not about being any
  // process that asks. A lease belonging to a different, live runner is refused.
  const other = newLease({ runnerPid: 1 });
  const refused = releaseLease(other);
  assert.equal(refused.released, false, "another process may not reclaim a live owner's lease");
  assert.match(refused.reason, /still alive/);
  fs.rmSync(other.dir, { recursive: true, force: true });
});

test("releasing a lease whose consumer is still live does nothing", () => {
  const lease = newLease();
  transitionLease(lease, "active", {
    consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
  });
  const { released, reason } = releaseLease(lease);
  assert.equal(released, false);
  assert.match(reason, /still running/);
  assert.ok(fs.existsSync(lease.dir));
  fs.rmSync(lease.dir, { recursive: true, force: true });
});

test("a lease record survives the partner recreating its home", (t) => {
  // THE PRODUCTION INCIDENT, fixed structurally rather than worked around.
  //
  // A partner CLI outlived its tmux pane and, after the lease was released,
  // recreated $CODEX_HOME to flush a models cache. With the record INSIDE the
  // directory, that recreation produced something no rule could classify: the
  // metadata was gone, so releaseLease() reported "unreadable" and the sweep
  // retained it forever. Two substitutes were tried -- ownership, then age --
  // and both were guesses standing in for a consumer proof.
  //
  // The record lives BESIDE the directory now, so the partner cannot reach it.
  const lease = newLease();
  transitionLease(lease, "active", {
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
    },
  });
  assert.equal(path.dirname(lease.metaPath), path.resolve(runtimeDir()));
  assert.equal(fs.existsSync(path.join(lease.dir, "lease.json")), false, "nothing inside the lease");

  const initialRelease = releaseAllowingUnknownDirectory(lease);
  if (!releasedOrRetainedUnknown(t, lease, initialRelease, "recreated-home reclamation")) {
    assert.equal(fs.existsSync(lease.metaPath), true, "the sibling record must survive retention");
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
    return;
  }

  assert.equal(fs.existsSync(lease.dir), false);

  // A TOMBSTONE remains, so what the directory was is still knowable.
  const tombstone = JSON.parse(fs.readFileSync(lease.metaPath, "utf-8"));
  assert.equal(tombstone.state, "released");
  assert.ok(tombstone.released_at);

  // Now the partner recreates its home, exactly as codex did.
  fs.mkdirSync(path.join(lease.dir, "codex-home"), { recursive: true });
  fs.writeFileSync(path.join(lease.dir, "codex-home", "models_cache.json"), "{}");

  // Reclaimed on the record, not on age and not on ownership.
  const receipt = sweepLeases({ apply: true });
  const removed = sweepRemovedOrRetainedUnknown(
    t,
    lease,
    receipt,
    "successful recreated-home sweep"
  );
  if (removed) {
    assert.match(removed.reason, /recreated after the lease was released/);
    assert.equal(fs.existsSync(lease.dir), false);
  } else {
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
  }
});

test("same-boot cleanup claims are taken over only for absent or reused owners", (t) => {
  const currentStart = processStartTime(process.pid);
  assert.ok(currentStart, "the supported host must expose this process generation");

  for (const fixture of [
    { name: "absent", ownerPid: 999999, ownerStartTime: "recorded-dead-generation" },
    { name: "reused", ownerPid: process.pid, ownerStartTime: `${currentStart}-previous` },
  ]) {
    const lease = newLease();
    transitionLease(lease, "projecting");
    const claim = installCleanupClaim(lease, {
      ownerPid: fixture.ownerPid,
      ownerStartTime: fixture.ownerStartTime,
    });

    const released = releaseLease(lease);
    assert.deepEqual(released, { released: true, reason: null }, fixture.name);
    assert.equal(fs.existsSync(lease.dir), false, `${fixture.name}: the lease is reclaimed`);
    assert.equal(fs.existsSync(claim.claimPath), false, `${fixture.name}: the new claim was released`);
    assert.equal(
      fs.existsSync(claim.archivedPath),
      true,
      `${fixture.name}: the exact stale generation remains archived`
    );
    cleanupLeaseFamilyArtifacts(lease);
  }
});

test("a precise previous boot permits cleanup-claim takeover", (t) => {
  const oldBoot = requirePreciseBoot(t);
  if (!oldBoot) return;
  const lease = newLease();
  transitionLease(lease, "projecting");
  const claim = installCleanupClaim(lease, {
    ownerPid: process.pid,
    ownerStartTime: processStartTime(process.pid),
    boot: oldBoot,
  });

  const released = releaseLease(lease);
  assert.deepEqual(released, { released: true, reason: null });
  assert.equal(fs.existsSync(lease.dir), false, "nothing from the prior boot can own the claim");
  assert.equal(fs.existsSync(claim.archivedPath), true);
  cleanupLeaseFamilyArtifacts(lease);
});

test("live, unknown, and malformed cleanup claims retain fail-closed", (t) => {
  const currentStart = processStartTime(process.pid);
  assert.ok(currentStart, "the supported host must expose this process generation");

  const live = newLease();
  transitionLease(live, "projecting");
  const liveClaim = installCleanupClaim(live, {
    ownerPid: process.pid,
    ownerStartTime: currentStart,
  });
  const liveResult = releaseLease(live);
  assert.equal(liveResult.released, false);
  assert.match(liveResult.reason, /cleanup owner process is still alive/);
  assert.equal(fs.existsSync(live.dir), true);
  assert.equal(fs.existsSync(liveClaim.claimPath), true);
  cleanupLeaseFamilyArtifacts(live);

  const unknown = newLease();
  transitionLease(unknown, "projecting");
  const unknownPid = 424242;
  const unknownClaim = installCleanupClaim(unknown, {
    ownerPid: unknownPid,
    ownerStartTime: "unprobeable-generation",
  });
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === unknownPid && signal === 0) {
      const error = new Error("synthetic process probe failure");
      error.code = "EIO";
      throw error;
    }
    return originalKill.call(process, pid, signal);
  };
  let unknownResult;
  try {
    unknownResult = releaseLease(unknown);
  } finally {
    process.kill = originalKill;
  }
  assert.equal(unknownResult.released, false);
  assert.match(unknownResult.reason, /could not be probed \(unknown\)/);
  assert.equal(fs.existsSync(unknown.dir), true);
  assert.equal(fs.existsSync(unknownClaim.claimPath), true);
  cleanupLeaseFamilyArtifacts(unknown);

  const malformed = newLease();
  transitionLease(malformed, "projecting");
  const malformedPath = `${malformed.dir}.cleanup.claim`;
  fs.mkdirSync(malformedPath, { mode: 0o700 });
  fs.writeFileSync(path.join(malformedPath, "claim.json"), "{}", { mode: 0o600 });
  const malformedResult = releaseLease(malformed);
  assert.equal(malformedResult.released, false);
  assert.match(malformedResult.reason, /claim record is malformed/);
  assert.equal(fs.existsSync(malformed.dir), true);
  assert.equal(fs.existsSync(malformedPath), true);
  cleanupLeaseFamilyArtifacts(malformed);
});

test("competing stale-claim reclaimers cannot move a fresh live claim", (t) => {
  const currentStart = processStartTime(process.pid);
  assert.ok(currentStart, "the supported host must expose this process generation");
  const lease = newLease();
  transitionLease(lease, "projecting");
  const stale = installCleanupClaim(lease, {
    ownerPid: 999999,
    ownerStartTime: "dead-generation",
  });
  const freshToken = crypto.randomBytes(16).toString("hex");
  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, target) => {
    const result = originalRenameSync(source, target);
    if (!injected && String(source) === stale.claimPath && String(target) === stale.archivedPath) {
      injected = true;
      installCleanupClaim(lease, {
        ownerPid: process.pid,
        ownerStartTime: currentStart,
        token: freshToken,
      });
    }
    return result;
  };

  let released;
  try {
    released = releaseLease(lease);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(injected, true, "the deterministic contender must acquire in the takeover gap");
  assert.equal(released.released, false);
  assert.match(released.reason, /cleanup owner process is still alive/);
  assert.equal(fs.existsSync(lease.dir), true, "the fresh claimant's generation is untouched");
  assert.equal(fs.existsSync(stale.archivedPath), true, "the stale token occupies its archive");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(stale.claimPath, "claim.json"), "utf-8")).token,
    freshToken,
    "the live canonical claim was neither moved nor removed"
  );
  cleanupLeaseFamilyArtifacts(lease);
});

test("an atomic quarantine never removes a late canonical generation", (t) => {
  const lease = newLease();
  transitionLease(lease, "projecting");
  const originalCredential = path.join(lease.dir, "codex-home", "auth.json");
  fs.mkdirSync(path.dirname(originalCredential), { recursive: true });
  fs.writeFileSync(originalCredential, '{"token":"original-generation"}');

  const originalRenameSync = fs.renameSync;
  let quarantineDir = null;
  let competingError = null;
  fs.renameSync = (source, target) => {
    const result = originalRenameSync(source, target);
    if (String(source) === lease.dir) {
      quarantineDir = String(target);
      // Exact race: an absolute-path writer arrives immediately after the
      // namespace switch. It must land in a NEW canonical generation and must
      // never be part of the recursive removal below.
      const late = path.join(lease.dir, "codex-home", "late.json");
      fs.mkdirSync(path.dirname(late), { recursive: true });
      fs.writeFileSync(late, '{"generation":"late-canonical"}');
      // A second cleanup that scanned before this namespace switch must not be
      // able to consume the just-created canonical generation. The exclusive
      // canonical claim serializes that stale attempt.
      try {
        removeLeaseDirectory(lease.dir);
      } catch (error) {
        competingError = error.message;
      }
    }
    return result;
  };

  let result;
  try {
    result = releaseLease(lease);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepEqual(result, { released: true, reason: null });
  assert.ok(quarantineDir, "release must atomically switch the checked generation");
  assert.match(competingError, /another cleanup owns the canonical generation/);
  assert.equal(fs.existsSync(quarantineDir), false, "only the detached original generation goes");
  assert.equal(
    fs.readFileSync(path.join(lease.dir, "codex-home", "late.json"), "utf-8"),
    '{"generation":"late-canonical"}',
    "the late canonical writer must survive"
  );
  const quarantineRecord = JSON.parse(
    fs.readFileSync(`${quarantineDir}.lease.json`, "utf-8")
  );
  assert.equal(quarantineRecord.quarantined_from, lease.id);
  assert.equal(quarantineRecord.release_generation, lease.id);
  assert.equal(quarantineRecord.quarantine_generation, true);
  assert.equal(fs.existsSync(lease.metaPath), true, "the canonical marker still attributes recreation");

  // A later sweep may handle the new canonical generation on its own proof.
  const swept = sweepLeases({ apply: true });
  assert.ok(swept.removed.some((entry) => entry.dir === lease.dir));
  assert.equal(fs.existsSync(lease.dir), false);

  for (const entry of fs.readdirSync(runtimeDir())) {
    if (!entry.endsWith(".lease.json")) continue;
    const target = path.join(runtimeDir(), entry);
    try {
      const value = JSON.parse(fs.readFileSync(target, "utf-8"));
      if (value.lease_id === lease.id || value.release_generation === lease.id) {
        fs.rmSync(target, { force: true });
      }
    } catch {}
  }
});

test("native Windows serializes two sweepers and preserves a late canonical writer", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-win-quarantine-race-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = `
    const fs = require("node:fs"), path = require("node:path");
    const cp = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.SystemRoot = "C:\\\\Windows";
    process.env.HOME = ${JSON.stringify(home)};
    process.env.USERPROFILE = ${JSON.stringify(home)};
    process.env.HOMEDRIVE = "";
    process.env.HOMEPATH = ${JSON.stringify(home)};
    cp.execFileSync = () => "638923456789012345";
    syncBuiltinESMExports();
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const turnDir = path.join(${JSON.stringify(home)}, ".dualog", "sessions", "win-race", "turns", "t1");
      fs.mkdirSync(turnDir, { recursive: true });
      const lease = m.allocateLease({
        sessionId: "win-race", turnId: "t1", agent: "codex", engine: "headless", turnDir,
      });
      m.transitionLease(lease, "projecting");
      const auth = path.join(lease.dir, "codex-home", "auth.json");
      fs.mkdirSync(path.dirname(auth), { recursive: true });
      fs.writeFileSync(auth, '{"token":"original-generation"}');

      const originalRenameSync = fs.renameSync;
      let quarantineDir = null, competingError = null;
      fs.renameSync = (source, target) => {
        const result = originalRenameSync(source, target);
        if (String(source) === lease.dir) {
          quarantineDir = String(target);
          const late = path.join(lease.dir, "codex-home", "late.json");
          fs.mkdirSync(path.dirname(late), { recursive: true });
          fs.writeFileSync(late, '{"generation":"late-canonical"}');
          try { m.removeLeaseDirectory(lease.dir); }
          catch (error) { competingError = error.message; }
        }
        return result;
      };

      let released;
      try { released = m.releaseLease(lease); }
      finally { fs.renameSync = originalRenameSync; }
      const quarantineRecord = JSON.parse(fs.readFileSync(quarantineDir + ".lease.json", "utf-8"));
      console.log(JSON.stringify({
        released,
        competingError,
        quarantineDir,
        quarantineSurvives: fs.existsSync(quarantineDir),
        late: fs.readFileSync(path.join(lease.dir, "codex-home", "late.json"), "utf-8"),
        canonicalMarkerSurvives: fs.existsSync(lease.metaPath),
        quarantinedFrom: quarantineRecord.quarantined_from,
        releaseGeneration: quarantineRecord.release_generation,
      }));
    });
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.deepEqual(out.released, { released: true, reason: null });
  assert.match(out.competingError, /another cleanup owns the canonical generation/);
  assert.equal(out.quarantineSurvives, false, "only the detached Windows generation is removed");
  assert.equal(out.late, '{"generation":"late-canonical"}');
  assert.equal(out.canonicalMarkerSurvives, true, "late recreation stays attributable");
  assert.equal(out.quarantinedFrom, out.releaseGeneration);
});

test("native Windows rename failure retains the canonical credential generation", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-win-quarantine-holder-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = `
    const fs = require("node:fs"), path = require("node:path");
    const cp = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.SystemRoot = "C:\\\\Windows";
    process.env.HOME = ${JSON.stringify(home)};
    process.env.USERPROFILE = ${JSON.stringify(home)};
    process.env.HOMEDRIVE = "";
    process.env.HOMEPATH = ${JSON.stringify(home)};
    cp.execFileSync = () => "638923456789012345";
    syncBuiltinESMExports();
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const turnDir = path.join(${JSON.stringify(home)}, ".dualog", "sessions", "win-holder", "turns", "t1");
      fs.mkdirSync(turnDir, { recursive: true });
      const lease = m.allocateLease({
        sessionId: "win-holder", turnId: "t1", agent: "codex", engine: "headless", turnDir,
      });
      m.transitionLease(lease, "projecting");
      const auth = path.join(lease.dir, "codex-home", "auth.json");
      fs.mkdirSync(path.dirname(auth), { recursive: true });
      fs.writeFileSync(auth, '{"token":"held-generation"}');

      const originalRenameSync = fs.renameSync;
      let reservedDir = null;
      fs.renameSync = (source, target) => {
        if (String(source) === lease.dir) {
          reservedDir = String(target);
          const error = new Error("synthetic Windows sharing violation");
          error.code = "EBUSY";
          throw error;
        }
        return originalRenameSync(source, target);
      };
      let released;
      try { released = m.releaseLease(lease); }
      finally { fs.renameSync = originalRenameSync; }
      console.log(JSON.stringify({
        released,
        reservedDir,
        canonicalSurvives: fs.existsSync(lease.dir),
        auth: fs.readFileSync(auth, "utf-8"),
        reservedDirectoryExists: fs.existsSync(reservedDir),
        reservedMarkerExists: fs.existsSync(reservedDir + ".lease.json"),
        canonicalClaimExists: fs.existsSync(lease.dir + ".cleanup.claim"),
      }));
    });
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.equal(out.released.released, false);
  assert.match(out.released.reason, /could not atomically quarantine.*EBUSY/);
  assert.equal(out.canonicalSurvives, true, "a holder-blocked rename cannot detach the payload");
  assert.equal(out.auth, '{"token":"held-generation"}');
  assert.equal(out.reservedDirectoryExists, false);
  assert.equal(out.reservedMarkerExists, true, "the reserved generation stays attributable");
  assert.equal(out.canonicalClaimExists, false, "the failed attempt retires its serialization claim");
});

test("a holder acquired during deletion leaves an attributable quarantine", (t) => {
  if (process.platform === "win32") {
    t.skip("native Windows relies on sharing semantics and durable lifecycle proof");
    return;
  }

  const lease = newLease();
  transitionLease(lease, "projecting");
  const credential = path.join(lease.dir, "codex-home", "auth.json");
  fs.mkdirSync(path.dirname(credential), { recursive: true });
  fs.writeFileSync(credential, '{"token":"held-generation"}');

  const originalRenameSync = fs.renameSync;
  let quarantineDir = null;
  let heldFd = null;
  fs.renameSync = (source, target) => {
    const result = originalRenameSync(source, target);
    if (String(source) === lease.dir) {
      quarantineDir = String(target);
      heldFd = fs.openSync(path.join(quarantineDir, "codex-home", "auth.json"), "r");
    }
    return result;
  };

  let result;
  try {
    result = releaseLease(lease);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(result.released, false, "the post-rename usage check must stop removal");
  assert.match(result.reason, /retained the attributable generation/);
  assert.ok(quarantineDir);
  assert.equal(fs.existsSync(lease.dir), false, "the canonical name is no longer the checked inode");
  assert.equal(fs.existsSync(quarantineDir), true, "the held generation remains intact");
  assert.equal(
    JSON.parse(fs.readFileSync(`${quarantineDir}.lease.json`, "utf-8")).quarantined_from,
    lease.id,
    "its sibling manifest makes the moved generation recoverable"
  );

  fs.closeSync(heldFd);
  heldFd = null;
  const retried = sweepLeases({ apply: true });
  const removed = retried.removed.find((entry) => entry.dir === quarantineDir);
  const retained = retried.retained.find((entry) => entry.dir === quarantineDir);
  assert.notEqual(Boolean(removed), Boolean(retained));
  if (removed) {
    assert.equal(fs.existsSync(quarantineDir), false, "a later free proof reclaims the generation");
  } else {
    assert.match(retained.reason, UNKNOWN_DIRECTORY_USAGE);
    fs.rmSync(quarantineDir, { recursive: true, force: true });
  }

  for (const entry of fs.readdirSync(runtimeDir())) {
    if (!entry.endsWith(".lease.json")) continue;
    const target = path.join(runtimeDir(), entry);
    try {
      const value = JSON.parse(fs.readFileSync(target, "utf-8"));
      if (value.lease_id === lease.id || value.release_generation === lease.id) {
        fs.rmSync(target, { force: true });
      }
    } catch {}
  }
});

test("a crash before cleanup-claim publication leaves only a recoverable staged artifact", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-claim-stage-crash-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const statePath = path.join(home, "crash-state.json");
  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: home,
  };
  const crashScript = `
    const fs = require("node:fs"), path = require("node:path");
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const turnDir = path.join(${JSON.stringify(home)}, ".dualog", "sessions", "claim-stage-crash", "turns", "t1");
      fs.mkdirSync(turnDir, { recursive: true });
      const lease = m.allocateLease({
        sessionId: "claim-stage-crash", turnId: "t1", agent: "codex", engine: "headless", turnDir,
      });
      m.transitionLease(lease, "projecting");
      fs.mkdirSync(path.join(lease.dir, "codex-home"), { recursive: true });
      fs.writeFileSync(path.join(lease.dir, "codex-home", "auth.json"), "secret");
      const originalRenameSync = fs.renameSync;
      fs.renameSync = (source, target) => {
        const sourceText = String(source), targetText = String(target);
        if (
          sourceText.startsWith(lease.dir + ".cleanup.claim.stage-") &&
          targetText === lease.dir + ".cleanup.claim"
        ) {
          const claim = JSON.parse(fs.readFileSync(path.join(sourceText, "claim.json"), "utf-8"));
          fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
            dir: lease.dir,
            metaPath: lease.metaPath,
            canonicalClaim: targetText,
            stagedPath: sourceText,
            claim,
          }));
          process.exit(44);
        }
        return originalRenameSync(source, target);
      };
      m.releaseLease(lease);
    });
  `;
  const crashed = spawnSync(process.execPath, ["-e", crashScript], {
    encoding: "utf-8",
    env: childEnv,
  });
  assert.equal(crashed.status, 44, crashed.stderr);

  const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.equal(fs.existsSync(state.dir), true, "publication never exposed cleanup authority");
  assert.equal(fs.existsSync(state.canonicalClaim), false, "an incomplete publish is not canonical");
  assert.equal(fs.existsSync(state.stagedPath), true, "the complete off-canonical record survives");
  assert.equal(state.claim.owner_pid, crashed.pid);
  assert.equal(state.claim.token, path.basename(state.stagedPath).split(".stage-")[1]);

  const recoveryScript = `
    const fs = require("node:fs");
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const receipt = m.sweepLeases({ apply: true });
      console.log(JSON.stringify({
        removed: receipt.removed.map((entry) => entry.dir),
        retained: receipt.retained,
        errors: receipt.errors,
        leaseSurvives: fs.existsSync(${JSON.stringify(state.dir)}),
        stageSurvives: fs.existsSync(${JSON.stringify(state.stagedPath)}),
      }));
    });
  `;
  const recovered = JSON.parse(
    execFileSync(process.execPath, ["-e", recoveryScript], {
      encoding: "utf-8",
      env: childEnv,
    }).trim()
  );
  assert.deepEqual(recovered.errors, []);
  assert.equal(recovered.leaseSurvives, false, "a fresh complete claim reclaims the lease");
  assert.equal(recovered.stageSurvives, false, "the dead publisher's staged record is reaped");
  assert.ok(recovered.removed.includes(state.dir));
  assert.ok(recovered.removed.includes(state.stagedPath));
});

test("a crash after claim creation but before rename is safely taken over", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-claim-crash-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const statePath = path.join(home, "crash-state.json");
  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: home,
  };
  const crashScript = `
    const fs = require("node:fs"), path = require("node:path");
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const turnDir = path.join(${JSON.stringify(home)}, ".dualog", "sessions", "crash-claim", "turns", "t1");
      fs.mkdirSync(turnDir, { recursive: true });
      const lease = m.allocateLease({
        sessionId: "crash-claim", turnId: "t1", agent: "codex", engine: "headless", turnDir,
      });
      m.transitionLease(lease, "projecting");
      fs.mkdirSync(path.join(lease.dir, "codex-home"), { recursive: true });
      fs.writeFileSync(path.join(lease.dir, "codex-home", "auth.json"), "secret");
      const originalRenameSync = fs.renameSync;
      fs.renameSync = (source, target) => {
        if (String(source) === lease.dir) {
          const claimPath = lease.dir + ".cleanup.claim";
          const claim = JSON.parse(fs.readFileSync(path.join(claimPath, "claim.json"), "utf-8"));
          fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
            id: lease.id,
            dir: lease.dir,
            metaPath: lease.metaPath,
            claimPath,
            claim,
          }));
          process.exit(43);
        }
        return originalRenameSync(source, target);
      };
      m.releaseLease(lease);
    });
  `;
  const crashed = spawnSync(process.execPath, ["-e", crashScript], {
    encoding: "utf-8",
    env: childEnv,
  });
  assert.equal(crashed.status, 43, crashed.stderr);

  const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.equal(fs.existsSync(state.dir), true, "the canonical generation was not renamed");
  assert.equal(fs.existsSync(state.claimPath), true, "the interrupted claim remains");
  assert.equal(state.claim.owner_pid, crashed.pid);
  assert.equal(typeof state.claim.owner_start_time, "string");
  assert.ok(state.claim.owner_start_time.length > 0, "the claim records its process generation");
  assert.equal(state.claim.boot.precise, true, "the claim records precise boot identity when available");

  const recoveryScript = `
    const fs = require("node:fs");
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const receipt = m.sweepLeases({ apply: true });
      console.log(JSON.stringify({
        removed: receipt.removed.map((entry) => entry.dir),
        retained: receipt.retained.map((entry) => entry.dir),
        errors: receipt.errors,
        survives: fs.existsSync(${JSON.stringify(state.dir)}),
      }));
    });
  `;
  const recovered = JSON.parse(
    execFileSync(process.execPath, ["-e", recoveryScript], {
      encoding: "utf-8",
      env: childEnv,
    }).trim()
  );
  assert.deepEqual(recovered.errors, []);
  assert.equal(recovered.survives, false, "the dead same-boot owner can be taken over");
  assert.ok(recovered.removed.includes(state.dir));
  assert.equal(fs.existsSync(state.claimPath), false, "the recovery owner's claim was released");
  assert.equal(
    fs.existsSync(`${state.claimPath}.stale-${state.claim.token}`),
    true,
    "the exact crashed claim generation remains archived"
  );
});

test("a crash during cleanup-claim retirement leaves a recoverable retired artifact", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-claim-retire-crash-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const statePath = path.join(home, "crash-state.json");
  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: home,
  };
  const crashScript = `
    const fs = require("node:fs"), path = require("node:path");
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const turnDir = path.join(${JSON.stringify(home)}, ".dualog", "sessions", "claim-retire-crash", "turns", "t1");
      fs.mkdirSync(turnDir, { recursive: true });
      const lease = m.allocateLease({
        sessionId: "claim-retire-crash", turnId: "t1", agent: "codex", engine: "headless", turnDir,
      });
      m.transitionLease(lease, "projecting");
      fs.mkdirSync(path.join(lease.dir, "codex-home"), { recursive: true });
      fs.writeFileSync(path.join(lease.dir, "codex-home", "auth.json"), "secret");
      const originalRmSync = fs.rmSync;
      fs.rmSync = (target, options) => {
        const targetText = String(target);
        if (targetText.startsWith(lease.dir + ".cleanup.claim.retired-")) {
          const claim = JSON.parse(fs.readFileSync(path.join(targetText, "claim.json"), "utf-8"));
          fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
            dir: lease.dir,
            metaPath: lease.metaPath,
            canonicalClaim: lease.dir + ".cleanup.claim",
            retiredPath: targetText,
            claim,
          }));
          process.exit(45);
        }
        return originalRmSync(target, options);
      };
      m.releaseLease(lease);
    });
  `;
  const crashed = spawnSync(process.execPath, ["-e", crashScript], {
    encoding: "utf-8",
    env: childEnv,
  });
  assert.equal(crashed.status, 45, crashed.stderr);

  const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.equal(fs.existsSync(state.dir), false, "the checked credential generation was removed");
  assert.equal(fs.existsSync(state.canonicalClaim), false, "retirement first removed canonical authority");
  assert.equal(fs.existsSync(state.retiredPath), true, "the interrupted retired generation survives");
  assert.equal(state.claim.owner_pid, crashed.pid);

  const recoveryScript = `
    const fs = require("node:fs");
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const receipt = m.sweepLeases({ apply: true });
      console.log(JSON.stringify({
        removed: receipt.removed.map((entry) => entry.dir),
        retained: receipt.retained,
        errors: receipt.errors,
        retiredSurvives: fs.existsSync(${JSON.stringify(state.retiredPath)}),
      }));
    });
  `;
  const recovered = JSON.parse(
    execFileSync(process.execPath, ["-e", recoveryScript], {
      encoding: "utf-8",
      env: childEnv,
    }).trim()
  );
  assert.deepEqual(recovered.errors, []);
  assert.equal(recovered.retiredSurvives, false, "a dead publisher's retired record is reaped");
  assert.ok(recovered.removed.includes(state.retiredPath));
});

test("a crash after quarantine rename leaves a recoverable attributed generation", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-quarantine-crash-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const statePath = path.join(home, "crash-state.json");
  const childEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: home,
  };
  const crashScript = `
    const fs = require("node:fs"), path = require("node:path");
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const turnDir = path.join(${JSON.stringify(home)}, ".dualog", "sessions", "crash", "turns", "t1");
      fs.mkdirSync(turnDir, { recursive: true });
      const lease = m.allocateLease({
        sessionId: "crash", turnId: "t1", agent: "codex", engine: "headless", turnDir,
      });
      m.transitionLease(lease, "projecting");
      fs.mkdirSync(path.join(lease.dir, "codex-home"), { recursive: true });
      fs.writeFileSync(path.join(lease.dir, "codex-home", "auth.json"), "secret");
      const originalRenameSync = fs.renameSync;
      fs.renameSync = (source, target) => {
        const result = originalRenameSync(source, target);
        if (String(source) === lease.dir) {
          fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
            id: lease.id, dir: lease.dir, metaPath: lease.metaPath, quarantineDir: String(target),
          }));
          process.exit(42);
        }
        return result;
      };
      m.releaseLease(lease);
    });
  `;
  const crashed = spawnSync(process.execPath, ["-e", crashScript], {
    encoding: "utf-8",
    env: childEnv,
  });
  assert.equal(crashed.status, 42, crashed.stderr);

  const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.equal(fs.existsSync(state.dir), false, "the canonical generation was detached");
  assert.equal(fs.existsSync(state.metaPath), true, "the canonical tombstone survived");
  assert.equal(fs.existsSync(state.quarantineDir), true, "the crash retained the moved payload");
  const quarantineMetaPath = `${state.quarantineDir}.lease.json`;
  assert.equal(
    JSON.parse(fs.readFileSync(quarantineMetaPath, "utf-8")).release_generation,
    state.id,
    "the pre-rename manifest attributes the crash generation"
  );
  assert.equal(
    fs.existsSync(`${state.dir}.cleanup.claim`),
    true,
    "a crashed canonical claim fails closed against stale competing cleanup"
  );

  const recoveryScript = `
    const fs = require("node:fs");
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((m) => {
      const receipt = m.sweepLeases({ apply: true });
      console.log(JSON.stringify({
        removed: receipt.removed.map((entry) => entry.dir),
        retained: receipt.retained.map((entry) => entry.dir),
        survives: fs.existsSync(${JSON.stringify(state.quarantineDir)}),
      }));
    });
  `;
  const recovered = JSON.parse(
    execFileSync(process.execPath, ["-e", recoveryScript], {
      encoding: "utf-8",
      env: childEnv,
    }).trim()
  );
  assert.equal(recovered.survives, false, "the independent quarantine id remains sweepable");
  assert.ok(recovered.removed.includes(state.quarantineDir));
  assert.equal(
    fs.existsSync(`${state.dir}.cleanup.claim`),
    true,
    "recovery never guesses that a crashed canonical claim is stale"
  );
});

test("a tombstone identifies what to check; it does not authorize deletion", (t) => {
  // "Was proven gone" is a statement about the PAST. A spawn believed to have
  // failed can still succeed -- a tmux client killed after handing new-session
  // to the server -- so the pane may be alive and this directory may be its
  // home. The record says what to probe; the probe decides.
  const lease = newLease();
  transitionLease(lease, "active", {
    consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
  });
  // Write the tombstone by hand: releaseLease would (correctly) refuse, since
  // the consumer is this very process.
  fs.writeFileSync(
    lease.metaPath,
    JSON.stringify({
      schema_version: 1,
      lease_id: lease.id,
      state: "released",
      released_at: new Date().toISOString(),
      consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
    })
  );

  const receipt = sweepLeases({ apply: true });
  const retained = receipt.retained.find((r) => r.dir === lease.dir);
  assert.ok(retained, "a released record whose consumer is alive must retain");
  assert.match(retained.reason, /running again/);
  assert.equal(fs.existsSync(lease.dir), true);

  fs.rmSync(lease.dir, { recursive: true, force: true });
  fs.rmSync(lease.metaPath, { force: true });
});

test("released-tombstone dry-run and apply both retain a directory held by this caller", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows open-handle behavior is enforced by the removal syscall");
    return;
  }
  const lease = newLease();
  const auth = path.join(lease.dir, "auth.json");
  fs.writeFileSync(auth, '{"token":"held-during-sweep"}');
  fs.writeFileSync(
    lease.metaPath,
    JSON.stringify({
      schema_version: 1,
      lease_id: lease.id,
      state: "released",
      released_from_state: "active",
      released_at: new Date().toISOString(),
      consumer: { kind: "headless", pid: 999999, pgid: 999999 },
    })
  );

  const fd = fs.openSync(auth, "r");
  const dry = sweepLeases();
  const dryRetained = dry.retained.find((entry) => entry.dir === lease.dir);
  assert.ok(dryRetained, "dry-run must retain the held released directory");
  assert.match(dryRetained.reason, /still has this directory open/);

  const applied = sweepLeases({ apply: true });
  const appliedRetained = applied.retained.find((entry) => entry.dir === lease.dir);
  assert.ok(appliedRetained, "apply must make the same authorization decision");
  assert.match(appliedRetained.reason, /still has this directory open/);
  assert.equal(fs.existsSync(auth), true);

  fs.closeSync(fd);
  const finished = sweepLeases({ apply: true });
  const removed = finished.removed.find((entry) => entry.dir === lease.dir);
  if (removed) {
    assert.equal(fs.existsSync(lease.dir), false);
  } else {
    const retained = finished.retained.find((entry) => entry.dir === lease.dir);
    assert.match(retained.reason, UNKNOWN_DIRECTORY_USAGE);
    t.diagnostic("post-close sweep retained because the host-wide usage scan is incomplete");
    fs.rmSync(lease.dir, { recursive: true, force: true });
  }
  fs.rmSync(lease.metaPath, { force: true });
});

test("releasing a tombstoned lease re-probes too, not only the sweep", (t) => {
  // FOUND IN REVIEW. sweepLeases() re-probed a released record, but
  // releaseLease() fell through to proveLeaseReleasable(), where `released` was
  // immediately removable. A failed tmux turn calls the owner cleanup TWICE --
  // the turn's catch and the setup envelope -- so if a late pane recreated the
  // directory between those two calls, the second deleted it without checking
  // the recorded consumer. Both paths must apply the same rule.
  const lease = newLease();
  fs.writeFileSync(
    lease.metaPath,
    JSON.stringify({
      schema_version: 1,
      lease_id: lease.id,
      state: "released",
      released_at: new Date().toISOString(),
      consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
    })
  );

  const refused = releaseLease(lease);
  assert.equal(refused.released, false, "a released record whose consumer is alive must retain");
  assert.match(refused.reason, /running again/);
  assert.equal(fs.existsSync(lease.dir), true);

  // And once that consumer really is gone, it goes -- on a host that can prove
  // the directory itself is unused. A restricted host must retain instead.
  fs.writeFileSync(
    lease.metaPath,
    JSON.stringify({
      schema_version: 1,
      lease_id: lease.id,
      state: "released",
      released_at: new Date().toISOString(),
      consumer: { kind: "headless", pid: 999999, pgid: 999999 },
    })
  );
  const finished = releaseAllowingUnknownDirectory(lease);
  if (!releasedOrRetainedUnknown(t, lease, finished, "successful tombstone reclamation")) {
    fs.rmSync(lease.dir, { recursive: true, force: true });
  }
  fs.rmSync(lease.metaPath, { force: true });
});

test("unreadable metadata retains, with no ownership shortcut", () => {
  // The counterweight to the above: ownership establishes that this process
  // allocated the path, never that nothing is using what is there now.
  const lease = newLease();
  fs.rmSync(lease.metaPath, { force: true });
  const refused = releaseLease(lease);
  assert.equal(refused.released, false, "an owned handle is not a consumer proof");
  assert.match(refused.reason, /metadata is/);
  assert.equal(fs.existsSync(lease.dir), true);
  fs.rmSync(lease.dir, { recursive: true, force: true });
});

test("an unattributable directory is retained, not aged out", () => {
  // Both previous designs reclaimed these -- first on ownership, then after 24h
  // of inactivity. Both were reachable while a consumer was alive: an idle
  // process can hold a directory for a day without touching a file. With the
  // record beside the directory and a tombstone left on release, the case that
  // produced unattributable directories is handled on evidence, so this can go
  // back to the rule the rest of the module follows -- what cannot be classified
  // is kept.
  const orphan = path.join(runtimeDir(), "d".repeat(32));
  fs.mkdirSync(path.join(orphan, "codex-home"), { recursive: true });

  for (const now of [Date.now(), Date.now() + 30 * 24 * 60 * 60 * 1000]) {
    const receipt = sweepLeases({ apply: true, now });
    assert.ok(
      receipt.retained.some((r) => r.dir === orphan),
      "an unattributable directory must be retained however old it is"
    );
    assert.equal(fs.existsSync(orphan), true);
  }
  fs.rmSync(orphan, { recursive: true, force: true });
});

test("a spawn the owner watched fail is not the same as one that may have happened", (t) => {
  // FOUND IN REVIEW. The headless engine writes `spawning` with only a kind
  // before spawn(), and an identity-less spawning lease is retained until the
  // next reboot -- correctly, because a crash there leaves no portable proof
  // that spawn() did not happen. But an ordinary missing-binary failure is not
  // that case: spawn() THREW, so no process exists, and the owner watched it.
  // Without recording that, a typo in a manifest held a credential copy for the
  // whole boot, or forever on a host with no boot identity.
  const crashed = newLease();
  transitionLease(crashed, "spawning", { consumer: { kind: "headless" } });
  assert.equal(
    releaseLease(crashed).released,
    false,
    "the ambiguous crash window must still retain"
  );
  fs.rmSync(crashed.dir, { recursive: true, force: true });
  fs.rmSync(crashed.metaPath, { force: true });

  const observed = newLease();
  fs.mkdirSync(path.join(observed.dir, "codex-home"), { recursive: true });
  fs.writeFileSync(path.join(observed.dir, "codex-home", "auth.json"), '{"token":"x"}');
  transitionLease(observed, "spawning", {
    consumer: { kind: "headless", spawn_outcome: "failed" },
  });
  const observedRelease = releaseAllowingUnknownDirectory(observed);
  if (releasedOrRetainedUnknown(t, observed, observedRelease, "successful failed-spawn cleanup")) {
    assert.equal(fs.existsSync(observed.dir), false);
  } else {
    fs.rmSync(observed.dir, { recursive: true, force: true });
    fs.rmSync(observed.metaPath, { force: true });
  }
});

test("an incomplete usage scan is not a free one", (t) => {
  // REPRODUCED BY THE REVIEWER, against code I had just written. `lsof -w`
  // suppresses warnings -- including "can't opendir" -- so a lease containing an
  // unreadable subdirectory with a held file beneath it answered `free`, and the
  // removal then UNLINKED that held file before failing on the non-empty parent.
  // On POSIX, unlink succeeds on open files, so this probe is the only thing
  // between a live process and its credentials.
  if (process.platform !== "darwin") {
    t.skip("exercises the lsof path specifically");
    return;
  }
  const lease = newLease();
  const deep = path.join(lease.dir, "codex-home", "deep");
  fs.mkdirSync(deep, { recursive: true });
  const held = path.join(deep, "auth.json");
  fs.writeFileSync(held, '{"token":"held"}');

  const holder = spawn("/bin/sh", ["-c", `exec 9<${JSON.stringify(held)}; sleep 20`], {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  t.after(() => {
    try {
      fs.chmodSync(deep, 0o755);
    } catch {}
    try {
      process.kill(-holder.pid, "SIGKILL");
    } catch {}
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
  });
  execFileSync("sh", ["-c", "sleep 0.6"]);
  fs.chmodSync(deep, 0o000);

  transitionLease(lease, "active", {
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
      pane_pid: 999999,
    },
  });
  const verdict = releaseLease(lease);
  assert.equal(verdict.released, false, "a scan that could not look everywhere must retain");
  fs.chmodSync(deep, 0o755);
  assert.equal(fs.existsSync(held), true, "and the held credential must still be there");
});

test("native macOS lsof removes a lifecycle-proven unused runtime lease", (t) => {
  if (process.platform !== "darwin") {
    t.skip("exercises the native macOS lsof binary at the deletion boundary");
    return;
  }

  const lease = newLease();
  t.after(() => {
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
  });
  assert.equal(
    fs.statSync(lease.dir).mode & 0o777,
    0o700,
    "precondition: runtime leases are private"
  );

  // The owner observed spawn() fail before it returned a process identity. That
  // is the durable lifecycle proof; the deletion choke point must still obtain
  // a fresh native lsof no-use result before removing the directory.
  transitionLease(lease, "spawning", {
    consumer: { kind: "headless", spawn_outcome: "failed" },
  });
  const result = releaseLease(lease);

  assert.deepEqual(
    result,
    { released: true, reason: null },
    "missing, broken, or incorrectly invoked lsof must prevent release on macOS"
  );
  assert.equal(fs.existsSync(lease.dir), false, "the lifecycle-proven lease is removed");
  assert.equal(meta(lease).state, "released", "the durable tombstone survives removal");
});

test("a released record with no probeable consumer is retained", () => {
  // Falling through to the usage check here let a null, partial, or unknown-kind
  // consumer authorize deletion whenever usage happened to be `free` -- and
  // usage cannot see a process that closed the file and kept the token. Only an
  // owner that PROVED nothing was ever started may reclaim without one.
  for (const consumer of [null, {}, { kind: "something-future" }, { kind: "headless" }]) {
    const verdict = proveLeaseReleasable({ state: "released", consumer });
    assert.equal(verdict.removable, false, JSON.stringify(consumer));
    assert.match(verdict.reason, /no consumer that can be probed/);
  }

  // The exception, and it is explicit rather than inferred.
  assert.equal(
    proveLeaseReleasable({ state: "released", consumer: null, consumer_never_created: true })
      .removable,
    true,
    "an owner-proven never-started lease may be reclaimed without a consumer"
  );
});

test("prior-boot lifecycle proof survives the released tombstone for release and sweep", () => {
  const script = `
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const cp = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.SystemRoot = "C:\\\\Windows";
    cp.execFileSync = (file) => {
      if (!String(file).endsWith("\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe")) {
        throw new Error("unexpected executable: " + file);
      }
      return "638923456789012345";
    };
    syncBuiltinESMExports();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-prior-boot-release-"));
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.HOMEDRIVE = ""; process.env.HOMEPATH = home;

    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((leaseApi) => {
      const current = leaseApi.bootIdentity();
      const oldBoot = { ...current, id: "previous-test-boot" };
      const makeLease = (turnId) => {
        const turnDir = path.join(home, ".dualog", "sessions", "prior-boot", "turns", turnId);
        fs.mkdirSync(turnDir, { recursive: true });
        return leaseApi.allocateLease({
          sessionId: "prior-boot",
          turnId,
          agent: "codex",
          engine: "headless",
          turnDir,
          runnerPid: 999999,
        });
      };
      const setPreviousBoot = (lease) => {
        const metadata = JSON.parse(fs.readFileSync(lease.metaPath, "utf-8"));
        fs.writeFileSync(lease.metaPath, JSON.stringify({ ...metadata, boot: oldBoot }));
      };
      const releaseAndSweep = (lease) => {
        const released = leaseApi.releaseLease(lease);
        const tombstone = JSON.parse(fs.readFileSync(lease.metaPath, "utf-8"));
        fs.mkdirSync(path.join(lease.dir, "recreated"), { recursive: true });
        const dry = leaseApi.sweepLeases();
        const applied = leaseApi.sweepLeases({ apply: true });
        leaseApi.sweepLeases({ apply: true, now: Date.now() + 25 * 60 * 60 * 1000 });
        return {
          released,
          tombstone,
          dryRemoved: dry.removed.some((entry) => entry.dir === lease.dir && entry.applied === false),
          appliedRemoved: applied.removed.some(
            (entry) => entry.dir === lease.dir && entry.applied === true
          ),
          survives: fs.existsSync(lease.dir),
          recordSurvives: fs.existsSync(lease.metaPath),
        };
      };

      const direct = makeLease("strict-direct");
      let directError = null;
      try { leaseApi.removeLeaseDirectory(direct.dir); }
      catch (error) { directError = error.message; }
      const directSurvivesAfterCall = fs.existsSync(direct.dir);

      const preSpawn = makeLease("pre-spawn");
      leaseApi.transitionLease(preSpawn, "projecting");
      const preSpawnRelease = leaseApi.releaseLease(preSpawn);

      const observedHeadless = makeLease("observed-headless");
      leaseApi.transitionLease(observedHeadless, "active", {
        consumer: {
          kind: "headless",
          pid: 999999,
          pgid: null,
          windows_tree_termination: "wrapper-exit-observed",
        },
      });
      const observedHeadlessRelease = leaseApi.releaseLease(observedHeadless);

      const legacyHeadless = makeLease("legacy-headless");
      leaseApi.transitionLease(legacyHeadless, "active", {
        consumer: { kind: "headless", pid: 999999, pgid: null },
      });
      const legacyHeadlessRelease = leaseApi.releaseLease(legacyHeadless);

      const sameBoot = makeLease("same-boot");
      leaseApi.transitionLease(sameBoot, "spawning", { consumer: null });
      const sameBootRelease = leaseApi.releaseLease(sameBoot);
      const sameBootSweep = leaseApi.sweepLeases({ apply: true });

      const identityless = makeLease("identityless");
      leaseApi.transitionLease(identityless, "spawning", { consumer: null });
      setPreviousBoot(identityless);
      const identitylessResult = releaseAndSweep(identityless);

      const windowsTree = makeLease("windows-tree");
      leaseApi.transitionLease(windowsTree, "active", {
        consumer: {
          kind: "headless",
          pid: 999999,
          pgid: 999999,
          windows_tree_termination: "failed",
        },
      });
      setPreviousBoot(windowsTree);
      const windowsTreeResult = releaseAndSweep(windowsTree);

      console.log(JSON.stringify({
        current,
        directError,
        directSurvivesAfterCall,
        preSpawnRelease,
        preSpawnSurvives: fs.existsSync(preSpawn.dir),
        observedHeadlessRelease,
        observedHeadlessSurvives: fs.existsSync(observedHeadless.dir),
        legacyHeadlessRelease,
        legacyHeadlessSurvives: fs.existsSync(legacyHeadless.dir),
        sameBootRelease,
        sameBootRemoved: sameBootSweep.removed.some((entry) => entry.dir === sameBoot.dir),
        sameBootSurvives: fs.existsSync(sameBoot.dir),
        identitylessResult,
        windowsTreeResult,
      }));
    });
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.equal(out.current.precise, true);
  assert.equal(out.current.source, "win32.last-boot-up-time");
  assert.match(out.directError, /could not be determined/);
  assert.equal(out.directSurvivesAfterCall, true, "the public Windows removal path is strict");
  assert.deepEqual(out.preSpawnRelease, { released: true, reason: null });
  assert.equal(out.preSpawnSurvives, false, "owner-proven no-spawn cleanup may proceed");
  assert.deepEqual(out.observedHeadlessRelease, { released: true, reason: null });
  assert.equal(
    out.observedHeadlessSurvives,
    false,
    "an explicitly observed Windows foreground lifecycle may proceed"
  );
  assert.equal(out.legacyHeadlessRelease.released, false);
  assert.match(out.legacyHeadlessRelease.reason, /could not be determined/);
  assert.equal(
    out.legacyHeadlessSurvives,
    true,
    "a legacy wrapper-only record cannot relax Windows handle uncertainty"
  );
  assert.equal(out.sameBootRelease.released, false, "same-boot spawning ambiguity must retain");
  assert.equal(out.sameBootRemoved, false, "same-boot sweep must retain");
  assert.equal(out.sameBootSurvives, true, "same-boot credential directory must survive");
  for (const [name, result] of [
    ["identitylessResult", out.identitylessResult],
    ["windowsTreeResult", out.windowsTreeResult],
  ]) {
    assert.deepEqual(result.released, { released: true, reason: null }, name);
    assert.equal(result.tombstone.state, "released", name);
    assert.ok(["spawning", "active"].includes(result.tombstone.released_from_state), name);
    assert.equal(
      result.tombstone.consumer_never_created,
      undefined,
      `${name}: prior-boot proof must not be rewritten as never-created`
    );
    assert.equal(result.dryRemoved, true, `${name}: dry-run must reproduce authorization`);
    assert.equal(result.appliedRemoved, true, `${name}: apply must reproduce authorization`);
    assert.equal(result.survives, false, `${name}: the recreated directory should be swept`);
    assert.equal(
      result.recordSurvives,
      true,
      `${name}: the permanent marker must keep late recreation attributable`
    );
  }
  assert.equal(out.identitylessResult.tombstone.released_from_state, "spawning");
  assert.equal(out.windowsTreeResult.tombstone.released_from_state, "active");
});

test("a pre-spawn release records that nothing was ever started", (t) => {
  // The tombstone rule is "no probeable consumer means retain". A lease released
  // BEFORE anything spawned legitimately has none -- so the owner records that
  // explicitly, rather than the reaper inferring it from an absence.
  const lease = newLease();
  transitionLease(lease, "projecting");
  const initialRelease = releaseAllowingUnknownDirectory(lease);
  if (!releasedOrRetainedUnknown(t, lease, initialRelease, "successful pre-spawn cleanup")) {
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
    return;
  }

  const tombstone = JSON.parse(fs.readFileSync(lease.metaPath, "utf-8"));
  assert.equal(tombstone.state, "released");
  assert.equal(
    tombstone.consumer_never_created,
    true,
    "an owner that watched nothing start must say so on the record"
  );

  // Which is what lets a recreated directory be reclaimed here and nowhere else.
  fs.mkdirSync(path.join(lease.dir, "codex-home"), { recursive: true });
  const receipt = sweepLeases({ apply: true });
  const removed = sweepRemovedOrRetainedUnknown(
    t,
    lease,
    receipt,
    "successful never-created sweep"
  );
  if (!removed) fs.rmSync(lease.dir, { recursive: true, force: true });
  fs.rmSync(lease.metaPath, { force: true });
});

test("the sweep keeps a recreated directory whose record names no probeable consumer", () => {
  // Same rule as proveLeaseReleasable, in the branch that acts on a live
  // directory. Without it, a null or partial consumer record authorized deleting
  // a recreated home whenever the usage probe happened to answer `free`.
  const lease = newLease();
  fs.writeFileSync(
    lease.metaPath,
    JSON.stringify({
      schema_version: 1,
      lease_id: lease.id,
      state: "released",
      released_at: new Date().toISOString(),
      consumer: { kind: "something-a-future-version-writes" },
    })
  );
  fs.mkdirSync(path.join(lease.dir, "codex-home"), { recursive: true });

  const receipt = sweepLeases({ apply: true });
  const retained = receipt.retained.find((r) => r.dir === lease.dir);
  assert.ok(retained, "a record with no probeable consumer must retain its directory");
  assert.match(retained.reason, /no (?:probeable )?consumer|no consumer that can be probed/);
  assert.equal(fs.existsSync(lease.dir), true);
  fs.rmSync(lease.dir, { recursive: true, force: true });
  fs.rmSync(lease.metaPath, { force: true });
});

test("a tombstone is never aged out, even after its consumer is proven gone", () => {
  // FOUND IN REVIEW. Even a fresh absence probe cannot be coupled atomically to
  // unlinking the sibling record. A process can remember the path, recreate its
  // home after that probe, and leave it unattributable if the marker is then
  // discarded. The tiny record therefore outlives the credential directory.
  const lease = newLease();
  transitionLease(lease, "active", {
    consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
  });
  fs.writeFileSync(
    lease.metaPath,
    JSON.stringify({
      schema_version: 1,
      lease_id: lease.id,
      state: "released",
      released_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
    })
  );
  fs.rmSync(lease.dir, { recursive: true, force: true });

  sweepLeases({ apply: true, now: Date.now() });
  assert.equal(
    fs.existsSync(lease.metaPath),
    true,
    "a long-expired record whose consumer is alive must be kept"
  );

  // Consumer absence authorizes removing a PRESENT directory. It still cannot
  // authorize removing the last record while that directory is absent.
  fs.writeFileSync(
    lease.metaPath,
    JSON.stringify({
      schema_version: 1,
      lease_id: lease.id,
      state: "released",
      released_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      consumer: { kind: "headless", pid: 999999, pgid: 999999 },
    })
  );
  sweepLeases({ apply: true, now: Date.now() });
  assert.equal(
    fs.existsSync(lease.metaPath),
    true,
    "consumer absence cannot make sibling-record unlink atomic"
  );
  fs.rmSync(lease.metaPath, { force: true });
});

test("a spent marker survives recreation and concurrent replacement during sweep", () => {
  const lease = newLease();
  const oldRecord = {
    schema_version: 1,
    lease_id: lease.id,
    state: "released",
    released_from_state: "projecting",
    release_generation: lease.id,
    released_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    consumer_never_created: true,
    consumer: null,
  };
  fs.writeFileSync(lease.metaPath, JSON.stringify(oldRecord));
  fs.rmSync(lease.dir, { recursive: true, force: true });

  const replacement = {
    ...oldRecord,
    released_from_state: "active",
    replacement_revision: "arrived-after-absence-check",
    consumer_never_created: false,
    consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
  };
  const originalReadFileSync = fs.readFileSync;
  let interleaved = false;
  fs.readFileSync = (target, ...args) => {
    const bytes = originalReadFileSync(target, ...args);
    if (!interleaved && String(target) === lease.metaPath) {
      interleaved = true;
      // Exact old failure window: the sweep had observed owner absence, then a
      // late process recreated the directory and a concurrent writer replaced
      // the sibling record before the sweep unlinked that pathname.
      fs.mkdirSync(path.join(lease.dir, "codex-home"), { recursive: true });
      fs.writeFileSync(path.join(lease.dir, "codex-home", "late.json"), "{}");
      fs.writeFileSync(lease.metaPath, JSON.stringify(replacement));
    }
    return bytes;
  };

  let receipt;
  try {
    receipt = sweepLeases({ apply: true, now: Date.now() });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(interleaved, true, "the deterministic interleaving must have occurred");
  assert.equal(fs.existsSync(lease.dir), true, "the recreated generation survives this snapshot");
  assert.equal(fs.existsSync(lease.metaPath), true, "the replacement marker must never be unlinked");
  assert.equal(
    JSON.parse(fs.readFileSync(lease.metaPath, "utf-8")).replacement_revision,
    replacement.replacement_revision,
    "sweep must not unlink a concurrent record replacement"
  );
  assert.ok(
    receipt.retained.some((entry) => entry.dir === lease.dir),
    "the snapshot reports the permanent marker conservatively"
  );

  fs.rmSync(lease.dir, { recursive: true, force: true });
  fs.rmSync(lease.metaPath, { force: true });
});

test("a release that cannot persist its tombstone keeps the directory", (t) => {
  // Removing anyway left the credential directory gone AND no record, so a late
  // recreation could never be attributed -- destroying exactly the evidence the
  // sibling-record design exists to preserve, and reporting success while doing it.
  if (process.platform === "win32") {
    t.skip("Windows chmod does not provide a deterministic unwritable-directory fixture");
    return;
  }
  const lease = newLease();
  transitionLease(lease, "active", {
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
      pane_pid: 999999,
    },
  });
  // Readable but NOT writable: the record is where it belongs, and the runtime
  // root denies the atomic write. That is the case being tested -- an unreadable
  // record takes a different branch entirely.
  const root = runtimeDir();
  const originalMode = fs.statSync(root).mode & 0o777;
  fs.chmodSync(root, 0o500);
  let result;
  try {
    result = releaseLease(lease);
  } finally {
    fs.chmodSync(root, originalMode);
  }

  assert.equal(result.released, false, "a release that cannot be recorded must not destroy");
  assert.match(
    result.reason,
    /could not be persisted|whether this directory is in use could not be determined/u,
    "the release must fail closed at the first unavailable proof"
  );
  assert.equal(fs.existsSync(lease.dir), true, "and the directory must survive");
  assert.equal(fs.existsSync(lease.metaPath), true, "as must the record it could not replace");

  fs.rmSync(lease.dir, { recursive: true, force: true });
  fs.rmSync(lease.metaPath, { force: true });
});

test("a never-created marker remains as compact attribution", (t) => {
  // No consumer existed, so the credential directory can be removed. The
  // sibling marker still cannot be unlinked atomically with continued path
  // absence, and remains as the bounded bookkeeping cost of safe recreation.
  for (const state of ["projecting", "spawning"]) {
    const lease = newLease();
    if (state === "spawning") {
      transitionLease(lease, "spawning", {
        consumer: { kind: "headless", spawn_outcome: "failed" },
      });
    } else {
      transitionLease(lease, "projecting");
    }

    const result = releaseAllowingUnknownDirectory(lease);
    if (!releasedOrRetainedUnknown(t, lease, result, `${state} marker cleanup`)) {
      fs.rmSync(lease.dir, { recursive: true, force: true });
      fs.rmSync(lease.metaPath, { force: true });
      continue;
    }
    assert.equal(fs.existsSync(lease.dir), false, `${state}: the directory goes`);
    assert.equal(fs.existsSync(lease.metaPath), true, `${state}: the marker remains for now`);

    // Fresh or old: kept, because age never proves future path absence.
    sweepLeases({ apply: true });
    assert.equal(fs.existsSync(lease.metaPath), true, `${state}: not reaped while fresh`);

    sweepLeases({ apply: true, now: Date.now() + 25 * 60 * 60 * 1000 });
    assert.equal(fs.existsSync(lease.metaPath), true, `${state}: age cannot erase attribution`);
    fs.rmSync(lease.metaPath, { force: true });
  }
});

test("a spent lease record remains after its directory is gone", (t) => {
  // Tombstones are tiny metadata. Keeping them is necessary because no finite
  // age establishes that a process will not recreate the canonical path later.
  const lease = newLease();
  transitionLease(lease, "active", {
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
    },
  });
  const result = releaseAllowingUnknownDirectory(lease);
  if (!releasedOrRetainedUnknown(t, lease, result, "spent-record cleanup")) {
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
    return;
  }
  assert.equal(fs.existsSync(lease.metaPath), true, "the tombstone outlives the directory");

  // Not while it is fresh: a recreation may still be coming.
  sweepLeases({ apply: true });
  assert.equal(fs.existsSync(lease.metaPath), true);

  const later = Date.now() + 25 * 60 * 60 * 1000;
  sweepLeases({ apply: true, now: later });
  assert.equal(fs.existsSync(lease.metaPath), true, "and age cannot erase attribution");
  fs.rmSync(lease.metaPath, { force: true });
});

// --- the sweep -----------------------------------------------------------------

test("the sweep reports what it will not touch, and touches nothing on a dry run", (t) => {
  const stray = path.join(runtimeDir(), "definitely-not-a-lease-id");
  fs.mkdirSync(stray, { recursive: true });

  const malformed = path.join(runtimeDir(), "c".repeat(32));
  fs.mkdirSync(malformed, { recursive: true });
  fs.writeFileSync(path.join(malformed, "lease.json"), "{ not json");

  const live = newLease();
  transitionLease(live, "active", {
    consumer: { kind: "headless", pid: process.pid, pgid: process.pid },
  });

  const dead = newLease();
  transitionLease(dead, "active", {
    consumer: { kind: "headless", pid: 999999, pgid: 999999 },
  });

  const dry = sweepLeases();
  const retainedDirs = dry.retained.map((r) => r.dir);
  assert.ok(retainedDirs.includes(stray), "an unknown directory is reported, never removed");
  assert.ok(retainedDirs.includes(malformed), "unreadable metadata retains");
  assert.ok(retainedDirs.includes(live.dir), "a live consumer retains");
  const dryRemovedDead = dry.removed.find((r) => r.dir === dead.dir);
  const dryRetainedDead = dry.retained.find((r) => r.dir === dead.dir);
  assert.notEqual(Boolean(dryRemovedDead), Boolean(dryRetainedDead));
  if (dryRemovedDead) {
    assert.equal(dryRemovedDead.applied, false);
  } else {
    const retainedDead = dryRetainedDead;
    assert.ok(retainedDead, "an unprovably free dead consumer must still retain");
    assert.match(retainedDead.reason, /could not be determined/);
  }
  assert.equal(fs.existsSync(dead.dir), true, "a dry run changes nothing");

  const applied = sweepLeases({ apply: true });
  const appliedRemovedDead = applied.removed.find((r) => r.dir === dead.dir);
  const appliedRetainedDead = applied.retained.find((r) => r.dir === dead.dir);
  assert.notEqual(Boolean(appliedRemovedDead), Boolean(appliedRetainedDead));
  if (appliedRemovedDead) {
    assert.equal(appliedRemovedDead.applied, true);
    assert.equal(fs.existsSync(dead.dir), false);
    const tombstone = JSON.parse(fs.readFileSync(dead.metaPath, "utf-8"));
    assert.equal(tombstone.state, "released", "ordinary sweep must persist a tombstone first");
    assert.equal(tombstone.released_from_state, "active");
    assert.ok(tombstone.released_at);
    sweepLeases({ apply: true, now: Date.now() + 25 * 60 * 60 * 1000 });
    assert.equal(fs.existsSync(dead.metaPath), true, "the spent sweep tombstone remains attributable");
  } else {
    const retainedDead = appliedRetainedDead;
    assert.ok(retainedDead, "apply must not turn unknown directory usage into permission");
    assert.match(retainedDead.reason, /could not be determined/);
    assert.equal(fs.existsSync(dead.dir), true);
  }
  assert.equal(fs.existsSync(live.dir), true, "the live one is still there");
  assert.equal(fs.existsSync(stray), true);
  assert.equal(fs.existsSync(malformed), true);

  fs.rmSync(stray, { recursive: true, force: true });
  fs.rmSync(malformed, { recursive: true, force: true });
  fs.rmSync(live.dir, { recursive: true, force: true });
  fs.rmSync(dead.dir, { recursive: true, force: true });
  fs.rmSync(dead.metaPath, { force: true });
});

// --- the turn paths, pinned at the source --------------------------------------

test("every exit from a partner turn releases its lease, and only on proof", () => {
  // Driving a real turn to completion needs tmux, a fake CLI and a live runner,
  // which tests/no-auto-kill.test.mjs already does for pane lifetime. What that
  // suite cannot see is a credential projection, so these two properties are
  // pinned structurally instead -- the same approach this repo uses for hook
  // fail-open and env containment.
  //
  // Both directions matter and they pull opposite ways. Never releasing is how
  // 176 credential copies accumulated. Releasing without proof deletes a home
  // out from under a CLI that is still running.
  const src = fs.readFileSync(
    new URL("../src/partner-invocation.mjs", import.meta.url),
    "utf-8"
  ).replace(/\r\n?/gu, "\n");

  const releases = (src.match(/^.*releaseLeaseQuietly\([^)]*\).*$/gm) || []).filter(
    (line) => !line.includes("function releaseLeaseQuietly")
  );
  assert.equal(
    releases.length,
    4,
    "a rejected turn, a completed turn, a failed turn, and a failed SETUP each release"
  );

  // The fourth is the setup envelope. Credentials are projected before the
  // turn's own try/catch, so a rendering or config-write error escaped both
  // release paths -- and since the runner survives a failed turn, that
  // projection then sat on disk until the whole session ended.
  assert.match(
    src,
    /\} catch \(setupErr\) \{\s*\n\s*releaseLeaseQuietly\(lease, log\);\s*\n\s*throw setupErr;/,
    "the pre-pane setup must release before rethrowing"
  );

  // EXACTLY ONE site may assert absence rather than prove it: the rejected turn,
  // where the API invariant says no process-creating call has been made. The
  // completed and failed paths pass no assertion, so releaseLease() has to
  // establish it from the recorded consumer.
  //
  // The completed path used to assert `consumerAbsent: verdict === "absent"`,
  // which trusted the TMUX verdict -- and a closed pane is not an exited
  // process, so it reclaimed the home while the partner was still shutting down.
  const asserted = (src.match(/consumerAbsent:/g) || []).length;
  assert.equal(asserted, 1, "only the rejected-turn release may assert absence");
  assert.match(src, /releaseLeaseQuietly\(lease, log, \{ consumerAbsent: true \}\)/);
  assert.equal(
    (src.match(/releaseLeaseQuietly\(lease, log\);/g) || []).length,
    3,
    "the completed, failed and setup paths must all prove rather than assert"
  );

  // And the completed path waits for the pane's PROCESS before reclaiming...
  assert.match(
    src,
    /partnerExited = await waitForPartnerPaneExit\(handle, PARTNER_EXIT_GRACE_MS\)/,
    "the completed turn must give the partner a chance to exit before cleanup"
  );
  // ...and only releases if that actually established absence. `owned` proves
  // this process created the lease, not that nothing is using it, so a partner
  // still alive after the grace period must keep its home.
  assert.match(
    src,
    /if \(partnerExited\) \{\s*\n\s*releaseLeaseQuietly\(lease, log\);/,
    "the release must be gated on the partner having exited"
  );

  // A spawn that failed after the pane existed carries the pane's process out
  // with the error, and that identity must be RECORDED before the release --
  // otherwise the lease is judged on the session name alone, and a session
  // teardown does not prove the process it ran has exited.
  assert.match(
    src,
    /if \([\s\S]{0,160}err\?\.panePidUnavailable === true[\s\S]{0,1800}tmux_transport: tmuxTransport,[\s\S]{0,300}tmux_distro: tmuxDistro,[\s\S]{0,300}tmux_launcher: tmuxLauncher,[\s\S]{0,300}tmux_control_binary: tmuxControlBinary,[\s\S]{0,300}tmux_socket_name: tmuxSocketName,[\s\S]{0,300}pane_pid: err\.panePid,[\s\S]{0,200}pane_pid_unavailable: err\.panePidUnavailable === true/,
    "a failed spawn must record the carried pane process before releasing"
  );

  // The failed-spawn shortcut probes TWICE across a settle: the tmux SERVER is a
  // separate process from the client we ran, so a killed client's queued
  // new-session can create the pane just after the call returns.
  const leaseSrc = fs.readFileSync(
    new URL("../src/runtime-lease.mjs", import.meta.url),
    "utf-8"
  ).replace(/\r\n?/gu, "\n");
  const settled = leaseSrc.match(/sleepSync\(SPAWN_SETTLE_MS\)/g) || [];
  assert.equal(settled.length, 1, "the failed-spawn shortcut must settle before its second probe");
  assert.equal(
    (leaseSrc.match(/probeConsumer\(spawnConsumer\) === "absent"/g) || []).length,
    2,
    "and must probe on both sides of that settle"
  );

  const headless = fs.readFileSync(
    new URL("../src/engines/headless.mjs", import.meta.url),
    "utf-8"
  ).replace(/\r\n?/gu, "\n");
  assert.match(
    headless,
    /\} finally \{[\s\S]{0,400}releaseLease\(lease\)/,
    "the headless engine has a dozen exit paths, so its release must be in a finally"
  );
});

test("same-UID ambiguity relaxation stays private to durable lifecycle cleanup", () => {
  const usageSrc = fs
    .readFileSync(new URL("../src/directory-usage.mjs", import.meta.url), "utf-8")
    .replace(/\r\n?/gu, "\n");
  const leaseSrc = fs
    .readFileSync(new URL("../src/runtime-lease.mjs", import.meta.url), "utf-8")
    .replace(/\r\n?/gu, "\n");

  assert.match(usageSrc, /export function probeDirectoryUsageEvidence\(dir\)/);
  assert.doesNotMatch(
    usageSrc,
    /export function probeDirectoryInUseAfterConsumerProof/u,
    "the directory module may classify ambiguity but must never authorize it"
  );
  assert.doesNotMatch(
    leaseSrc,
    /export function removeLeaseDirectoryAfterConsumerProof/u,
    "the relaxed deletion path must not be public"
  );
  assert.equal(
    (leaseSrc.match(/removeLeaseDirectoryAfterConsumerProof\(/gu) || []).length,
    3,
    "only its definition, finishRelease, and released-tombstone sweep may reach it"
  );
  assert.match(
    leaseSrc,
    /function finishRelease\([\s\S]+writeJsonAtomic\(metaPathFor\(dir\)[\s\S]+removeLeaseDirectoryAfterConsumerProof\(dir\)/u,
    "the tombstone must be durable before the private deletion check"
  );
  assert.match(
    leaseSrc,
    /const verdict = prospectiveLeaseRemovalVerdict\(dir, record\)[\s\S]{0,700}finishRelease\(dir, record\.metaPath, verdict\.releaseMeta\)/u,
    "ordinary sweep dry-run and apply must share prospective proof, then apply via finishRelease"
  );
  assert.match(
    leaseSrc,
    /consumerAbsent === true[\s\S]{0,200}record\.value\.runner_pid === process\.pid[\s\S]{0,200}\["allocated", "projecting", "ready"\]/u,
    "the caller assertion alone may authorize only this owner's pre-spawn states"
  );
});

test("a partner that outlives its pane keeps its lease until it really exits", async (t) => {
  // THE PRODUCTION INCIDENT, reproduced end to end against a real tmux server.
  //
  // codex flushes its models cache during shutdown, after its pane has closed.
  // Releasing on the tmux verdict alone deleted the home mid-shutdown, and the
  // partner then recreated it -- leaving a directory with a valid lease name and
  // no metadata that nothing could reclaim. This drives the same shape: a
  // process that survives its pane by a beat and writes into its home.
  if (process.platform === "win32") {
    t.skip("native POSIX tmux/process fixture; Windows tree lifecycle has dedicated coverage");
    return;
  }
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("tmux is not installed");
    return;
  }
  if (ORIGINAL_TMUX_BINARY === undefined) delete process.env.DUALOG_TMUX_BINARY;
  else process.env.DUALOG_TMUX_BINARY = ORIGINAL_TMUX_BINARY;
  t.after(() => {
    process.env.DUALOG_TMUX_BINARY = FIXTURE_TMUX_BINARY;
  });
  const { startTmuxSession, terminateTmuxSession } = await import("../src/tmux-runtime.mjs");
  const { probeProcess } = await import("../src/process-probe.mjs");

  const socket = `dualog-lease-outlive-${process.pid}`;
  const previousSocket = process.env.DUALOG_TMUX_SOCKET;
  process.env.DUALOG_TMUX_SOCKET = socket;
  t.after(() => {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    if (previousSocket === undefined) delete process.env.DUALOG_TMUX_SOCKET;
    else process.env.DUALOG_TMUX_SOCKET = previousSocket;
  });

  const lease = newLease();
  const home = path.join(lease.dir, "codex-home");
  fs.mkdirSync(home, { recursive: true });

  // Ignores the pane going away, then writes into its home -- exactly what a
  // cache flush during shutdown looks like from the outside.
  const script = path.join(lease.dir, "fake-partner.sh");
  fs.writeFileSync(
    script,
    `#!/bin/sh\ntrap '' TERM HUP\nsleep 2\necho '{}' > ${JSON.stringify(path.join(home, "models_cache.json"))}\n`
  );
  fs.chmodSync(script, 0o755);

  const handle = await startTmuxSession({
    sessionName: `dualog-outlive-${process.pid}`,
    cwd: lease.dir,
    command: script,
    args: [],
    env: {},
  });
  assert.ok(handle.panePid, "the pane's process must be identified");
  transitionLease(lease, "active", {
    consumer: {
      kind: "tmux",
      session_name: handle.sessionName,
      pane_pid: handle.panePid,
      tmux_transport: handle.tmuxTransport,
      tmux_distro: handle.tmuxDistro,
      tmux_launcher: handle.tmuxLauncher,
      tmux_control_binary: handle.tmuxControlBinary,
      tmux_socket_name: handle.tmuxSocketName,
    },
  });

  // Take the pane down. The tmux SESSION goes; the process does not.
  await terminateTmuxSession(handle);
  if (probeProcess(handle.panePid) === "alive") {
    const premature = releaseLease(lease);
    assert.equal(premature.released, false, "a partner still running must keep its home");
    assert.match(premature.reason, /still running/);
    assert.equal(fs.existsSync(home), true, "and the home it is about to write to must survive");
  }

  // Once it is genuinely gone, the lease goes with it.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && probeProcess(handle.panePid) !== "absent") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(probeProcess(handle.panePid), "absent", "the fake partner should have exited by now");
  const finished = releaseAllowingUnknownDirectory(lease);
  if (releasedOrRetainedUnknown(t, lease, finished, "successful post-process cleanup")) {
    assert.equal(fs.existsSync(lease.dir), false);
  } else {
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
  }
});

test("a setsid descendant keeps the lease, though no identity check can see it", async (t) => {
  // THE FINDING THAT BLOCKED THIS CHANGE, closed without a supervisor.
  //
  // Every identity-based answer reasons about LINEAGE, and lineage is exactly
  // what this child escapes: it calls setsid(), so it is in no process group we
  // recorded, and when its launcher exits it is reparented away entirely. A
  // process-tree supervisor is the usual fix and needs cgroups or a Job Object.
  //
  // Asking the kernel about the DIRECTORY instead answers the question that
  // actually governs deletion, and ancestry cannot hide from it.
  if (process.platform === "win32") {
    t.skip("POSIX setsid/process-group fixture; Windows tree lifecycle has separate coverage");
    return;
  }

  const lease = newLease();
  const home = path.join(lease.dir, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), '{"token":"held-by-a-descendant"}');

  // Detached AND setsid: no group we know, and reparented once its shell exits.
  const escapee = spawn("/bin/sh", ["-c", `cd ${JSON.stringify(home)} && exec sleep 30`], {
    detached: true,
    stdio: "ignore",
  });
  escapee.unref();
  t.after(() => {
    try {
      process.kill(-escapee.pid, "SIGKILL");
    } catch {}
    try {
      process.kill(escapee.pid, "SIGKILL");
    } catch {}
  });
  await new Promise((resolve) => setTimeout(resolve, 700));

  // The consumer we RECORDED is gone -- every identity check says "release".
  transitionLease(lease, "active", {
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
      pane_pid: 999999,
    },
  });

  const verdict = releaseLease(lease);
  assert.equal(verdict.released, false, "a descendant holding the home must keep the lease");
  assert.match(
    verdict.reason,
    /still has this directory open|whether this directory is in use could not be determined/u,
    "a detected holder or an incomplete usage scan must both retain"
  );
  assert.equal(
    fs.readFileSync(path.join(home, "auth.json"), "utf-8"),
    '{"token":"held-by-a-descendant"}',
    "and the credential it is using must survive"
  );

  // The sweep reaches the same conclusion, and reports it rather than acting.
  const receipt = sweepLeases({ apply: true });
  assert.ok(receipt.retained.some((r) => r.dir === lease.dir));
  assert.equal(fs.existsSync(lease.dir), true);

  // Once it really is gone, so is the lease.
  try {
    process.kill(-escapee.pid, "SIGKILL");
  } catch {}
  const { probeProcess } = await import("../src/process-probe.mjs");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && probeProcess(escapee.pid) !== "absent") {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(probeProcess(escapee.pid), "absent", "the detached holder must have exited");
  const finished = releaseAllowingUnknownDirectory(lease);
  if (releasedOrRetainedUnknown(t, lease, finished, "successful detached-holder cleanup")) {
    assert.equal(fs.existsSync(lease.dir), false, "and it is reclaimed once nothing holds it");
  } else {
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
  }
});

test("an undeterminable usage answer cannot authorize deletion at ANY path", (t) => {
  // REPRODUCED BY THE REVIEWER. The verdict retained on `unknown`, but the
  // deletion choke point rejected only `in-use` -- and several paths reach the
  // removal WITHOUT going through the verdict (the owner's failed-spawn
  // shortcut, the released-tombstone branch). So on a host with no lsof the
  // answer was `unknown` and the directory was removed anyway.
  const script = `
    process.env.PATH = "";
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = (target, ...args) => {
      if (String(target) === "/proc") {
        const error = new Error("procfs is unavailable");
        error.code = "ENOENT";
        throw error;
      }
      return originalReaddirSync(target, ...args);
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-unknown-"));
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.HOMEDRIVE = ""; process.env.HOMEPATH = home;
    const dir = path.join(home, ".dualog", "runtime", "a".repeat(32));
    fs.mkdirSync(path.join(dir, "codex-home"), { recursive: true });
    Promise.all([
      import(${JSON.stringify(new URL("../src/directory-usage.mjs", import.meta.url).href)}),
      import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}),
    ]).then(([u, l]) => {
      let refused = false;
      try { l.removeLeaseDirectory(dir); } catch { refused = true; }
      console.log(JSON.stringify({
        usage: u.probeDirectoryInUse(dir),
        refused,
        survives: fs.existsSync(dir),
      }));
    });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim());
  assert.equal(out.usage, "unknown", "precondition: neither /proc nor lsof reachable");
  assert.equal(out.refused, true, "the choke point must refuse an unanswerable usage query");
  assert.equal(out.survives, true);
});

test("only lifecycle-proven cleanup may relax an unrelated same-UID permission hole", () => {
  const script = `
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const crossSpawn = require("cross-spawn");
    const originalReadFileSync = fs.readFileSync;
    const originalReaddirSync = fs.readdirSync;
    const originalReadlinkSync = fs.readlinkSync;
    const originalStatSync = fs.statSync;
    const originalRenameSync = fs.renameSync;
    const hiddenPid = "424242";
    const holderPid = "424243";
    let leaseReal = null;
    let readableHolder = false;
    let restrictedProc = false;

    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
    const denied = (code) => {
      const error = new Error(code);
      error.code = code;
      throw error;
    };
    fs.readFileSync = (target, ...args) => {
      const value = String(target);
      if (value === "/proc/sys/kernel/random/boot_id") {
        return "current-proof-boot\\n";
      }
      if (value === "/proc/self/mountinfo") {
        return restrictedProc
          ? "148 146 0:72 / /proc rw,relatime - proc proc rw,hidepid=invisible\\n"
          : "148 146 0:72 / /proc rw,relatime - proc proc rw\\n";
      }
      if (
        value === "/proc/" + hiddenPid + "/status" ||
        value === "/proc/" + holderPid + "/status"
      ) {
        return "Name:\\tssh-agent-like\\nUid:\\t1000\\t1000\\t1000\\t1000\\n";
      }
      return originalReadFileSync(target, ...args);
    };
    fs.readdirSync = (target, ...args) => {
      const value = String(target);
      if (value === "/proc") return readableHolder ? [hiddenPid, holderPid] : [hiddenPid];
      if (value === "/proc/" + hiddenPid + "/fd") return denied("EACCES");
      if (value === "/proc/" + holderPid + "/fd") return [];
      return originalReaddirSync(target, ...args);
    };
    fs.readlinkSync = (target, ...args) => {
      if (String(target) === "/proc/" + hiddenPid + "/cwd") return denied("EACCES");
      if (String(target) === "/proc/" + holderPid + "/cwd") return leaseReal;
      return originalReadlinkSync(target, ...args);
    };
    fs.statSync = (target, ...args) => {
      const stat = originalStatSync(target, ...args);
      if (!leaseReal || String(target) !== leaseReal) return stat;
      return new Proxy(stat, {
        get(value, key) {
          if (key === "uid") return 1000;
          if (key === "mode") return (value.mode & ~0o777) | 0o700;
          const member = Reflect.get(value, key, value);
          return typeof member === "function" ? member.bind(value) : member;
        },
      });
    };
    fs.renameSync = (source, target) => {
      let movedGeneration = false;
      try {
        movedGeneration = leaseReal != null && fs.realpathSync(source) === leaseReal;
      } catch {}
      const result = originalRenameSync(source, target);
      if (movedGeneration) leaseReal = fs.realpathSync(target);
      return result;
    };

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-proof-mode-"));
    process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.HOMEDRIVE = ""; process.env.HOMEPATH = home;
    const fixtureTmux = path.join(home, "tmux-fixture");
    process.env.DUALOG_TMUX_BINARY = fixtureTmux;
    crossSpawn.sync = (command, args) => {
      if (command === fixtureTmux && Array.isArray(args) && args.includes("has-session")) {
        return {
          pid: 0,
          output: [null, "", "can't find session: fixture"],
          stdout: "",
          stderr: "can't find session: fixture",
          status: 1,
          signal: null,
        };
      }
      throw new Error("unexpected child process: " + command);
    };
    import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}).then((leaseApi) => {
      const makeLease = (turnId, engine = "headless") => {
        const turnDir = path.join(
          home,
          ".dualog",
          "sessions",
          "dialog-proof-0000",
          "turns",
          turnId
        );
        fs.mkdirSync(turnDir, { recursive: true });
        return leaseApi.allocateLease({
          sessionId: "dialog-proof-0000",
          turnId,
          agent: "codex",
          engine,
          turnDir,
        });
      };

      const lease = makeLease("t1");
      leaseReal = fs.realpathSync(lease.dir);
      leaseApi.transitionLease(lease, "projecting");

      let directError = null;
      try { leaseApi.removeLeaseDirectory(lease.dir); }
      catch (error) { directError = error.message; }
      const release = leaseApi.releaseLease(lease);
      const preSpawnTombstone = JSON.parse(fs.readFileSync(lease.metaPath, "utf-8"));

      const headless = makeLease("t2");
      leaseReal = fs.realpathSync(headless.dir);
      leaseApi.transitionLease(headless, "active", {
        consumer: { kind: "headless", pid: 999999, pgid: 999999 },
      });
      const headlessRelease = leaseApi.releaseLease(headless);

      const legacyTmux = makeLease("t3", "tmux-interactive");
      leaseReal = fs.realpathSync(legacyTmux.dir);
      leaseApi.transitionLease(legacyTmux, "active", {
        consumer: {
          kind: "tmux",
          session_name: "dualog-absent-legacy",
          tmux_transport: "local",
          tmux_distro: null,
          tmux_launcher: fixtureTmux,
          tmux_control_binary: fixtureTmux,
          tmux_socket_name: "dualog",
        },
      });
      const legacyTmuxRelease = leaseApi.releaseLease(legacyTmux);

      const readable = makeLease("t4");
      leaseReal = fs.realpathSync(readable.dir);
      leaseApi.transitionLease(readable, "active", {
        consumer: { kind: "headless", pid: 999999, pgid: 999999 },
      });
      readableHolder = true;
      const readableRelease = leaseApi.releaseLease(readable);
      readableHolder = false;

      const restricted = makeLease("t5");
      leaseReal = fs.realpathSync(restricted.dir);
      leaseApi.transitionLease(restricted, "projecting");
      restrictedProc = true;
      const restrictedRelease = leaseApi.releaseLease(restricted);
      restrictedProc = false;

      const oldSchema = makeLease("t6");
      leaseReal = fs.realpathSync(oldSchema.dir);
      leaseApi.transitionLease(oldSchema, "projecting");
      const oldSchemaMeta = JSON.parse(fs.readFileSync(oldSchema.metaPath, "utf-8"));
      fs.writeFileSync(oldSchema.metaPath, JSON.stringify({ ...oldSchemaMeta, schema_version: 0 }));
      const oldSchemaRelease = leaseApi.releaseLease(oldSchema);

      const wrongId = makeLease("t7");
      leaseReal = fs.realpathSync(wrongId.dir);
      leaseApi.transitionLease(wrongId, "projecting");
      const wrongIdMeta = JSON.parse(fs.readFileSync(wrongId.metaPath, "utf-8"));
      fs.writeFileSync(wrongId.metaPath, JSON.stringify({ ...wrongIdMeta, lease_id: "b".repeat(32) }));
      const wrongIdRelease = leaseApi.releaseLease(wrongId);

      const legacyRecord = makeLease("t8");
      leaseReal = fs.realpathSync(legacyRecord.dir);
      leaseApi.transitionLease(legacyRecord, "projecting");
      fs.renameSync(legacyRecord.metaPath, path.join(legacyRecord.dir, "lease.json"));
      const legacyRecordRelease = leaseApi.releaseLease(legacyRecord);
      const migratedLegacy = JSON.parse(fs.readFileSync(legacyRecord.metaPath, "utf-8"));

      const priorPreSpawn = makeLease("t9");
      leaseReal = fs.realpathSync(priorPreSpawn.dir);
      leaseApi.transitionLease(priorPreSpawn, "projecting");
      const priorMeta = JSON.parse(fs.readFileSync(priorPreSpawn.metaPath, "utf-8"));
      fs.writeFileSync(
        priorPreSpawn.metaPath,
        JSON.stringify({ ...priorMeta, boot: { ...priorMeta.boot, id: "previous-proof-boot" } })
      );
      const priorDry = leaseApi.sweepLeases();
      const priorApply = leaseApi.sweepLeases({ apply: true });
      const priorRelease = leaseApi.releaseLease(priorPreSpawn);
      const priorReleasedDry = leaseApi.sweepLeases();
      const priorReleasedApply = leaseApi.sweepLeases({ apply: true });

      console.log(JSON.stringify({
        directError,
        survivedDirectCall: directError != null,
        release,
        survivesAfterProof: fs.existsSync(lease.dir),
        preSpawnTombstone,
        headlessRelease,
        headlessSurvives: fs.existsSync(headless.dir),
        legacyTmuxRelease,
        legacyTmuxSurvives: fs.existsSync(legacyTmux.dir),
        readableRelease,
        readableSurvives: fs.existsSync(readable.dir),
        restrictedRelease,
        restrictedSurvives: fs.existsSync(restricted.dir),
        oldSchemaRelease,
        oldSchemaSurvives: fs.existsSync(oldSchema.dir),
        wrongIdRelease,
        wrongIdSurvives: fs.existsSync(wrongId.dir),
        legacyRecordRelease,
        legacyRecordSurvives: fs.existsSync(legacyRecord.dir),
        migratedLegacy,
        priorDryRetained: priorDry.retained.some((entry) => entry.dir === priorPreSpawn.dir),
        priorApplyRetained: priorApply.retained.some((entry) => entry.dir === priorPreSpawn.dir),
        priorRelease,
        priorReleasedDryRetained: priorReleasedDry.retained.some(
          (entry) => entry.dir === priorPreSpawn.dir
        ),
        priorReleasedApplyRetained: priorReleasedApply.retained.some(
          (entry) => entry.dir === priorPreSpawn.dir
        ),
        priorPreSpawnSurvives: fs.existsSync(priorPreSpawn.dir),
      }));
    });
  `;
  const out = JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
  assert.match(out.directError, /whether this directory is in use could not be determined/);
  assert.equal(out.survivedDirectCall, true, "the strict public choke point must retain");
  assert.deepEqual(out.release, { released: true, reason: null });
  assert.equal(out.survivesAfterProof, false, "owner-proven pre-spawn cleanup may proceed");
  assert.equal(out.preSpawnTombstone.schema_version, 1);
  assert.equal(out.preSpawnTombstone.state, "released");
  assert.equal(out.preSpawnTombstone.released_from_state, "projecting");
  assert.equal(out.preSpawnTombstone.consumer_never_created, true);

  assert.deepEqual(out.headlessRelease, { released: true, reason: null });
  assert.equal(
    out.headlessSurvives,
    false,
    "a freshly absent PID and PGID may relax an unrelated same-UID permission hole"
  );

  assert.equal(out.legacyTmuxRelease.released, false);
  assert.match(out.legacyTmuxRelease.reason, /could not be determined/);
  assert.equal(
    out.legacyTmuxSurvives,
    true,
    "session-name-only tmux absence is too weak to relax incomplete evidence"
  );

  assert.equal(out.readableRelease.released, false);
  assert.match(out.readableRelease.reason, /still has this directory open/);
  assert.equal(out.readableSurvives, true, "an actual readable holder always blocks");

  assert.equal(out.restrictedRelease.released, false);
  assert.match(out.restrictedRelease.reason, /could not be determined/);
  assert.equal(out.restrictedSurvives, true, "restricted proc enumeration remains fail-closed");

  assert.equal(out.oldSchemaRelease.released, false);
  assert.match(out.oldSchemaRelease.reason, /could not be determined/);
  assert.equal(
    out.oldSchemaSurvives,
    true,
    "a non-current record may pass only a strict free scan"
  );
  assert.equal(out.wrongIdRelease.released, false);
  assert.match(out.wrongIdRelease.reason, /could not be determined/);
  assert.equal(
    out.wrongIdSurvives,
    true,
    "a tombstone for another lease id cannot relax incomplete evidence"
  );
  assert.equal(out.legacyRecordRelease.released, false);
  assert.match(out.legacyRecordRelease.reason, /could not be determined/);
  assert.equal(out.legacyRecordSurvives, true, "a legacy in-directory record stays strict");
  assert.equal(
    out.migratedLegacy.release_relaxation_eligible,
    false,
    "migrating the tombstone must not upgrade legacy evidence"
  );
  assert.equal(out.priorDryRetained, true);
  assert.equal(out.priorApplyRetained, true);
  assert.equal(out.priorRelease.released, false);
  assert.match(out.priorRelease.reason, /could not be determined/);
  assert.equal(out.priorReleasedDryRetained, true);
  assert.equal(out.priorReleasedApplyRetained, true);
  assert.equal(
    out.priorPreSpawnSurvives,
    true,
    "a prior-boot pre-spawn proof must never relax Linux same-UID ambiguity"
  );
});

test("usage that cannot be determined retains, and never reads as free", (t) => {
  // The probe needs /proc or lsof. Where neither is reachable -- a stripped
  // container, a restricted PATH, or native Windows -- the answer is `unknown`,
  // and the strict verdict must retain. Reading it as "free" would turn missing
  // evidence into permission to delete a live partner's home.
  const script = `
    process.env.PATH = "";
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = (target, ...args) => {
      if (String(target) === "/proc") {
        const error = new Error("procfs is unavailable");
        error.code = "ENOENT";
        throw error;
      }
      return originalReaddirSync(target, ...args);
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-nolsof-"));
    Promise.all([
      import(${JSON.stringify(new URL("../src/directory-usage.mjs", import.meta.url).href)}),
      import(${JSON.stringify(new URL("../src/runtime-lease.mjs", import.meta.url).href)}),
    ]).then(([usage, lease]) => {
      const verdict = lease.proveLeaseReleasable(
        { state: "active", consumer: { kind: "headless", pid: 999999, pgid: 999999 } },
        { dir }
      );
      console.log(JSON.stringify({
        usage: usage.probeDirectoryInUse(dir),
        removable: verdict.removable,
        reason: verdict.reason,
      }));
    });
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim());
  assert.equal(out.usage, "unknown", "precondition: neither /proc nor lsof reachable");
  assert.equal(out.removable, false, "an undeterminable directory must not be deleted");
  assert.match(out.reason, /could not be determined/);
});

test("the removal choke point refuses a directory in use, whatever the caller believed", async (t) => {
  // Callers check usage for a legible receipt; this is what makes it
  // unskippable. A future path that forgets the check still cannot delete a home
  // out from under a running process.
  if (process.platform === "win32") {
    t.skip("POSIX live-cwd fixture; Windows strict removal is covered below");
    return;
  }
  const lease = newLease();
  const home = path.join(lease.dir, "codex-home");
  fs.mkdirSync(home, { recursive: true });

  const holder = spawn("/bin/sh", ["-c", `cd ${JSON.stringify(home)} && exec sleep 30`], {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  t.after(() => {
    try {
      process.kill(-holder.pid, "SIGKILL");
    } catch {}
  });
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.throws(
    () => removeLeaseDirectory(lease.dir),
    /a process still has this directory open/,
    "the choke point must refuse regardless of what the caller decided"
  );
  assert.equal(fs.existsSync(home), true);

  try {
    process.kill(-holder.pid, "SIGKILL");
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.rmSync(lease.dir, { recursive: true, force: true });
  fs.rmSync(lease.metaPath, { force: true });
});

test("the caller's own credential descriptor blocks strict removal and release until closed", (t) => {
  const strictLease = newLease();
  const strictAuth = path.join(strictLease.dir, "auth.json");
  fs.writeFileSync(strictAuth, '{"token":"strict-self-holder"}');
  const strictFd = fs.openSync(strictAuth, "r");
  try {
    assert.throws(
      () => removeLeaseDirectory(strictLease.dir),
      /a process still has this directory open|whether this directory is in use could not be determined/u,
      "the exported strict choke point must count the process calling it"
    );
    assert.equal(fs.existsSync(strictAuth), true);
  } finally {
    fs.closeSync(strictFd);
    fs.rmSync(strictLease.dir, { recursive: true, force: true });
    fs.rmSync(strictLease.metaPath, { force: true });
  }

  if (process.platform === "win32") {
    // There is no portable Windows handle scan. The assertion above is the
    // important boundary: callers without a durable lifecycle proof cannot turn
    // that unknown into permission. The private release path is tested with
    // synthetic Windows lifecycle records above.
    t.skip("Windows has no portable self-handle scan beyond the strict assertion above");
    return;
  }

  const releasedLease = newLease();
  const releasedAuth = path.join(releasedLease.dir, "auth.json");
  fs.writeFileSync(releasedAuth, '{"token":"release-self-holder"}');
  transitionLease(releasedLease, "active", {
    consumer: { kind: "headless", pid: 999999, pgid: 999999 },
  });
  const releasedFd = fs.openSync(releasedAuth, "r");
  const blocked = releaseLease(releasedLease);
  assert.equal(blocked.released, false);
  assert.match(blocked.reason, /a process still has this directory open/);
  assert.equal(fs.existsSync(releasedAuth), true, "release must retain while its caller holds auth");

  fs.closeSync(releasedFd);
  const finished = releaseLease(releasedLease);
  if (finished.released) {
    assert.equal(fs.existsSync(releasedLease.dir), false, "closing the descriptor permits release");
  } else {
    assert.match(finished.reason, UNKNOWN_DIRECTORY_USAGE);
    assert.equal(fs.existsSync(releasedLease.dir), true, "other incomplete evidence still retains");
    t.diagnostic("closing the caller descriptor exposed unrelated host-wide visibility ambiguity");
    fs.rmSync(releasedLease.dir, { recursive: true, force: true });
  }
  fs.rmSync(releasedLease.metaPath, { force: true });
});

// --- the property all of it exists for ----------------------------------------

test("a partner's credentials land in the lease and never in the session archive", async (t) => {
  // THE POINT. Config isolation used to seed a partner's real auth into
  // `<sessionDir>/codex-home` -- a directory kept so a conversation could be
  // reread months later -- so every session ever run retained a live credential
  // copy. 176 of them, 12 GiB, one of which reached a public repository.
  const { buildInvocationFromAdapter } = await import("../src/adapters/argv.mjs");
  const { getAdapter } = await import("../src/adapters/registry.mjs");

  const lease = newLease();
  const seedHome = path.join(ROOT, ".codex");
  fs.mkdirSync(seedHome, { recursive: true });
  fs.writeFileSync(path.join(seedHome, "auth.json"), '{"token":"a-token-no-process-carries"}');

  const { env } = buildInvocationFromAdapter(getAdapter("codex"), {
    projectPath: "/fixture/project",
    sessionDir: SESSION_DIR,
    scratchDir: lease.dir,
    sessionName: "dlg-lease-probe",
    initialPrompt: "hi",
  });

  assert.equal(env.CODEX_HOME, path.join(lease.dir, "codex-home"));
  assert.equal(
    fs.readFileSync(path.join(lease.dir, "codex-home", "auth.json"), "utf-8"),
    '{"token":"a-token-no-process-carries"}',
    "the partner still gets the credentials it needs"
  );

  // The copy's mode is PINNED, not inherited. copyFileSync reproduces the
  // source's permissions, so a user whose real auth.json is world-readable was
  // getting a world-readable copy -- it landed at 0600 in the live run only
  // because that particular source happened to be 0600.
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(seedHome, "auth.json"), 0o644);
    const second = newLease();
    buildInvocationFromAdapter(getAdapter("codex"), {
      projectPath: "/fixture/project",
      sessionDir: SESSION_DIR,
      scratchDir: second.dir,
      sessionName: "dlg-lease-probe-2",
      initialPrompt: "hi",
    });
    assert.equal(
      fs.statSync(path.join(second.dir, "codex-home", "auth.json")).mode & 0o777,
      0o600,
      "a world-readable source must not produce a world-readable credential copy"
    );
  }

  // And the archive holds none of it.
  assert.equal(fs.existsSync(path.join(SESSION_DIR, "codex-home")), false);
  const archived = fs
    .readdirSync(SESSION_DIR, { recursive: true })
    .filter((entry) => String(entry).includes("auth.json"));
  assert.deepEqual(archived, [], "no credential file anywhere under the session directory");

  // Then the turn ends, and the copy ceases to exist.
  transitionLease(lease, "active", {
    consumer: {
      kind: "tmux",
      ...localTmuxIdentity(),
      session_name: "dualog-lease-test-no-such-session",
    },
  });
  const finished = releaseAllowingUnknownDirectory(lease);
  if (releasedOrRetainedUnknown(t, lease, finished, "successful credential cleanup")) {
    assert.equal(fs.existsSync(path.join(lease.dir, "codex-home", "auth.json")), false);
  } else {
    assert.equal(
      fs.existsSync(path.join(lease.dir, "codex-home", "auth.json")),
      true,
      "fail-closed cleanup leaves the credential in its private runtime lease, not the archive"
    );
    fs.rmSync(lease.dir, { recursive: true, force: true });
    fs.rmSync(lease.metaPath, { force: true });
  }
});
