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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

import { managedSession } from "./helpers/session.mjs";

const { home: ROOT, dir: SESSION_DIR } = managedSession("lease");

const {
  allocateLease,
  bootIdentity,
  isSameBoot,
  leasePath,
  proveLeaseReleasable,
  readTurnLease,
  releaseLease,
  removeLeaseDirectory,
  sweepLeases,
  transitionLease,
} = await import("../src/runtime-lease.mjs");
const { assertManagedLeasePath, runtimeDir } = await import("../src/platform.mjs");

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

test("a lease mid-spawn is not mistaken for one whose consumer exited", (t) => {
  // FOUND IN REVIEW. The tmux identity is recorded BEFORE startTmuxSession(),
  // so between those two statements the session name is legitimately absent --
  // the pane does not exist YET. Reading that as "the consumer finished" let a
  // concurrent sweep delete the lease, with its freshly seeded credentials,
  // while the partner was still launching against it.
  const spawning = {
    state: "spawning",
    runner_pid: liveProcess(t),
    boot: bootIdentity(),
    consumer: { kind: "tmux", session_name: "dualog-lease-test-not-created-yet" },
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
      boot: { host: os.hostname(), bootedAtEpoch: 1 },
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
      consumer: { kind: "tmux", session_name: "dualog-lease-test-no-such-session" },
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
  if (process.platform === "win32") return;
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
      consumer: { kind: "tmux", session_name: "dualog-lease-test-no-such-session" },
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
      consumer: { kind: "tmux", session_name: "dualog-lease-test-no-such-session" },
    }).removable,
    true
  );
});

test("a consumer record with no usable identity retains, and heals on reboot", () => {
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
        boot: { host: os.hostname(), bootedAtEpoch: 1 },
      }).removable,
      true,
      `${JSON.stringify(consumer)} must be reclaimable after a reboot`
    );
  }
});

test("the identity-less spawning window retains on this boot and heals on the next", () => {
  // There is no portable proof that spawn() did not happen, so a lease that
  // crashed here must be kept.
  const thisBoot = proveLeaseReleasable({ state: "spawning", consumer: null, boot: bootIdentity() });
  assert.equal(thisBoot.removable, false);
  assert.match(thisBoot.reason, /a spawn may have begun/);

  // But nothing that lease started can outlive a reboot, which is what stops
  // conservative retention from being permanent.
  const previousBoot = proveLeaseReleasable({
    state: "spawning",
    consumer: null,
    boot: { host: os.hostname(), bootedAtEpoch: 1 },
  });
  assert.equal(previousBoot.removable, true);

  // A lease from another machine is not ours to reason about at all.
  const otherHost = proveLeaseReleasable({
    state: "spawning",
    consumer: null,
    boot: { host: "some-other-host", bootedAtEpoch: 1 },
  });
  assert.equal(otherHost.removable, true, "another host's boot cannot be running our spawn");

  // And no boot identity at all is not evidence of anything.
  const noBoot = proveLeaseReleasable({ state: "spawning", consumer: null, boot: null });
  assert.equal(noBoot.removable, false);
  assert.match(noBoot.reason, /no usable boot identity/);
});

test("boot identity is stable within one boot", () => {
  assert.equal(isSameBoot(bootIdentity()), true);
  assert.equal(isSameBoot(null), null);
  assert.equal(isSameBoot({ host: os.hostname(), bootedAtEpoch: 1 }), false);
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
        fs.symlinkSync(victim, link);
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
    fs.symlinkSync(victim, path.join(home, ".dualog"));
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
    fs.symlinkSync(victim, path.join(home, ".dualog", "runtime"));
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

  // Both platforms this runs on expose a real boot identity -- /proc/.../boot_id
  // on Linux, kern.boottime on macOS -- so falling back to wall-clock arithmetic
  // here is a regression, not an environment difference.
  if (process.platform === "linux" || process.platform === "darwin") {
    assert.equal(identity.precise, true, `${process.platform} must yield a precise boot identity`);
    assert.ok(
      identity.source === "boot-id" || identity.source === "kern.boottime",
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
    false,
    "but a genuinely ancient record is a previous boot"
  );
});

test("boot identity reports unavailable rather than throwing", () => {
  // FOUND IN REVIEW, on a restricted host: os.uptime() raises
  // `uv_uptime returned EPERM` rather than returning something unusable, and it
  // propagated out of allocateLease() -- so no lease-backed adapter could start
  // there at all. An unavailable identity only costs the self-healing of
  // identity-less spawning leases, which is a retention, not a failure.
  // Everything unavailable at once: uptime raises EPERM (the reviewer's host),
  // PATH is emptied so sysctl cannot be found, and /proc does not exist here.
  const script = `
    const os = require("node:os");
    os.uptime = () => { throw new Error("uv_uptime returned EPERM"); };
    process.env.PATH = "";
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
    assert.throws(() => removeLeaseDirectory(link), /symbolic link/);
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
    fs.symlinkSync(victim, path.join(home, ".dualog", "runtime"));
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

test("releasing takes the credentials with it", () => {
  const lease = newLease();
  transitionLease(lease, "projecting");
  const home = path.join(lease.dir, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), '{"token":"secret"}');
  transitionLease(lease, "active", {
    consumer: { kind: "tmux", session_name: "dualog-lease-test-no-such-session" },
  });

  const { released } = releaseLease(lease);
  assert.equal(released, true);
  assert.equal(fs.existsSync(lease.dir), false, "the whole lease goes, auth.json included");
});

test("a runner can clean up after its own failed pre-spawn turn", () => {
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

  const { released } = releaseLease(lease);
  assert.equal(released, true, "the owner may reclaim its own pre-spawn lease");
  assert.equal(fs.existsSync(lease.dir), false);

  // A FAILED SPAWN too, once the consumer is provably absent. The owner has
  // awaited its own spawn call by the time it releases, so unlike a third-party
  // sweep it knows no helper of its own is still in flight. Without this, a
  // failed startTmuxSession() retained its credentials until the next reboot,
  // because the sweep's rule for that state is deliberately boot-scoped.
  const failed = newLease();
  transitionLease(failed, "spawning", {
    consumer: { kind: "tmux", session_name: "dualog-lease-test-no-such-session" },
  });
  assert.equal(releaseLease(failed).released, true, "the owner may reclaim its own failed spawn");
  assert.equal(fs.existsSync(failed.dir), false);

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

test("an owner can reclaim its lease after the metadata is gone", () => {
  // FOUND IN PRODUCTION, during this change's own review. A partner CLI
  // outlived its tmux pane; after the lease was released it recreated
  // $CODEX_HOME to flush a models cache, leaving a directory with a valid lease
  // name, mode 0755 and no metadata. releaseLease() reported "lease metadata is
  // unreadable" and retained it -- and every rule in the sweep keys off metadata
  // that no longer existed, so nothing could ever reclaim it.
  const lease = newLease();
  transitionLease(lease, "projecting");
  fs.mkdirSync(path.join(lease.dir, "codex-home"), { recursive: true });
  fs.writeFileSync(path.join(lease.dir, "codex-home", "auth.json"), '{"token":"x"}');
  fs.rmSync(lease.metaPath, { force: true });

  const { released } = releaseLease(lease);
  assert.equal(released, true, "a handle from allocateLease is ownership the metadata cannot revoke");
  assert.equal(fs.existsSync(lease.dir), false);

  // But ONLY for a handle this process created. A directory someone merely
  // points at, with no readable metadata, is not reclaimable on request.
  const stranger = newLease();
  fs.rmSync(stranger.metaPath, { force: true });
  const refused = releaseLease({ dir: stranger.dir, metaPath: stranger.metaPath });
  assert.equal(refused.released, false);
  assert.match(refused.reason, /metadata is/);
  fs.rmSync(stranger.dir, { recursive: true, force: true });
});

test("an unattributable directory expires rather than accumulating forever", () => {
  // "Retain what you cannot classify" is right until it has no expiry. The
  // production orphan above had no metadata by construction, so no probe could
  // ever classify it, and it would have sat in the runtime root permanently.
  const orphan = path.join(runtimeDir(), "d".repeat(32));
  fs.mkdirSync(path.join(orphan, "codex-home"), { recursive: true });

  // Young: retained, and the receipt says what it is waiting for.
  const young = sweepLeases({ apply: true });
  const retained = young.retained.find((r) => r.dir === orphan);
  assert.ok(retained, "a fresh unattributable directory must be retained");
  assert.match(retained.reason, /retained until nothing has touched it for 24h/);
  assert.equal(fs.existsSync(orphan), true);

  // Old enough: reclaimed. Driven by injecting `now` rather than by touching
  // timestamps, so the test states the rule rather than the filesystem's.
  const later = Date.now() + 25 * 60 * 60 * 1000;
  const dry = sweepLeases({ now: later });
  assert.ok(dry.removed.some((r) => r.dir === orphan && r.applied === false));
  assert.equal(fs.existsSync(orphan), true, "a dry run still changes nothing");

  // BUT a live writer inside it must reset that clock. The window exists for a
  // partner that outlived its pane and is writing into a home it recreated;
  // measuring the directory's own creation time would have reclaimed it out from
  // under exactly that process.
  const active = path.join(runtimeDir(), "e".repeat(32));
  fs.mkdirSync(path.join(active, "codex-home"), { recursive: true });
  const written = path.join(active, "codex-home", "models_cache.json");
  fs.writeFileSync(written, "{}");
  // Touched as of the evaluation time. `now` is injected 25h ahead, so a file
  // written at real-now would read as 25h stale; the point being tested is what
  // happens when something writes WHILE the sweep considers the directory.
  const asOf = new Date(later);
  fs.utimesSync(written, asOf, asOf);
  // A dry run: applying here would reclaim the orphan too, and the last
  // assertion below still needs it present.
  const stillWriting = sweepLeases({ now: later });
  assert.ok(
    stillWriting.retained.some((r) => r.dir === active),
    "a tree touched recently must be retained however old the directory is"
  );
  assert.equal(fs.existsSync(active), true);
  fs.rmSync(active, { recursive: true, force: true });

  const applied = sweepLeases({ apply: true, now: later });
  assert.ok(applied.removed.some((r) => r.dir === orphan && r.applied === true));
  assert.equal(fs.existsSync(orphan), false);
});

// --- the sweep -----------------------------------------------------------------

test("the sweep reports what it will not touch, and touches nothing on a dry run", () => {
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
  assert.ok(dry.removed.some((r) => r.dir === dead.dir));
  assert.ok(dry.removed.every((r) => r.applied === false));
  assert.equal(fs.existsSync(dead.dir), true, "a dry run changes nothing");

  const applied = sweepLeases({ apply: true });
  assert.ok(applied.removed.some((r) => r.dir === dead.dir && r.applied === true));
  assert.equal(fs.existsSync(dead.dir), false);
  assert.equal(fs.existsSync(live.dir), true, "the live one is still there");
  assert.equal(fs.existsSync(stray), true);
  assert.equal(fs.existsSync(malformed), true);

  fs.rmSync(stray, { recursive: true, force: true });
  fs.rmSync(malformed, { recursive: true, force: true });
  fs.rmSync(live.dir, { recursive: true, force: true });
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
  );

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
    /partnerExited = await waitForProcessExit\(handle\.panePid, PARTNER_EXIT_GRACE_MS\)/,
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

  // The failed-spawn shortcut probes TWICE across a settle: the tmux SERVER is a
  // separate process from the client we ran, so a killed client's queued
  // new-session can create the pane just after the call returns.
  const leaseSrc = fs.readFileSync(
    new URL("../src/runtime-lease.mjs", import.meta.url),
    "utf-8"
  );
  const settled = leaseSrc.match(/sleepSync\(SPAWN_SETTLE_MS\)/g) || [];
  assert.equal(settled.length, 1, "the failed-spawn shortcut must settle before its second probe");
  assert.equal(
    (leaseSrc.match(/probeConsumer\(record\.value\.consumer \?\? \{\}\) === "absent"/g) || []).length,
    2,
    "and must probe on both sides of that settle"
  );

  const headless = fs.readFileSync(
    new URL("../src/engines/headless.mjs", import.meta.url),
    "utf-8"
  );
  assert.match(
    headless,
    /\} finally \{[\s\S]{0,400}releaseLease\(lease\)/,
    "the headless engine has a dozen exit paths, so its release must be in a finally"
  );
});

// --- the property all of it exists for ----------------------------------------

test("a partner's credentials land in the lease and never in the session archive", async () => {
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
    consumer: { kind: "tmux", session_name: "dualog-lease-test-no-such-session" },
  });
  assert.equal(releaseLease(lease).released, true);
  assert.equal(fs.existsSync(path.join(lease.dir, "codex-home", "auth.json")), false);
});
