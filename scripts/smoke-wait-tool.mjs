#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readProcessCommandLine } from "../src/process-command-line.mjs";
import { terminateWindowsProcessTree } from "../src/windows-process-tree.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(repoRoot, "src", "dialog-server.mjs");
const smokePartnerPath = path.join(repoRoot, "scripts", "smoke-partner-fixture.mjs");
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-wait-smoke-"));
const smokeHome = path.join(smokeRoot, "home");
const adapterDir = path.join(smokeRoot, "adapters");
const dialogsDir = path.join(smokeHome, ".claude", "dialogs");
const createdDirs = [];
const startedRunners = [];
const runnerPath = path.join(repoRoot, "src", "dialog-runner.mjs");
const RUNNER_GRACE_MS = 1500;
const RUNNER_TERM_MS = 750;
const RUNNER_KILL_MS = 2500;

fs.mkdirSync(adapterDir, { recursive: true });
fs.writeFileSync(
  path.join(adapterDir, "smoke-fixture.json"),
  JSON.stringify(
    {
      id: "smoke-fixture",
      displayName: "Hermetic smoke fixture",
      binary: { default: process.execPath, versionArgs: ["--version"] },
      engines: { default: "headless", allowed: ["headless"] },
      capabilities: {
        modelFlag: true,
        reasoningEffort: true,
        toolProfiles: "none",
        addDir: false,
        writesFiles: true,
        tuiDrivable: "no",
      },
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      models: [
        {
          id: "gpt-5.6-sol",
          efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          defaultEffort: "low",
        },
      ],
      discovery: { strategy: "none" },
      defaultToolProfile: "read",
      toolProfiles: {},
      mcp: { strategy: "none" },
      configIsolation: null,
      promptDelivery: { headless: "argv" },
      argv: {
        headless: [
          { args: [smokePartnerPath] },
          { when: { set: "model" }, args: ["--model", "{{model}}"] },
          {
            when: { set: "reasoningEffort" },
            args: ["--effort", "{{reasoningEffort}}"],
          },
          { when: { set: "initialPrompt" }, args: ["{{initialPrompt}}"] },
        ],
      },
      completion: { sidecar: "always", stdoutTrustworthy: false },
    },
    null,
    2
  )
);

const smokeEnv = {
  ...process.env,
  HOME: smokeHome,
  USERPROFILE: smokeHome,
  HOMEDRIVE: "",
  HOMEPATH: smokeHome,
  // PowerShell/CIM may initialize per-user application-data directories even
  // under -NoProfile. Keep those helper side effects inside the disposable
  // smoke root rather than the caller's HOME/USERPROFILE.
  APPDATA: path.join(smokeHome, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(smokeHome, "AppData", "Local"),
  XDG_CONFIG_HOME: path.join(smokeHome, ".config"),
  XDG_CONFIG_DIRS: "",
  CODEX_HOME: path.join(smokeHome, ".codex"),
  DUALOG_ADAPTER_PATH: adapterDir,
  // This is redundant with the fixture's headless-only manifest, but pins the
  // smoke's contract explicitly: it must never discover or invoke tmux.
  DUALOG_STRATEGY: "headless",
};

function nowIso() {
  return new Date().toISOString();
}

function readSessionStatus(sessionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, "status.json"), "utf-8"));
  } catch {
    return null;
  }
}

function recordStartedRunner({ sessionId, sessionDir, pid, child = null, source }) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `${source} did not provide a valid runner pid`);
  const existing = startedRunners.find(
    (candidate) => candidate.pid === pid && candidate.sessionDir === sessionDir
  );
  if (existing) {
    if (child) existing.child = child;
    if (!existing.initialStatus) existing.initialStatus = readSessionStatus(sessionDir);
    return existing;
  }

  const record = {
    sessionId,
    sessionDir,
    pid,
    child,
    source,
    initialStatus: readSessionStatus(sessionDir),
    finalStatus: null,
  };
  startedRunners.push(record);
  return record;
}

function recordToolRunner(payload) {
  const record = recordStartedRunner({
    sessionId: payload.session_id,
    sessionDir: payload.dialog_dir,
    pid: payload.runner_pid,
    source: "start_dialog",
  });
  assert.equal(
    record.initialStatus?.runner_pid,
    payload.runner_pid,
    `status.json did not record runner pid ${payload.runner_pid}`
  );
  assert.equal(record.initialStatus?.session_id, payload.session_id);
}

function discoverUnrecordedSessionRunners() {
  if (!fs.existsSync(dialogsDir)) return;
  for (const entry of fs.readdirSync(dialogsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(dialogsDir, entry.name);
    const status = readSessionStatus(sessionDir);
    const pid = Number.isSafeInteger(status?.runner_pid) && status.runner_pid > 0
      ? status.runner_pid
      : status?.last_runner_pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const record = recordStartedRunner({
      sessionId: status.session_id || entry.name,
      sessionDir,
      pid,
      source: "status discovery",
    });
    if (!record.initialStatus) record.initialStatus = status;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// PID reuse must never turn cleanup into a signal aimed at an unrelated
// process. The runner path, isolated session directory, and per-session token
// together prove that a live PID is still the process this smoke created.
function probeRecordedRunner(record) {
  if (!isPidAlive(record.pid)) return "gone";
  const commandLine = readProcessCommandLine(record.pid, { env: smokeEnv });
  if (!commandLine) return "unknown";
  const normalize = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const normalized = normalize(commandLine);
  const token = record.initialStatus?.runner_token;
  const matches =
    normalized.includes(normalize(runnerPath)) &&
    normalized.includes(normalize(record.sessionDir)) &&
    (typeof token !== "string" ||
      token.length === 0 ||
      normalized.includes(normalize(`--runner-token=${token}`)));
  return matches ? "alive" : "reused";
}

// Poll only kernel liveness here. On Windows, proving command-line identity
// requires PowerShell/CIM; doing that every 25ms for every runner can create
// hundreds of helper processes. Identity is proved once, immediately before
// each signal, while waits use the cheap process.kill(pid, 0) probe.
async function waitForRunnerPidsToExit(records, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (records.every((record) => !isPidAlive(record.pid))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return records.every((record) => !isPidAlive(record.pid));
}

function signalPosixRunner(record, signal) {
  if (record.child) {
    record.child.kill(signal);
    return;
  }

  // Server-created runners are detached process-group leaders. Signal their
  // group so a headless child cannot outlive the runner. Fall back to the exact
  // PID only if the group disappeared between the identity probe and signal.
  try {
    process.kill(-record.pid, signal);
  } catch (err) {
    if (err?.code !== "ESRCH") throw err;
    try {
      process.kill(record.pid, signal);
    } catch (pidErr) {
      if (pidErr?.code !== "ESRCH") throw pidErr;
    }
  }
}

function shouldSignalRunner(record) {
  const state = probeRecordedRunner(record);
  // A ChildProcess handle is itself authority over the exact process we
  // spawned, even when the OS command-line probe is temporarily unavailable.
  if (state === "unknown" && record.child) return true;
  if (state === "unknown") {
    record.cleanupDiagnostic = `could not verify runner ${record.pid}`;
    return false;
  }
  return state === "alive";
}

async function stopAndVerifyStartedRunners() {
  // A tool call can spawn successfully and then lose its response. Discovering
  // statuses closes that gap, so cleanup owns every runner created under the
  // isolated smoke home even on an earlier assertion failure.
  discoverUnrecordedSessionRunners();

  for (const record of startedRunners) {
    if (fs.existsSync(record.sessionDir)) {
      fs.writeFileSync(path.join(record.sessionDir, "end_signal"), "");
    }
  }

  // Let real dialog runners observe end_signal before escalating. The direct
  // liveness fixtures deliberately ignore it, ensuring the forced path is
  // exercised on every smoke run.
  await waitForRunnerPidsToExit(startedRunners, RUNNER_GRACE_MS);

  for (const record of startedRunners) {
    if (!shouldSignalRunner(record)) continue;
    try {
      if (process.platform === "win32") {
        const result = terminateWindowsProcessTree(record.pid);
        if (result.status !== "succeeded") record.cleanupDiagnostic = result.reason;
      } else {
        signalPosixRunner(record, "SIGTERM");
      }
    } catch (err) {
      record.cleanupDiagnostic = err.message;
    }
  }

  if (process.platform !== "win32") {
    await waitForRunnerPidsToExit(startedRunners, RUNNER_TERM_MS);
    for (const record of startedRunners) {
      if (!shouldSignalRunner(record)) continue;
      try {
        signalPosixRunner(record, "SIGKILL");
      } catch (err) {
        record.cleanupDiagnostic = err.message;
      }
    }
  }

  await waitForRunnerPidsToExit(startedRunners, RUNNER_KILL_MS);
  for (const record of startedRunners) {
    if (
      record.child &&
      record.child.exitCode == null &&
      record.child.signalCode == null
    ) {
      await Promise.race([
        once(record.child, "exit"),
        new Promise((resolve) => setTimeout(resolve, RUNNER_KILL_MS)),
      ]);
    }
  }
  const cleanupErrors = [];
  for (const record of startedRunners) {
    record.finalStatus = readSessionStatus(record.sessionDir);
    const state = probeRecordedRunner(record);
    record.finalProbe = state;
    if (state !== "gone" && state !== "reused") {
      cleanupErrors.push(
        new Error(
          `runner ${record.pid} (${record.sessionId}) remained ${state}` +
            (record.cleanupDiagnostic ? `: ${record.cleanupDiagnostic}` : "")
        )
      );
    }
    if (
      record.child &&
      record.child.exitCode == null &&
      record.child.signalCode == null
    ) {
      cleanupErrors.push(new Error(`runner child ${record.pid} was not reaped`));
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `runner cleanup failed; retained smoke root ${smokeRoot}`
    );
  }
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
  let fixture = null;
  if (runnerPid == null) {
    fixture = spawn(
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
  if (fixture) {
    recordStartedRunner({
      sessionId,
      sessionDir,
      pid: runnerPid,
      child: fixture,
      source: "wait fixture",
    });
  }

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
  assert.doesNotMatch(text, /^Error:/u, `MCP tool returned an error: ${text}`);
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
    env: smokeEnv,
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
          agents.includes("smoke-fixture"),
          `hermetic smoke adapter was not registered: ${agents.join(", ")}`
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
            partner_agent: "smoke-fixture",
            partner_timeout_ms: 30 * 60 * 1000,
          },
        },
        undefined,
        { timeout: 10000 }
      );
      const payload = parseToolText(result);
      recordToolRunner(payload);
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
            partner_agent: "smoke-fixture",
            model: "gpt-5.6-sol",
            reasoning_effort: "ultra",
          },
        },
        undefined,
        { timeout: 10000 }
      );
      const payload = parseToolText(result);
      recordToolRunner(payload);
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

  } finally {
    let cleanupError = null;
    try {
      await stopAndVerifyStartedRunners();
    } catch (err) {
      cleanupError = err;
    } finally {
      await transport.close().catch(() => {});
    }

    // Closing the server reaps any just-exited runner that was still its child.
    // Verify again after that boundary and before deleting the only identity
    // evidence that makes a safe retry possible.
    if (!cleanupError) {
      await waitForRunnerPidsToExit(startedRunners, RUNNER_KILL_MS);
      for (const record of startedRunners) {
        const finalProbe = probeRecordedRunner(record);
        record.finalProbe = finalProbe;
        assert.notEqual(
          finalProbe,
          "alive",
          `runner ${record.pid} survived transport close; retained smoke root ${smokeRoot}`
        );
      }
    }
    if (cleanupError) throw cleanupError;

    for (const dir of createdDirs) {
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
    fs.rmSync(smokeRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }

  console.log(
    `wait_for_partner_response smoke checks passed; verified ${startedRunners.filter((record) => record.source !== "status discovery").length} started runner processes exited`
  );
  if (process.env.DUALOG_SMOKE_RUNNER_AUDIT === "1") {
    const audit = startedRunners
      .filter((record) => record.source !== "status discovery")
      .map((record) => ({
        session_id: record.sessionId,
        pid: record.pid,
        initial_runner_state: record.initialStatus?.runner_state ?? null,
        final_runner_state: record.finalStatus?.runner_state ?? null,
        final_probe: record.finalProbe,
      }));
    console.log(`DUALOG_SMOKE_RUNNER_AUDIT=${JSON.stringify(audit)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
