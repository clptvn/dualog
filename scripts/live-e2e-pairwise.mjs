#!/usr/bin/env node
/**
 * Live pairwise E2E — real partner CLIs in tmux.
 * Usage: node scripts/live-e2e-pairwise.mjs [b1|b2|b3|all]
 *
 * B1: host=grok partner=codex
 * B2: host=grok partner=claude
 * B3: host=claude partner=grok
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(repoRoot, "src", "dialog-server.mjs");
const which = process.argv[2] || "b1";
const WAIT_MS = Number(process.env.LIVE_E2E_WAIT_MS || 12 * 60 * 1000);

function parseToolText(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("no text in tool result: " + JSON.stringify(result));
  if (text.startsWith("Error:")) throw new Error(text);
  return JSON.parse(text);
}

const CASES = {
  b1: {
    id: "B1",
    host: "grok",
    partner: "codex",
    prompt: "Reply with exactly the single word PONG and nothing else.",
  },
  b2: {
    id: "B2",
    host: "grok",
    partner: "claude",
    prompt: "Reply with exactly the single word PONG and nothing else.",
  },
  b3: {
    id: "B3",
    host: "claude",
    partner: "grok",
    prompt: "Reply with exactly the single word PONG and nothing else.",
  },
};

async function runCase(c) {
  console.log(`\n=== ${c.id}: host=${c.host} partner=${c.partner} ===`);
  const client = new Client({ name: "live-e2e", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  let sessionId = null;
  let dialogDir = null;
  try {
    await client.connect(transport);
    const start = parseToolText(
      await client.callTool(
        {
          name: "start_dialog",
          arguments: {
            problem_description: `${c.id} live e2e ping`,
            project_path: repoRoot,
            host_agent: c.host,
            partner_agent: c.partner,
            max_rounds: 1,
            reasoning_effort: "low",
          },
        },
        undefined,
        { timeout: 15000 }
      )
    );
    sessionId = start.session_id;
    dialogDir = start.dialog_dir;
    assert.equal(start.host_agent, c.host);
    assert.equal(start.partner_agent, c.partner);
    console.log("session", sessionId);

    const sent = parseToolText(
      await client.callTool(
        {
          name: "send_message",
          arguments: { session_id: sessionId, content: c.prompt },
        },
        undefined,
        { timeout: 15000 }
      )
    );
    console.log("sent message_id", sent.message_id);

    const wait = parseToolText(
      await client.callTool(
        {
          name: "wait_for_partner_response",
          arguments: {
            session_id: sessionId,
            since_id: sent.message_id,
            timeout_ms: WAIT_MS,
          },
        },
        undefined,
        { timeout: WAIT_MS + 30000 }
      )
    );
    console.log("wait_result", wait.wait_result, "waited_ms", wait.waited_ms);

    const partnerMsgs = (wait.new_messages || []).filter(
      (m) => m.from === c.partner
    );
    const ok =
      wait.wait_result === "message" &&
      partnerMsgs.length > 0 &&
      /PONG/i.test(partnerMsgs.map((m) => m.content).join("\n"));

    // Isolation checks
    if (c.partner === "claude") {
      assert.ok(
        fs.existsSync(path.join(dialogDir, "claude-empty-mcp.json")),
        "claude-empty-mcp.json missing"
      );
    }
    if (c.partner === "grok") {
      // may appear after partner starts
      const grokHome = path.join(dialogDir, "grok-home");
      console.log("grok-home exists?", fs.existsSync(grokHome));
    }
    if (c.partner === "codex") {
      console.log(
        "codex-home exists?",
        fs.existsSync(path.join(dialogDir, "codex-home"))
      );
    }

    const end = parseToolText(
      await client.callTool(
        { name: "end_dialog", arguments: { session_id: sessionId } },
        undefined,
        { timeout: 30000 }
      )
    );
    console.log("ended", end.ended);

    const evidence = {
      id: c.id,
      pass: ok,
      session_id: sessionId,
      host: c.host,
      partner: c.partner,
      wait_result: wait.wait_result,
      partner_preview: partnerMsgs[0]?.content?.slice(0, 200) || null,
      dialog_dir: dialogDir,
    };
    console.log(JSON.stringify(evidence, null, 2));
    if (!ok) {
      const logPath = path.join(dialogDir, "runner.log");
      if (fs.existsSync(logPath)) {
        console.log("--- runner.log tail ---");
        console.log(fs.readFileSync(logPath, "utf-8").slice(-2000));
      }
      throw new Error(`${c.id} FAILED`);
    }
    return evidence;
  } finally {
    await transport.close().catch(() => {});
  }
}

async function main() {
  const keys = which === "all" ? ["b1", "b2", "b3"] : [which];
  const results = [];
  for (const k of keys) {
    if (!CASES[k]) throw new Error(`unknown case ${k}`);
    results.push(await runCase(CASES[k]));
  }
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
