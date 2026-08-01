import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { killTmuxServer } from "./helpers/tmux.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmuxSocket = `codex-dialog-test-${process.pid}`;
process.env.CODEX_DIALOG_TMUX_SOCKET = tmuxSocket;

// This suite proves a session is NOT auto-killed, so it necessarily ends with a
// live session. Owning the socket by pid is what makes tearing the whole server
// down at file scope compatible with that: the assertion is about dualog's
// behavior during the test, not about what survives the process.
after(() => {
  killTmuxServer(tmuxSocket);
});

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

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode != null || child.signalCode != null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Runner did not exit after SIGTERM")), timeoutMs)
    ),
  ]);
}

test("runner shutdown preserves an active tmux pane until explicit termination", { timeout: 30000 }, async (t) => {
  if (!(await isTmuxAvailable())) {
    t.skip("tmux is not available");
    return;
  }

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-dialog-no-auto-kill-"));
  const fakeCodex = path.join(sessionDir, "fake-codex.sh");
  fs.writeFileSync(
    fakeCodex,
    "#!/bin/sh\nprintf 'OpenAI Codex (v1.0.0)\\n\u203a \\n'\nwhile :; do sleep 1; done\n"
  );
  fs.chmodSync(fakeCodex, 0o755);
  fs.writeFileSync(path.join(sessionDir, "problem.md"), "Keep the partner turn running.");
  fs.writeFileSync(
    path.join(sessionDir, "conversation.jsonl"),
    `${JSON.stringify({
      id: 1,
      from: "claude",
      content: "Start a deliberately long turn.",
      timestamp: new Date().toISOString(),
    })}\n`
  );

  const runner = spawn(
    process.execPath,
    [
      path.join(repoRoot, "src/dialog-runner.mjs"),
      sessionDir,
      repoRoot,
      fakeCodex,
      "5",
      "high",
      "",
      "claude",
      "codex",
      "read",
      "1000",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, CODEX_DIALOG_TMUX_SOCKET: tmuxSocket },
      stdio: "ignore",
    }
  );

  t.after(async () => {
    if (runner.exitCode == null && runner.signalCode == null) runner.kill("SIGKILL");
    await terminateCurrentPartnerTerminal(sessionDir).catch(() => {});
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  const terminal = await waitFor(() => {
    const { current } = readTerminalState(sessionDir);
    return current?.status === "running" ? current : null;
  });
  assert.equal(await isTmuxSessionAlive(terminal.session_name), true);

  runner.kill("SIGTERM");
  await waitForExit(runner);
  assert.equal(
    await isTmuxSessionAlive(terminal.session_name),
    true,
    "runner shutdown must not kill an active partner pane"
  );

  assert.equal(await terminateCurrentPartnerTerminal(sessionDir), true);
  assert.equal(await isTmuxSessionAlive(terminal.session_name), false);
});

test("source contains no pane inactivity watchdog or automatic orphan sweep", () => {
  const invocation = fs.readFileSync(
    path.join(repoRoot, "src/partner-invocation.mjs"),
    "utf8"
  );
  const combinedRuntime = [
    "src/dialog-server.mjs",
    "src/dialog-runner.mjs",
    "src/review-runner.mjs",
    "src/tmux-runtime.mjs",
  ]
    .map((relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8"))
    .join("\n");

  assert.doesNotMatch(invocation, /CODEX_DIALOG_STALLED_PANE_MS|UNKNOWN_STALL_MS|IDLE_PROMPT_STALL_MS/u);
  assert.doesNotMatch(invocation, /did not show recognizable activity|appears idle in tmux without writing completion/u);
  assert.doesNotMatch(combinedRuntime, /sweepOrphanedPartnerTerminals/u);
});
