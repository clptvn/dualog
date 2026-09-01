import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { killTmuxServer } from "./helpers/tmux.mjs";
import { managedSession } from "./helpers/session.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmuxSocket = `codex-dialog-cleanup-test-${process.pid}`;
process.env.CODEX_DIALOG_TMUX_SOCKET = tmuxSocket;

// This file owns its socket exclusively (it is keyed by pid), so tearing the
// whole server down is safe even when an assertion failed and left a session
// behind -- including the deliberate no-auto-kill case. Per-test cleanup only
// removes sessions; without this the server process and its socket outlive the
// run and accumulate in the tmux socket directory.
after(() => {
  killTmuxServer(tmuxSocket);
});
process.env.CODEX_DIALOG_TERMINAL_FAILURE_CHECK_MS = "100";
process.env.CODEX_DIALOG_POST_SUBMIT_VERIFY_MS = "500";
process.env.CODEX_DIALOG_POST_SUBMIT_RETRY_MS = "300";
process.env.CODEX_DIALOG_POST_SUBMIT_RETRY_TRIGGER_MS = "100";

const {
  detectPartnerTerminalFailure,
} = await import("../src/partner-invocation.mjs");
const {
  isSessionRunnerAlive,
} = await import("../src/runner-lifecycle.mjs");
const {
  isTmuxAvailable,
  isTmuxSessionAlive,
  readTerminalState,
  terminateCurrentPartnerTerminal,
} = await import("../src/tmux-runtime.mjs");

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode != null || child.signalCode != null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Runner did not exit")), timeoutMs)
    ),
  ]);
}

test("definitive partner CLI failures are distinguished from a normal idle prompt", () => {
  assert.deepEqual(
    detectPartnerTerminalFailure(
      "⎿  You've hit your monthly spend limit.\n/usage-credits to adjust your monthly spend limit.\n❯"
    ),
    {
      code: "usage_limit",
      summary: "the partner CLI reported an account usage, spend, or rate limit",
    }
  );
  assert.deepEqual(
    detectPartnerTerminalFailure(
      "API Error: Fable 5's safeguards flagged this message. Claude Code can't respond to this request with Fable 5.\n❯"
    ),
    {
      code: "policy_block",
      summary: "the partner CLI reported a terminal policy or safeguard refusal",
    }
  );
  assert.equal(
    detectPartnerTerminalFailure(
      "OpenAI Codex (v1.0.0)\nPartner is waiting at a normal prompt.\n›"
    ),
    null
  );
  assert.equal(
    detectPartnerTerminalFailure(
      `You've hit your usage limit in this historical example.\n${"ordinary output\n".repeat(60)}`
    ),
    null,
    "old transcript text outside the recent terminal tail must not be treated as a live CLI failure"
  );
});

test("runner liveness rejects an unrelated process after PID reuse", () => {
  const sessionDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-dialog-runner-identity-")
  );
  try {
    assert.equal(
      isSessionRunnerAlive(
        {
          type: "review",
          runner_pid: process.pid,
        },
        sessionDir
      ),
      false
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test(
  "definitive terminal failure cleans tmux, exits the review runner, and clears its PID",
  { timeout: 30000 },
  async (t) => {
    if (process.platform === "win32") {
      t.skip("native POSIX tmux failure fixture; WSL routing has separate coverage");
      return;
    }
    if (!(await isTmuxAvailable())) {
      t.skip("tmux is not available");
      return;
    }

    const { home: sessionHome, dir: sessionDir } = managedSession("orphancleanup");
    const fakeCodex = path.join(sessionDir, "fake-codex.sh");
    const runnerToken = "cleanup-regression-token";
    fs.writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        "printf 'OpenAI Codex (v1.0.0)\\n'",
        "printf \"You've hit your usage limit.\\n\"",
        "printf '› \\n'",
        "while :; do sleep 1; done",
        "",
      ].join("\n")
    );
    fs.chmodSync(fakeCodex, 0o755);
    fs.writeFileSync(path.join(sessionDir, "diff.patch"), "diff --git a/a b/a\n");
    fs.writeFileSync(
      path.join(sessionDir, "review_meta.json"),
      JSON.stringify({
        branch: "test",
        base_branch: "HEAD",
        diff_label: "test diff",
        diff_stat: "1 file changed",
      })
    );
    fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), "");
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify({
        session_id: path.basename(sessionDir),
        type: "review",
        host_agent: "claude",
        partner_agent: "codex",
        runner_pid: null,
        runner_token: runnerToken,
        runner_state: "starting",
      })
    );

    const runner = spawn(
      process.execPath,
      [
        path.join(repoRoot, "src/review-runner.mjs"),
        sessionDir,
        repoRoot,
        fakeCodex,
        "5",
        "high",
        "",
        "claude",
        "codex",
        "1000",
        `--runner-token=${runnerToken}`,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CODEX_DIALOG_TMUX_SOCKET: tmuxSocket,
          CODEX_DIALOG_TERMINAL_FAILURE_CHECK_MS: "100",
        },
        stdio: "ignore",
      }
    );

    const statusPath = path.join(sessionDir, "status.json");
    const startingStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        ...startingStatus,
        runner_pid: runner.pid,
        runner_state: "running",
      })
    );

    t.after(async () => {
      if (runner.exitCode == null && runner.signalCode == null) {
        runner.kill("SIGKILL");
      }
      await terminateCurrentPartnerTerminal(sessionDir).catch(() => {});
      fs.rmSync(sessionHome, { recursive: true, force: true });
    });

    const terminal = await waitFor(() => {
      const { current, last } = readTerminalState(sessionDir);
      return current || (last?.status === "failed" ? last : null);
    });
    await waitForExit(runner);

    const finalStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    const { current, last } = readTerminalState(sessionDir);
    const error = fs.readFileSync(
      path.join(sessionDir, "last_error.txt"),
      "utf-8"
    );

    assert.equal(current, null);
    assert.equal(last.status, "failed");
    assert.equal(
      await isTmuxSessionAlive(terminal.session_name),
      false,
      "definitive terminal failure must not leave its tmux session alive"
    );
    assert.match(error, /usage, spend, or rate limit/u);
    assert.equal(finalStatus.runner_pid, null);
    assert.equal(finalStatus.last_runner_pid, runner.pid);
    assert.equal(finalStatus.runner_state, "exited");
    assert.equal(finalStatus.runner_exit_reason, "partner_terminal_failure");
  }
);

test(
  "undelivered Claude prompt is cleaned up without treating ordinary idle as a timeout",
  { timeout: 30000 },
  async (t) => {
    if (process.platform === "win32") {
      t.skip("native POSIX tmux prompt fixture; WSL routing has separate coverage");
      return;
    }
    if (!(await isTmuxAvailable())) {
      t.skip("tmux is not available");
      return;
    }

    const { home: sessionHome, dir: sessionDir } = managedSession("submissioncleanup");
    const fakeClaude = path.join(sessionDir, "fake-claude.sh");
    const runnerToken = "submission-cleanup-token";
    fs.writeFileSync(
      fakeClaude,
      [
        "#!/bin/sh",
        "stty -echo",
        "printf 'Claude Code v2.1.220\\n'",
        "printf 'Try \"refactor page.tsx\"\\n'",
        "printf 'bypass permissions on\\n'",
        "printf '❯ \\n'",
        "while :; do sleep 1; done",
        "",
      ].join("\n")
    );
    fs.chmodSync(fakeClaude, 0o755);
    fs.writeFileSync(path.join(sessionDir, "diff.patch"), "diff --git a/a b/a\n");
    fs.writeFileSync(
      path.join(sessionDir, "review_meta.json"),
      JSON.stringify({
        branch: "test",
        base_branch: "HEAD",
        diff_label: "test diff",
        diff_stat: "1 file changed",
      })
    );
    fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), "");
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify({
        session_id: path.basename(sessionDir),
        type: "review",
        host_agent: "codex",
        partner_agent: "claude",
        runner_pid: null,
        runner_token: runnerToken,
        runner_state: "starting",
      })
    );

    const runner = spawn(
      process.execPath,
      [
        path.join(repoRoot, "src/review-runner.mjs"),
        sessionDir,
        repoRoot,
        fakeClaude,
        "5",
        "high",
        "",
        "codex",
        "claude",
        "1000",
        `--runner-token=${runnerToken}`,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CODEX_DIALOG_TMUX_SOCKET: tmuxSocket,
          CODEX_DIALOG_POST_SUBMIT_VERIFY_MS: "500",
          CODEX_DIALOG_POST_SUBMIT_RETRY_MS: "300",
          CODEX_DIALOG_POST_SUBMIT_RETRY_TRIGGER_MS: "100",
        },
        stdio: "ignore",
      }
    );

    const statusPath = path.join(sessionDir, "status.json");
    const startingStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        ...startingStatus,
        runner_pid: runner.pid,
        runner_state: "running",
      })
    );

    t.after(async () => {
      if (runner.exitCode == null && runner.signalCode == null) {
        runner.kill("SIGKILL");
      }
      await terminateCurrentPartnerTerminal(sessionDir).catch(() => {});
      fs.rmSync(sessionHome, { recursive: true, force: true });
    });

    const terminal = await waitFor(() => {
      const { current, last } = readTerminalState(sessionDir);
      return current || (last?.status === "failed" ? last : null);
    });
    await waitForExit(runner);

    const { current, last } = readTerminalState(sessionDir);
    const error = fs.readFileSync(
      path.join(sessionDir, "last_error.txt"),
      "utf-8"
    );
    assert.equal(current, null);
    assert.equal(last.status, "failed");
    assert.equal(
      await isTmuxSessionAlive(terminal.session_name),
      false,
      "an undelivered prompt must not leave its tmux session alive"
    );
    assert.match(error, /prompt submission failed/u);
  }
);
