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
const CLAUDE_HOOKS_DIR = path.join(CLAUDE_HOOKS_ROOT, "dualog");
const CLAUDE_HOOKS_PLATFORM = path.join(CLAUDE_HOOKS_ROOT, "dualog-platform.mjs");
const CLAUDE_HOOKS_LEGACY_PLATFORM = path.join(CLAUDE_HOOKS_ROOT, "platform.mjs");
const CLAUDE_SETTINGS_JSON = path.join(CLAUDE_DIR, "settings.json");
const CODEX_DIR = path.join(HOME_DIR, ".codex");
const CODEX_SKILLS_DIR = path.join(CODEX_DIR, "skills");
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, "config.toml");
const SERVER_PATH = path.join(REPO_ROOT, "src", "dialog-server.mjs");

const CLAUDE_COMMANDS = [
  "dualog-review-code",
  "dualog-review-plan",
  "dualog-review-spec",
  "dualog-audit",
];

// Pre-rename artifacts. Removed on install, so a stale command file cannot keep
// calling a tool namespace the server no longer serves.
const LEGACY_CLAUDE_COMMANDS = [
  "codex-review-code",
  "codex-review-plan",
  "codex-review-spec",
  "codex-audit",
];
const LEGACY_MCP_KEY = "codex-dialog";
const LEGACY_HOOKS_DIR_NAME = "codex-dialog";

const HOOK_FILES = [
  "mark-needs-investigation.mjs",
  "clear-investigation.mjs",
  "enforce-investigation.mjs",
  "enforce-resolution.mjs",
  "require-lgtm-or-cap.mjs",
];

const CODEX_SKILLS = [
  "dualog-review-code",
  "dualog-review-plan",
  "dualog-review-spec",
  "dualog-audit",
  "dualog-ui-implementer",
];

const LEGACY_CODEX_SKILLS = [
  "claude-review-code",
  "claude-review-plan",
  "claude-review-spec",
  "claude-audit",
  "claude-ui-implementer",
];

function parseMode(argv) {
  let installClaude = true;
  let installCodex = true;

  for (const arg of argv) {
    const normalized = arg.toLowerCase();
    if (normalized === "--claude" || normalized === "-claude") {
      installClaude = true;
      installCodex = false;
    } else if (normalized === "--codex" || normalized === "-codex") {
      installClaude = false;
      installCodex = true;
    } else if (normalized === "--both" || normalized === "-both") {
      installClaude = true;
      installCodex = true;
    } else {
      throw new Error(`Unknown option: ${arg}\nUsage: npm run setup -- [--claude|--codex|--both]`);
    }
  }

  return { installClaude, installCodex };
}

function modeLabel({ installClaude, installCodex }) {
  if (installClaude && installCodex) return "Claude + Codex";
  if (installClaude) return "Claude only";
  return "Codex only";
}

function plannedStepCount({ installClaude, installCodex }) {
  // +1 for the legacy-migration step.
  return 4 + (installClaude ? 2 : 0) + (installCodex ? 2 : 0);
}

function createStepLogger(totalSteps) {
  let currentStep = 1;
  return (label) => {
    console.log(`[${currentStep++}/${totalSteps}] ${label}`);
  };
}

/**
 * Remove pre-rename artifacts.
 *
 * The tool namespace moved from mcp__codex-dialog__* to mcp__dualog__*, so a
 * leftover command file or hook matcher does not merely look untidy -- it calls
 * tools that no longer exist. Clearing them is part of installing, not an
 * optional tidy-up.
 */
function removeLegacyInstall() {
  let removed = 0;

  for (const name of LEGACY_CLAUDE_COMMANDS) {
    const file = path.join(CLAUDE_COMMANDS_DIR, `${name}.md`);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      console.log(`  removed legacy command ${name}`);
      removed++;
    }
  }

  for (const name of LEGACY_CODEX_SKILLS) {
    const dir = path.join(CODEX_SKILLS_DIR, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`  removed legacy skill ${name}`);
      removed++;
    }
  }

  const legacyHooks = path.join(CLAUDE_HOOKS_ROOT, LEGACY_HOOKS_DIR_NAME);
  if (fs.existsSync(legacyHooks)) {
    fs.rmSync(legacyHooks, { recursive: true, force: true });
    console.log(`  removed legacy hooks directory ${LEGACY_HOOKS_DIR_NAME}`);
    removed++;
  }
  const legacyPlatform = path.join(CLAUDE_HOOKS_ROOT, "codex-dialog-platform.mjs");
  if (fs.existsSync(legacyPlatform)) {
    fs.rmSync(legacyPlatform, { force: true });
    removed++;
  }

  // Claude MCP registration
  try {
    if (fs.existsSync(CLAUDE_JSON)) {
      const config = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf-8"));
      if (config?.mcpServers?.[LEGACY_MCP_KEY]) {
        delete config.mcpServers[LEGACY_MCP_KEY];
        fs.writeFileSync(CLAUDE_JSON, JSON.stringify(config, null, 2) + "\n");
        console.log(`  removed legacy MCP registration "${LEGACY_MCP_KEY}" from ~/.claude.json`);
        removed++;
      }
    }
  } catch (err) {
    console.log(`  warning: could not clean ~/.claude.json: ${err.message}`);
  }

  // Codex MCP registration
  try {
    if (fs.existsSync(CODEX_CONFIG_TOML)) {
      const toml = fs.readFileSync(CODEX_CONFIG_TOML, "utf-8");
      const stripped = toml.replace(
        /\n?\[mcp_servers\.codex-dialog\]\n(?:.*\n)*?(?=\n\[|$)/g,
        ""
      );
      if (stripped !== toml) {
        fs.writeFileSync(CODEX_CONFIG_TOML, stripped);
        console.log(`  removed legacy [mcp_servers.${LEGACY_MCP_KEY}] from ~/.codex/config.toml`);
        removed++;
      }
    }
  } catch (err) {
    console.log(`  warning: could not clean ~/.codex/config.toml: ${err.message}`);
  }

  // Hook matchers referencing the old tool namespace.
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_JSON)) {
      const raw = fs.readFileSync(CLAUDE_SETTINGS_JSON, "utf-8");
      if (raw.includes("mcp__codex-dialog__") || raw.includes("hooks/codex-dialog/")) {
        fs.writeFileSync(
          CLAUDE_SETTINGS_JSON,
          raw
            .replaceAll("mcp__codex-dialog__", "mcp__dualog__")
            .replaceAll("hooks/codex-dialog/", "hooks/dualog/")
            .replaceAll("codex-dialog-platform.mjs", "dualog-platform.mjs")
        );
        console.log("  rewrote legacy hook matchers in ~/.claude/settings.json");
        removed++;
      }
    }
  } catch (err) {
    console.log(`  warning: could not clean settings.json: ${err.message}`);
  }

  if (removed === 0) console.log("  no pre-rename artifacts found OK");
  return removed;
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
  const hasTmux = runCli(spawn, "tmux", ["-V"], { allowFailure: true });
  console.log(hasClaude ? "  Claude Code CLI OK" : "  WARNING: Claude Code CLI not found on PATH.");
  console.log(hasCodex ? "  Codex CLI OK" : "  WARNING: Codex CLI not found on PATH.");
  console.log(hasTmux ? "  tmux OK" : "  WARNING: tmux not found on PATH. Partner sessions require tmux.");
  return { hasClaude, hasCodex, hasTmux };
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
    if (content.includes("dualog platform helpers")) {
      fs.rmSync(filePath, { force: true });
    }
  } catch {}
}

function installHookFile(fileName) {
  const sourcePath = path.join(REPO_ROOT, "src", "hooks", fileName);
  const targetPath = path.join(CLAUDE_HOOKS_DIR, fileName);
  const content = fs
    .readFileSync(sourcePath, "utf-8")
    .replaceAll("../platform.mjs", "../dualog-platform.mjs");
  fs.writeFileSync(targetPath, content);
}

function installSharedFile() {
  const sourcePath = path.join(REPO_ROOT, "src", "shared.mjs");
  const targetPath = path.join(CLAUDE_HOOKS_DIR, "shared.mjs");
  const content = fs
    .readFileSync(sourcePath, "utf-8")
    .replaceAll("./platform.mjs", "../dualog-platform.mjs");
  fs.writeFileSync(targetPath, content);
}

function registerClaudeMcp(spawn, hasClaude, logStep) {
  console.log("");
  logStep("Registering MCP server for Claude...");

  if (hasClaude) {
    runCli(spawn, "claude", ["mcp", "remove", "dualog", "-s", "user"], {
      allowFailure: true,
    });
    runCli(spawn, "claude", [
      "mcp",
      "add",
      "-s",
      "user",
      "dualog",
      "--",
      "node",
      SERVER_PATH,
    ]);
    console.log("  MCP server registered with Claude CLI OK");
    return;
  }

  const config = readJsonConfig(CLAUDE_JSON);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers["dualog"] = {
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
      matcher: "mcp__dualog__send_message",
      hooks: [
        { type: "command", command: hookCommand("enforce-investigation.mjs") },
        { type: "command", command: hookCommand("enforce-resolution.mjs") },
      ],
    },
    {
      matcher: "mcp__dualog__end_dialog",
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
    "mcp__dualog__check_messages",
    "mcp__dualog__wait_for_partner_response",
    "mcp__dualog__get_full_history",
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
    .replace(/\n?\[mcp_servers\.dualog\]\n(?:.*\n)*?(?=\n\[|$)/g, "\n")
    .trimEnd();
}

function registerCodexMcp(spawn, hasCodex, logStep) {
  console.log("");
  logStep("Registering MCP server for Codex...");

  if (hasCodex) {
    runCli(spawn, "codex", ["mcp", "remove", "dualog"], {
      allowFailure: true,
    });
    runCli(spawn, "codex", ["mcp", "add", "dualog", "--", "node", SERVER_PATH]);
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
    "[mcp_servers.dualog]",
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
    fs.cpSync(path.join(REPO_ROOT, "dualog-skills", skill), target, {
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
    console.log(` Claude:     ${path.join(CLAUDE_COMMANDS_DIR, "dualog-{review-code,review-plan,review-spec,audit}.md")}`);
    console.log(` Hooks:      ${CLAUDE_HOOKS_DIR}`);
  }
  if (mode.installCodex) {
    console.log(` Codex:      ${path.join(CODEX_SKILLS_DIR, "dualog-{review-code,review-plan,review-spec,audit,ui-implementer}")}`);
  }
  console.log("");
  if (mode.installClaude) console.log(" Restart Claude Code to pick up updated MCP configuration and commands.");
  if (mode.installCodex) console.log(" Restart Codex to pick up updated MCP configuration and skills.");
  if (!cliStatus.hasClaude || !cliStatus.hasCodex) {
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
  }
  console.log("");
  console.log(" Usage:");
  // Both hosts get the same partner-agnostic command set, so list it once.
  console.log("   /dualog-review-code         Review uncommitted code changes");
  console.log("   /dualog-review-plan         Review an implementation plan");
  console.log("   /dualog-review-spec         Review a product/feature spec");
  console.log("   /dualog-audit src/          Audit files");
  if (mode.installCodex) {
    console.log("   /dualog-ui-implementer      Delegate frontend/UI implementation");
  }
  console.log("");
  console.log("   Add partner:<agent-id> to choose the reviewer.");
  console.log("   Run list_adapters to see which agent CLIs are installed.");
  console.log("");
}

async function main() {
  const mode = parseMode(process.argv.slice(2));

  console.log("dualog installer");
  console.log("");
  console.log(` Mode: ${modeLabel(mode)}`);
  console.log("");

  const logStep = createStepLogger(plannedStepCount(mode));

  logStep("Checking prerequisites...");
  checkNode();

  console.log("");
  logStep("Migrating any pre-rename install...");
  removeLegacyInstall();

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

  printSummary(mode, cliStatus);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
