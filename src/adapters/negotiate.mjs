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
import { resolveContext } from "./argv.mjs";

/** Is `command` runnable -- an executable path, or a name on PATH? */
export function findBinary(command, env = process.env) {
  if (!command) return null;
  if (command.includes(path.sep)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return path.resolve(command);
    } catch {
      return null;
    }
  }
  const exts = process.platform === "win32" ? (env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Best-effort version probe; never throws, never blocks for long. */
export function probeVersion(binaryPath, versionArgs, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      versionArgs,
      { timeout: timeoutMs, encoding: "utf-8", windowsHide: true },
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
export async function describeAdapter(adapter, { probe = false, env = process.env } = {}) {
  const command = adapter.binary.default;
  const binaryPath = findBinary(command, env);
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
    binary_available: Boolean(binaryPath),
    binary_path: binaryPath,
    version:
      probe && binaryPath
        ? await probeVersion(binaryPath, adapter.binary.versionArgs)
        : undefined,
    install_hint: adapter.binary.installHint ?? null,
    sources: adapter.__sources,
  };
}
