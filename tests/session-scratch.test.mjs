// The scratch sweep deletes directories out of the user's home, so its refusals
// matter more than its deletions.
//
// Every case here is written from that direction: what must it decline to
// touch, and does a dry run really change nothing. The one behaviour that is
// not negotiable is that a session it cannot prove dead is left completely
// alone -- deleting a config home out from under a running CLI is a worse
// outcome than keeping a stale credential copy another day.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import {
  SCRATCH_LEDGER,
  ledgerNames,
  planScratchSweep,
  proveSessionInactive,
  sweepScratch,
  formatBytes,
} from "../src/session-scratch.mjs";

function tempRoot(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dualog-scratch-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function createFileSymlinkOrSkip(t, target, link) {
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch (err) {
    // Windows hosted runners do not consistently grant file-symlink
    // privileges. That host capability is unrelated to the sweep contract, so
    // skip this one assertion rather than failing before it can run.
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES", "UNKNOWN"].includes(err?.code)
    ) {
      t.skip(`file symlinks are unavailable on this Windows runner (${err.code})`);
      return false;
    }
    throw err;
  }
}

/** A session with a partner home in it, plus whatever status the case needs. */
function makeSession(root, sessionId, { status = null, homes = ["codex-home"], extra = {} } = {}) {
  const dir = path.join(root, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (const home of homes) {
    fs.mkdirSync(path.join(dir, home), { recursive: true });
    fs.writeFileSync(path.join(dir, home, "auth.json"), '{"token":"secret"}');
    fs.writeFileSync(path.join(dir, home, "config.toml"), "[x]\n");
    fs.mkdirSync(path.join(dir, home, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(dir, home, "sessions", "rollout.jsonl"), "{}\n");
  }
  fs.writeFileSync(path.join(dir, "conversation.jsonl"), "{}\n");
  if (status) fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
  for (const [file, content] of Object.entries(extra)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

/** A process that is genuinely alive for the duration of one test. */
function liveProcess(t) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });
  return child.pid;
}

test("the ledger is exact names, never patterns", () => {
  // A glob would let a manifest change silently widen what gets deleted, and a
  // pattern like `*-home` matches directories dualog never created.
  for (const version of SCRATCH_LEDGER) {
    for (const name of Object.keys(version.homes)) {
      assert.equal(name, path.basename(name), `${name} must be a bare directory name`);
      assert.doesNotMatch(name, /[*?[\]]/, `${name} must not be a glob`);
    }
  }
  // opencode-data was never a configIsolation.dir: it came from extraEnv, and
  // now lives in configIsolation.dirs. Deriving this list from whichever field
  // is current would have missed it twice over.
  assert.ok(ledgerNames().has("opencode-data"));
  assert.ok(ledgerNames().has("codex-home"));
});

test("a session with a live runner is skipped entirely", (t) => {
  const root = tempRoot(t, "liverunner");
  const pid = liveProcess(t);
  makeSession(root, "dialog-1785600000001-0000000a", { status: { runner_pid: pid, type: "dialog" } });

  const plan = planScratchSweep({ roots: [root] });
  assert.equal(plan.sessions.length, 1);
  assert.equal(plan.sessions[0].inactive, false, "a live runner must block the sweep");
  assert.equal(plan.totals.targets, 0, "and must contribute nothing to the totals");

  const receipt = sweepScratch({ apply: true, roots: [root] });
  assert.equal(receipt.removed.length, 0);
  assert.equal(receipt.skipped.length, 1);
  assert.ok(fs.existsSync(path.join(root, "dialog-1785600000001-0000000a", "codex-home", "auth.json")));
});

test("a live runner blocks even when its identity cannot be confirmed", (t) => {
  // isSessionRunnerAlive() answers "not alive" when it cannot read a command
  // line -- correct for deciding whether to SIGNAL something, wrong for
  // deciding whether to DELETE. This pins the stricter rule: a live pid blocks
  // regardless of whether we can prove it is ours.
  const root = tempRoot(t, "unidentified");
  const pid = liveProcess(t);
  makeSession(root, "dialog-1785600000002-0000000b", {
    status: { runner_pid: pid, type: "dialog", runner_token: "a-token-no-process-carries" },
  });

  const { inactive, reason } = proveSessionInactive(path.join(root, "dialog-1785600000002-0000000b"));
  assert.equal(inactive, false);
  assert.match(reason, /alive/);
});

test("a recorded terminal blocks, using the shape the product actually writes", (t) => {
  // The first version of this check looked for `terminal.current.pid`. Real
  // `current_terminal.json` is FLAT and carries NO pid at all -- it has
  // `session_name`, `pane_target`, `command`, `args`. So the check was inert
  // against every file the product writes, and the test passed only because it
  // planted an invented shape. This one uses a real record.
  const root = tempRoot(t, "liveterm");
  makeSession(root, "dialog-1785626305511-65d59015", {
    status: { runner_pid: null, type: "dialog" },
    extra: {
      "current_terminal.json": JSON.stringify({
        schema_version: 1,
        runtime: "tmux-interactive",
        agent: "codex",
        session_name: "dualog-probe-session-that-does-not-exist",
        pane_target: "dualog-probe-session-that-does-not-exist:0.0",
        command: "codex",
        args: [],
      }),
    },
  });

  const plan = planScratchSweep({ roots: [root] });
  assert.equal(plan.sessions.length, 1, "precondition: the session id must be the generated shape");
  // Either tmux says the session is alive, or tmux cannot be consulted. Both
  // must block; only a definitive absence may proceed. On a machine with tmux
  // installed and no such session this is a clean "absent", so assert the
  // property rather than one environment's answer.
  const { inactive, reason } = plan.sessions[0];
  if (!inactive) {
    assert.match(reason, /tmux session/);
  }
});

/** Point the runtime at a tmux socket nothing is listening on. */
function withDeadTmuxSocket(t) {
  const previousSocket = process.env.DUALOG_TMUX_SOCKET;
  const previousBinary = process.env.DUALOG_TMUX_BINARY;
  process.env.DUALOG_TMUX_SOCKET = `dualog-noserver-${process.pid}`;
  delete process.env.DUALOG_TMUX_BINARY;
  t.after(() => {
    if (previousSocket === undefined) delete process.env.DUALOG_TMUX_SOCKET;
    else process.env.DUALOG_TMUX_SOCKET = previousSocket;
    if (previousBinary !== undefined) process.env.DUALOG_TMUX_BINARY = previousBinary;
  });
}

// The case above asserts only that a blocked session gives a tmux reason, which
// a probe answering `unknown` satisfies. That is how the following shipped: on a
// machine whose tmux server is not running -- the ordinary state after a reboot
// -- tmux prints "error connecting to <socket> (No such file or directory)",
// the absence pattern did not match it, every session holding a
// current_terminal.json probed `unknown`, and the sweep retained all of them.
// The credential copies this module exists to reclaim were never reclaimed. So
// this case pins the verdict itself, not just its shape.
test("with no tmux server running, a recorded pane is provably absent and can be reclaimed", (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) {
    t.skip("tmux is not installed");
    return;
  }
  withDeadTmuxSocket(t);

  const root = tempRoot(t, "noserver");
  makeSession(root, "dialog-1785626305511-65d59016", {
    status: { runner_state: "exited", runner_pid: null, type: "dialog" },
    extra: {
      "current_terminal.json": JSON.stringify({
        schema_version: 1,
        runtime: "tmux-interactive",
        agent: "codex",
        session_name: "dualog-probe-session-that-does-not-exist",
        tmux_transport: "local",
        tmux_distro: null,
        tmux_launcher: "tmux",
        tmux_control_binary: "tmux",
        tmux_socket_name: process.env.DUALOG_TMUX_SOCKET,
      }),
    },
  });

  const plan = planScratchSweep({ roots: [root] });
  assert.equal(
    plan.sessions[0].inactive,
    true,
    `expected a reclaimable session, got: ${plan.sessions[0].reason}`
  );
});

test("a tmux we cannot run still retains the home", (t) => {
  // The other direction, and the one that must never regress: ignorance retains.
  const previousBinary = process.env.DUALOG_TMUX_BINARY;
  process.env.DUALOG_TMUX_BINARY = path.join(os.tmpdir(), "dualog-absent-tmux-binary");
  t.after(() => {
    if (previousBinary === undefined) delete process.env.DUALOG_TMUX_BINARY;
    else process.env.DUALOG_TMUX_BINARY = previousBinary;
  });

  const root = tempRoot(t, "notmux");
  makeSession(root, "dialog-1785626305511-65d59017", {
    status: { runner_state: "exited", runner_pid: null, type: "dialog" },
    extra: {
      "current_terminal.json": JSON.stringify({
        schema_version: 1,
        runtime: "tmux-interactive",
        agent: "codex",
        session_name: "dualog-probe-session-that-does-not-exist",
      }),
    },
  });

  const plan = planScratchSweep({ roots: [root] });
  assert.equal(plan.sessions[0].inactive, false);
  assert.match(plan.sessions[0].reason, /could not be checked \(unknown\)/);
});

test("a terminal record with no session_name blocks, because there is nothing to check", (t) => {
  const root = tempRoot(t, "namelessterm");
  makeSession(root, "dialog-1785626305511-aaaaaaaa", {
    status: { runner_pid: null },
    extra: { "current_terminal.json": JSON.stringify({ schema_version: 1, runtime: "tmux-interactive" }) },
  });

  const plan = planScratchSweep({ roots: [root] });
  assert.equal(plan.sessions[0].inactive, false);
  assert.match(plan.sessions[0].reason, /no session_name/);
});

test("a live headless child blocks", (t) => {
  const root = tempRoot(t, "liveheadless");
  const pid = liveProcess(t);
  makeSession(root, "dialog-1785600000004-0000000d", {
    status: { runner_pid: null, type: "dialog" },
    extra: {
      "turns/1/headless-child.json": JSON.stringify({ pid, pgid: pid, command: "codex" }),
    },
  });

  const plan = planScratchSweep({ roots: [root] });
  assert.equal(plan.sessions[0].inactive, false);
  assert.match(plan.sessions[0].reason, /headless/);
});

test("a dead session is cleaned, and the WHOLE home goes, not just the credential", (t) => {
  // Unlinking auth.json and keeping the rest is a guess about where a CLI
  // writes secrets. It also writes refreshed tokens, caches and rollout logs.
  const root = tempRoot(t, "dead");
  const dir = makeSession(root, "dialog-1785600000005-0000000e", { status: { runner_pid: null, type: "dialog" } });

  const receipt = sweepScratch({ apply: true, roots: [root] });
  assert.equal(receipt.errors.length, 0);
  assert.equal(receipt.removed.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "codex-home")), false, "the home must be gone");
  assert.ok(fs.existsSync(path.join(dir, "conversation.jsonl")), "the transcript must survive");
});

test("a dry run reports exactly what --apply would do, and changes nothing", (t) => {
  const root = tempRoot(t, "dryrun");
  makeSession(root, "dialog-1785600000006-0000000f", { status: { runner_pid: null } });
  makeSession(root, "dialog-1785600000007-00000010", { status: { runner_pid: null }, homes: ["codex-home", "qwen-home"] });

  const dry = sweepScratch({ apply: false, roots: [root] });
  assert.equal(dry.applied, false);
  assert.equal(dry.totals.removed_targets, 3);
  assert.ok(dry.removed.every((r) => r.dryRun === true));
  assert.ok(fs.existsSync(path.join(root, "dialog-1785600000006-0000000f", "codex-home", "auth.json")), "nothing removed");

  const applied = sweepScratch({ apply: true, roots: [root] });
  assert.equal(applied.totals.removed_targets, dry.totals.removed_targets, "same count");
  assert.equal(applied.totals.removed_bytes, dry.totals.removed_bytes, "same bytes");
  assert.equal(fs.existsSync(path.join(root, "dialog-1785600000006-0000000f", "codex-home")), false);
  assert.equal(fs.existsSync(path.join(root, "dialog-1785600000007-00000010", "qwen-home")), false);
});

test("a symlink in place of a generated home is reported and never followed", (t) => {
  const root = tempRoot(t, "symlink");
  const outside = tempRoot(t, "symlink-target");
  fs.writeFileSync(path.join(outside, "precious.json"), "do not delete me");

  const dir = path.join(root, "dialog-1785600000008-00000011");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runner_pid: null }));
  fs.symlinkSync(
    outside,
    path.join(dir, "codex-home"),
    process.platform === "win32" ? "junction" : "dir"
  );

  const receipt = sweepScratch({ apply: true, roots: [root] });
  assert.equal(receipt.removed.length, 0, "a link must not be treated as a removable home");
  assert.ok(
    receipt.skipped.some((s) => /symbolic link/.test(s.reason)),
    "and the refusal must be reported rather than silent"
  );
  assert.ok(fs.existsSync(path.join(outside, "precious.json")), "the target must be untouched");
  assert.ok(fs.existsSync(path.join(dir, "codex-home")), "the link itself is left in place");
});

test("directories that are not dualog sessions are left alone inside our own root", (t) => {
  // Being inside ~/.dualog/sessions is not sufficient authority to delete
  // something: a stray directory there was put there by someone else.
  const root = tempRoot(t, "strangers");
  for (const name of ["not-a-session", "dialog", "../escape", "Downloads", "review"]) {
    const dir = path.join(root, name.replace(/[^\w.-]/g, "_"));
    fs.mkdirSync(path.join(dir, "codex-home"), { recursive: true });
    fs.writeFileSync(path.join(dir, "codex-home", "auth.json"), "{}");
  }

  const plan = planScratchSweep({ roots: [root] });
  assert.deepEqual(plan.sessions, [], "nothing that is not a dialog-/review- session may be planned");

  const receipt = sweepScratch({ apply: true, roots: [root] });
  assert.equal(receipt.totals.removed_targets, 0);
});

test("a home name that is not in the ledger is not removed", (t) => {
  const root = tempRoot(t, "unledgered");
  const dir = path.join(root, "dialog-1785600000009-00000012");
  fs.mkdirSync(path.join(dir, "some-other-home"), { recursive: true });
  fs.writeFileSync(path.join(dir, "some-other-home", "auth.json"), "{}");
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runner_pid: null }));

  const receipt = sweepScratch({ apply: true, roots: [root] });
  assert.equal(receipt.totals.removed_targets, 0, "deletion is by ledger, never by finding auth.json");
  assert.ok(fs.existsSync(path.join(dir, "some-other-home", "auth.json")));
});

test("the sweep is idempotent and a missing root is not an error", (t) => {
  const root = tempRoot(t, "idempotent");
  makeSession(root, "dialog-1785600000010-00000013", { status: { runner_pid: null } });

  const first = sweepScratch({ apply: true, roots: [root, path.join(root, "does-not-exist")] });
  assert.equal(first.totals.removed_targets, 1);
  assert.equal(first.errors.length, 0);

  const second = sweepScratch({ apply: true, roots: [root, path.join(root, "does-not-exist")] });
  assert.equal(second.totals.removed_targets, 0, "a second run finds nothing left to do");
  assert.equal(second.errors.length, 0);
});

test("byte formatting stays readable at every scale", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(12 * 1024 ** 3), "12 GiB");
  assert.equal(formatBytes(-1), "unknown");
});

// --- the failure modes an external review proved were live -------------------
//
// Each of these passed against the first version of this module while the
// module was, in fact, willing to delete a live partner's home. They are the
// reason "unknown liveness retains" needs cases of its own rather than a
// comment.

test("a record that exists but cannot be parsed blocks, in every layer", (t) => {
  // `readJson()` returned null for missing, unreadable AND malformed, so a
  // corrupt status.json looked exactly like a session that never had one --
  // and a file that exists but is unintelligible is the strongest signal
  // something crashed mid-write, which is when deleting is least safe.
  const cases = [
    { label: "status", file: "status.json", match: /status\.json/ },
    { label: "terminal", file: "current_terminal.json", match: /current_terminal\.json/ },
    { label: "headless", file: "turns/1/headless-child.json", match: /headless-child\.json/ },
  ];

  for (const { label, file, match } of cases) {
    const root = tempRoot(t, `malformed-${label}`);
    const sessionId = "dialog-1785600000020-000000aa";
    makeSession(root, sessionId, { status: { runner_pid: null }, extra: { [file]: "{ not json" } });

    const { inactive, reason } = proveSessionInactive(path.join(root, sessionId));
    assert.equal(inactive, false, `a malformed ${label} record must block`);
    assert.match(reason, match, label);

    const receipt = sweepScratch({ apply: true, roots: [root] });
    assert.equal(receipt.totals.removed_targets, 0, `nothing may be removed for ${label}`);
  }
});

test("a process that exists but cannot be signalled blocks", (t) => {
  // isProcessAlive() catches every error as "dead", so EPERM -- which means the
  // process is THERE and belongs to someone else -- read as absent. Verified on
  // this machine: isProcessAlive(1) is false while pid 1 plainly exists.
  const root = tempRoot(t, "eperm");
  const sessionId = "dialog-1785600000021-000000bb";
  makeSession(root, sessionId, { status: { runner_pid: 1 } });

  let epermIsReachable = false;
  try {
    process.kill(1, 0);
  } catch (err) {
    epermIsReachable = err.code === "EPERM";
  }
  if (!epermIsReachable) {
    t.skip("this process can signal pid 1, so EPERM is not reachable here");
    return;
  }

  const { inactive, reason } = proveSessionInactive(path.join(root, sessionId));
  assert.equal(inactive, false, "an EPERM process must block deletion");
  assert.match(reason, /alive/);
});

test("a non-numeric recorded pid blocks rather than being ignored", (t) => {
  const root = tempRoot(t, "badpid");
  const sessionId = "dialog-1785600000022-000000cc";
  makeSession(root, sessionId, { status: { runner_pid: "12345" } });

  const { inactive, reason } = proveSessionInactive(path.join(root, sessionId));
  assert.equal(inactive, false, "a malformed pid is not the same as no pid");
  assert.match(reason, /could not be probed/);
});

test("inactivity is re-proved immediately before deletion, not trusted from the plan", (t) => {
  // Sizing 12 GiB takes real time. A session that was idle when the plan was
  // built can acquire a runner before the plan is acted on, so liveness
  // measured at plan time is a claim that has since expired.
  const root = tempRoot(t, "recheck");
  const sessionId = "dialog-1785600000023-000000dd";
  const dir = makeSession(root, sessionId, { status: { runner_pid: null } });

  const plan = planScratchSweep({ roots: [root] });
  assert.equal(plan.sessions[0].inactive, true, "precondition: idle at plan time");

  // The session comes alive between the plan and the sweep.
  const pid = liveProcess(t);
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runner_pid: pid }));

  // The STALE plan is handed in deliberately: that is exactly the situation the
  // re-proof exists for, and building a fresh plan here would test nothing.
  const receipt = sweepScratch({ apply: true, roots: [root], plan });
  assert.equal(receipt.totals.removed_targets, 0, "the re-check must stop the deletion");
  assert.ok(
    receipt.skipped.some((s) => /became active after the plan was built/.test(s.reason)),
    "and must say so explicitly"
  );
  assert.ok(fs.existsSync(path.join(dir, "codex-home", "auth.json")));
});

test("only the generated session id shape is authorized for deletion", (t) => {
  // `isValidSessionId()` plus a `dialog-` prefix also authorizes `dialog-notes`
  // -- a directory a person could plausibly have made by hand.
  const root = tempRoot(t, "idshape");
  for (const id of ["dialog-personal", "dialog-notes", "review-scratch", "dialog-123-nothex", "dialog--0000000a"]) {
    makeSession(root, id, { status: { runner_pid: null } });
  }
  makeSession(root, "dialog-1785600000024-000000ee", { status: { runner_pid: null } });

  const plan = planScratchSweep({ roots: [root] });
  assert.deepEqual(
    plan.sessions.map((s) => s.sessionId),
    ["dialog-1785600000024-000000ee"],
    "only the exact generated shape may be planned"
  );
});

test("claude-home is not in the ledger, because nothing ever generated it", () => {
  // The claude adapter has configIsolation: null and isolates with an empty MCP
  // config instead. An exact-name ledger is safe only while every name is one
  // dualog actually wrote; a plausible-looking invention is a licence to delete
  // somebody else's directory.
  assert.equal(ledgerNames().has("claude-home"), false);
});

test("sensitive files are classified per home, and auth is not conflated with config", () => {
  const names = ledgerNames();
  // qwen seeds oauth_creds.json -- real auth material that a global filename
  // list of auth.json/credentials.json missed entirely.
  assert.equal(names.get("qwen-home").sensitive["oauth_creds.json"], "auth");
  // A codex config.toml is not a credential, but can define MCP servers whose
  // env blocks hold API keys.
  assert.equal(names.get("codex-home").sensitive["config.toml"], "config");
  assert.equal(names.get("codex-home").sensitive["auth.json"], "auth");
});

test("the receipt separates what was planned from what was actually removed", (t) => {
  const root = tempRoot(t, "totals");
  makeSession(root, "dialog-1785600000025-000000ff", { status: { runner_pid: null } });

  const receipt = sweepScratch({ apply: true, roots: [root] });
  assert.equal(receipt.planned.targets, 1, "the plan is reported as the plan");
  assert.equal(receipt.totals.removed_targets, 1, "and the outcome as the outcome");
  assert.equal(receipt.totals.removed_auth, 1, "auth counted separately");
  assert.equal(receipt.totals.removed_config, 1, "from secret-capable config");
  assert.equal(receipt.planned.auth, receipt.totals.removed_auth, "equal only because nothing failed");
});

// --- record SHAPE, not just record parseability ------------------------------
//
// "Unknown liveness retains" was still false for valid JSON of the wrong shape.
// Each of these parsed cleanly, produced `undefined` where a pid was expected,
// and read as "nothing running here".

test("valid JSON of the wrong shape blocks rather than reading as 'no runner'", (t) => {
  const cases = [
    { label: "empty status object", files: { "status.json": "{}" }, match: /neither runner_state nor runner_pid/ },
    { label: "status is an array", files: { "status.json": "[]" }, match: /not a JSON object/ },
    { label: "empty headless record", files: {
        "status.json": JSON.stringify({ runner_pid: null, runner_state: "exited" }),
        "turns/1/headless-child.json": "{}",
      }, match: /no usable pid/ },
    { label: "headless record with no pgid", files: {
        "status.json": JSON.stringify({ runner_pid: null, runner_state: "exited" }),
        "turns/1/headless-child.json": JSON.stringify({ pid: 999999, command: "codex" }),
      }, match: /no usable pgid/ },
  ];

  let i = 0;
  for (const { label, files, match } of cases) {
    const root = tempRoot(t, `shape-${i}`);
    const sessionId = `dialog-17856000000${30 + i}-000000a${i}`;
    i += 1;
    makeSession(root, sessionId, { status: null, extra: files });

    const { inactive, reason } = proveSessionInactive(path.join(root, sessionId));
    assert.equal(inactive, false, `${label} must block`);
    assert.match(reason, match, label);

    const receipt = sweepScratch({ apply: true, roots: [root] });
    assert.equal(receipt.totals.removed_targets, 0, `nothing may be removed for ${label}`);
  }
});

test(
  "native Windows retains an explicit-null breadcrumb after its wrapper vanishes",
  { skip: process.platform !== "win32" },
  (t) => {
    // This is the failed-taskkill shape: the direct cmd.exe wrapper is gone,
    // but headless.mjs deliberately retains the breadcrumb because taskkill did
    // not prove its descendants died. Explicit `pgid: null` validates the
    // native producer shape; it is not a whole-tree death proof.
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    assert.ok(Number.isSafeInteger(exited.pid) && exited.pid > 0);

    const root = tempRoot(t, "windows-null-pgid");
    const sessionId = "dialog-1785600000039-000000af";
    const dir = makeSession(root, sessionId, {
      status: { runner_pid: null, runner_state: "exited" },
      extra: {
        "turns/1/headless-child.json": JSON.stringify({
          pid: exited.pid,
          pgid: null,
          command: process.execPath,
          reap_attempts: 1,
        }),
      },
    });

    const proof = proveSessionInactive(dir);
    assert.equal(proof.inactive, false);
    assert.match(proof.reason, /whole process-tree death is not proven/);

    const receipt = sweepScratch({ apply: true, roots: [root] });
    assert.equal(receipt.totals.removed_targets, 0);
    assert.equal(
      fs.existsSync(path.join(dir, "codex-home", "auth.json")),
      true,
      "failed tree termination must retain the credential home"
    );
  }
);

test("a session still starting its runner is never cleaned", (t) => {
  // The real product race, not a corrupt-file thought experiment.
  // start_dialog/start_code_review write `runner_state: "starting"` with no
  // pid, THEN spawn the detached runner, and only then record its pid
  // (dialog-server.mjs writes status at :880, spawns at :910, marks at :927).
  // Inside that window the runner has already reached runPartnerCommand() and
  // seeded the home with real credentials, while status still says
  // starting/null and no terminal or headless record exists yet.
  const root = tempRoot(t, "starting");
  const sessionId = "dialog-1785600000040-000000b0";
  const dir = makeSession(root, sessionId, { status: { runner_state: "starting", runner_pid: null } });

  const { inactive, reason } = proveSessionInactive(dir);
  assert.equal(inactive, false, "a starting session must block");
  // Match the reason UNIQUE to this branch. `/starting/` also matches the
  // enum's catch-all ('runner_state "starting" is not a state this version
  // understands'), so a mutant that deleted this branch entirely still passed.
  assert.match(reason, /a runner may be spawning right now/);

  // And re-proving before deletion cannot rescue it -- the status has not
  // changed -- so blocking has to happen here.
  const receipt = sweepScratch({ apply: true, roots: [root] });
  assert.equal(receipt.totals.removed_targets, 0);
  assert.ok(fs.existsSync(path.join(dir, "codex-home", "auth.json")));
});

test("a running status with no usable pid blocks", (t) => {
  const root = tempRoot(t, "runningnopid");
  const sessionId = "dialog-1785600000041-000000b1";
  makeSession(root, sessionId, { status: { runner_state: "running", runner_pid: null } });

  const { inactive, reason } = proveSessionInactive(path.join(root, sessionId));
  assert.equal(inactive, false);
  assert.match(reason, /no usable runner_pid/);
});

test("a session holding a scratch home with no status at all blocks", (t) => {
  // Every producer writes status.json before spawning anything, so its absence
  // beside a credential-bearing home is not evidence of a clean finish.
  const root = tempRoot(t, "nostatus");
  const sessionId = "dialog-1785600000042-000000b2";
  makeSession(root, sessionId, { status: null });

  const { inactive, reason } = proveSessionInactive(path.join(root, sessionId));
  assert.equal(inactive, false);
  assert.match(reason, /status\.json is absent/);
});

test("the exited legacy shape still cleans, so the new rules did not freeze the sweep", (t) => {
  // The counterweight to the four cases above: a genuinely finished session
  // must still be cleanable, or "retain on unknown" has quietly become "retain
  // on everything" and the migration stops working.
  const root = tempRoot(t, "legacyexited");
  const dir = makeSession(root, "dialog-1785600000043-000000b3", {
    status: { runner_pid: null, runner_state: "exited", runner_exit_reason: "end_signal" },
  });

  const receipt = sweepScratch({ apply: true, roots: [root] });
  assert.equal(receipt.totals.removed_targets, 1, "a proven-dead session must still be cleaned");
  assert.equal(fs.existsSync(path.join(dir, "codex-home")), false);
});

test("sensitive-file discovery is direct-children-only, so no intermediate path can be subverted", (t) => {
  // The ledger describes files dualog SEEDED, and seeding writes direct
  // children. Recursive basename matching invented authority the ledger never
  // granted, and its remembered paths were later handed to unlinkSync after the
  // target recheck -- so a nested directory swapped for a symlink between plan
  // and apply could redirect that unlink outside the home.
  const root = tempRoot(t, "directonly");
  const dir = makeSession(root, "dialog-1785600000044-000000b4", { status: { runner_pid: null, runner_state: "exited" } });
  const nested = path.join(dir, "codex-home", "nested");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "auth.json"), "{}");

  const plan = planScratchSweep({ roots: [root] });
  const target = plan.sessions[0].targets.find((x) => x.name === "codex-home");
  assert.deepEqual(
    target.sensitiveFiles.auth,
    [path.join(dir, "codex-home", "auth.json")],
    "only the direct child is nominated; the nested one is not the ledger's business"
  );

  // It is still removed -- by the whole-directory deletion, which is the actual
  // guarantee.
  sweepScratch({ apply: true, roots: [root], plan });
  assert.equal(fs.existsSync(path.join(dir, "codex-home")), false);
});

test("only regular direct-child files are nominated for the unlink-first pass", (t) => {
  // Found by a mutant that survived: nothing asserted the file-type filter, so
  // relaxing it changed nothing visible. A directory named `config.toml` or a
  // symlink named `auth.json` is not a seeded credential, and nominating either
  // means handing unlinkSync a path the ledger never described -- a link would
  // resolve somewhere nobody authorized.
  const root = tempRoot(t, "filetype");
  const outside = tempRoot(t, "filetype-target");
  fs.writeFileSync(path.join(outside, "real-secret.json"), "not ours to delete");

  const dir = makeSession(root, "dialog-1785600000045-000000b5", {
    status: { runner_pid: null, runner_state: "exited" },
    homes: [],
  });
  const home = path.join(dir, "codex-home");
  fs.mkdirSync(path.join(home, "config.toml"), { recursive: true }); // a DIRECTORY
  if (
    !createFileSymlinkOrSkip(
      t,
      path.join(outside, "real-secret.json"),
      path.join(home, "auth.json")
    )
  ) {
    return;
  }

  const plan = planScratchSweep({ roots: [root] });
  const target = plan.sessions[0].targets.find((x) => x.name === "codex-home");
  assert.deepEqual(target.sensitiveFiles.auth, [], "a symlink is not a seeded auth file");
  assert.deepEqual(target.sensitiveFiles.config, [], "a directory is not a seeded config file");

  sweepScratch({ apply: true, roots: [root], plan });
  assert.ok(
    fs.existsSync(path.join(outside, "real-secret.json")),
    "and whatever the link pointed at must be untouched"
  );
});

test("runner_state is an enum: any value outside it blocks", (t) => {
  // Special-casing the recognized states and letting the rest fall through
  // meant `paused`, `null` and `42` all reached the pid check, found none, and
  // read as inactive. A state this version does not understand is not a state
  // that authorizes deletion.
  const cases = [
    ["paused", { runner_state: "paused", runner_pid: null }],
    ["null", { runner_state: null }],
    ["numeric", { runner_state: 42, runner_pid: null }],
    ["future", { runner_state: "draining", runner_pid: null }],
  ];

  let i = 0;
  for (const [label, status] of cases) {
    const root = tempRoot(t, `enum-${i}`);
    const sessionId = `dialog-17856000000${50 + i}-000000c${i}`;
    i += 1;
    makeSession(root, sessionId, { status });

    const { inactive, reason } = proveSessionInactive(path.join(root, sessionId));
    assert.equal(inactive, false, `runner_state ${label} must block`);
    assert.match(reason, /not a state this version understands|neither runner_state nor runner_pid/, label);
  }
});

test("the ledger's sensitive files match what the producer manifests actually seed", () => {
  // Two entries were empty while their manifests plainly seed auth, which left
  // unlink ordering and the reported auth counts wrong on any machine that had
  // used those adapters. This pins the ledger against the manifests rather than
  // against memory.
  const names = ledgerNames();
  const seededAuth = {
    "codex-home": "auth.json",
    "grok-home": "auth.json",
    "opencode-config": "auth.json",
    "qwen-home": "oauth_creds.json",
  };
  for (const [home, file] of Object.entries(seededAuth)) {
    assert.equal(
      names.get(home)?.sensitive?.[file],
      "auth",
      `${home}/${file} is seeded by its manifest and must be classified as auth`
    );
  }
});
