import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildInvocationFromAdapter } from "../src/adapters/argv.mjs";
import { getAdapter } from "../src/adapters/registry.mjs";
import { managedSession } from "./helpers/session.mjs";
import { captureTmuxPane, isTmuxPaneDead, readTerminalState, startTmuxSession } from "../src/tmux-runtime.mjs";
import { runPartnerCommand } from "../src/partner-invocation.mjs";
import { killTmuxServer } from "./helpers/tmux.mjs";
import { writeNodeCommand } from "./helpers/node-command.mjs";

const { home, dir: sessionDir, scratchDir } = managedSession("codex-config");
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const seed = path.join(home, "seed");
const project = path.join(home, "project");
fs.mkdirSync(seed);
fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
spawnSync("git", ["init", "--quiet", project]);
const projectPath = fs.realpathSync(project);
const source = [
  'cli_auth_credentials_store = "file"',
  `[projects.${JSON.stringify(projectPath)}]`,
  'trust_level = "trusted"',
  "[mcp_servers]",
  'inline = { command = "node" }',
  'dotted.command = "node"',
  "[mcp_servers.supabase]",
  'url = "http://127.0.0.1:1/mcp"',
  "[mcp_servers.dualog]",
  'command = "node"',
  '[mcp_servers."quoted.server"]',
  'command = "node"',
  '[mcp_servers."quoted.server".env]',
  'FIXTURE = "value"',
].join("\n") + "\n";
fs.writeFileSync(path.join(seed, "config.toml"), source);
const projectConfig = "[mcp_servers.supabase]\nenabled = false\n" +
  "[mcp_servers.dualog]\nenabled = true\n";
fs.writeFileSync(path.join(project, ".codex", "config.toml"), projectConfig);
process.env.CODEX_HOME = seed;
const adapter = getAdapter("codex", { cwd: home, env: { XDG_CONFIG_HOME: home, XDG_CONFIG_DIRS: "" } });

function invoke(engine, tables) {
  return buildInvocationFromAdapter({
    ...adapter,
    configIsolation: { ...adapter.configIsolation, dropTomlTables: { "config.toml": tables } },
  }, { engine, projectPath, sessionDir, scratchDir });
}

for (const engine of adapter.engines.allowed) {
  test(`${engine} retains transports and disables stripped MCP servers after project overrides`, () => {
    const invocation = invoke(engine, ["mcp_servers"]);
    assert.equal(fs.readFileSync(path.join(invocation.env.CODEX_HOME, "config.toml"), "utf8"), source);
    const index = invocation.args.indexOf('mcp_servers={inline={enabled=false},dotted={enabled=false},supabase={enabled=false},dualog={enabled=false},"quoted.server"={enabled=false}}');
    assert.ok(index >= 0);
    assert.equal(invocation.args[index - 1], "-c");
    assert.equal(fs.readFileSync(path.join(seed, "config.toml"), "utf8"), source);
    assert.equal(fs.readFileSync(path.join(project, ".codex", "config.toml"), "utf8"), projectConfig);
  });
}

test("the built-in policy disables only Dualog and does not invent absent servers", () => {
  const invocation = invoke("headless", ["mcp_servers.dualog"]);
  assert.ok(invocation.args.includes("mcp_servers={dualog={enabled=false}}"));
  assert.ok(!invoke("headless", ["mcp_servers.absent"]).args.some((arg) => arg.startsWith("mcp_servers=")));
});

test("installed Codex loads the isolated config with a disabled project Supabase override", (t) => {
  const binary = process.env.DUALOG_TEST_CODEX_BINARY;
  if (!binary) return t.skip("set DUALOG_TEST_CODEX_BINARY to run the installed CLI regression");
  const brokenHome = path.join(home, "broken-home");
  fs.mkdirSync(brokenHome);
  fs.writeFileSync(path.join(brokenHome, "config.toml"),
    `[projects.${JSON.stringify(projectPath)}]\ntrust_level = "trusted"\n`);
  const env = { ...process.env, CODEX_HOME: brokenHome };
  const broken = spawnSync(binary, ["-C", projectPath, "features", "list"], {
    cwd: projectPath, env, encoding: "utf8", timeout: 10000,
  });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /invalid transport[\s\S]*mcp_servers\.supabase/);
  for (const engine of adapter.engines.allowed) {
    const invocation = invoke(engine, ["mcp_servers"]);
    const flags = invocation.args.flatMap((arg, index, args) =>
      arg === "-c" ? [arg, args[index + 1]] : []);
    const fixed = spawnSync(binary, ["-C", projectPath, ...flags, "features", "list"], {
      cwd: projectPath, env: { ...env, ...invocation.env }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(fixed.status, 0, fixed.stderr || fixed.error?.message);
  }
});

test("the isolated project reaches the installed Codex welcome screen in tmux", async (t) => {
  const binary = process.env.DUALOG_TEST_CODEX_BINARY;
  if (!binary) return t.skip("set DUALOG_TEST_CODEX_BINARY to run the installed CLI regression");
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return t.skip("tmux is not installed");
  const invocation = invoke("tmux-interactive", ["mcp_servers"]);
  const socket = `dualog-codex-config-${process.pid}`;
  t.after(() => killTmuxServer(socket));
  const env = { ...invocation.env, HOME: home, USERPROFILE: home, TERM: "xterm-256color", OPENAI_API_KEY: "" };
  const handle = await startTmuxSession({
    sessionName: `dualog-codex-config-${process.pid}`,
    cwd: projectPath, command: binary, args: invocation.args, env, socketName: socket,
  });
  let capture = "";
  const deadline = Date.now() + 10000;
  do {
    capture = await captureTmuxPane(handle);
    if (capture.includes("OpenAI Codex") || await isTmuxPaneDead(handle)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.match(capture, /OpenAI Codex/);
  assert.equal(await isTmuxPaneDead(handle), false, capture);
});

test("a failed partner launch reports and persists the Supabase error before cleanup", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX tmux launch fixture");
  if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return t.skip("tmux is not installed");
  const commands = path.join(home, "commands");
  fs.mkdirSync(commands);
  const partnerCommand = writeNodeCommand(commands, "failing-codex",
    'console.error("Error: invalid transport\\nin `mcp_servers.supabase`"); process.exit(1);');
  const socket = `dualog-failed-config-${process.pid}`;
  const previousSocket = process.env.DUALOG_TMUX_SOCKET;
  process.env.DUALOG_TMUX_SOCKET = socket;
  t.after(() => {
    killTmuxServer(socket);
    if (previousSocket === undefined) delete process.env.DUALOG_TMUX_SOCKET;
    else process.env.DUALOG_TMUX_SOCKET = previousSocket;
  });
  await assert.rejects(runPartnerCommand({
    partnerAgent: "codex", partnerCommand, prompt: "fixture prompt", projectPath,
    sessionDir, engine: "tmux-interactive", log: () => {},
  }), (error) => {
    assert.equal(error.failureCode, "terminal_exited");
    assert.match(error.message, /invalid transport[\s\S]*mcp_servers\.supabase/);
    return true;
  });
  const { current, last } = readTerminalState(sessionDir);
  assert.equal(current, null);
  assert.equal(last.status, "failed");
  assert.match(fs.readFileSync(last.last_capture_path, "utf8"), /invalid transport[\s\S]*mcp_servers\.supabase/);
});
