#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const HOME_DIR = os.homedir();
const CLAUDE_DIR = path.join(HOME_DIR, ".claude");
const CLAUDE_JSON = path.join(HOME_DIR, ".claude.json");
const CLAUDE_COMMANDS_DIR = path.join(CLAUDE_DIR, "commands");
const CLAUDE_HOOKS_ROOT = path.join(CLAUDE_DIR, "hooks");
const CLAUDE_HOOKS_DIR = path.join(CLAUDE_HOOKS_ROOT, "codex-dialog");
const CLAUDE_HOOKS_PLATFORM = path.join(CLAUDE_HOOKS_ROOT, "codex-dialog-platform.mjs");
const CLAUDE_HOOKS_LEGACY_PLATFORM = path.join(CLAUDE_HOOKS_ROOT, "platform.mjs");
const CLAUDE_SETTINGS_JSON = path.join(CLAUDE_DIR, "settings.json");
const CODEX_DIR = path.join(HOME_DIR, ".codex");
const CODEX_SKILLS_DIR = path.join(CODEX_DIR, "skills");
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, "config.toml");
const GROK_DIR = path.join(HOME_DIR, ".grok");
const GROK_CONFIG_TOML = path.join(GROK_DIR, "config.toml");
const GROK_SKILLS_DIR = path.join(GROK_DIR, "skills");
const GROK_COMMANDS_DIR = path.join(GROK_DIR, "commands");
const SERVER_PATH = path.join(REPO_ROOT, "src", "dialog-server.mjs");

const CLAUDE_COMMANDS = [
  "codex-review-code",
  "codex-review-plan",
  "codex-review-spec",
  "codex-audit",
];

const HOOK_FILES = [
  "mark-needs-investigation.mjs",
  "clear-investigation.mjs",
  "enforce-investigation.mjs",
  "enforce-resolution.mjs",
  "require-lgtm-or-cap.mjs",
];

const CODEX_SKILLS = [
  "claude-review-code",
  "claude-review-plan",
  "claude-review-spec",
  "claude-audit",
  "claude-ui-implementer",
];

const GROK_COMMANDS = [
  "codex-review-code",
  "codex-review-plan",
  "codex-review-spec",
  "codex-audit",
];

function parseMode(argv) {
  // Default remains Claude+Codex for backward compatibility.
  let installClaude = true;
  let installCodex = true;
  let installGrok = false;
  let sawFlag = false;

  for (const arg of argv) {
    const normalized = arg.toLowerCase();
    if (normalized === "--claude" || normalized === "-claude") {
      if (!sawFlag) {
        installClaude = false;
        installCodex = false;
        installGrok = false;
      }
      sawFlag = true;
      installClaude = true;
    } else if (normalized === "--codex" || normalized === "-codex") {
      if (!sawFlag) {
        installClaude = false;
        installCodex = false;
        installGrok = false;
      }
      sawFlag = true;
      installCodex = true;
    } else if (normalized === "--grok" || normalized === "-grok") {
      if (!sawFlag) {
        installClaude = false;
        installCodex = false;
        installGrok = false;
      }
      sawFlag = true;
      installGrok = true;
    } else if (normalized === "--both" || normalized === "-both") {
      sawFlag = true;
      installClaude = true;
      installCodex = true;
      // --both keeps historical meaning (Claude+Codex only)
    } else if (normalized === "--all" || normalized === "-all") {
      sawFlag = true;
      installClaude = true;
      installCodex = true;
      installGrok = true;
    } else {
      throw new Error(
        `Unknown option: ${arg}\nUsage: npm run setup -- [--claude|--codex|--grok|--both|--all]`
      );
    }
  }

  return { installClaude, installCodex, installGrok };
}

function modeLabel({ installClaude, installCodex, installGrok }) {
  const parts = [];
  if (installClaude) parts.push("Claude");
  if (installCodex) parts.push("Codex");
  if (installGrok) parts.push("Grok");
  return parts.length ? parts.join(" + ") : "nothing";
}

function plannedStepCount({ installClaude, installCodex, installGrok }) {
  return 3 + (installClaude ? 2 : 0) + (installCodex ? 2 : 0) + (installGrok ? 2 : 0);
}

function createStepLogger(totalSteps) {
  let currentStep = 1;
  return (label) => {
    console.log(`[${currentStep++}/${totalSteps}] ${label}`);
  };
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node.js >= 18 required, found ${process.version}`);
  }
  console.log(`  Node.js ${process.version} OK`);
}

function runNpmInstall() {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCmd, ["install", "--silent"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.error ? `npm install failed: ${result.error.message}` : "npm install failed");
  }
}

function dependencyAvailable(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function ensureDependencies() {
  if (dependencyAvailable("cross-spawn")) {
    console.log("  Dependencies already installed OK");
    return;
  }
  runNpmInstall();
  console.log("  Dependencies installed OK");
}

async function loadSpawn() {
  const mod = await import("cross-spawn");
  return mod.default;
}

function cliExists(spawn, command) {
  const result = spawn.sync(command, ["--version"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function checkPartnerClis(spawn, logStep) {
  console.log("");
  logStep("Checking partner CLIs...");
  const hasClaude = cliExists(spawn, "claude");
  const hasCodex = cliExists(spawn, "codex");
  const hasGrok = cliExists(spawn, "grok");
  const hasTmux = runCli(spawn, "tmux", ["-V"], { allowFailure: true });
  console.log(hasClaude ? "  Claude Code CLI OK" : "  WARNING: Claude Code CLI not found on PATH.");
  console.log(hasCodex ? "  Codex CLI OK" : "  WARNING: Codex CLI not found on PATH.");
  console.log(hasGrok ? "  Grok Build CLI OK" : "  WARNING: Grok Build CLI not found on PATH.");
  console.log(hasTmux ? "  tmux OK" : "  WARNING: tmux not found on PATH. Partner sessions require tmux.");
  return { hasClaude, hasCodex, hasGrok, hasTmux };
}

function removeGrokMcpSection(content) {
  return content
    .replace(/\n?\[mcp_servers\.codex-dialog\]\n(?:.*\n)*?(?=\n\[|$)/g, "\n")
    .trimEnd();
}

function registerGrokMcp(spawn, hasGrok, logStep) {
  console.log("");
  logStep("Registering MCP server for Grok Build...");

  if (hasGrok) {
    runCli(spawn, "grok", ["mcp", "remove", "codex-dialog"], { allowFailure: true });
    // Long-running wait tool needs a high tool timeout (seconds).
    const added = runCli(
      spawn,
      "grok",
      [
        "mcp",
        "add",
        "--scope",
        "user",
        "codex-dialog",
        "--",
        "node",
        SERVER_PATH,
      ],
      { allowFailure: true }
    );
    if (added) {
      // Best-effort: ensure wait tool timeout is generous in config.toml
      ensureGrokMcpTimeouts();
      console.log("  MCP server registered with Grok CLI OK");
      return;
    }
    console.log("  WARNING: grok mcp add failed; writing ~/.grok/config.toml fallback.");
  }

  fs.mkdirSync(GROK_DIR, { recursive: true });
  let content = "";
  if (fs.existsSync(GROK_CONFIG_TOML)) {
    content = removeGrokMcpSection(fs.readFileSync(GROK_CONFIG_TOML, "utf-8"));
    if (content) content += "\n";
  }
  const section = [
    "[mcp_servers.codex-dialog]",
    'command = "node"',
    `args = [${JSON.stringify(SERVER_PATH)}]`,
    "tool_timeout_sec = 1200",
    'tool_timeouts = { wait_for_partner_response = 1200 }',
    "",
  ].join("\n");
  fs.writeFileSync(GROK_CONFIG_TOML, content + section);
  console.log("  MCP server written to ~/.grok/config.toml OK");
}

function ensureGrokMcpTimeouts() {
  if (!fs.existsSync(GROK_CONFIG_TOML)) return;
  let content = fs.readFileSync(GROK_CONFIG_TOML, "utf-8");
  if (!content.includes("[mcp_servers.codex-dialog]")) return;
  if (!content.includes("tool_timeout_sec")) {
    content = content.replace(
      /\[mcp_servers\.codex-dialog\]\n/,
      "[mcp_servers.codex-dialog]\ntool_timeout_sec = 1200\ntool_timeouts = { wait_for_partner_response = 1200 }\n"
    );
    fs.writeFileSync(GROK_CONFIG_TOML, content);
  }
}

function installGrokSkillsAndCommands(logStep) {
  console.log("");
  logStep("Installing Grok skills and commands...");

  const skillSource = path.join(REPO_ROOT, "grok-skills", "codex-dialog");
  const skillTarget = path.join(GROK_SKILLS_DIR, "codex-dialog");
  if (fs.existsSync(skillSource)) {
    fs.rmSync(skillTarget, { recursive: true, force: true });
    fs.cpSync(skillSource, skillTarget, { recursive: true });
    console.log("  skill codex-dialog OK");
  } else {
    console.log("  WARNING: grok-skills/codex-dialog missing from repo");
  }

  fs.mkdirSync(GROK_COMMANDS_DIR, { recursive: true });
  for (const command of GROK_COMMANDS) {
    const src = path.join(REPO_ROOT, "grok-commands", `${command}.md`);
    if (!fs.existsSync(src)) {
      console.log(`  WARNING: missing ${src}`);
      continue;
    }
    fs.copyFileSync(src, path.join(GROK_COMMANDS_DIR, `${command}.md`));
    console.log(`  /${command} OK`);
  }
}

function runCli(spawn, command, args, { allowFailure = false } = {}) {
  const result = spawn.sync(command, args, {
    cwd: REPO_ROOT,
    stdio: "ignore",
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.status === 0;
}

function readJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonConfig(filePath, config) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
}

function shellQuote(value) {
  const s = String(value);
  if (process.platform === "win32") return `"${s.replace(/"/g, '\\"')}"`;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

function hookCommand(fileName) {
  return `node ${shellQuote(path.join(CLAUDE_HOOKS_DIR, fileName))}`;
}

function removeOwnedPlatformHelper(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.includes("claude-codex-dialog platform helpers")) {
      fs.rmSync(filePath, { force: true });
    }
  } catch {}
}

function installHookFile(fileName) {
  const sourcePath = path.join(REPO_ROOT, "src", "hooks", fileName);
  const targetPath = path.join(CLAUDE_HOOKS_DIR, fileName);
  const content = fs
    .readFileSync(sourcePath, "utf-8")
    .replaceAll("../platform.mjs", "../codex-dialog-platform.mjs");
  fs.writeFileSync(targetPath, content);
}

function installSharedFile() {
  const sourcePath = path.join(REPO_ROOT, "src", "shared.mjs");
  const targetPath = path.join(CLAUDE_HOOKS_DIR, "shared.mjs");
  const content = fs
    .readFileSync(sourcePath, "utf-8")
    .replaceAll("./platform.mjs", "../codex-dialog-platform.mjs");
  fs.writeFileSync(targetPath, content);
}

function registerClaudeMcp(spawn, hasClaude, logStep) {
  console.log("");
  logStep("Registering MCP server for Claude...");

  if (hasClaude) {
    runCli(spawn, "claude", ["mcp", "remove", "codex-dialog", "-s", "user"], {
      allowFailure: true,
    });
    runCli(spawn, "claude", [
      "mcp",
      "add",
      "-s",
      "user",
      "codex-dialog",
      "--",
      "node",
      SERVER_PATH,
    ]);
    console.log("  MCP server registered with Claude CLI OK");
    return;
  }

  const config = readJsonConfig(CLAUDE_JSON);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers["codex-dialog"] = {
    command: "node",
    args: [SERVER_PATH],
  };
  writeJsonConfig(CLAUDE_JSON, config);
  console.log("  MCP server written to ~/.claude.json (CLI fallback) OK");
}

function installClaudeCommandsAndHooks(logStep) {
  console.log("");
  logStep("Installing Claude commands and hooks...");

  fs.mkdirSync(CLAUDE_COMMANDS_DIR, { recursive: true });
  for (const command of CLAUDE_COMMANDS) {
    fs.copyFileSync(
      path.join(REPO_ROOT, ".claude", "commands", `${command}.md`),
      path.join(CLAUDE_COMMANDS_DIR, `${command}.md`)
    );
    console.log(`  /${command} OK`);
  }

  fs.mkdirSync(CLAUDE_HOOKS_DIR, { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "src", "platform.mjs"), CLAUDE_HOOKS_PLATFORM);
  installSharedFile();
  for (const fileName of HOOK_FILES) {
    installHookFile(fileName);
  }
  removeOwnedPlatformHelper(CLAUDE_HOOKS_LEGACY_PLATFORM);

  for (const oldHook of [
    "mark-needs-investigation.sh",
    "clear-investigation.sh",
    "enforce-investigation.sh",
  ]) {
    try {
      fs.rmSync(path.join(CLAUDE_HOOKS_DIR, oldHook), { force: true });
    } catch {}
  }

  const config = readJsonConfig(CLAUDE_SETTINGS_JSON);
  if (!config.hooks) config.hooks = {};

  if (!Array.isArray(config.hooks.PreToolUse)) config.hooks.PreToolUse = [];
  const preHooks = config.hooks.PreToolUse;
  const preEntries = [
    {
      matcher: "mcp__codex-dialog__send_message",
      hooks: [
        { type: "command", command: hookCommand("enforce-investigation.mjs") },
        { type: "command", command: hookCommand("enforce-resolution.mjs") },
      ],
    },
    {
      matcher: "mcp__codex-dialog__end_dialog",
      hooks: [{ type: "command", command: hookCommand("require-lgtm-or-cap.mjs") }],
    },
  ];

  for (const entry of preEntries) {
    const idx = preHooks.findIndex((h) => h.matcher === entry.matcher);
    if (idx >= 0) preHooks[idx] = entry;
    else preHooks.push(entry);
  }

  if (!Array.isArray(config.hooks.PostToolUse)) config.hooks.PostToolUse = [];
  const postHooks = config.hooks.PostToolUse;

  for (const matcher of [
    "mcp__codex-dialog__check_messages",
    "mcp__codex-dialog__wait_for_partner_response",
    "mcp__codex-dialog__get_full_history",
  ]) {
    const entry = {
      matcher,
      hooks: [{ type: "command", command: hookCommand("mark-needs-investigation.mjs") }],
    };
    const idx = postHooks.findIndex(
      (h) => h.matcher === matcher && h.hooks?.[0]?.command?.includes("mark-needs")
    );
    if (idx >= 0) postHooks[idx] = entry;
    else postHooks.push(entry);
  }

  const clearEntry = {
    matcher: "Read",
    hooks: [{ type: "command", command: hookCommand("clear-investigation.mjs") }],
  };
  const clearIdx = postHooks.findIndex(
    (h) => h.matcher === "Read" && h.hooks?.[0]?.command?.includes("clear-investigation")
  );
  if (clearIdx >= 0) postHooks[clearIdx] = clearEntry;
  else postHooks.push(clearEntry);

  for (let i = postHooks.length - 1; i >= 0; i--) {
    if (
      (postHooks[i].matcher === "Grep" || postHooks[i].matcher === "Glob") &&
      postHooks[i].hooks?.[0]?.command?.includes("clear-investigation")
    ) {
      postHooks.splice(i, 1);
    }
  }

  writeJsonConfig(CLAUDE_SETTINGS_JSON, config);
  console.log("  Claude hooks installed OK");
}

function removeCodexMcpSection(content) {
  return content
    .replace(/\n?\[mcp_servers\.codex-dialog\]\n(?:.*\n)*?(?=\n\[|$)/g, "\n")
    .trimEnd();
}

function registerCodexMcp(spawn, hasCodex, logStep) {
  console.log("");
  logStep("Registering MCP server for Codex...");

  if (hasCodex) {
    runCli(spawn, "codex", ["mcp", "remove", "codex-dialog"], {
      allowFailure: true,
    });
    runCli(spawn, "codex", ["mcp", "add", "codex-dialog", "--", "node", SERVER_PATH]);
    console.log("  MCP server registered with Codex CLI OK");
    return;
  }

  fs.mkdirSync(CODEX_DIR, { recursive: true });
  let content = "";
  if (fs.existsSync(CODEX_CONFIG_TOML)) {
    content = removeCodexMcpSection(fs.readFileSync(CODEX_CONFIG_TOML, "utf-8"));
    if (content) content += "\n";
  }

  const section = [
    "[mcp_servers.codex-dialog]",
    'command = "node"',
    `args = [${JSON.stringify(SERVER_PATH)}]`,
    "",
  ].join("\n");
  fs.writeFileSync(CODEX_CONFIG_TOML, content + section);
  console.log("  Codex CLI not found; wrote MCP server fallback to ~/.codex/config.toml OK");
}

function installCodexSkills(logStep) {
  console.log("");
  logStep("Installing Codex skills...");

  fs.mkdirSync(CODEX_SKILLS_DIR, { recursive: true });
  for (const skill of CODEX_SKILLS) {
    const target = path.join(CODEX_SKILLS_DIR, skill);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(REPO_ROOT, "codex-skills", skill), target, {
      recursive: true,
    });
    console.log(`  /${skill} OK`);
  }
}

function printSummary(mode, cliStatus) {
  console.log("");
  console.log("Installation complete!");
  console.log("");
  console.log(` MCP server: ${SERVER_PATH}`);
  if (mode.installClaude) {
    console.log(` Claude:     ${path.join(CLAUDE_COMMANDS_DIR, "codex-{review-code,review-plan,review-spec,audit}.md")}`);
    console.log(` Hooks:      ${CLAUDE_HOOKS_DIR}`);
  }
  if (mode.installCodex) {
    console.log(` Codex:      ${path.join(CODEX_SKILLS_DIR, "{claude-review-code,claude-review-plan,claude-review-spec,claude-audit,claude-ui-implementer}")}`);
  }
  if (mode.installGrok) {
    console.log(` Grok:       ${path.join(GROK_SKILLS_DIR, "codex-dialog")}`);
    console.log(` Commands:   ${path.join(GROK_COMMANDS_DIR, "codex-{review-code,review-plan,review-spec,audit}.md")}`);
  }
  console.log("");
  if (mode.installClaude) console.log(" Restart Claude Code to pick up updated MCP configuration and commands.");
  if (mode.installCodex) console.log(" Restart Codex to pick up updated MCP configuration and skills.");
  if (mode.installGrok) console.log(" Restart Grok Build (or /mcps → r) to pick up MCP configuration and skills.");
  if (!cliStatus.hasClaude || !cliStatus.hasCodex || (mode.installGrok && !cliStatus.hasGrok)) {
    console.log("");
    console.log(" CLI check:");
    if (!cliStatus.hasClaude) {
      console.log("   WARNING: Claude Code CLI was not found on PATH.");
      console.log("            Install it before using Claude Code as a host or review partner.");
      console.log("            https://docs.anthropic.com/en/docs/claude-code");
    }
    if (!cliStatus.hasCodex) {
      console.log("   WARNING: Codex CLI was not found on PATH.");
      console.log("            Install it before using Codex as a host or review partner.");
      console.log("            https://github.com/openai/codex");
    }
    if (mode.installGrok && !cliStatus.hasGrok) {
      console.log("   WARNING: Grok Build CLI was not found on PATH.");
      console.log("            Install it before using Grok Build as a host.");
      console.log("            https://x.ai/cli");
    }
  }
  console.log("");
  console.log(" Usage:");
  if (mode.installClaude || mode.installGrok) {
    console.log("   /codex-review-code          Review uncommitted code changes with Codex");
    console.log("   /codex-review-plan          Review an implementation plan with Codex");
    console.log("   /codex-review-spec          Review a product/feature spec with Codex");
    console.log("   /codex-audit src/           Audit files with Codex");
  }
  if (mode.installCodex) {
    console.log("   /claude-review-code         Review uncommitted code changes with Claude");
    console.log("   /claude-review-plan         Review an implementation plan with Claude");
    console.log("   /claude-review-spec         Review a product/feature spec with Claude");
    console.log("   /claude-audit src/          Audit files with Claude");
    console.log("   /claude-ui-implementer      Collaborate with Claude Opus 4.7 on frontend/UI work");
  }
  if (mode.installGrok) {
    console.log('   Grok host: pass host_agent: "grok" on start_dialog / start_code_review');
  }
  console.log("");
}

async function main() {
  const mode = parseMode(process.argv.slice(2));

  console.log("claude-codex-dialog installer");
  console.log("");
  console.log(` Mode: ${modeLabel(mode)}`);
  console.log("");

  const logStep = createStepLogger(plannedStepCount(mode));

  logStep("Checking prerequisites...");
  checkNode();

  console.log("");
  logStep("Installing dependencies...");
  ensureDependencies();

  const spawn = await loadSpawn();
  const cliStatus = checkPartnerClis(spawn, logStep);

  if (mode.installClaude) {
    registerClaudeMcp(spawn, cliStatus.hasClaude, logStep);
    installClaudeCommandsAndHooks(logStep);
  }

  if (mode.installCodex) {
    registerCodexMcp(spawn, cliStatus.hasCodex, logStep);
    installCodexSkills(logStep);
  }

  if (mode.installGrok) {
    registerGrokMcp(spawn, cliStatus.hasGrok, logStep);
    installGrokSkillsAndCommands(logStep);
  }

  printSummary(mode, cliStatus);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
