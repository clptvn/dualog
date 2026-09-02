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
import {
  inspectWslPartnerCommand,
  probeWslPartnerCommand,
  resolveWslPartnerExecutable,
  resolveWslRouteDistro,
  tmuxRoute,
} from "../tmux-runtime.mjs";
import {
  spawnWithTrustedWindowsComSpec,
  terminateWindowsProcessTree,
} from "../windows-process-tree.mjs";

const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;

/** Is `command` runnable -- an executable path, or a name on PATH? */
export function findBinary(
  command,
  env = process.env,
  {
    platform = process.platform,
    accessSync = fs.accessSync,
    realpathSync = fs.realpathSync,
    excludedRoots = [],
  } = {}
) {
  if (!command) return null;
  if (
    platform === "win32" &&
    (/^[A-Za-z]:(?![\\/])/u.test(command) || /^[\\/](?![\\/])/u.test(command))
  ) {
    // `C:tool` / `C:dir\\tool` use that drive's ambient current directory;
    // `\\tool` uses the process's ambient current drive. Neither is a fully
    // qualified explicit path, so neither may smuggle cwd authority through
    // the explicit-path branch.
    return null;
  }
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const exclusionRoots = (Array.isArray(excludedRoots) ? excludedRoots : [])
    .filter((root) => typeof root === "string" && root.trim())
    .map((root) => pathImpl.resolve(root));
  const canonicalExclusionRoots = [...exclusionRoots];
  for (const root of exclusionRoots) {
    try {
      const canonical = pathImpl.resolve(realpathSync(root));
      if (!canonicalExclusionRoots.includes(canonical)) canonicalExclusionRoots.push(canonical);
    } catch {
      // The lexical root still excludes a reviewed path that cannot be resolved.
    }
  }
  const isInsideExcludedRoot = (candidate, roots = exclusionRoots) =>
    roots.some((root) => {
      const relative = pathImpl.relative(root, candidate);
      return (
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${pathImpl.sep}`) &&
          !pathImpl.isAbsolute(relative))
      );
    });
  const usableCandidate = (candidate) => {
    const resolved = pathImpl.resolve(candidate);
    // Reject a project-local PATH entry before even touching it. Besides making
    // the trust rule explicit, this prevents a reviewed repository from learning
    // which executable suffixes the host probes through access timing/errors.
    if (isInsideExcludedRoot(resolved)) return null;
    try {
      accessSync(candidate, fs.constants.X_OK);
    } catch {
      return null;
    }
    if (exclusionRoots.length > 0) {
      let canonical;
      try {
        canonical = pathImpl.resolve(realpathSync(candidate));
      } catch {
        // Once an exclusion boundary is requested, a candidate whose target
        // cannot be established is not trusted executable authority.
        return null;
      }
      if (isInsideExcludedRoot(canonical, canonicalExclusionRoots)) return null;
    }
    return resolved;
  };
  const isPath =
    platform === "win32"
      ? pathImpl.isAbsolute(command) || /[\\/]/u.test(command)
      : command.includes(pathImpl.sep);

  if (isPath) {
    return usableCandidate(command);
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
  const delimiter = pathImpl.delimiter;
  for (const rawDir of String(envValue("PATH") || "").split(delimiter).filter(Boolean)) {
    // Quoted PATH entries are common in hand-written Windows environments;
    // the quotes delimit the entry and are not part of the directory name.
    const dir =
      platform === "win32" && /^".*"$/u.test(rawDir)
        ? rawDir.slice(1, -1)
        : rawDir;
    // A relative PATH component delegates executable authority to the spawn
    // cwd. That is especially dangerous for native Windows, where a reviewed
    // repository can otherwise satisfy `claude.cmd` or `codex.cmd` before the
    // operator's installed CLI. PATH lookup is only a trust decision when the
    // directory itself is absolute. Explicit relative command paths still use
    // the branch above and are resolved to an absolute path for callers that
    // intentionally selected them.
    const absolutePathDirectory =
      platform === "win32"
        ? /^[A-Za-z]:[\\/]/u.test(dir) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(dir)
        : pathImpl.isAbsolute(dir);
    if (!absolutePathDirectory) continue;
    for (const ext of exts) {
      const candidate = pathImpl.join(dir, command + ext);
      const resolved = usableCandidate(candidate);
      if (resolved) return resolved;
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
    env = process.env,
    execFileImpl = execFile,
    spawnImpl = crossSpawn,
    terminateWindowsTreeFn = terminateWindowsProcessTree,
  } = {}
) {
  if (platform === "win32") {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnWithTrustedWindowsComSpec(
          spawnImpl,
          binaryPath,
          versionArgs,
          {
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
          { platform, env }
        );
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
    platform = process.platform,
    findBinaryFn = findBinary,
    allowUnknownModel = false,
    // A discovery result for this adapter, when the caller has one. Without it
    // an unrecognized model can only be flagged, never rejected -- a declared
    // model list is a snapshot, not a catalog. See resolveContext.
    discoveredModels = null,
  } = options;

  const errors = [];
  const warnings = [];
  let binaryPath = null;
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
    binaryPath = findBinaryFn(command, env, {
      platform,
      excludedRoots: [options.projectPath || process.cwd()],
    });
    if (!binaryPath) {
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

  return { errors, warnings, notices, engine, resolution, binaryPath };
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
    inspectWslPartnerCommandFn = inspectWslPartnerCommand,
    resolveWslPartnerExecutableFn = resolveWslPartnerExecutable,
    resolveWslRouteDistroFn = resolveWslRouteDistro,
    projectPath = process.cwd(),
    pinnedWslRuntime = null,
  } = {}
) {
  const command = adapter.binary.default;
  const usesPinnedWslRuntime = pinnedWslRuntime !== null;
  let pinnedWslCommand = null;
  let pinnedWslRoute = null;
  if (usesPinnedWslRuntime) {
    pinnedWslCommand = pinnedWslRuntime?.partnerCommand;
    pinnedWslRoute = pinnedWslRuntime?.tmuxRoute;
    const pinnedDistro = String(pinnedWslRuntime?.tmuxDistro ?? "").trim();
    if (
      platform !== "win32" ||
      typeof pinnedWslCommand !== "string" ||
      !path.posix.isAbsolute(pinnedWslCommand) ||
      /[\u0000-\u001f\u007f]/u.test(pinnedWslCommand) ||
      pinnedWslRoute?.transport !== "wsl" ||
      !pinnedDistro ||
      String(pinnedWslRoute.distro ?? "").toLocaleLowerCase("en-US") !==
        pinnedDistro.toLocaleLowerCase("en-US")
    ) {
      throw new Error("Pinned WSL adapter status requires one absolute executable and distribution");
    }
  }
  // A frozen WSL runtime has already selected its Linux namespace and exact
  // executable. Do not let a simultaneously installed Windows CLI replace that
  // status simply because native PATH lookup happens first.
  const binaryPath = usesPinnedWslRuntime
    ? null
    : findBinaryFn(command, env, {
        platform,
        excludedRoots: [projectPath || process.cwd()],
      });
  let wslAvailable = false;
  let wslBinaryPath = null;
  let wslVersion = null;
  let route = null;

  if (usesPinnedWslRuntime) {
    route = pinnedWslRoute;
    wslBinaryPath = pinnedWslCommand;
    try {
      const inspection = await inspectWslPartnerCommandFn(
        pinnedWslCommand,
        adapter.binary.versionArgs,
        { env, platform, route }
      );
      wslAvailable = inspection?.availability === "available";
      wslVersion = wslAvailable ? inspection.version ?? null : null;
    } catch {
      wslAvailable = false;
      wslVersion = null;
    }
  }

  // Native Windows can host this MCP server while the selected interactive
  // partner lives only in WSL. Startup validates that exact command through
  // resolveRunnableEngine(); status must ask the same question instead of
  // declaring the adapter missing from the Windows PATH alone. The probe is
  // one bounded `--version` call and is skipped everywhere else.
  if (!usesPinnedWslRuntime && !binaryPath && platform === "win32") {
    try {
      route = tmuxRouteFn({ env, platform });
      if (
        route?.transport === "wsl" &&
        adapter.engines.allowed.includes("tmux-interactive")
      ) {
        route = await resolveWslRouteDistroFn(route);
        wslBinaryPath = await resolveWslPartnerExecutableFn(command, {
          projectPath: projectPath || process.cwd(),
          route,
        });
        wslAvailable =
          Boolean(wslBinaryPath) &&
          (await probeWslPartnerCommandFn(wslBinaryPath, adapter.binary.versionArgs, {
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
    binary_path: usesPinnedWslRuntime ? pinnedWslCommand : binaryPath,
    binary_transport: usesPinnedWslRuntime
      ? "wsl"
      : binaryPath
        ? "local"
        : wslAvailable
          ? "wsl"
          : null,
    wsl_distro: usesPinnedWslRuntime
      ? pinnedWslRuntime.tmuxDistro
      : wslAvailable
        ? (route?.distro ?? null)
        : null,
    version:
      probe && binaryPath
        ? await probeVersionFn(binaryPath, adapter.binary.versionArgs, 5000, {
            platform,
            env,
          })
        : probe && usesPinnedWslRuntime
          ? wslVersion
          : undefined,
    install_hint: adapter.binary.installHint ?? null,
    sources: adapter.__sources,
  };
}
