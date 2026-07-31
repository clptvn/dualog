import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { describe, it, after } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccd-inv-"));
const sessionDir = path.join(TMP, "session");
fs.mkdirSync(sessionDir, { recursive: true });

const { buildPartnerInvocation } = await import(
  "../src/partner-invocation.mjs"
);

describe("buildPartnerInvocation isolation", () => {
  it("claude partner uses empty MCP config and no recursive servers", () => {
    const inv = buildPartnerInvocation({
      partnerAgent: "claude",
      partnerCommand: "claude",
      projectPath: TMP,
      sessionDir,
      toolProfile: "read",
      sessionName: "test-sess",
    });
    assert.equal(inv.command, "claude");
    assert.ok(inv.args.includes("--mcp-config"));
    assert.ok(inv.args.includes("--strict-mcp-config"));
    assert.ok(inv.args.includes("--permission-mode"));
    const mcpIdx = inv.args.indexOf("--mcp-config");
    const mcpPath = inv.args[mcpIdx + 1];
    assert.ok(fs.existsSync(mcpPath));
    const cfg = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    assert.deepEqual(cfg.mcpServers, {});
    assert.ok(inv.args.includes("Edit,MultiEdit,Write,NotebookEdit"));
  });

  it("codex partner uses isolated CODEX_HOME and workspace-write sandbox", () => {
    const inv = buildPartnerInvocation({
      partnerAgent: "codex",
      partnerCommand: "codex",
      projectPath: TMP,
      sessionDir,
      toolProfile: "read",
      sessionName: "test-sess",
      initialPrompt: "hello",
    });
    assert.equal(inv.command, "codex");
    // read-only sandbox exits immediately under current Codex CLI in tmux
    assert.ok(inv.args.includes("workspace-write"));
    assert.ok(inv.env?.CODEX_HOME);
    assert.ok(inv.env.CODEX_HOME.includes("codex-home"));
    assert.equal(inv.usesInitialPrompt, true);
    const cfg = path.join(inv.env.CODEX_HOME, "config.toml");
    assert.ok(fs.existsSync(cfg));
    assert.match(fs.readFileSync(cfg, "utf-8"), /mcp_servers/);
  });

  it("grok partner uses isolated GROK_HOME and always-approve", () => {
    const inv = buildPartnerInvocation({
      partnerAgent: "grok",
      partnerCommand: "grok",
      projectPath: TMP,
      sessionDir,
      toolProfile: "read",
      sessionName: "test-sess",
      initialPrompt: "hello",
    });
    assert.equal(inv.command, "grok");
    assert.ok(inv.args.includes("--always-approve"));
    assert.ok(inv.args.includes("--no-subagents"));
    assert.ok(inv.env?.GROK_HOME);
    assert.ok(inv.env.GROK_HOME.includes("grok-home"));
    assert.equal(inv.usesInitialPrompt, true);
  });

  it("codex implementation profile uses workspace-write", () => {
    const inv = buildPartnerInvocation({
      partnerAgent: "codex",
      partnerCommand: "codex",
      projectPath: TMP,
      sessionDir,
      toolProfile: "implementation",
      sessionName: "test-sess",
    });
    assert.ok(inv.args.includes("workspace-write"));
  });
});

describe("active session limit rejection", () => {
  it("throws when at capacity with live runner pids", async () => {
    const root = path.join(TMP, "limit-root");
    fs.mkdirSync(root, { recursive: true });
    process.env.CODEX_DIALOG_HOME = root;
    process.env.CODEX_DIALOG_MAX_ACTIVE_SESSIONS = "2";

    // Re-import maintenance with env set — module may already be cached; call with root arg
    const { assertUnderActiveSessionLimit } =
      await import("../src/session-maintenance.mjs");

    for (let i = 0; i < 2; i++) {
      const id = `dialog-${Date.now() + i}-abcde${i}f0`;
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      // Use our own pid so isProcessAlive returns true
      fs.writeFileSync(
        path.join(dir, "status.json"),
        JSON.stringify({
          session_id: id,
          runner_pid: process.pid,
          started_at: new Date().toISOString(),
        })
      );
    }

    assert.throws(
      () => assertUnderActiveSessionLimit(root),
      /Active session limit reached/
    );
  });
});

describe("resolveGroupTargets", () => {
  it("resolves addressable, fan_out, and round_robin", async () => {
    const { resolveGroupTargets } = await import("../src/shared.mjs");
    const status = {
      partner_agents: ["claude", "codex"],
      mode: "addressable",
      turn_state: { rr_index: 0 },
    };
    assert.deepEqual(resolveGroupTargets(status, { to: "claude" }), ["claude"]);
    assert.deepEqual(resolveGroupTargets(status, { to: "all" }), [
      "claude",
      "codex",
    ]);
    assert.deepEqual(resolveGroupTargets({ ...status, mode: "fan_out" }, {}), [
      "claude",
      "codex",
    ]);
    assert.deepEqual(
      resolveGroupTargets({ ...status, mode: "round_robin" }, {}),
      ["claude"]
    );
    assert.deepEqual(
      resolveGroupTargets(
        { ...status, mode: "round_robin", turn_state: { rr_index: 1 } },
        {}
      ),
      ["codex"]
    );
  });
});

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});
