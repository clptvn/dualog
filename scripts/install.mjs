#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import {
  assertSafeConfigWriteTarget,
  atomicWriteFile,
  buildClaudeMcpRegistration,
  buildWslLifecycleInvocation,
  effectiveExplicitWslSelection,
  formatInstallEnvironment,
  probeInstallEnvironment,
  persistedWslEnv,
  preflightExplicitWslSelection,
  readJsonConfig,
  removeMcpServerConfig,
  replaceMcpServerSection,
  resolveCodexPaths,
  runInstallProbe,
  validateExplicitWslSelection,
  writeJsonConfig,
  wslArgs,
} from "./install-utils.mjs";
import { runNpmInstallBootstrap } from "./npm-bootstrap.mjs";

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
const CODEX_PATHS = resolveCodexPaths();
const CODEX_DIR = CODEX_PATHS.root;
const CODEX_SKILLS_DIR = CODEX_PATHS.skills;
const CODEX_CONFIG_TOML = CODEX_PATHS.config;
const SERVER_PATH = path.join(REPO_ROOT, "src", "dialog-server.mjs");
const NODE_PATH = process.execPath;
const RUNTIME_DEPENDENCY_PROBES = Object.freeze([
  ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/server/mcp.js"],
  ["cross-spawn", "cross-spawn"],
  // Probe the same public entrypoint the runtime imports. A version-specific
  // subpath is not present in every valid 3.24.x install allowed by package.json.
  ["zod", "zod"],
]);

const CLAUDE_COMMANDS = [
  "dualog-review-code",
  "dualog-review-pr",
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
  "dualog-review-pr",
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
  let hostOnly = process.env.DUALOG_INSTALL_HOST_ONLY === "1";
  let wslDistro = null;
  let wslBinary = null;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
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
    } else if (normalized === "--host-only" || normalized === "-hostonly") {
      hostOnly = true;
    } else if (normalized === "--wsl-distro") {
      wslDistro = argv[++index]?.trim();
      if (!wslDistro) throw new Error("--wsl-distro requires a non-empty distribution name");
    } else if (normalized === "--wsl-binary") {
      wslBinary = argv[++index]?.trim();
      if (!wslBinary) throw new Error("--wsl-binary requires a non-empty executable path");
    } else {
      throw new Error(
        `Unknown option: ${arg}\nUsage: npm run setup -- [--claude|--codex|--both] [--host-only] [--wsl-distro <name>] [--wsl-binary <path>]`
      );
    }
  }

  return { installClaude, installCodex, hostOnly, wslDistro, wslBinary };
}

function modeLabel({ installClaude, installCodex }) {
  if (installClaude && installCodex) return "Claude + Codex";
  if (installClaude) return "Claude only";
  return "Codex only";
}

function plannedStepCount({ installClaude, installCodex }) {
  // +1 for the legacy-migration step.
  const wslStep = process.platform === "win32" ? 1 : 0;
  return 4 + (installClaude ? 2 : 0) + (installCodex ? 2 : 0) + wslStep;
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
      const config = readJsonConfig(CLAUDE_JSON);
      if (config?.mcpServers?.[LEGACY_MCP_KEY]) {
        delete config.mcpServers[LEGACY_MCP_KEY];
        writeJsonConfig(CLAUDE_JSON, config);
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
      const stripped = removeMcpServerConfig(toml, [LEGACY_MCP_KEY]);
      if (stripped !== toml) {
        atomicWriteFile(CODEX_CONFIG_TOML, stripped);
        console.log(
          `  removed old Dualog MCP registrations from ${CODEX_CONFIG_TOML}`
        );
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
        // Validate before touching the file. String replacement preserves
        // unrelated formatting, but malformed JSON must never be overwritten.
        readJsonConfig(CLAUDE_SETTINGS_JSON);
        atomicWriteFile(
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
  runNpmInstallBootstrap({ cwd: REPO_ROOT });
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
  let missing = RUNTIME_DEPENDENCY_PROBES.filter(([, probe]) => !dependencyAvailable(probe));
  if (missing.length === 0) {
    console.log("  Dependencies already installed OK");
    return;
  }
  runNpmInstall();
  missing = RUNTIME_DEPENDENCY_PROBES.filter(([, probe]) => !dependencyAvailable(probe));
  if (missing.length > 0) {
    throw new Error(
      `npm install completed, but runtime dependencies are still unavailable: ${missing
        .map(([name]) => name)
        .join(", ")}`
    );
  }
  console.log("  Dependencies installed OK");
}

function prevalidateConfigTargets() {
  for (const filePath of [CLAUDE_JSON, CLAUDE_SETTINGS_JSON]) {
    readJsonConfig(filePath);
  }
  assertSafeConfigWriteTarget(CODEX_CONFIG_TOML);
}

async function loadSpawn() {
  const mod = await import("cross-spawn");
  return mod.default;
}

async function checkPartnerClis(spawn, logStep, mode) {
  console.log("");
  logStep("Checking partner CLIs...");
  const status = await probeInstallEnvironment(
    (command, args, options) =>
      runInstallProbe(command, args, options, {
        platform: process.platform,
        spawnFn: spawn,
      }),
    {
    platform: process.platform,
    env: {
      ...process.env,
      ...(mode.wslDistro ? { DUALOG_WSL_DISTRO: mode.wslDistro } : {}),
      ...(mode.wslBinary ? { DUALOG_WSL_BINARY: mode.wslBinary } : {}),
    },
    cwd: REPO_ROOT,
    }
  );
  for (const line of formatInstallEnvironment(status)) console.log(line);
  // An explicit route is a hard constraint, not a hint. Validate it before
  // either native host registration can be written so a typo can never become
  // an unpinned registration that later follows a different default distro.
  validateExplicitWslSelection(
    effectiveExplicitWslSelection(mode, { env: process.env }),
    status
  );
  return {
    ...status,
    // Registration must use the host CLI only. A WSL CLI is a partner and a
    // separate host installation target, not evidence that a Win32 command can run.
    hasClaude: status.host.claude,
    hasCodex: status.host.codex,
    hasTmux: status.host.tmux,
  };
}

function shellQuote(value) {
  const s = String(value);
  if (process.platform === "win32") return `"${s.replace(/"/g, '\\"')}"`;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

function hookCommand(fileName) {
  return `${shellQuote(NODE_PATH)} ${shellQuote(path.join(CLAUDE_HOOKS_DIR, fileName))}`;
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

function registerClaudeMcp(cliStatus, logStep) {
  console.log("");
  logStep("Registering MCP server for Claude...");
  const config = readJsonConfig(CLAUDE_JSON);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers["dualog"] = buildClaudeMcpRegistration({
    serverPath: SERVER_PATH,
    nodePath: NODE_PATH,
    cliStatus,
  });
  writeJsonConfig(CLAUDE_JSON, config);
  console.log(`  MCP server written atomically to ${CLAUDE_JSON} OK`);
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

function registerCodexMcp(cliStatus, logStep) {
  console.log("");
  logStep("Registering MCP server for Codex...");

  fs.mkdirSync(CODEX_DIR, { recursive: true });
  let content = "";
  if (fs.existsSync(CODEX_CONFIG_TOML)) {
    content = fs.readFileSync(CODEX_CONFIG_TOML, "utf-8");
  }

  atomicWriteFile(
    CODEX_CONFIG_TOML,
    replaceMcpServerSection(content, {
      serverPath: SERVER_PATH,
      nodePath: NODE_PATH,
      env: persistedWslEnv(cliStatus),
    })
  );
  console.log(`  MCP server written atomically to ${CODEX_CONFIG_TOML} OK`);
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

function modeArgument(mode) {
  if (mode.installClaude && mode.installCodex) return "--both";
  return mode.installClaude ? "--claude" : "--codex";
}

function printWslManualInstall(mode, cliStatus) {
  const distro = cliStatus.wsl?.distro || process.env.DUALOG_WSL_DISTRO || "<distro>";
  console.log(
    `  After installing Node.js >= 18 in WSL, open ${distro} and run from this repository:`
  );
  console.log(`    node scripts/install.mjs ${modeArgument(mode)} --host-only`);
}

async function configureWslHosts(spawn, mode, cliStatus, logStep) {
  console.log("");
  logStep(
    mode.hostOnly
      ? "Skipping WSL host configuration (--host-only)..."
      : "Configuring the selected WSL distribution..."
  );
  if (mode.hostOnly) {
    console.log("  Host-only mode requested OK");
    return false;
  }

  const wsl = cliStatus.wsl;
  if (!wsl?.binaryAvailable || !wsl.distroAvailable) {
    console.log(
      `  WARNING: ${wsl?.binary ?? "wsl.exe"} or the selected WSL distribution is unavailable.`
    );
    printWslManualInstall(mode, cliStatus);
    return false;
  }
  if (!wsl.distro) {
    console.log(
      "  WARNING: WSL did not report the exact selected distribution, so Dualog will not guess where to install."
    );
    console.log("  Set DUALOG_WSL_DISTRO to the distribution name and rerun this installer.");
    printWslManualInstall(mode, cliStatus);
    return false;
  }
  if (!wsl.node || !wsl.nodePath) {
    console.log(
      `  WARNING: Node.js >= 18 was not found in WSL distribution ${wsl.distro}; WSL host configuration was not changed.`
    );
    printWslManualInstall(mode, cliStatus);
    return false;
  }

  const translated = await runInstallProbe(
    wsl.binary,
    wslArgs(["wslpath", "-a", "-u", REPO_ROOT], { route: wsl }),
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      windowsHide: true,
    },
    { platform: process.platform, spawnFn: spawn }
  );
  const wslRepoRoot = translated.status === 0 ? String(translated.stdout ?? "").trim() : "";
  if (!wslRepoRoot) {
    throw new Error(
      `Could not translate ${REPO_ROOT} for WSL distribution ${wsl.distro}: ` +
        `${String(translated.stderr ?? translated.error?.message ?? "unknown error").trim()}`
    );
  }

  const wslInstaller = path.posix.join(wslRepoRoot, "scripts", "install.mjs");
  const invocation = buildWslLifecycleInvocation({
    operation: "install",
    route: wsl,
    nodePath: wsl.nodePath,
    scriptPath: wslInstaller,
    modeArgument: modeArgument(mode),
  });
  const result = await runInstallProbe(
    invocation.command,
    invocation.args,
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      timeout: 120000,
      windowsHide: true,
    },
    { platform: process.platform, spawnFn: spawn }
  );
  if (result.status !== 0) {
    throw new Error(
      result.error
        ? `WSL installer failed: ${result.error.message}`
        : `WSL installer failed in distribution ${wsl.distro}`
    );
  }
  console.log(`  WSL host configuration installed in ${wsl.distro} OK`);
  return true;
}

function printSummary(mode, cliStatus, { wslConfigured = false } = {}) {
  console.log("");
  console.log("Installation complete!");
  console.log("");
  console.log(` MCP server: ${SERVER_PATH}`);
  if (mode.installClaude) {
    console.log(` Claude:     ${path.join(CLAUDE_COMMANDS_DIR, "dualog-{review-code,review-pr,review-plan,review-spec,audit}.md")}`);
    console.log(` Hooks:      ${CLAUDE_HOOKS_DIR}`);
  }
  if (mode.installCodex) {
    console.log(` Codex:      ${path.join(CODEX_SKILLS_DIR, "dualog-{review-code,review-pr,review-plan,review-spec,audit,ui-implementer}")}`);
  }
  console.log("");
  if (mode.installClaude) console.log(" Restart Claude Code to pick up updated MCP configuration and commands.");
  if (mode.installCodex) console.log(" Restart Codex to pick up updated MCP configuration and skills.");
  if (process.platform === "win32") {
    console.log("");
    console.log(" Windows / WSL check:");
    console.log(
      `   Native registrations use ${CLAUDE_JSON} and ${CODEX_CONFIG_TOML}.`
    );
    if (cliStatus.wsl?.distro) {
      console.log(
        `   Runtime WSL distribution pinned as ${cliStatus.wsl.distro} in native MCP registrations.`
      );
    }
    if (wslConfigured) {
      console.log("   Selected WSL host registrations and skills/commands were installed too.");
    } else if (!mode.hostOnly) {
      console.log("   WARNING: WSL host installation did not complete; see the warning above.");
    }
    if (!cliStatus.wsl?.tmux) {
      console.log("   WARNING: tmux was not found in the selected WSL distribution.");
      console.log("            WSL interactive partner sessions require tmux.");
    }
    if (!cliStatus.wsl?.claude) {
      console.log("   WARNING: Claude Code CLI is unavailable as a WSL review partner.");
    }
    if (!cliStatus.wsl?.codex) {
      console.log("   WARNING: Codex CLI is unavailable as a WSL review partner.");
    }
  } else if (!cliStatus.hasClaude || !cliStatus.hasCodex) {
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
  console.log("   /dualog-review-pr           Multi-specialist PR review panel");
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
  // Explicit Windows routing is a hard prerequisite. Check it before legacy
  // migration or dependency installation can mutate the repository/user home.
  await preflightExplicitWslSelection(mode, { cwd: REPO_ROOT });
  // Migration removes files as well as rewriting configs. Validate every JSON
  // target first so malformed user data produces zero partial mutations.
  prevalidateConfigTargets();

  console.log("");
  logStep("Migrating any pre-rename install...");
  removeLegacyInstall();

  console.log("");
  logStep("Installing dependencies...");
  ensureDependencies();

  const spawn = await loadSpawn();
  const cliStatus = await checkPartnerClis(spawn, logStep, mode);

  // Finish the required selected-WSL lifecycle step before writing native
  // registrations. A failed nested install cannot leave a new native route
  // pointing at an unconfigured WSL host.
  const wslConfigured =
    process.platform === "win32"
      ? await configureWslHosts(spawn, mode, cliStatus, logStep)
      : false;

  if (mode.installClaude) {
    registerClaudeMcp(cliStatus, logStep);
    installClaudeCommandsAndHooks(logStep);
  }

  if (mode.installCodex) {
    registerCodexMcp(cliStatus, logStep);
    installCodexSkills(logStep);
  }

  printSummary(mode, cliStatus, { wslConfigured });
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
