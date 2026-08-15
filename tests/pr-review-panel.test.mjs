// The PR review panel, driven end to end through the real runner.
//
// Everything else about the panel is unit-testable: prompt construction, aspect
// selection, finding extraction. The phase loop is not. It is a detached
// process that appends messages other code parses back by shape, and the two
// halves live in different files -- the runner writes a header, and
// get_pr_review_report attributes findings by matching it. Nothing in a unit
// test notices when one side of that changes.
//
// So this runs the actual runner against a scripted fake partner CLI and reads
// what lands on disk. What it deliberately does NOT test is review quality:
// the fake returns a canned report, so the assertions are about plumbing --
// that every selected aspect gets its own pass, that consolidation happens once
// and only after them, and that the result is attributable back to the aspect
// that produced it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { writeFakeCli, writeFakeAdapter } from "./helpers/fake-cli.mjs";
import {
  ASPECT_HEADER_RE,
  CONSOLIDATED_HEADER_RE,
  extractAspectResult,
  extractNormalizedFindings,
} from "../src/pr-review-aspects.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNNER_PATH = path.join(REPO_ROOT, "src", "pr-review-runner.mjs");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-pr-panel-"));
const HOME = path.join(ROOT, "home");
const ADAPTER_DIR = path.join(ROOT, "adapters");
const BIN_DIR = path.join(ROOT, "bin");
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

// The canned report carries a normalized finding so the extraction path is
// exercised with real runner output rather than a hand-written string.
const FAKE_REPLY = [
  "The specialist looked at the change.",
  "",
  "### Normalized Findings",
  "[CORRECTNESS] src/app.ts:4 — the retry loop never terminates",
  "",
  "ASPECT_RESULT: FINDINGS",
].join("\n");

const FAKE_BIN = writeFakeCli(BIN_DIR, "fake-panel.mjs", "sidecar-ok", {
  reply: FAKE_REPLY,
});
writeFakeAdapter(ADAPTER_DIR, "fake-panel", FAKE_BIN);

// A partner that exits cleanly having written an empty result. This is a real
// shape, not a contrived one: a CLI whose write tools were silently denied, a
// turn stopped by a content filter, or a done.json that raced result.md all
// arrive exactly like this.
// Passed as the runner's partner COMMAND, so it runs under the same adapter --
// only the binary's behavior differs.
const EMPTY_BIN = writeFakeCli(BIN_DIR, "fake-empty.mjs", "sidecar-ok", { reply: "" });

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,5 @@",
  " const existing = 1;",
  "+export interface Retry { attempts: number }",
  "+try { go() } catch (e) {}",
].join("\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readConversation(sessionDir) {
  const file = path.join(sessionDir, "conversation.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function setupSession(label, aspects) {
  const sessionId = `review-${Date.now()}-${label}`;
  const sessionDir = path.join(HOME, ".dualog", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "diff.patch"), DIFF);
  fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), "");
  fs.writeFileSync(
    path.join(sessionDir, "pr_review_meta.json"),
    JSON.stringify({
      review_kind: "pr_panel",
      scope: "pr",
      scope_label: "pull request #9 (feature → main)",
      pr: {
        number: 9,
        title: "Add retry",
        body: "",
        author: "someone",
        base: "main",
        head: "feature",
        url: "https://example.invalid/9",
      },
      diff_stat: "1 file(s) changed:\n  src/app.ts",
      files_changed: ["src/app.ts"],
      review_focus: null,
      aspects,
      skipped: [{ aspect: "comments", reason: "no comment changes detected" }],
    })
  );
  fs.writeFileSync(
    path.join(sessionDir, "status.json"),
    JSON.stringify({
      session_id: sessionId,
      type: "pr_review",
      host_agent: "claude",
      partner_agent: "fake-panel",
      project_path: ROOT,
      aspects,
      max_rounds: aspects.length + 1 + 5,
      hard_cap: aspects.length + 1 + 10,
      runner_state: "starting",
    })
  );
  return { sessionId, sessionDir };
}

function startRunner(sessionDir, followUpRounds = 2, binary = FAKE_BIN) {
  const child = spawn(
    process.execPath,
    [
      RUNNER_PATH,
      sessionDir,
      ROOT, // project path
      binary,
      String(followUpRounds),
      "", // reasoning effort
      "", // model
      "claude",
      "fake-panel",
      "60000",
    ],
    {
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
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  child.stderr.resume();
  return child;
}

/** Stop the runner and wait for it, so no detached child outlives the test. */
async function stopRunner(child, sessionDir) {
  try {
    fs.writeFileSync(path.join(sessionDir, "end_signal"), "");
  } catch {}
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await Promise.race([exited, sleep(8000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {}
    await Promise.race([exited, sleep(2000)]);
  }
}

async function waitForPartnerMessages(sessionDir, count, deadlineMs = 90000) {
  const giveUpAt = Date.now() + deadlineMs;
  for (;;) {
    const messages = readConversation(sessionDir);
    const partner = messages.filter((m) => m.from === "fake-panel");
    if (partner.length >= count) return messages;
    if (Date.now() >= giveUpAt) {
      const log = (() => {
        try {
          return fs.readFileSync(path.join(sessionDir, "runner.log"), "utf-8").slice(-3000);
        } catch {
          return "(no runner log)";
        }
      })();
      assert.fail(
        `expected ${count} partner message(s), saw ${partner.length}.\nrunner.log tail:\n${log}`
      );
    }
    await sleep(250);
  }
}

test("the panel runs one pass per aspect, then consolidates exactly once", async () => {
  const aspects = ["code", "types"];
  const { sessionDir } = setupSession("aaaaaaa1", aspects);
  const child = startRunner(sessionDir);

  try {
    // Two specialists plus one consolidation.
    const messages = await waitForPartnerMessages(sessionDir, aspects.length + 1);
    const partner = messages.filter((m) => m.from === "fake-panel");

    // Matched with the SHARED pattern the server parses with, not a local copy.
    // A third copy here meant the test checked the runner against itself, so a
    // change to either real side left every assertion green.
    const headers = partner.map((m) => m.content.match(ASPECT_HEADER_RE)).filter(Boolean);

    assert.equal(headers.length, 2, "each selected aspect must produce exactly one panel pass");
    assert.deepEqual(
      headers.map((h) => h[4]),
      aspects,
      "passes must run in the selected order and be labelled with their aspect"
    );
    assert.deepEqual(
      headers.map((h) => Number(h[1])),
      [1, 2],
      "passes must be numbered for the reader following along"
    );

    const consolidations = partner.filter((m) => CONSOLIDATED_HEADER_RE.test(m.content));
    assert.equal(consolidations.length, 1, "consolidation must happen once");
    // Compared against the LAST panel pass, found by header rather than by
    // position: a positional index silently checks the wrong message as soon as
    // the panel has more aspects than the index assumed.
    const lastPass = partner.filter((m) => ASPECT_HEADER_RE.test(m.content)).at(-1);
    assert.ok(
      consolidations[0].id > lastPass.id,
      "consolidation must come after every specialist pass, never before"
    );

    // The cross-file coupling this test exists for: what the runner writes must
    // be what the report tool can attribute back to an aspect.
    for (const message of partner.slice(0, 2)) {
      const findings = extractNormalizedFindings(message.content);
      assert.equal(findings.length, 1, "the pass's normalized finding must survive the round trip");
      assert.equal(findings[0].category, "CORRECTNESS");
      assert.equal(extractAspectResult(message.content), "FINDINGS");
    }
  } finally {
    await stopRunner(child, sessionDir);
  }
});

test("panel progress is recorded on disk while the panel is still running", async () => {
  const aspects = ["code"];
  const { sessionDir } = setupSession("aaaaaaa2", aspects);
  const child = startRunner(sessionDir);

  try {
    await waitForPartnerMessages(sessionDir, aspects.length + 1);

    // panel_state.json is the only place that distinguishes "this aspect found
    // nothing" from "this aspect never ran", which is the distinction a reader
    // of the report most needs and can least infer.
    const panelPath = path.join(sessionDir, "panel_state.json");
    assert.ok(fs.existsSync(panelPath), "the runner must record panel state");
    const panel = JSON.parse(fs.readFileSync(panelPath, "utf-8"));

    assert.equal(panel.total_passes, 2, "one specialist plus consolidation");
    const completed = panel.completed.map((c) => c.aspect);
    assert.ok(completed.includes("code"));
    assert.ok(completed.includes("__aggregate__"));
    for (const entry of panel.completed) {
      assert.equal(entry.status, "complete", `${entry.aspect} did not complete: ${entry.error}`);
    }
    assert.equal(panel.phase, "follow_up", "the panel must hand off to the conversation phase");
  } finally {
    await stopRunner(child, sessionDir);
  }
});

test("a pass that returns nothing is recorded as failed, not as clean", async () => {
  // The highest-value invariant in this system: a review that did not happen
  // must never render as a review that found nothing. A turn can exit
  // successfully having produced no text, and recorded as success that aspect
  // lands in aspects_reported with an empty finding list -- indistinguishable
  // from a specialist that ran and cleared the code.
  const aspects = ["code"];
  const { sessionDir } = setupSession("aaaaaaa4", aspects);
  const child = startRunner(sessionDir, 2, EMPTY_BIN);

  try {
    // The failure is announced as a system message, so wait on that rather than
    // on a partner message that will never come.
    const giveUpAt = Date.now() + 90000;
    let panel;
    for (;;) {
      try {
        panel = JSON.parse(fs.readFileSync(path.join(sessionDir, "panel_state.json"), "utf-8"));
      } catch {
        panel = null;
      }
      if (panel?.completed?.some((c) => c.aspect === "code")) break;
      if (Date.now() >= giveUpAt) assert.fail("the empty pass never resolved either way");
      await sleep(500);
    }

    const entry = panel.completed.find((c) => c.aspect === "code");
    assert.equal(entry.status, "failed", "an empty response was recorded as a completed pass");
    assert.match(entry.error, /empty report/i);

    const messages = readConversation(sessionDir);
    const partner = messages.filter((m) => m.from === "fake-panel");
    assert.equal(partner.length, 0, "an empty response was appended as if it were a report");

    const system = messages.filter((m) => m.from === "system");
    assert.ok(
      system.some((m) => /UNREVIEWED/.test(m.content)),
      "the log must say the aspect is unreviewed, not merely go quiet"
    );

    // And with no surviving report, consolidation must not run and quietly
    // approve a panel that reviewed nothing.
    assert.ok(
      !partner.some((m) => CONSOLIDATED_HEADER_RE.test(m.content)),
      "consolidation ran over a panel with no reports at all"
    );
  } finally {
    await stopRunner(child, sessionDir);
  }
});

test("a host message after the panel gets a follow-up turn, not a second panel", async () => {
  const aspects = ["code"];
  const { sessionDir } = setupSession("aaaaaaa3", aspects);
  const child = startRunner(sessionDir);

  try {
    await waitForPartnerMessages(sessionDir, 2);

    // Append a host message the way send_message would.
    const convPath = path.join(sessionDir, "conversation.jsonl");
    const existing = readConversation(sessionDir);
    const nextId = existing.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    fs.appendFileSync(
      convPath,
      JSON.stringify({
        id: nextId,
        from: "claude",
        content: "I fixed the retry loop.",
        timestamp: new Date().toISOString(),
      }) + "\n"
    );
    // No cache surgery is needed here. appendMessage's id cache records the log
    // SIZE it describes, so this raw append leaves it describing a shorter file
    // and the next append simply rebuilds by scanning -- one wasted scan, never
    // a duplicate id. (An earlier version of this test deleted the cache and
    // claimed it was preventing id reuse, which had it exactly backwards.)

    const messages = await waitForPartnerMessages(sessionDir, 3);
    const partner = messages.filter((m) => m.from === "fake-panel");
    const followUp = partner[partner.length - 1];

    assert.ok(
      !/^## Panel pass/m.test(followUp.content),
      "a follow-up must not re-run the panel — six specialists to confirm one fix would spend the whole budget"
    );
    assert.ok(!/^## Consolidated PR Review/m.test(followUp.content));
  } finally {
    await stopRunner(child, sessionDir);
  }
});
