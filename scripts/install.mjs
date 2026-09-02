#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import {
  assertSafeConfigWriteTarget,
  buildClaudeMcpRegistration,
  buildWslLifecycleInvocation,
  effectiveExplicitWslSelection,
  formatInstallEnvironment,
  probeInstallEnvironment,
  persistedWslEnv,
  preflightExplicitWslSelection,
  readJsonConfig,
  replaceMcpServerSection,
  resolveCodexPaths,
  runInstallProbe,
  validateExplicitWslSelection,
  wslArgs,
} from "./install-utils.mjs";
import {
  InstallTransaction,
  copyTreeContents,
  fingerprintInstallPath,
  recoverPendingInstallTransaction,
} from "./install-transaction.mjs";
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
const CLAUDE_HOOKS_RENAMED_LEGACY_PLATFORM = path.join(
  CLAUDE_HOOKS_ROOT,
  "codex-dialog-platform.mjs"
);
const CLAUDE_SETTINGS_JSON = path.join(CLAUDE_DIR, "settings.json");
const CODEX_PATHS = resolveCodexPaths();
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

const LEGACY_SHELL_HOOK_FILES = [
  "mark-needs-investigation.sh",
  "clear-investigation.sh",
  "enforce-investigation.sh",
];

const OWNED_HOOK_DIRECTORIES = [
  CLAUDE_HOOKS_DIR,
  path.join(CLAUDE_HOOKS_ROOT, LEGACY_HOOKS_DIR_NAME),
];

const OWNED_PLATFORM_HELPER_HEADERS = [
  [
    'import fs from "fs";',
    'import os from "os";',
    'import path from "path";',
    "",
    "// dualog platform helpers. Keep this file dependency-light because",
    "// Claude hook scripts import it from the user-level hooks directory.",
  ].join("\n"),
  [
    'import fs from "fs";',
    'import os from "os";',
    'import path from "path";',
    "",
    "// claude-codex-dialog platform helpers. Keep this file dependency-light because",
    "// Claude hook scripts import it from the user-level hooks directory.",
  ].join("\n"),
];

const LEGACY_MATCHERS = new Map([
  ["mcp__codex-dialog__send_message", "mcp__dualog__send_message"],
  ["mcp__codex-dialog__end_dialog", "mcp__dualog__end_dialog"],
  ["mcp__codex-dialog__check_messages", "mcp__dualog__check_messages"],
  [
    "mcp__codex-dialog__wait_for_partner_response",
    "mcp__dualog__wait_for_partner_response",
  ],
  ["mcp__codex-dialog__get_full_history", "mcp__dualog__get_full_history"],
]);

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

function ownedInstallPaths() {
  return new Set([
    CLAUDE_JSON,
    CLAUDE_SETTINGS_JSON,
    CODEX_CONFIG_TOML,
    CLAUDE_HOOKS_DIR,
    CLAUDE_HOOKS_PLATFORM,
    CLAUDE_HOOKS_LEGACY_PLATFORM,
    CLAUDE_HOOKS_RENAMED_LEGACY_PLATFORM,
    path.join(CLAUDE_HOOKS_ROOT, LEGACY_HOOKS_DIR_NAME),
    ...CLAUDE_COMMANDS.map((name) => path.join(CLAUDE_COMMANDS_DIR, `${name}.md`)),
    ...LEGACY_CLAUDE_COMMANDS.map((name) =>
      path.join(CLAUDE_COMMANDS_DIR, `${name}.md`)
    ),
    ...LEGACY_SHELL_HOOK_FILES.map((name) => path.join(CLAUDE_HOOKS_DIR, name)),
    ...CODEX_SKILLS.map((name) => path.join(CODEX_SKILLS_DIR, name)),
    ...LEGACY_CODEX_SKILLS.map((name) => path.join(CODEX_SKILLS_DIR, name)),
  ]);
}

function snapshotConfigTarget(filePath) {
  const before = assertSafeConfigWriteTarget(filePath);
  const snapshot = {
    targetPath: before?.targetPath ?? null,
    fingerprint: before ? fingerprintInstallPath(before.targetPath) : null,
    mode: before ? before.target.mode & 0o777 : 0o600,
  };
  return snapshot;
}

function assertConfigSnapshotUnchanged(filePath, snapshot) {
  const after = assertSafeConfigWriteTarget(filePath);
  const afterTarget = after?.targetPath ?? null;
  if (
    afterTarget !== snapshot.targetPath ||
    (afterTarget !== null &&
      fingerprintInstallPath(afterTarget) !== snapshot.fingerprint)
  ) {
    throw new Error(`Config changed while preparing install: ${filePath}`);
  }
}

function readJsonSnapshot(filePath) {
  const snapshot = snapshotConfigTarget(filePath);
  const config = readJsonConfig(filePath);
  assertConfigSnapshotUnchanged(filePath, snapshot);
  return { ...snapshot, config };
}

function readTextSnapshot(filePath) {
  const snapshot = snapshotConfigTarget(filePath);
  const content = snapshot.targetPath
    ? fs.readFileSync(snapshot.targetPath, "utf-8")
    : "";
  assertConfigSnapshotUnchanged(filePath, snapshot);
  return { ...snapshot, content };
}

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

function removeMcpKeys(config, keys) {
  const servers = config?.mcpServers;
  if (servers === null || (typeof servers !== "object" && typeof servers !== "function")) {
    return false;
  }
  let changed = false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(servers, key)) continue;
    delete servers[key];
    changed = true;
  }
  if (changed && Object.keys(servers).length === 0) delete config.mcpServers;
  return changed;
}

function samePath(left, right) {
  try {
    const normalizedLeft = path.resolve(left);
    const normalizedRight = path.resolve(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  } catch {
    return false;
  }
}

/** Parse only the simple two-token command shape emitted by Dualog installers. */
function tokenizeHookCommand(command) {
  const tokens = [];
  let token = "";
  let quote = null;
  let active = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (
        process.platform !== "win32" &&
        quote === '"' &&
        char === "\\" &&
        index + 1 < command.length &&
        ['"', "\\", "$", "`"].includes(command[index + 1])
      ) {
        token += command[++index];
        active = true;
        continue;
      }
      token += char;
      active = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      active = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (active) {
        tokens.push(token);
        token = "";
        active = false;
      }
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      if (process.platform === "win32") token += char;
      else token += command[++index];
      active = true;
      continue;
    }
    token += char;
    active = true;
  }
  if (quote) return null;
  if (active) tokens.push(token);
  return tokens;
}

function isOwnedHookCommand(
  command,
  { directories = OWNED_HOOK_DIRECTORIES, fileNames = [...HOOK_FILES, ...LEGACY_SHELL_HOOK_FILES] } = {}
) {
  if (typeof command !== "string") return false;

  // Shell installers before the Windows-safe rewrite emitted this exact raw
  // shape. It was unusable when HOME contained spaces, but remains ours to
  // migrate. Full equality prevents substring or extra-argument ownership.
  for (const directory of directories) {
    for (const fileName of fileNames) {
      const executable = fileName.endsWith(".sh") ? "bash" : "node";
      if (command === `${executable} ${path.join(directory, fileName)}`) return true;
    }
  }

  const tokens = tokenizeHookCommand(command);
  if (!tokens || tokens.length !== 2) return false;
  const executable = tokens[0].replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return directories.some((directory) =>
    fileNames.some((fileName) => {
      const validExecutables = fileName.endsWith(".sh")
        ? ["bash", "bash.exe"]
        : ["node", "node.exe"];
      return (
        (validExecutables.includes(executable) ||
          (!fileName.endsWith(".sh") && samePath(tokens[0], NODE_PATH))) &&
        samePath(tokens[1], path.join(directory, fileName))
      );
    })
  );
}

function hasOwnedPlatformHelperHeader(content) {
  const normalized = content.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  return OWNED_PLATFORM_HELPER_HEADERS.some((header) => normalized.startsWith(header));
}

function migrateLegacySettings(config) {
  let changed = removeMcpKeys(config, ["dualog", LEGACY_MCP_KEY]);
  const legacyDirectory = path.join(CLAUDE_HOOKS_ROOT, LEGACY_HOOKS_DIR_NAME);
  if (config?.hooks === null || typeof config?.hooks !== "object") return changed;

  let hookStructureChanged = false;
  for (const key of ["PreToolUse", "PostToolUse"]) {
    if (!Array.isArray(config.hooks[key])) continue;
    const migrated = [];
    let keyChanged = false;
    for (const original of config.hooks[key]) {
      if (original === null || typeof original !== "object") {
        migrated.push(original);
        continue;
      }
      let entry = original;
      const replacementMatcher = LEGACY_MATCHERS.get(original.matcher);
      if (replacementMatcher) {
        entry = { ...entry, matcher: replacementMatcher };
        changed = true;
        keyChanged = true;
      }
      if (Array.isArray(original.hooks)) {
        const hooks = original.hooks.filter(
          (hook) =>
            !isOwnedHookCommand(hook?.command, {
              directories: [legacyDirectory],
            })
        );
        if (hooks.length !== original.hooks.length) {
          changed = true;
          keyChanged = true;
          entry = { ...entry, hooks };
          if (hooks.length === 0) continue;
        }
      }
      migrated.push(entry);
    }
    if (!keyChanged) continue;
    hookStructureChanged = true;
    if (migrated.length === 0) delete config.hooks[key];
    else config.hooks[key] = migrated;
  }
  if (hookStructureChanged && Object.keys(config.hooks).length === 0) delete config.hooks;
  return changed;
}

function stageLegacyInstall(transaction, mode) {
  let staged = 0;
  if (mode.installClaude) {
    for (const name of LEGACY_CLAUDE_COMMANDS) {
      if (transaction.stageDelete(path.join(CLAUDE_COMMANDS_DIR, `${name}.md`))) {
        staged++;
      }
    }
    if (
      transaction.stageDelete(
        path.join(CLAUDE_HOOKS_ROOT, LEGACY_HOOKS_DIR_NAME)
      )
    ) {
      staged++;
    }
    for (const filePath of [
      CLAUDE_HOOKS_RENAMED_LEGACY_PLATFORM,
      CLAUDE_HOOKS_LEGACY_PLATFORM,
    ]) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      if (hasOwnedPlatformHelperHeader(content) && transaction.stageDelete(filePath)) {
        staged++;
      }
    }
  }
  if (mode.installCodex) {
    for (const name of LEGACY_CODEX_SKILLS) {
      if (transaction.stageDelete(path.join(CODEX_SKILLS_DIR, name))) staged++;
    }
  }
  if (staged === 0) console.log("  no pre-rename artifacts found OK");
  else console.log(`  staged ${staged} pre-rename artifact(s) for transactional cleanup OK`);
  return staged;
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 18) {
    throw new Error(`Node.js >= 18 required, found ${process.version}`);
  }
  console.log(`  Node.js ${process.version} OK`);
}

async function runNpmInstall() {
  await runNpmInstallBootstrap({ cwd: REPO_ROOT });
}

function dependencyAvailable(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

async function ensureDependencies() {
  let missing = RUNTIME_DEPENDENCY_PROBES.filter(([, probe]) => !dependencyAvailable(probe));
  if (missing.length === 0) {
    console.log("  Dependencies already installed OK");
    return;
  }
  await runNpmInstall();
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

function prevalidateConfigTargets(mode) {
  if (mode.installClaude) {
    for (const filePath of [CLAUDE_JSON, CLAUDE_SETTINGS_JSON]) {
      readJsonConfig(filePath);
    }
  }
  if (mode.installCodex) assertSafeConfigWriteTarget(CODEX_CONFIG_TOML);
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

function upsertOwnedHookEntry(
  entries,
  desired,
  ownedFileNames,
  directories = [CLAUDE_HOOKS_DIR]
) {
  let replacementIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.matcher !== desired.matcher || !Array.isArray(entry.hooks)) continue;
    const unrelated = entry.hooks.filter(
      (hook) =>
        !isOwnedHookCommand(hook?.command, { directories, fileNames: ownedFileNames })
    );
    if (unrelated.length === entry.hooks.length) continue;
    if (replacementIndex < 0) {
      entries[index] = { ...entry, hooks: [...desired.hooks, ...unrelated] };
      replacementIndex = index;
    } else if (unrelated.length > 0) {
      entries[index] = { ...entry, hooks: unrelated };
    } else {
      entries.splice(index, 1);
    }
  }
  if (replacementIndex < 0) entries.push(desired);
}

function removeOwnedHookFromMatchers(
  entries,
  matchers,
  ownedFileNames,
  directories = [CLAUDE_HOOKS_DIR]
) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!matchers.has(entry?.matcher) || !Array.isArray(entry.hooks)) continue;
    const hooks = entry.hooks.filter(
      (hook) =>
        !isOwnedHookCommand(hook?.command, { directories, fileNames: ownedFileNames })
    );
    if (hooks.length === entry.hooks.length) continue;
    if (hooks.length === 0) entries.splice(index, 1);
    else entries[index] = { ...entry, hooks };
  }
}

function writeStagedSource(sourcePath, targetPath, transform = (content) => content) {
  const stat = fs.statSync(sourcePath);
  const content = transform(fs.readFileSync(sourcePath));
  fs.writeFileSync(targetPath, content, { mode: stat.mode & 0o777 });
}

function updateClaudeSettings(config) {
  migrateLegacySettings(config);
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    config.hooks = {};
  }

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

  upsertOwnedHookEntry(preHooks, preEntries[0], [
    "enforce-investigation.mjs",
    "enforce-resolution.mjs",
    "enforce-investigation.sh",
  ]);
  upsertOwnedHookEntry(preHooks, preEntries[1], ["require-lgtm-or-cap.mjs"]);

  if (!Array.isArray(config.hooks.PostToolUse)) config.hooks.PostToolUse = [];
  const postHooks = config.hooks.PostToolUse;
  for (const matcher of [
    "mcp__dualog__check_messages",
    "mcp__dualog__wait_for_partner_response",
    "mcp__dualog__get_full_history",
  ]) {
    upsertOwnedHookEntry(
      postHooks,
      {
        matcher,
        hooks: [{ type: "command", command: hookCommand("mark-needs-investigation.mjs") }],
      },
      ["mark-needs-investigation.mjs", "mark-needs-investigation.sh"]
    );
  }
  upsertOwnedHookEntry(
    postHooks,
    {
      matcher: "Read",
      hooks: [{ type: "command", command: hookCommand("clear-investigation.mjs") }],
    },
    ["clear-investigation.mjs", "clear-investigation.sh"]
  );
  removeOwnedHookFromMatchers(
    postHooks,
    new Set(["Grep", "Glob"]),
    ["clear-investigation.mjs", "clear-investigation.sh"]
  );
  return config;
}

function stageClaudeRegistrations(transaction, cliStatus, logStep) {
  console.log("");
  logStep("Registering MCP server for Claude...");
  const claude = readJsonSnapshot(CLAUDE_JSON);
  if (
    !claude.config.mcpServers ||
    typeof claude.config.mcpServers !== "object" ||
    Array.isArray(claude.config.mcpServers)
  ) {
    claude.config.mcpServers = {};
  }
  removeMcpKeys(claude.config, [LEGACY_MCP_KEY]);
  claude.config.mcpServers.dualog = buildClaudeMcpRegistration({
    serverPath: SERVER_PATH,
    nodePath: NODE_PATH,
    cliStatus,
  });
  transaction.stageFile(CLAUDE_JSON, `${JSON.stringify(claude.config, null, 2)}\n`, {
    targetPath: claude.targetPath,
    mode: claude.mode,
    expectedOriginalFingerprint: claude.fingerprint,
  });

  const settings = readJsonSnapshot(CLAUDE_SETTINGS_JSON);
  updateClaudeSettings(settings.config);
  transaction.stageFile(
    CLAUDE_SETTINGS_JSON,
    `${JSON.stringify(settings.config, null, 2)}\n`,
    {
      targetPath: settings.targetPath,
      mode: settings.mode,
      expectedOriginalFingerprint: settings.fingerprint,
    }
  );
  console.log("  Claude registration and settings staged atomically OK");
}

function stageClaudeCommandsAndHooks(transaction, logStep) {
  console.log("");
  logStep("Installing Claude commands and hooks...");

  for (const command of CLAUDE_COMMANDS) {
    const source = path.join(REPO_ROOT, ".claude", "commands", `${command}.md`);
    transaction.stageFile(
      path.join(CLAUDE_COMMANDS_DIR, `${command}.md`),
      fs.readFileSync(source),
      { mode: fs.statSync(source).mode & 0o777 }
    );
    console.log(`  /${command} OK`);
  }

  const platformSource = path.join(REPO_ROOT, "src", "platform.mjs");
  transaction.stageFile(CLAUDE_HOOKS_PLATFORM, fs.readFileSync(platformSource), {
    mode: fs.statSync(platformSource).mode & 0o777,
  });
  transaction.stageTree(CLAUDE_HOOKS_DIR, (stage) => {
    const sharedSource = path.join(REPO_ROOT, "src", "shared.mjs");
    writeStagedSource(sharedSource, path.join(stage, "shared.mjs"), (content) =>
      Buffer.from(
        content.toString("utf-8").replaceAll("./platform.mjs", "../dualog-platform.mjs")
      )
    );
    for (const fileName of HOOK_FILES) {
      const source = path.join(REPO_ROOT, "src", "hooks", fileName);
      writeStagedSource(source, path.join(stage, fileName), (content) =>
        Buffer.from(
          content.toString("utf-8").replaceAll("../platform.mjs", "../dualog-platform.mjs")
        )
      );
    }
  });
  console.log("  Claude command and complete hook generation staged OK");
}

function stageCodexRegistration(transaction, cliStatus, logStep) {
  console.log("");
  logStep("Registering MCP server for Codex...");
  const config = readTextSnapshot(CODEX_CONFIG_TOML);
  transaction.stageFile(
    CODEX_CONFIG_TOML,
    replaceMcpServerSection(config.content, {
      serverPath: SERVER_PATH,
      nodePath: NODE_PATH,
      env: persistedWslEnv(cliStatus),
    }),
    {
      targetPath: config.targetPath,
      mode: config.mode,
      expectedOriginalFingerprint: config.fingerprint,
    }
  );
  console.log(`  MCP server staged atomically for ${CODEX_CONFIG_TOML} OK`);
}

function stageCodexSkills(transaction, logStep) {
  console.log("");
  logStep("Installing Codex skills...");
  for (const skill of CODEX_SKILLS) {
    const target = path.join(CODEX_SKILLS_DIR, skill);
    transaction.stageTree(target, (stage) => {
      copyTreeContents(path.join(REPO_ROOT, "dualog-skills", skill), stage);
    });
    console.log(`  /${skill} OK`);
  }
  console.log("  Codex skill generations staged for atomic replacement OK");
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

  if (
    recoverPendingInstallTransaction({
      home: HOME_DIR,
      allowedLogicalPaths: ownedInstallPaths(),
    })
  ) {
    console.log("Recovered an interrupted Dualog install transaction OK");
  }

  // Acquire the installer generation before dependency bootstrap, WSL setup,
  // directory creation, or any other fallible step that may mutate state.
  const transaction = new InstallTransaction({
    home: HOME_DIR,
    allowedLogicalPaths: ownedInstallPaths(),
  });
  try {

    console.log("dualog installer");
    console.log("");
    console.log(` Mode: ${modeLabel(mode)}`);
    console.log("");

  const logStep = createStepLogger(plannedStepCount(mode));

  logStep("Checking prerequisites...");
  checkNode();
  // Explicit Windows routing is a hard prerequisite. Check it before legacy
  // cleanup or dependency installation can mutate the repository/user home.
  await preflightExplicitWslSelection(mode, { cwd: REPO_ROOT });
  // Validate only the selected hosts. A broken Codex config must not block a
  // Claude-only install, and vice versa.
  prevalidateConfigTargets(mode);

  console.log("");
  logStep("Installing dependencies...");
  await ensureDependencies();

  const spawn = await loadSpawn();
  const cliStatus = await checkPartnerClis(spawn, logStep, mode);

  // Finish the required selected-WSL lifecycle step before writing native
  // registrations. A failed nested install cannot leave a new native route
  // pointing at an unconfigured WSL host.
  const wslConfigured =
    process.platform === "win32"
      ? await configureWslHosts(spawn, mode, cliStatus, logStep)
      : false;

    // Build every selected generation before touching any live artifact. The
    // transaction retains same-directory backups until both selected hosts and
    // every config have committed and verified.
    if (mode.installClaude) stageClaudeCommandsAndHooks(transaction, logStep);
    if (mode.installCodex) stageCodexSkills(transaction, logStep);

    console.log("");
    logStep("Cleaning up any pre-rename install...");
    stageLegacyInstall(transaction, mode);

    // Configs commit last so an old registration remains usable until all
    // command, hook, and skill generations are already in place. Any failure,
    // including the second host of --both, rolls the complete transaction back.
    if (mode.installClaude) stageClaudeRegistrations(transaction, cliStatus, logStep);
    if (mode.installCodex) stageCodexRegistration(transaction, cliStatus, logStep);
    transaction.commit();
    printSummary(mode, cliStatus, { wslConfigured });
  } catch (error) {
    transaction.abort();
    throw error;
  }

}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
