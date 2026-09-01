#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  assertSafeConfigWriteTarget,
  atomicWriteFile,
  buildWslLifecycleInvocation,
  planWslUninstallTargets,
  probeInstallEnvironment,
  readJsonConfig,
  removeMcpServerConfig,
  resolveCodexPaths,
  runInstallProbe,
  writeJsonConfig,
  wslArgs,
} from "./install-utils.mjs";
import { assertSafeWslLauncher } from "../src/wsl-shell.mjs";

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
const CODEX_PATHS = resolveCodexPaths();
const CODEX_DIR = CODEX_PATHS.root;
const CODEX_SKILLS_DIR = CODEX_PATHS.skills;
const CODEX_CONFIG_TOML = CODEX_PATHS.config;

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
  let hostOnly = process.env.DUALOG_UNINSTALL_HOST_ONLY === "1";
  let wslDistro = null;
  let wslBinary = null;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
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
        `Unknown option: ${arg}\nUsage: npm run uninstall -- [--claude|--codex|--both] [--host-only] [--wsl-distro <name>] [--wsl-binary <path>]`
      );
    }
  }

  return { removeClaude, removeCodex, hostOnly, wslDistro, wslBinary };
}

function removeClaudeMcp() {
  const config = readJsonConfig(CLAUDE_JSON);
  if (config.mcpServers?.["dualog"]) {
    delete config.mcpServers["dualog"];
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
    writeJsonConfig(CLAUDE_JSON, config);
    console.log(`  Removed ${CLAUDE_JSON} MCP registration atomically OK`);
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

function removeCodexMcp() {
  if (fs.existsSync(CODEX_CONFIG_TOML)) {
    const original = fs.readFileSync(CODEX_CONFIG_TOML, "utf-8");
    const updated = removeMcpServerConfig(original);
    if (updated !== original) {
      atomicWriteFile(CODEX_CONFIG_TOML, updated);
      console.log(`  Removed ${CODEX_CONFIG_TOML} MCP registration atomically OK`);
    }
  }
}

function modeArgument(mode) {
  if (mode.removeClaude && mode.removeCodex) return "--both";
  return mode.removeClaude ? "--claude" : "--codex";
}

function discoverPersistedWslTargets(mode) {
  const claudeConfig =
    mode.removeClaude && fs.existsSync(CLAUDE_JSON) ? readJsonConfig(CLAUDE_JSON) : null;
  const codexToml =
    mode.removeCodex && fs.existsSync(CODEX_CONFIG_TOML)
      ? fs.readFileSync(CODEX_CONFIG_TOML, "utf-8")
      : "";
  const envDistro = process.env.DUALOG_WSL_DISTRO?.trim() || null;
  const envBinary = process.env.DUALOG_WSL_BINARY?.trim() || null;
  return planWslUninstallTargets({
    removeClaude: mode.removeClaude,
    removeCodex: mode.removeCodex,
    explicitRoute: {
      distro: mode.wslDistro ?? envDistro,
      binary: mode.wslBinary ?? envBinary,
    },
    claudeConfig,
    codexToml,
  });
}

function printWslManualUninstall(mode, wsl) {
  console.log(
    `  Open ${wsl?.distro ?? "the selected WSL distribution"}, cd to this repository, and run:`
  );
  console.log(`    node scripts/uninstall.mjs ${modeArgument(mode)} --host-only`);
}

function unsafeWslLifecycleReason(route) {
  try {
    assertSafeWslLauncher(route?.binary || "wsl.exe", { platform: "win32" });
    return null;
  } catch (error) {
    return error.message;
  }
}

function skipUnsafeWslLifecycle(mode, route, reason) {
  console.log("");
  console.log(
    `  WARNING: Skipping unsafe legacy WSL lifecycle route ${JSON.stringify(route?.binary || "wsl.exe")}: ${reason}`
  );
  console.log(
    "  Native MCP registration will still be removed; remove any remaining WSL-host files manually."
  );
  printWslManualUninstall(mode, route);
  // Remove this scoped native registration immediately. A different host may
  // have a valid but currently unavailable WSL route that makes the overall
  // nested cleanup fail; that must not strand this known-unsafe legacy route.
  if (mode.removeClaude) removeClaudeMcp();
  if (mode.removeCodex) removeCodexMcp();
}

async function removeWslHost(mode, persistedRoute) {
  const probeEnv = {
    ...process.env,
    ...(persistedRoute.distro ? { DUALOG_WSL_DISTRO: persistedRoute.distro } : {}),
    ...(persistedRoute.binary ? { DUALOG_WSL_BINARY: persistedRoute.binary } : {}),
  };
  const status = await probeInstallEnvironment(
    (command, args, options) =>
      runInstallProbe(command, args, options, { platform: process.platform }),
    {
    platform: process.platform,
    env: probeEnv,
    cwd: REPO_ROOT,
    }
  );
  const wsl = status.wsl;
  console.log("");
  console.log(
    `Removing the selected WSL host installation (${modeArgument(mode).slice(2)})...`
  );
  if (!wsl?.binaryAvailable || !wsl.distroAvailable || !wsl.node || !wsl.nodePath) {
    console.log(
      "  WARNING: WSL, the selected distribution, or Node.js >= 18 is unavailable; WSL files were not removed."
    );
    printWslManualUninstall(mode, wsl);
    return false;
  }
  if (!wsl.distro) {
    console.log("  WARNING: WSL did not report an exact distribution; refusing to guess.");
    printWslManualUninstall(mode, wsl);
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
    { platform: process.platform }
  );
  const wslRepoRoot = translated.status === 0 ? String(translated.stdout ?? "").trim() : "";
  if (!wslRepoRoot) {
    throw new Error(
      `Could not translate ${REPO_ROOT} for WSL distribution ${wsl.distro}: ` +
        `${String(translated.stderr ?? translated.error?.message ?? "unknown error").trim()}`
    );
  }
  const scriptPath = path.posix.join(wslRepoRoot, "scripts", "uninstall.mjs");
  const invocation = buildWslLifecycleInvocation({
    operation: "uninstall",
    route: wsl,
    nodePath: wsl.nodePath,
    scriptPath,
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
    { platform: process.platform }
  );
  if (result.status !== 0) {
    throw new Error(
      result.error
        ? `WSL uninstaller failed: ${result.error.message}`
        : `WSL uninstaller failed in distribution ${wsl.distro}`
    );
  }
  console.log(`  Removed WSL host installation from ${wsl.distro} OK`);
  return true;
}

async function removeWslHosts(mode) {
  if (process.platform !== "win32" || mode.hostOnly) return;
  const plan = discoverPersistedWslTargets(mode);
  let complete = true;
  for (const unresolved of plan.unresolved) {
    const unresolvedMode = {
      ...mode,
      removeClaude: unresolved.removeClaude,
      removeCodex: unresolved.removeCodex,
    };
    const unsafeReason = unsafeWslLifecycleReason(unresolved.route);
    if (unsafeReason) {
      skipUnsafeWslLifecycle(unresolvedMode, unresolved.route, unsafeReason);
      continue;
    }
    console.log("");
    console.log(
      `  WARNING: No exact WSL distribution was recorded for ${modeArgument(unresolvedMode).slice(2)}; refusing to guess the current default distribution.`
    );
    console.log(
      `  If that install was host-only, rerun with: node scripts/uninstall.mjs ${modeArgument(unresolvedMode)} --host-only`
    );
    printWslManualUninstall(unresolvedMode, null);
    complete = false;
  }
  for (const target of plan.targets) {
    const targetMode = {
      ...mode,
      removeClaude: target.removeClaude,
      removeCodex: target.removeCodex,
    };
    const unsafeReason = unsafeWslLifecycleReason(target.route);
    if (unsafeReason) {
      skipUnsafeWslLifecycle(targetMode, target.route, unsafeReason);
      continue;
    }
    complete = (await removeWslHost(
      targetMode,
      target.route
    )) && complete;
  }
  if (!complete) {
    throw new Error(
      "One or more WSL host installations could not be removed; registrations for unresolved or failed routes were retained so their exact routes remain discoverable."
    );
  }
}

async function main() {
  const mode = parseMode(process.argv.slice(2));

  console.log("dualog uninstaller");
  console.log("");

  // Validate every config that may be rewritten before removing any files.
  // Malformed JSON, dangling links, non-regular files, and multi-link targets
  // are hard stops. Valid file symlinks are preserved by atomic target writes.
  if (mode.removeClaude) {
    readJsonConfig(CLAUDE_JSON);
    readJsonConfig(CLAUDE_SETTINGS_JSON);
  }
  if (mode.removeCodex) {
    assertSafeConfigWriteTarget(CODEX_CONFIG_TOML);
  }

  await removeWslHosts(mode);

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

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
