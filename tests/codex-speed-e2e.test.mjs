import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFakeCli } from "./helpers/fake-cli.mjs";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("all start tools carry opt-in Codex speed through initial and follow-up turns", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-speed-e2e-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const adapters = path.join(root, "adapters");
  const bin = path.join(root, "bin");
  const log = path.join(root, "invocations.jsonl");
  for (const dir of [project, home, adapters, bin]) fs.mkdirSync(dir);
  execFileSync("git", ["init", "--quiet", project]);
  fs.writeFileSync(path.join(project, "fixture.txt"), "before\n");
  execFileSync("git", ["add", "."], { cwd: project });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "fixture"], { cwd: project });
  fs.writeFileSync(path.join(project, "fixture.txt"), "after\n");
  const fake = writeFakeCli(bin, "fake-codex", "sidecar-ok", {
    reply: "### Normalized Findings\nNone.\nASPECT_RESULT: CLEAN\nREVIEW_VERDICT: APPROVE",
  });
  const script = process.platform === "win32" ? path.join(bin, "fake-codex.mjs") : fake;
  fs.writeFileSync(script, fs.readFileSync(script, "utf8").replace(
    "const behavior =", 'fs.appendFileSync(process.env.DUALOG_SPEED_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nconst behavior ='
  ));
  const adapter = JSON.parse(fs.readFileSync(path.join(repo, "src/adapters/builtin/codex.json"), "utf8"));
  adapter.binary.default = fake;
  adapter.engines.default = "headless";
  adapter.nativeSubagents = null;
  fs.writeFileSync(path.join(adapters, "codex.json"), JSON.stringify(adapter));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex/config.toml"), 'service_tier = "ultrafast"\n');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, "src/dialog-server.mjs")],
    cwd: home,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, HOMEDRIVE: "", HOMEPATH: home,
      CODEX_HOME: path.join(home, ".codex"), XDG_CONFIG_HOME: home, XDG_CONFIG_DIRS: "",
      DUALOG_ADAPTER_PATH: adapters, DUALOG_ROLE: "", DUALOG_DEPTH: "", DUALOG_MAX_DEPTH: "",
      DUALOG_STRATEGY: "headless", DUALOG_SPEED_LOG: log,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "codex-speed-test", version: "1.0.0" }, { capabilities: {} });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(result.content[0].text);
  };
  const sessions = [];
  try {
    await client.connect(transport);
    for (const name of ["start_dialog", "start_code_review", "start_pr_review"]) {
      for (const speed of [undefined, "fast", "ultrafast"]) {
        fs.writeFileSync(log, "");
        const started = await call(name, {
          project_path: project, partner_agent: "codex", partner_command: fake,
          ...(speed ? { speed } : {}),
          ...(name === "start_dialog" ? { problem_description: "Quick review of ultrafast code" } : { diff_target: "uncommitted" }),
          ...(name === "start_pr_review" ? { aspects: ["code"] } : {}),
        });
        assert.ok(started.session_id);
        sessions.push(started.session_id);
        assert.equal(started.speed, speed ?? null);
        const sessionDir = path.join(home, ".dualog/sessions", started.session_id);
        assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, "status.json"))).speed, speed ?? null);
        if (name === "start_dialog") {
          await call("send_message", { session_id: started.session_id, content: "Please review quickly." });
        }
        let count = 0;
        for (let attempt = 0; attempt < 200; attempt++) {
          count = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
          const panel = path.join(sessionDir, "panel_state.json");
          if (count && (name !== "start_pr_review" || (fs.existsSync(panel) && JSON.parse(fs.readFileSync(panel)).phase === "follow_up"))) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(count > 0, `${name} did not invoke the partner`);
        const waited = await call("wait_for_partner_response", { session_id: started.session_id, since_id: 0, timeout_ms: 10000 });
        assert.equal(waited.wait_result, "message");
        const sent = await call("send_message", { session_id: started.session_id, content: "Confirm the review is complete." });
        const followup = await call("wait_for_partner_response", { session_id: started.session_id, since_id: sent.message_id, timeout_ms: 15000 });
        assert.equal(followup.wait_result, "message");
        const invocations = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
        assert.ok(invocations.length >= (name === "start_pr_review" ? 3 : 2));
        for (const args of invocations) {
          assert.ok(args.includes(`service_tier="${speed ?? "default"}"`));
          assert.equal(args.includes("-p"), Boolean(speed));
          if (speed) assert.equal(args[args.indexOf("-p") + 1], speed);
        }
        const ended = await call("end_dialog", { session_id: started.session_id });
        assert.equal(ended.ended, true);
      }
    }
  } finally {
    for (const sessionId of sessions) {
      const statusPath = path.join(home, ".dualog/sessions", sessionId, "status.json");
      const status = JSON.parse(fs.readFileSync(statusPath));
      if (status.runner_pid) {
        try { process.kill(status.runner_pid, "SIGKILL"); } catch {}
      }
    }
    await client.close();
  }
});
