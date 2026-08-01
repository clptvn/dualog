import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sentinelFreeEnv } from "./helpers/sentinel.mjs";
import { killTmuxServer } from "./helpers/tmux.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SERVER_PATH = path.join(REPO_ROOT, "src", "dialog-server.mjs");

const tmuxSocket = `codex-dialog-recursion-test-${process.pid}`;
process.env.CODEX_DIALOG_TMUX_SOCKET = tmuxSocket;

// The socket is keyed by pid, so this file owns it outright. Per-test cleanup
// only terminates sessions; the server itself would otherwise survive the run
// and leave its socket file behind on every invocation.
after(() => {
  killTmuxServer(tmuxSocket);
});
const { isTmuxAvailable, terminateCurrentPartnerTerminal } = await import(
  "../src/tmux-runtime.mjs"
);

async function waitFor(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function listToolNames(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    // The child inherits our env, so every sentinel var must be explicitly
    // cleared rather than merely omitted.
    env: { ...process.env, DUALOG_ROLE: "", DUALOG_DEPTH: "", DUALOG_MAX_DEPTH: "", ...env },
    stderr: "ignore",
  });
  const client = new Client(
    { name: "recursion-guard-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

test("host session exposes the full tool surface", async () => {
  const names = await listToolNames({});
  assert.ok(names.length > 0, "host server exposed no tools");
  for (const expected of ["start_dialog", "send_message", "end_dialog"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
});

test("DUALOG_ROLE=partner serves an empty tool list instead of recursing", async () => {
  const names = await listToolNames({ DUALOG_ROLE: "partner" });
  assert.deepEqual(names, [], `partner server exposed tools: ${names.join(", ")}`);
});

test("depth at or past the cap serves an empty tool list", async () => {
  assert.deepEqual(await listToolNames({ DUALOG_DEPTH: "1" }), []);
  assert.deepEqual(await listToolNames({ DUALOG_DEPTH: "9" }), []);
});

test("depth below the cap is unaffected", async () => {
  const baseline = await listToolNames({});
  assert.deepEqual(await listToolNames({ DUALOG_DEPTH: "0" }), baseline);
  // A raised cap must re-open the surface at a depth that would otherwise block.
  assert.deepEqual(
    await listToolNames({ DUALOG_DEPTH: "1", DUALOG_MAX_DEPTH: "2" }),
    baseline
  );
});

test("unparseable depth values are treated as unset, not NaN", async () => {
  const baseline = await listToolNames({});
  // Empty is the common case: the var is inherited-but-cleared rather than
  // absent. Non-numeric and negative values carry no usable depth, so they
  // must not poison the comparison into NaN (which would compare false and
  // silently disable the guard).
  for (const bogus of ["", "abc", "-3", "0"]) {
    assert.deepEqual(
      await listToolNames({ DUALOG_DEPTH: bogus }),
      baseline,
      `DUALOG_DEPTH=${JSON.stringify(bogus)} should behave as unset`
    );
  }
});

test("a partially-numeric depth blocks rather than admits", async () => {
  // parseInt("1.5") === 1, which is at the cap. For a recursion guard the safe
  // direction is to block, so this asserts fail-closed behavior deliberately.
  assert.deepEqual(await listToolNames({ DUALOG_DEPTH: "1.5" }), []);
  assert.deepEqual(await listToolNames({ DUALOG_DEPTH: "2x" }), []);
});

// The env sentinel is only worth anything if it actually reaches the partner
// process. It is passed through the tmux command's `env K=V` prefix rather than
// inherited, because the tmux server is long-lived: a session started later
// would otherwise reuse whatever environment the server first booted with.
// These tests run a fake partner CLI that dumps its own environment.
for (const { hostAgent, partnerAgent, readyBanner } of [
  { hostAgent: "claude", partnerAgent: "codex", readyBanner: "OpenAI Codex (v1.0.0)\\n\\u203a \\n" },
  { hostAgent: "codex", partnerAgent: "claude", readyBanner: "Claude Code v1.0.0\\nTry \\\"x\\\"\\n" },
]) {
  test(
    `sentinel env reaches a spawned ${partnerAgent} partner`,
    { timeout: 40000 },
    async (t) => {
      if (!(await isTmuxAvailable())) {
        t.skip("tmux is not available");
        return;
      }

      const sessionDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `codex-dialog-sentinel-${partnerAgent}-`)
      );
      const envDump = path.join(sessionDir, "partner-env.txt");
      const fakeCli = path.join(sessionDir, `fake-${partnerAgent}.sh`);
      fs.writeFileSync(
        fakeCli,
        `#!/bin/sh\n` +
          `{\n` +
          `  printf 'DUALOG_ROLE=%s\\n' "$DUALOG_ROLE"\n` +
          `  printf 'DUALOG_DEPTH=%s\\n' "$DUALOG_DEPTH"\n` +
          `} > ${JSON.stringify(envDump)}\n` +
          `printf '${readyBanner}'\n` +
          `while :; do sleep 1; done\n`
      );
      fs.chmodSync(fakeCli, 0o755);
      fs.writeFileSync(path.join(sessionDir, "problem.md"), "Sentinel env check.");
      fs.writeFileSync(
        path.join(sessionDir, "conversation.jsonl"),
        `${JSON.stringify({
          id: 1,
          from: hostAgent,
          content: "Start a turn so the partner CLI is launched.",
          timestamp: new Date().toISOString(),
        })}\n`
      );

      const runner = spawn(
        process.execPath,
        [
          path.join(REPO_ROOT, "src/dialog-runner.mjs"),
          sessionDir,
          REPO_ROOT,
          fakeCli,
          "5",
          "high",
          "",
          hostAgent,
          partnerAgent,
          "read",
          "60000",
        ],
        {
          cwd: REPO_ROOT,
          // Depth 1 is what a partner spawned by a non-partner must see, so the
          // runner has to start from depth 0. Inheriting this process's own
          // sentinel would make the assertion below describe who ran the suite
          // rather than what the runner does.
          env: {
            ...sentinelFreeEnv(),
            CODEX_DIALOG_TMUX_SOCKET: tmuxSocket,
          },
          stdio: "ignore",
        }
      );

      t.after(async () => {
        if (runner.exitCode == null && runner.signalCode == null) runner.kill("SIGKILL");
        await terminateCurrentPartnerTerminal(sessionDir).catch(() => {});
        fs.rmSync(sessionDir, { recursive: true, force: true });
      });

      const dumped = await waitFor(() =>
        fs.existsSync(envDump) ? fs.readFileSync(envDump, "utf-8") : null
      );

      assert.match(
        dumped,
        /^DUALOG_ROLE=partner$/m,
        `partner ${partnerAgent} did not receive DUALOG_ROLE=partner; got:\n${dumped}`
      );
      assert.match(
        dumped,
        /^DUALOG_DEPTH=1$/m,
        `partner ${partnerAgent} did not receive DUALOG_DEPTH=1; got:\n${dumped}`
      );
    }
  );
}
