// Capability negotiation.
//
// Governing principle: a degradation that changes what the partner is ALLOWED
// TO DO is a hard error. A degradation that changes how WELL it does it is a
// loud warning. Nothing is ever silent.
//
// The reason for the asymmetry: if the host asked for effort "high" and the
// partner cannot do effort levels, the reply is merely less considered, and the
// host can be told. If the host asked for a read-only partner and the adapter
// cannot enforce that, the host would be reasoning about a safety property that
// does not hold.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { Buffer } from "node:buffer";
import crossSpawn from "cross-spawn";
import { resolveContext } from "./argv.mjs";
import { probeWslPartnerCommand, tmuxRoute } from "../tmux-runtime.mjs";
import { terminateWindowsProcessTree } from "../windows-process-tree.mjs";

const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

/** Is `command` runnable -- an executable path, or a name on PATH? */
export function findBinary(
  command,
  env = process.env,
  { platform = process.platform, accessSync = fs.accessSync } = {}
) {
  if (!command) return null;
  const pathImpl = platform === "win32" ? path.win32 : path;
  const isPath =
    platform === "win32"
      ? path.win32.isAbsolute(command) || /[\\/]/u.test(command)
      : command.includes(path.sep);

  if (isPath) {
    try {
      accessSync(command, fs.constants.X_OK);
      return pathImpl.resolve(command);
    } catch {
      return null;
    }
  }

  const envValue = (name) => {
    if (env?.[name] != null) return env[name];
    if (platform !== "win32") return undefined;
    const key = Object.keys(env ?? {}).find((candidate) => candidate.toUpperCase() === name);
    return key ? env[key] : undefined;
  };
  const windowsExts = (envValue("PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
  // PATHEXT is case-insensitive on Windows. If the caller already named one
  // of its executable suffixes, appending every suffix again turns `codex.exe`
  // into `codex.exe.EXE` and guarantees a false negative.
  const exts =
    platform === "win32"
      ? windowsExts.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()))
        ? [""]
        : windowsExts
      : [""];
  const delimiter = platform === "win32" ? path.win32.delimiter : path.delimiter;
  for (const rawDir of String(envValue("PATH") || "").split(delimiter).filter(Boolean)) {
    // Quoted PATH entries are common in hand-written Windows environments;
    // the quotes delimit the entry and are not part of the directory name.
    const dir =
      platform === "win32" && /^".*"$/u.test(rawDir)
        ? rawDir.slice(1, -1)
        : rawDir;
    for (const ext of exts) {
      const candidate = pathImpl.join(dir, command + ext);
      try {
        accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Best-effort version probe; never throws, never blocks for long. */
export function probeVersion(
  binaryPath,
  versionArgs,
  timeoutMs = 5000,
  {
    platform = process.platform,
    execFileImpl = execFile,
    spawnImpl = crossSpawn,
    terminateWindowsTreeFn = terminateWindowsProcessTree,
  } = {}
) {
  if (platform === "win32") {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(binaryPath, versionArgs, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        resolve(null);
        return;
      }

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const terminateAndFinish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Keep the .cmd/cmd.exe wrapper live while taskkill enumerates /T.
        // Detaching its pipes first can let the wrapper exit and reparent the
        // actual vendor CLI before the tree walk starts.
        terminateWindowsTreeFn(child?.pid);
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try { stream?.destroy(); } catch {}
        }
        try { child.unref?.(); } catch {}
        resolve(null);
      };
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        stdoutBytes += Buffer.byteLength(chunk, "utf-8");
        if (stdoutBytes > MAX_VERSION_OUTPUT_BYTES) return terminateAndFinish();
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (settled) return;
        stderrBytes += Buffer.byteLength(chunk, "utf-8");
        if (stderrBytes > MAX_VERSION_OUTPUT_BYTES) return terminateAndFinish();
        stderr += chunk;
      });
      child.once("error", () => finish(null));
      child.once("close", (code) => {
        if (code !== 0 && !stdout) return finish(null);
        finish(String(stdout || stderr).trim().split(/\r?\n/u)[0] || null);
      });
      timer = setTimeout(terminateAndFinish, timeoutMs);
    });
  }

  return new Promise((resolve) => {
    execFileImpl(
      binaryPath,
      versionArgs,
      {
        timeout: timeoutMs,
        encoding: "utf-8",
        windowsHide: true,
        maxBuffer: MAX_VERSION_OUTPUT_BYTES,
      },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve(null);
        resolve(String(stdout || stderr).trim().split("\n")[0] || null);
      }
    );
  });
}

/**
 * Decide whether this invocation can proceed, and what the caller must be told.
 *
 * Returns { errors, warnings, engine, notices, resolution }. A non-empty
 * `errors` means do not spawn. `resolution` reports what the turn would
 * actually run as -- including the effort the CLI applies by default when none
 * was requested, which is otherwise invisible.
 */
export function negotiate(adapter, options = {}) {
  const {
    engine,
    partnerCommand = null,
    toolProfile = null,
    env = process.env,
    allowRecursiveMcp = false,
    requireBinary = true,
    allowUnknownModel = false,
    // A discovery result for this adapter, when the caller has one. Without it
    // an unrecognized model can only be flagged, never rejected -- a declared
    // model list is a snapshot, not a catalog. See resolveContext.
    discoveredModels = null,
  } = options;

  const errors = [];
  const warnings = [];
  const sources = adapter.__sources?.join(" <- ") ?? "<unknown source>";

  // Option-level findings (model / effort / tool profile) come from the same
  // normalization the argv builder uses, so the two can never disagree about
  // what this turn would do. Severity is decided there, next to the fact that
  // produced it; this only routes it.
  const { notices, resolution } = resolveContext(adapter, {
    projectPath: options.projectPath ?? process.cwd(),
    sessionDir: options.sessionDir ?? process.cwd(),
    model: options.model ?? null,
    reasoningEffort: options.reasoningEffort ?? null,
    toolProfile,
    allowUnknownModel,
    discoveredModels,
    // This function exists to predict what a real start would do, and a real
    // start applies the house default to an omitted effort.
    applyOperatorDefault: options.applyOperatorDefault ?? true,
  });
  for (const notice of notices) {
    const entry = {
      code: notice.code ?? `dropped_${notice.field}`,
      message: notice.message,
      source: sources,
    };
    if (notice.severity === "error") errors.push(entry);
    else if (notice.severity !== "info") warnings.push(entry);
  }

  if (requireBinary) {
    const command = partnerCommand || adapter.binary.default;
    if (!findBinary(command, env)) {
      errors.push({
        code: "binary_not_found",
        message:
          `"${command}" was not found on PATH, so adapter "${adapter.id}" cannot start.` +
          (adapter.binary.installHint ? ` Install: ${adapter.binary.installHint}` : ""),
        source: sources,
      });
    }
  }

  // A read-only tool profile that the adapter can only express as prompt
  // wording is a safety property the host must not assume holds.
  if (
    toolProfile === "read" &&
    adapter.capabilities.toolProfiles !== "flags" &&
    adapter.capabilities.writesFiles
  ) {
    warnings.push({
      code: "tool_profile_not_enforced",
      message:
        `adapter "${adapter.id}" cannot enforce a read-only profile with flags; ` +
        `the partner is asked to behave read-only in the prompt but retains write access`,
      source: sources,
    });
  }

  // Recursion is already closed by the env sentinel for every adapter, so a
  // missing per-CLI switch is a credential-inheritance concern, not a recursion
  // one -- and it is the config-dir isolation that addresses it.
  if (adapter.mcp.strategy === "none" && !adapter.configIsolation && !allowRecursiveMcp) {
    warnings.push({
      code: "mcp_not_suppressed",
      message:
        `adapter "${adapter.id}" has neither MCP suppression nor config-dir isolation, ` +
        `so the partner inherits the user's MCP servers and any credentials in their env`,
      source: sources,
    });
  } else if (!adapter.configIsolation) {
    warnings.push({
      code: "no_config_isolation",
      message:
        `adapter "${adapter.id}" has no config-dir isolation, so the partner runs ` +
        `against the user's real config and auth`,
      source: sources,
    });
  }

  if (engine === "tmux-interactive" && adapter.capabilities.tuiDrivable === "risky") {
    warnings.push({
      code: "tui_risky",
      message:
        `adapter "${adapter.id}" is marked risky to drive through a TUI ` +
        `(often an alternate-screen buffer, which defeats pane capture)`,
      source: sources,
    });
  }

  return { errors, warnings, notices, engine, resolution };
}

/** Runtime availability report for one adapter, for the discovery tools. */
export async function describeAdapter(
  adapter,
  {
    probe = false,
    env = process.env,
    platform = process.platform,
    findBinaryFn = findBinary,
    probeVersionFn = probeVersion,
    tmuxRouteFn = tmuxRoute,
    probeWslPartnerCommandFn = probeWslPartnerCommand,
  } = {}
) {
  const command = adapter.binary.default;
  const binaryPath = findBinaryFn(command, env, { platform });
  let wslAvailable = false;
  let route = null;

  // Native Windows can host this MCP server while the selected interactive
  // partner lives only in WSL. Startup validates that exact command through
  // resolveRunnableEngine(); status must ask the same question instead of
  // declaring the adapter missing from the Windows PATH alone. The probe is
  // one bounded `--version` call and is skipped everywhere else.
  if (!binaryPath && platform === "win32") {
    try {
      route = tmuxRouteFn({ env, platform });
      if (
        route?.transport === "wsl" &&
        adapter.engines.allowed.includes("tmux-interactive")
      ) {
        wslAvailable =
          (await probeWslPartnerCommandFn(command, adapter.binary.versionArgs, {
            env,
            platform,
            route,
          })) ===
          "available";
      }
    } catch {
      // An invalid WSL/tmux override is an unavailable route, not a reason for
      // the read-only listing tool itself to fail.
      wslAvailable = false;
    }
  }

  const available = Boolean(binaryPath) || wslAvailable;
  return {
    id: adapter.id,
    display_name: adapter.displayName,
    experimental: adapter.experimental,
    engines: adapter.engines,
    capabilities: adapter.capabilities,
    reasoning_efforts: adapter.reasoningEfforts,
    models: adapter.models,
    tool_profiles: Object.keys(adapter.toolProfiles),
    mcp_suppression: adapter.mcp.strategy,
    config_isolation: adapter.configIsolation?.env ?? null,
    completion: adapter.completion.sidecar,
    binary: command,
    binary_available: available,
    binary_path: binaryPath,
    binary_transport: binaryPath ? "local" : wslAvailable ? "wsl" : null,
    wsl_distro: wslAvailable ? (route?.distro ?? null) : null,
    version:
      probe && binaryPath
        ? await probeVersionFn(binaryPath, adapter.binary.versionArgs)
        : undefined,
    install_hint: adapter.binary.installHint ?? null,
    sources: adapter.__sources,
  };
}
