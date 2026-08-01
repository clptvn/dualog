#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(repoRoot, "src", "dialog-server.mjs");
const dialogsDir = path.join(os.homedir(), ".claude", "dialogs");
const createdDirs = [];
const fixtureRunners = [];

function nowIso() {
  return new Date().toISOString();
}

function createSession(options = {}) {
  fs.mkdirSync(dialogsDir, { recursive: true });
  const sessionId = `dialog-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const sessionDir = path.join(dialogsDir, sessionId);
  createdDirs.push(sessionDir);
  fs.mkdirSync(sessionDir, { recursive: true });

  const messages = options.messages || [];
  fs.writeFileSync(
    path.join(sessionDir, "conversation.jsonl"),
    messages.map((m) => JSON.stringify(m)).join(messages.length ? "\n" : "") +
      (messages.length ? "\n" : "")
  );
  fs.writeFileSync(path.join(sessionDir, "problem.md"), "wait tool smoke test");
  const runnerToken = crypto.randomBytes(16).toString("hex");
  let runnerPid = options.runnerPid;
  if (runnerPid == null) {
    const fixture = spawn(
      process.execPath,
      [
        "-e",
        "setInterval(() => {}, 1000)",
        path.join(repoRoot, "src", "dialog-runner.mjs"),
        sessionDir,
        `--runner-token=${runnerToken}`,
      ],
      {
        stdio: "ignore",
        windowsHide: true,
      }
    );
    fixtureRunners.push(fixture);
    runnerPid = fixture.pid;
  }
  fs.writeFileSync(
    path.join(sessionDir, "status.json"),
    JSON.stringify(
      {
        session_id: sessionId,
        type: "dialog",
        started_at: nowIso(),
        project_path: repoRoot,
        host_agent: "codex",
        partner_agent: "claude",
        partner_command: "claude",
        max_rounds: 5,
        hard_cap: 10,
        reasoning_effort: null,
        model: null,
        partner_timeout_ms: options.partnerTimeoutMs ?? 15 * 60 * 1000,
        tool_profile: "read",
        subject_path: null,
        subject_kind: null,
        runner_pid: runnerPid,
        runner_token: runnerToken,
        runner_state: "running",
      },
      null,
      2
    )
  );

  if (options.processing) {
    fs.writeFileSync(path.join(sessionDir, "partner_processing"), nowIso());
  }
  if (options.error) {
    fs.writeFileSync(path.join(sessionDir, "last_error.txt"), options.error);
  }

  return { sessionId, sessionDir };
}

function appendMessage(sessionDir, message) {
  fs.appendFileSync(
    path.join(sessionDir, "conversation.jsonl"),
    `${JSON.stringify(message)}\n`
  );
}

function parseToolText(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool result did not include text content");
  return JSON.parse(text);
}

async function waitForFileMatching(filePath, patterns, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      if (patterns.every((pattern) => pattern.test(content))) {
        return content;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for expected content in file: ${filePath}`);
}

async function callWait(client, args, options = {}) {
  const result = await client.callTool(
    {
      name: "wait_for_partner_response",
      arguments: args,
    },
    undefined,
    {
      timeout: options.timeout ?? 10000,
      onprogress: options.onprogress,
    }
  );
  return parseToolText(result);
}

async function main() {
  const client = new Client({
    name: "wait-tool-smoke",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: repoRoot,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });

  try {
    await client.connect(transport);

    {
      const { tools } = await client.listTools();
      const expectedModels = [
        "gpt-5.6",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ];
      for (const toolName of ["start_dialog", "start_code_review"]) {
        const tool = tools.find((candidate) => candidate.name === toolName);
        assert.ok(tool, `${toolName} was not exposed by the MCP server`);
        const modelDescription = tool.inputSchema.properties.model.description;
        for (const model of expectedModels) {
          assert.match(modelDescription, new RegExp(`\\b${model.replaceAll(".", "\\.")}\\b`));
        }
        // The effort enum is the union across every registered adapter, so it
        // grows as adapters are added. Assert containment, not equality --
        // otherwise this fails every time a new agent ships.
        const efforts = tool.inputSchema.properties.reasoning_effort.enum;
        for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
          assert.ok(
            efforts.includes(effort),
            `reasoning_effort enum lost "${effort}": ${efforts.join(", ")}`
          );
        }

        // Agent choice must be registry-driven, not the historical pair.
        const agents = tool.inputSchema.properties.partner_agent.enum;
        for (const agent of ["claude", "codex"]) {
          assert.ok(agents.includes(agent), `partner_agent enum lost "${agent}"`);
        }
        assert.ok(
          agents.length > 2,
          `partner_agent enum is still limited to the original pair: ${agents.join(", ")}`
        );
      }
    }

    {
      const result = await client.callTool(
        {
          name: "start_dialog",
          arguments: {
            problem_description: "partner timeout smoke",
            project_path: repoRoot,
            host_agent: "codex",
            partner_agent: "claude",
            partner_timeout_ms: 30 * 60 * 1000,
          },
        },
        undefined,
        { timeout: 10000 }
      );
      const payload = parseToolText(result);
      assert.equal(payload.partner_timeout_ms, 30 * 60 * 1000);
      assert.equal(payload.reasoning_effort, "high");
      if (payload.dialog_dir) createdDirs.push(payload.dialog_dir);
      const runnerLogPath = path.join(payload.dialog_dir, "runner.log");
      await waitForFileMatching(runnerLogPath, [
        /Partner timeout hint: 1800s/,
        /Reasoning effort: high/,
      ]);
      await client.callTool(
        {
          name: "end_dialog",
          arguments: { session_id: payload.session_id },
        },
        undefined,
        { timeout: 10000 }
      );
    }

    {
      const { sessionId } = createSession({
        messages: [
          {
            id: 1,
            from: "claude",
            content: "ready",
            timestamp: nowIso(),
          },
        ],
      });
      const result = await callWait(client, {
        session_id: sessionId,
        since_id: 0,
        timeout_ms: 5000,
      });
      assert.equal(result.wait_result, "message");
      assert.equal(result.partner_timeout_ms, 15 * 60 * 1000);
      assert.equal(result.next_since_id, 1);
      assert.equal(result.new_messages.length, 1);
    }

    {
      const result = await client.callTool(
        {
          name: "start_dialog",
          arguments: {
            problem_description: "GPT-5.6 model support smoke",
            project_path: repoRoot,
            host_agent: "claude",
            partner_agent: "codex",
            model: "gpt-5.6-sol",
            reasoning_effort: "ultra",
          },
        },
        undefined,
        { timeout: 10000 }
      );
      const payload = parseToolText(result);
      assert.equal(payload.model, "gpt-5.6-sol");
      assert.equal(payload.reasoning_effort, "ultra");
      if (payload.dialog_dir) createdDirs.push(payload.dialog_dir);
      const runnerLogPath = path.join(payload.dialog_dir, "runner.log");
      await waitForFileMatching(runnerLogPath, [
        /Model: gpt-5\.6-sol/,
        /Reasoning effort: ultra/,
      ]);
      await client.callTool(
        {
          name: "end_dialog",
          arguments: { session_id: payload.session_id },
        },
        undefined,
        { timeout: 10000 }
      );
    }

    {
      const { sessionId, sessionDir } = createSession();
      const pending = callWait(client, {
        session_id: sessionId,
        since_id: 0,
        timeout_ms: 5000,
      });
      setTimeout(() => {
        appendMessage(sessionDir, {
          id: 1,
          from: "claude",
          content: "delayed",
          timestamp: nowIso(),
        });
      }, 250);
      const result = await pending;
      assert.equal(result.wait_result, "message");
      assert.equal(result.next_since_id, 1);
    }

    {
      const { sessionId } = createSession();
      const result = await callWait(client, {
        session_id: sessionId,
        since_id: 0,
        timeout_ms: 1000,
      });
      assert.equal(result.wait_result, "timeout_idle");
      assert.equal(result.timed_out, true);
    }

    {
      const { sessionId } = createSession({ processing: true });
      const result = await callWait(client, {
        session_id: sessionId,
        since_id: 0,
        timeout_ms: 1000,
      });
      assert.equal(result.wait_result, "timeout_processing");
      assert.equal(result.timed_out, true);
    }

    {
      const { sessionId } = createSession({ error: "boom" });
      const result = await callWait(client, {
        session_id: sessionId,
        since_id: 0,
        timeout_ms: 5000,
      });
      assert.equal(result.wait_result, "error");
      assert.match(result.last_error, /boom/);
    }

    {
      const { sessionId } = createSession({ runnerPid: 999999999 });
      const result = await callWait(client, {
        session_id: sessionId,
        since_id: 0,
        timeout_ms: 5000,
      });
      assert.equal(result.wait_result, "runner_exited");
    }

    console.log("wait_for_partner_response smoke checks passed");
  } finally {
    await transport.close().catch(() => {});
    for (const runner of fixtureRunners) {
      if (runner.exitCode == null && runner.signalCode == null) {
        runner.kill("SIGTERM");
      }
    }
    for (const dir of createdDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
