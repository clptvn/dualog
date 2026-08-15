// A live PR review panel, driven through the server's own tools.
//
// This is the seam the other two PR-review suites leave open, and the gap is not
// hypothetical: it hid a shipped bug that made the feature's documented workflow
// non-functional. pr-review-panel.test.mjs spawns the runner directly and
// appends host messages straight to conversation.jsonl; start-response-contract
// .test.mjs starts a panel and then inspects only its status.json and its
// list_sessions entry. So nothing ever ASSERTED that a live panel session was
// reachable -- and it was not, for every panel session, for its entire life,
// because isSessionRunnerAlive() mapped the new type onto the wrong runner.
//
// Every assertion below therefore goes through a tool a real caller would use.
// The rule this file exists to enforce: if the documented workflow says to call
// it, a test has to call it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { writeFakeCli, writeFakeAdapter } from "./helpers/fake-cli.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SERVER_PATH = path.join(REPO_ROOT, "src", "dialog-server.mjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-pr-e2e-"));
const HOME = path.join(ROOT, "home");
const ADAPTER_DIR = path.join(ROOT, "adapters");
const BIN_DIR = path.join(ROOT, "bin");
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

const FAKE_REPLY = [
  "The specialist reviewed the change.",
  "",
  "### Normalized Findings",
  "[CORRECTNESS] src/app.ts:4 — the retry loop never terminates",
  "",
  "ASPECT_RESULT: FINDINGS",
].join("\n");

const FAKE_BIN = writeFakeCli(BIN_DIR, "fake-e2e.mjs", "sidecar-ok", { reply: FAKE_REPLY });
writeFakeAdapter(ADAPTER_DIR, "fake-e2e", FAKE_BIN);

// A committed sha, so the review target does not depend on the working tree
// being dirty or clean when the suite runs.
const HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })
  .toString()
  .trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// end_dialog is not synchronous with the runner's death: it writes end_signal and
// only WAITS when isSessionRunnerAlive says the runner is alive, which answers
// "not alive" whenever it cannot read a command line. So the deadline has to
// cover a poll interval plus process startup, not just the grace period.
const RUNNER_EXIT_DEADLINE_MS = Number(
  process.env.DUALOG_TEST_RUNNER_EXIT_DEADLINE_MS || 20000
);

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

async function withServer(t, body) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: HOME,
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      HOMEDRIVE: "",
      HOMEPATH: HOME,
      XDG_CONFIG_HOME: path.join(HOME, ".config"),
      XDG_CONFIG_DIRS: "",
      DUALOG_ADAPTER_PATH: ADAPTER_DIR,
      DUALOG_ROLE: "",
      DUALOG_DEPTH: "",
      DUALOG_MAX_DEPTH: "",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "pr-review-e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    return await body(client);
  } finally {
    // Driven by what is on disk rather than by what the body remembered: a
    // detached runner that outlives the test is invisible to node:test, and
    // these runners idle for up to 24 hours.
    //
    // Failures are COLLECTED and asserted, not swallowed. An earlier version
    // caught them with a comment promising "reported by the assertions below" --
    // and there were no assertions below, so a session that refused to close and
    // a runner that ignored SIGTERM both passed silently.
    const sessionsRoot = path.join(HOME, ".dualog", "sessions");
    const onDisk = fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : [];

    const pids = new Map();
    for (const sessionId of onDisk) {
      const pid = readStatus(sessionsRoot, sessionId)?.runner_pid;
      if (Number.isSafeInteger(pid) && pid > 0) pids.set(sessionId, pid);
    }

    const failures = [];
    for (const sessionId of onDisk) {
      try {
        const res = await client.callTool({
          name: "end_dialog",
          arguments: { session_id: sessionId },
        });
        const parsed = JSON.parse(res.content[0].text);
        if (!parsed.ended) failures.push(`${sessionId}: ${res.content[0].text.slice(0, 160)}`);
      } catch (err) {
        failures.push(`${sessionId}: ${err.message}`);
      }
    }

    // Observed, not assumed, and BEFORE the client closes -- shutting the
    // transport first kills the server's child-exit watcher, so runner_state
    // would never reach "exited".
    const stragglers = [];
    for (const [sessionId, pid] of pids) {
      const giveUpAt = Date.now() + RUNNER_EXIT_DEADLINE_MS;
      while (pidAlive(pid) && readStatus(sessionsRoot, sessionId)?.runner_state !== "exited") {
        if (Date.now() >= giveUpAt) {
          stragglers.push(`${sessionId}: runner ${pid} still alive after end_dialog`);
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* exited between the poll and here */
          }
          break;
        }
        await sleep(100);
      }
    }

    await client.close();

    assert.deepEqual(failures, [], "every session created under this home must close cleanly");
    assert.deepEqual(stragglers, [], "every runner started under this home must be gone");
  }
}

const callJson = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};

const callText = async (client, name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return res.content[0].text;
};

async function startPanel(client, aspects = ["code"]) {
  return callJson(client, "start_pr_review", {
    project_path: REPO_ROOT,
    diff_target: `commit:${HEAD_SHA}`,
    aspects,
    partner_agent: "fake-e2e",
    follow_up_rounds: 2,
  });
}

test("a live panel session is reachable through the tools its own docs name", async (t) => {
  await withServer(t, async (client) => {
    const started = await startPanel(client);
    assert.equal(started.panel_passes, 1);

    // 1. wait_for_partner_response must BLOCK for a real reply. The bug made it
    //    return `runner_exited` in single-digit milliseconds, before the first
    //    pass had produced anything, because the liveness check could never
    //    match the runner it had just spawned.
    const waited = await callJson(client, "wait_for_partner_response", {
      session_id: started.session_id,
      since_id: 0,
      timeout_ms: 120000,
    });
    // Asserted positively. `notEqual(..., "runner_exited")` also passes on
    // "error" -- and classifyWaitResult checks last_error BEFORE liveness, so a
    // panel whose first pass failed outright would satisfy that assertion, plus
    // the two below it, while being entirely broken.
    assert.equal(
      waited.wait_result,
      "message",
      `expected the wait to return the first panel pass, got ${waited.wait_result}`
    );
    assert.equal(waited.partner_runner_alive, true);
    assert.ok(
      waited.new_messages.length > 0,
      "the wait returned without the panel pass it was waiting for"
    );

    // 2. list_sessions must agree, and must report the panel as its own type.
    const listed = await callJson(client, "list_sessions", {});
    const entry = listed.find((s) => s.session_id === started.session_id);
    assert.equal(entry.type, "pr_review");
    assert.equal(entry.runner_alive, true);

    // 3. check_partner_alive is the documented recovery path when a wait times
    //    out; it has to be able to see the runner too.
    const alive = await callJson(client, "check_partner_alive", {
      session_id: started.session_id,
    });
    assert.equal(alive.partner_runner_alive ?? alive.runner_alive, true);
  });
});

test("the panel's findings survive the round trip into get_pr_review_report", async (t) => {
  await withServer(t, async (client) => {
    const started = await startPanel(client);

    // Wait for the panel pass AND the consolidation that follows it.
    let report;
    const giveUpAt = Date.now() + 120000;
    for (;;) {
      report = await callJson(client, "get_pr_review_report", {
        session_id: started.session_id,
      });
      if (report.panel_complete) break;
      if (Date.now() >= giveUpAt) {
        assert.fail(
          `panel never completed: reported=${JSON.stringify(report.aspects_reported)} ` +
            `pending=${JSON.stringify(report.aspects_pending)} ` +
            `failed=${JSON.stringify(report.aspects_failed)}`
        );
      }
      await sleep(1000);
    }

    // Attribution is the coupling that used to live in three separate copies of
    // a regex. If the header and the parser ever drift apart again, findings
    // vanish from this report silently -- so assert the content, not the count.
    assert.deepEqual(report.aspects_reported, ["code"]);
    assert.deepEqual(report.aspects_pending, []);
    assert.deepEqual(report.aspects_failed, []);
    assert.equal(report.phase, "follow_up");

    const critical = report.findings_by_category.correctness;
    assert.equal(critical.length, 1, "the specialist's normalized finding was not indexed");
    assert.equal(critical[0].aspect, "code", "the finding lost its aspect attribution");
    assert.match(critical[0].text, /retry loop never terminates/);

    assert.ok(report.consolidated_report, "the consolidated report is missing");

    // A skipped aspect must stay visible in the report, or a five-of-six review
    // reads as a six-of-six one.
    const skipped = report.aspects_skipped.map((s) => s.aspect);
    assert.ok(skipped.includes("tests"), "an unselected aspect vanished from the report");
    for (const entry of report.aspects_skipped) {
      assert.ok(entry.reason, `${entry.aspect} was skipped with no reason recorded`);
    }
  });
});

test("send_message is accepted once the panel has reported", async (t) => {
  await withServer(t, async (client) => {
    const started = await startPanel(client);

    const giveUpAt = Date.now() + 120000;
    for (;;) {
      const report = await callJson(client, "get_pr_review_report", {
        session_id: started.session_id,
      });
      if (report.panel_complete) break;
      if (Date.now() >= giveUpAt) assert.fail("panel never completed");
      await sleep(1000);
    }

    // The bug's most user-visible symptom: every follow-up message was refused
    // with "this session's runner is no longer running", making phase 3 of the
    // runner unreachable through the server no matter how healthy it was.
    const text = await callText(client, "send_message", {
      session_id: started.session_id,
      content: "I fixed the retry loop.",
    });
    assert.doesNotMatch(
      text,
      /runner is no longer running/,
      "the server refused a follow-up to a live panel session"
    );
    const sent = JSON.parse(text);
    assert.equal(sent.sent, true);
  });
});
