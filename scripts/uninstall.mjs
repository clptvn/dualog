#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
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

const HOOK_FILE_MARKERS = [
  "enforce-investigation.mjs",
  "enforce-resolution.mjs",
  "require-lgtm-or-cap.mjs",
  "mark-needs-investigation.mjs",
  "clear-investigation.mjs",
];

function parseMode(argv) {
  let removeClaude = true;
  let removeCodex = true;

  for (const arg of argv) {
    const normalized = arg.toLowerCase();
    if (normalized === "--claude" || normalized === "-claude") {
      removeClaude = true;
      removeCodex = false;
    } else if (normalized === "--codex" || normalized === "-codex") {
      removeClaude = false;
      removeCodex = true;
    } else if (normalized === "--both" || normalized === "-both") {
      removeClaude = true;
      removeCodex = true;
    } else {
      throw new Error(`Unknown option: ${arg}\nUsage: npm run uninstall -- [--claude|--codex|--both]`);
    }
  }

  return { removeClaude, removeCodex };
}

function runCli(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "ignore",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return result.status === 0;
}

function cliExists(command) {
  return runCli(command, ["--version"]);
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

function removeClaudeMcp() {
  const hasClaude = cliExists("claude");
  if (hasClaude) {
    runCli("claude", ["mcp", "remove", "dualog", "-s", "user"]);
    console.log("  Removed Claude MCP registration OK");
  }

  const config = readJsonConfig(CLAUDE_JSON);
  if (config.mcpServers?.["dualog"]) {
    delete config.mcpServers["dualog"];
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
    writeJsonConfig(CLAUDE_JSON, config);
    console.log("  Removed ~/.claude.json MCP fallback OK");
  } else if (!hasClaude) {
    console.log("  WARNING: Claude CLI not found. Skipped Claude MCP CLI removal.");
  }
}

function isCodexDialogHookCommand(command) {
  if (typeof command !== "string") return false;
  return (
    command.includes("dualog") ||
    HOOK_FILE_MARKERS.some((marker) => command.includes(marker))
  );
}

function removeOwnedPlatformHelper(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.includes("dualog platform helpers")) {
      fs.rmSync(filePath, { force: true });
      console.log(`  Removed Claude hook ${path.basename(filePath)} OK`);
    }
  } catch {}
}

function removeClaudeHooks() {
  if (fs.existsSync(CLAUDE_HOOKS_DIR)) {
    fs.rmSync(CLAUDE_HOOKS_DIR, { recursive: true, force: true });
    console.log("  Removed Claude hook files OK");
  }

  removeOwnedPlatformHelper(CLAUDE_HOOKS_PLATFORM);
  removeOwnedPlatformHelper(CLAUDE_HOOKS_LEGACY_PLATFORM);

  if (!fs.existsSync(CLAUDE_SETTINGS_JSON)) return;

  const config = readJsonConfig(CLAUDE_SETTINGS_JSON);
  if (!config.hooks) return;

  for (const key of ["PreToolUse", "PostToolUse"]) {
    if (!Array.isArray(config.hooks[key])) continue;
    config.hooks[key] = config.hooks[key]
      .map((entry) => {
        if (!Array.isArray(entry.hooks)) return entry;
        const hooks = entry.hooks.filter((hook) => !isCodexDialogHookCommand(hook.command));
        return { ...entry, hooks };
      })
      .filter((entry) => entry.hooks?.length > 0);
    if (config.hooks[key].length === 0) delete config.hooks[key];
  }

  if (Object.keys(config.hooks).length === 0) delete config.hooks;
  writeJsonConfig(CLAUDE_SETTINGS_JSON, config);
  console.log("  Removed Claude hook settings OK");
}

function removeCodexMcpSection(content) {
  return content
    .replace(/\n?\[mcp_servers\.dualog\]\n(?:.*\n)*?(?=\n\[|$)/g, "\n")
    .trimEnd();
}

function removeCodexMcp() {
  const hasCodex = cliExists("codex");
  if (hasCodex) {
    runCli("codex", ["mcp", "remove", "dualog"]);
    console.log("  Removed Codex MCP registration OK");
  }

  if (fs.existsSync(CODEX_CONFIG_TOML)) {
    const updated = removeCodexMcpSection(fs.readFileSync(CODEX_CONFIG_TOML, "utf-8"));
    fs.writeFileSync(CODEX_CONFIG_TOML, updated ? updated + "\n" : "");
    console.log("  Removed ~/.codex/config.toml MCP fallback OK");
  } else if (!hasCodex) {
    console.log("  WARNING: Codex CLI not found. Skipped Codex MCP removal.");
  }
}

function main() {
  const mode = parseMode(process.argv.slice(2));

  console.log("dualog uninstaller");
  console.log("");

  if (mode.removeClaude) {
    for (const command of CLAUDE_COMMANDS) {
      const target = path.join(CLAUDE_COMMANDS_DIR, `${command}.md`);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
        console.log(`  Removed /${command} OK`);
      }
    }

    removeClaudeHooks();
    removeClaudeMcp();
  }

  if (mode.removeCodex) {
    for (const skill of CODEX_SKILLS) {
      const target = path.join(CODEX_SKILLS_DIR, skill);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`  Removed /${skill} OK`);
      }
    }

    removeCodexMcp();
  }

  console.log("");
  if (mode.removeClaude) console.log(" Restart Claude Code to apply the removal.");
  if (mode.removeCodex) console.log(" Restart Codex to apply the removal.");
  console.log("");
}

try {
  main();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
