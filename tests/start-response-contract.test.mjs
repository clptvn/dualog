// The start-response contract, asserted against a live server.
//
// The docs now tell callers to read three different effort fields for three
// different questions, and to compare requested-vs-resolved to detect a dropped
// parameter. That guidance is only worth anything if the response actually has
// that shape -- and a source-level test cannot prove it, because it can only
// show that values flow into selected code shapes, never that the whole
// returned document is internally consistent.
//
// It caught a real defect on its first run: the structured fields said
// `reasoning_effort: null` / `effective_reasoning_effort: "low"` while the
// human-readable `message` in the SAME response said "reasoning effort: null".
// One response, two different claims about the runtime configuration.
//
// Leaving no session behind is possible because a session with no partner turns
// can always be closed -- the `no_partner_turns` rule added alongside these
// tests. Every case ends before the partner ever speaks.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SERVER_PATH = path.join(REPO_ROOT, "src", "dialog-server.mjs");

// end_dialog is not synchronous with the runner's death. It writes end_signal
// and only WAITS when isSessionRunnerAlive() says the runner is alive -- and
// that predicate answers "not alive" whenever it cannot read the process
// command line (ps missing, sandboxed, or timing out), because it cannot
// confirm identity. In such an environment end_dialog returns immediately while
// the freshly spawned runner is still up, and the runner then exits on its own
// the next time it polls end_signal (3s for dialogs, 5s for reviews). So the
// deadline has to cover a poll interval plus process startup, not just the
// grace period.
const RUNNER_EXIT_DEADLINE_MS = Number(
  process.env.DUALOG_TEST_RUNNER_EXIT_DEADLINE_MS || 20000
);
const RUNNER_EXIT_POLL_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function readStatus(sessionsRoot, sessionId) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(sessionsRoot, sessionId, "status.json"), "utf-8")
    );
  } catch {
    return null;
  }
}

/**
 * The PID must be captured BEFORE end_dialog, never after.
 *
 * A clean shutdown clears `runner_pid` to null and records `runner_state:
 * "exited"`, so a post-hoc read cannot tell "the runner exited" from "there was
 * never a runner to check" -- both look like a missing PID, and both skip the
 * check. That is precisely how the previous version of this teardown passed:
 * verified by probe, `runner_pid` is null after end_dialog on a machine where
 * ps works, so its liveness assertion never executed at all.
 */
function recordedRunnerPid(sessionsRoot, sessionId) {
  const pid = readStatus(sessionsRoot, sessionId)?.runner_pid;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Every environment variable that lets operator state reach these assertions.
 *
 * Overriding HOME is NOT sufficient, and believing it was is what made the
 * cases below environment-dependent. Codex's manifest declares
 * `configIsolation.seedFromEnv: "CODEX_HOME"`, and `resolveUserConfigHome()`
 * prefers that variable over the home-relative fallback -- so an operator with
 * CODEX_HOME set had these cases validating against their live
 * `models_cache.json` instead of the manifest the comments claim. Reproduced:
 * pointing CODEX_HOME at a FRESH cache whose `gpt-5.5` lists `max` turns the
 * rejected-pair case from a refusal into a successful start. (A stale cache is
 * explicitly demoted to "a hint, not grounds to reject a model", so only a
 * fresh one flips it -- which is why this needs a `fetched_at` to reproduce.)
 *
 * Every adapter's seed variable is redirected, not just codex's, and the
 * adapter SEARCH PATH is neutralized as well: a manifest under XDG_CONFIG_HOME
 * or DUALOG_ADAPTER_PATH merges by `id` into a shipped adapter, so it can
 * redefine the very per-model efforts these cases assert on.
 */
function isolatedHomeEnv(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: home,
    CODEX_HOME: path.join(home, ".codex"),
    GROK_HOME: path.join(home, ".grok"),
    QWEN_HOME: path.join(home, ".qwen"),
    OPENCODE_CONFIG_DIR: path.join(home, ".opencode"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CONFIG_DIRS: "",
    DUALOG_ADAPTER_PATH: "",
  };
}

async function waitForRunnerExit(sessionsRoot, sessionId, pid, deadlineMs) {
  const giveUpAt = Date.now() + deadlineMs;
  for (;;) {
    if (readStatus(sessionsRoot, sessionId)?.runner_state === "exited") return true;
    if (!pidAlive(pid)) return true;
    if (Date.now() >= giveUpAt) return false;
    await sleep(RUNNER_EXIT_POLL_MS);
  }
}

/**
 * Start a server whose sessions live under a throwaway home, run `body`, and
 * guarantee both the sessions and the transport are torn down.
 *
 * `withServer` owns session cleanup deliberately. Registering `end_dialog` via
 * `t.after()` inside the body does NOT work: node:test runs after-hooks only
 * once the test function has returned, which is after this helper's `finally`
 * has already closed the client -- so the cleanup call hits a dead transport
 * and fails. Every start_dialog here spawns a DETACHED runner that then idles
 * for up to 24 hours (dialog-runner's default idle shutdown), so a swallowed
 * cleanup failure leaks a process the test runner cannot see and that no socket
 * or directory check would catch, because an idle runner has not started a
 * partner turn yet.
 *
 * The recursion sentinels must be cleared explicitly: a partner-role server
 * serves an empty tool list, which would make every assertion here vacuous.
 */
async function withServer(t, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-startresp-"));
  // Last-resort removal, kept in t.after so it still runs if the finally block
  // below throws. It is only SAFE because that block does not return until
  // every runner is confirmed gone: a live runner recreates its session tree
  // after the delete, and rmSync's maxRetries cannot help with that -- retrying
  // only covers conflicts during the synchronous call, not a process that
  // repopulates the path a moment later.
  t.after(() =>
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    // cwd matters, and no environment variable substitutes for it.
    // adapterSearchPath() appends `<gitRoot>/.dualog/adapters` derived from the
    // server's WORKING DIRECTORY, so a server launched from the repo picked up
    // project-local adapter overrides no matter how clean its environment was.
    // Verified: dropping a `codex` patch into <repo>/.dualog/adapters failed all
    // four cases. The tools still pass `project_path: REPO_ROOT` -- what moves
    // is only where the server itself runs.
    cwd: home,
    env: {
      ...process.env,
      ...isolatedHomeEnv(home),
      DUALOG_ROLE: "",
      DUALOG_DEPTH: "",
      DUALOG_MAX_DEPTH: "",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "start-response-contract", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    return await body(client, home);
  } finally {
    // Cleanup is driven by what is ON DISK, not by what the body remembered to
    // register. An earlier version tracked sessions explicitly and looked
    // correct -- but a case that forgot to call track() simply produced an empty
    // list, so the cleanup assertion passed while the runner leaked. Reading the
    // sessions root cannot be forgotten.
    const sessionsRoot = path.join(home, ".dualog", "sessions");
    const onDisk = fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : [];

    const runners = new Map();
    for (const sessionId of onDisk) {
      const pid = recordedRunnerPid(sessionsRoot, sessionId);
      if (pid) runners.set(sessionId, pid);
    }

    const failures = [];
    for (const sessionId of onDisk) {
      try {
        const res = await client.callTool({ name: "end_dialog", arguments: { session_id: sessionId } });
        const parsed = JSON.parse(res.content[0].text);
        if (!parsed.ended) failures.push(`${sessionId}: ${res.content[0].text.slice(0, 120)}`);
      } catch (err) {
        failures.push(`${sessionId}: ${err.message}`);
      }
    }

    // Wait for the runners to actually be gone, with the server and the home
    // both still alive. Closing the transport first would kill the server's
    // child-exit watcher (so `runner_state` would never reach "exited"), and
    // removing the home first would let a still-running runner recreate it.
    const stragglers = [];
    for (const [sessionId, pid] of runners) {
      if (await waitForRunnerExit(sessionsRoot, sessionId, pid, RUNNER_EXIT_DEADLINE_MS)) {
        continue;
      }
      stragglers.push(
        `${sessionId}: runner ${pid} still alive ${RUNNER_EXIT_DEADLINE_MS}ms after end_dialog`
      );
      // Fail loudly, but do not ALSO leak the process the failure is about.
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* it exited between the poll and here */
      }
      const killedBy = Date.now() + 2000;
      while (pidAlive(pid) && Date.now() < killedBy) await sleep(RUNNER_EXIT_POLL_MS);
    }

    await client.close();

    // Every start_dialog spawns a DETACHED runner that idles for up to 24 hours,
    // so a swallowed cleanup failure leaks a process no socket or directory
    // check would notice -- an idle runner has not started a partner turn yet.
    assert.deepEqual(failures, [], "every session created under this home must be closed");
    assert.deepEqual(stragglers, [], "every runner started under this home must be gone");
  }
}

const callJson = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};

test("an omitted effort reports the model default consistently in every field", async (t) => {
  await withServer(t, async (client) => {
    const started = await callJson(client, "start_dialog", {
      problem_description: "contract probe: omitted effort",
      project_path: REPO_ROOT,
      partner_agent: "codex",
      model: "gpt-5.6-sol",
      // effort deliberately omitted -- the model's own default should apply
      partner_command: "true",
    });

    assert.equal(started.requested_model, "gpt-5.6-sol", "the request is echoed untouched");
    assert.equal(started.requested_reasoning_effort, null, "nothing was requested");
    assert.equal(started.reasoning_effort, null, "no flag is sent, so the flag field is null");
    assert.equal(
      started.effective_reasoning_effort,
      "low",
      "gpt-5.6-sol declares low as its own default, which is what the turn will run at"
    );
    assert.ok(
      (started.notices ?? []).some((n) => n.code === "default_effort_applied"),
      "the info notice explaining the difference must be exposed, not filtered into warnings"
    );

    // The defect this file was written for: the prose must not contradict the
    // fields sitting next to it.
    assert.doesNotMatch(
      started.message,
      /reasoning effort: null/,
      "the summary must not claim a null effort when the turn runs at the model default"
    );
    assert.match(started.message, /reasoning effort: low/, "the summary must state the effective value");
  });
});

test("an explicitly requested effort is reported plainly", async (t) => {
  await withServer(t, async (client) => {
    const started = await callJson(client, "start_dialog", {
      problem_description: "contract probe: explicit effort",
      project_path: REPO_ROOT,
      partner_agent: "codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      partner_command: "true",
    });

    assert.equal(started.requested_reasoning_effort, "high");
    assert.equal(started.reasoning_effort, "high");
    assert.equal(started.effective_reasoning_effort, "high");
    assert.match(started.message, /reasoning effort: high/);
    assert.match(started.message, /model: gpt-5\.6-sol/);
  });
});

test("a start response can be closed before any partner turn, leaving nothing behind", async (t) => {
  await withServer(t, async (client, home) => {
    const started = await callJson(client, "start_dialog", {
      problem_description: "contract probe: immediate cancel",
      project_path: REPO_ROOT,
      partner_agent: "codex",
      partner_command: "true",
    });

    // This is the recovery path the docs promise when a parameter is dropped.
    const ended = await callJson(client, "end_dialog", { session_id: started.session_id });
    assert.equal(ended.ended, true, "a session with no partner turns must be closable");
    assert.equal(
      ended.review_status.close_allowed_reason,
      "no_partner_turns",
      "and closable for that specific reason"
    );

    // Nothing may leak outside the throwaway home.
    assert.ok(started.dialog_dir.startsWith(home), "the session must live under the temporary home");
  });
});

// The partner here must be CODEX, not claude, and `partner_command: "true"` is
// not enough to make that choice cosmetic.
//
// Preflight runs resolveDiscoveryForValidation() before negotiation, and that
// call is never given partner_command -- it takes `{ model, projectPath }` only.
// Claude's discovery strategy is sdk-control, which falls back to
// `adapter.binary.default`, so naming claude here booted the operator's REAL
// installed CLI. Verified with a logging shim first on PATH:
//
//   INVOKED: --input-format stream-json --output-format stream-json --verbose
//            -p --bare --mcp-config {"mcpServers":{}} --strict-mcp-config
//
// That process is not a session runner, so the on-disk enumeration in
// withServer() cannot see it, and it outlives the home it was pointed at.
//
// Codex is hermetic for the same request: its discovery is a local-cache read
// (`{{configHome}}/models_cache.json`), which is simply absent under a throwaway
// home, so it degrades to the manifest. models.dev enrichment does not fire
// either -- it is demand-driven and every codex entry already declares
// `efforts`. No child process, no network.
test("a rejected model/effort pair never creates a session", async (t) => {
  await withServer(t, async (client, home) => {
    const res = await client.callTool({
      name: "start_dialog",
      arguments: {
        problem_description: "contract probe: invalid pair",
        project_path: REPO_ROOT,
        // host defaults to claude, so partner codex already differs. gpt-5.5
        // declares efforts low/medium/high/xhigh -- "max" is a valid effort for
        // the ADAPTER (so it passes the enum) and invalid for this MODEL, which
        // is exactly the pair preflight exists to catch.
        partner_agent: "codex",
        model: "gpt-5.5",
        reasoning_effort: "max",
        partner_command: "true",
      },
    });
    const text = res.content[0].text;
    assert.match(text, /^Error:/, "an unhonorable pair must be refused");
    assert.match(text, /gpt-5\.5/, "the error must name the model");
    // Pin the REASON, not just the failure. Without this the case would pass on
    // any unrelated refusal -- a missing binary, an unreachable catalog -- while
    // proving nothing about per-model effort enforcement.
    assert.match(
      text,
      /effort_unsupported_by_model/,
      "and must be refused for the per-model effort rule specifically"
    );
    // Hermeticity, asserted rather than assumed. Env and cwd hygiene are both
    // invisible when they lapse; this fails loudly instead.
    //
    // The trailing period is the whole assertion. A merged adapter reports its
    // full chain -- `Declared in <builtin> <- <override>.` -- so a bare
    // substring match on the builtin path passes even when operator state
    // contributed to the decision. Requiring the builtin path to END the
    // sentence is what makes an override detectable here.
    const builtinManifest = path.join(REPO_ROOT, "src", "adapters", "builtin", "codex.json");
    assert.match(
      text,
      new RegExp(`Declared in ${escapeRegExp(builtinManifest)}\\.`),
      "the rule must come from the shipped manifest ALONE, with nothing merged over it"
    );

    // Preflight runs before any session directory exists, so nothing is created.
    const sessionsRoot = path.join(home, ".dualog", "sessions");
    const leftovers = fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : [];
    assert.deepEqual(leftovers, [], "a refused start must not leave a session behind");
  });
});
