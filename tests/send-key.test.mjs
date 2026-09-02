import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { sendKeyToTmux } from "../src/tmux-runtime.mjs";
import { writeNodeCommand } from "./helpers/node-command.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SERVER_PATH = path.join(REPO_ROOT, "src", "dialog-server.mjs");

function isolatedHomeEnv(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: "",
    HOMEPATH: home,
    CODEX_HOME: path.join(home, ".codex"),
    GROK_HOME: path.join(home, ".grok"),
    QWEN_HOME: path.join(home, ".qwen"),
    OPENCODE_CONFIG_DIR: path.join(home, ".opencode"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CONFIG_DIRS: "",
    DUALOG_ADAPTER_PATH: "",
  };
}

function writeFakeTmux(home, logPath, paneId) {
  return writeNodeCommand(
    home,
    "fake-tmux",
    `import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args.includes("list-panes")) process.stdout.write(${JSON.stringify(`${paneId}\n`)});
`
  );
}

function writeSession(home, sessionId, terminal) {
  const sessionDir = path.join(home, ".dualog", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "status.json"),
    JSON.stringify({
      type: "dialog",
      host_agent: "claude",
      partner_agent: "codex",
    })
  );
  fs.writeFileSync(
    path.join(sessionDir, "current_terminal.json"),
    JSON.stringify({
      schema_version: 1,
      runtime: "tmux-interactive",
      status: "running",
      agent: "codex",
      ...terminal,
    })
  );
  return sessionDir;
}

const parseToolText = (result) => {
  const text = result.content[0].text;
  return text.startsWith("Error:") ? text : JSON.parse(text);
};

const SEND_KEY_MANAGED_PANE_TEST =
  process.platform === "win32"
    ? "send_key fails closed for an unsupported native Windows cmd tmux override"
    : "send_key delivers a menu choice and Enter only to the recorded managed pane";

test(SEND_KEY_MANAGED_PANE_TEST, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-send-key-"));
  let client = null;
  // node:test runs after hooks in registration order and stops after a hook
  // throws. On Windows, removing `home` while the MCP child still has it as
  // cwd fails; registering deletion before client.close() therefore leaked the
  // live server and pinned the whole test worker until CI's job timeout.
  t.after(async () => {
    try {
      await client?.close();
    } finally {
      fs.rmSync(home, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 5 : 0,
        retryDelay: 100,
      });
    }
  });

  const sessionId = "dialog-123-abcdef";
  const tmuxSession = `dlg-${sessionId}-turn-1`;
  const logPath = path.join(home, "tmux-args.log");
  const fakeTmux = writeFakeTmux(home, logPath, "%42");
  const tmuxSocket = `dualog-send-key-${process.pid}`;
  const sessionDir = writeSession(home, sessionId, {
    session_name: tmuxSession,
    pane_target: `${tmuxSession}:0.0`,
    pane_id: "%42",
    tmux_transport: "local",
    tmux_distro: null,
    tmux_launcher: fakeTmux,
    tmux_control_binary: fakeTmux,
    tmux_socket_name: tmuxSocket,
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: home,
    env: {
      ...process.env,
      ...isolatedHomeEnv(home),
      DUALOG_ROLE: "",
      DUALOG_DEPTH: "",
      DUALOG_MAX_DEPTH: "",
      DUALOG_TMUX_BINARY: fakeTmux,
      DUALOG_TMUX_SOCKET: tmuxSocket,
    },
    stderr: "ignore",
  });
  client = new Client(
    { name: "send-key-contract", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);

  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "send_key"));

  const result = parseToolText(
    await client.callTool({
      name: "send_key",
      arguments: { session_id: sessionId, key: "2", submit: true },
    })
  );

  if (process.platform === "win32") {
    // The helper intentionally produces a .cmd package-style shim. Native
    // Windows tmux control launchers must be direct .exe/.com images because
    // synchronous cleanup probes cannot safely time out a cmd.exe descendant.
    // Desktop's supported interactive route is WSL; its direct wsl.exe path is
    // covered by the Windows tmux/WSL suites. This fixture must be rejected
    // promptly and, crucially, its MCP child must still be closed before home
    // cleanup.
    assert.equal(typeof result, "string");
    assert.match(result, /could not confirm/i);
    assert.equal(fs.existsSync(logPath), false, "an unsafe tmux shim must not be invoked");
    return;
  }

  assert.equal(result.sent, true);
  assert.equal(result.key, "2");
  assert.equal(result.submitted, true);
  assert.equal(result.pane_id, "%42");

  const calls = fs.readFileSync(logPath, "utf-8").trim().split("\n");
  assert.match(calls[0], new RegExp(`has-session -t =${tmuxSession}$`));
  assert.match(calls[1], new RegExp(`list-panes -t =${tmuxSession} -F #\\{pane_id\\}$`));
  assert.match(calls[2], /send-keys -l -t %42 2$/);
  assert.match(calls[3], /send-keys -t %42 Enter$/);

  // A server-global pane id must also be proven to belong to the recorded
  // session. A matching session name beside somebody else's pane id is not
  // enough authority to address it.
  fs.writeFileSync(
    path.join(sessionDir, "current_terminal.json"),
    JSON.stringify({
      schema_version: 1,
      runtime: "tmux-interactive",
      status: "running",
      session_name: tmuxSession,
      pane_id: "%99",
      tmux_transport: "local",
      tmux_distro: null,
      tmux_launcher: fakeTmux,
      tmux_control_binary: fakeTmux,
      tmux_socket_name: tmuxSocket,
    })
  );
  const beforeWrongPane = fs.readFileSync(logPath, "utf-8");
  const wrongPane = parseToolText(
    await client.callTool({
      name: "send_key",
      arguments: { session_id: sessionId, key: "y" },
    })
  );
  assert.match(wrongPane, /pane ID does not belong/);
  const afterWrongPane = fs.readFileSync(logPath, "utf-8");
  assert.doesNotMatch(afterWrongPane.slice(beforeWrongPane.length), /send-keys.*%99/);

  // A forged or stale terminal record may not redirect the tool to some other
  // tmux pane. The session id and recorded tmux identity must agree before the
  // first liveness probe or key delivery happens.
  fs.writeFileSync(
    path.join(sessionDir, "current_terminal.json"),
    JSON.stringify({
      schema_version: 1,
      runtime: "tmux-interactive",
      status: "running",
      session_name: "dlg-dialog-999-deadbeef-turn-1",
      pane_id: "%99",
    })
  );
  const before = fs.readFileSync(logPath, "utf-8");
  const refused = parseToolText(
    await client.callTool({
      name: "send_key",
      arguments: { session_id: sessionId, key: "y" },
    })
  );
  assert.match(refused, /does not identify a managed Dualog pane/);
  assert.equal(fs.readFileSync(logPath, "utf-8"), before, "refusal must not invoke tmux");
});

test("the tmux key primitive refuses strings and accidental double-submit", async () => {
  await assert.rejects(
    sendKeyToTmux({ paneId: "%1" }, "C-c"),
    /Unsupported tmux key/
  );
  await assert.rejects(
    sendKeyToTmux({ paneId: "%1" }, "enter", { submit: true }),
    /submit cannot be used/
  );
});
