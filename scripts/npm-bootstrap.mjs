import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const NPM_INSTALL_ARGS = Object.freeze(["install", "--silent"]);
const CMD_NPM_INSTALL = "npm.cmd install --silent";

function windowsNpmCliCandidates({ execPath, env }) {
  const candidates = [
    path.win32.join(
      path.win32.dirname(execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    ),
  ];

  // `npm run` supplies the exact CLI entrypoint it used. This covers version
  // managers whose node.exe is a shim rather than a directory containing npm.
  // Accept only npm's CLI filename; a yarn/pnpm `npm_execpath` must not silently
  // turn `npm install` into a different package-manager operation.
  const npmExecPath = env.npm_execpath ?? env.NPM_EXECPATH;
  if (
    typeof npmExecPath === "string" &&
    path.win32.isAbsolute(npmExecPath) &&
    /^npm-cli\.(?:c?js)$/iu.test(path.win32.basename(npmExecPath))
  ) {
    candidates.push(path.win32.normalize(npmExecPath));
  }

  return [...new Set(candidates)];
}

/**
 * Build an npm-install invocation without asking raw child_process.spawnSync()
 * to execute a Windows .cmd shim.
 *
 * The preferred Windows route runs npm-cli.js with the already-running Node
 * executable, keeping paths with spaces or shell metacharacters as argv values.
 * If npm's JS entrypoint cannot be located, the fallback uses ComSpec with a
 * constant command string: no repository path, executable path, or environment
 * value is interpolated into shell syntax.
 */
export function resolveNpmInstallInvocation({
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== "win32") {
    return {
      command: "npm",
      args: [...NPM_INSTALL_ARGS],
      route: "path",
    };
  }

  const npmCli = windowsNpmCliCandidates({ execPath, env }).find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (npmCli) {
    return {
      command: execPath,
      args: [npmCli, ...NPM_INSTALL_ARGS],
      route: "npm-cli-js",
    };
  }

  const command = env.ComSpec || env.COMSPEC || "cmd.exe";
  return {
    command,
    args: ["/d", "/s", "/c", CMD_NPM_INSTALL],
    route: "comspec",
  };
}

export function runNpmInstallBootstrap({
  cwd,
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  existsSync = fs.existsSync,
  spawnSyncFn = spawnSync,
} = {}) {
  const invocation = resolveNpmInstallInvocation({
    platform,
    execPath,
    env,
    existsSync,
  });
  const result = spawnSyncFn(invocation.command, invocation.args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });

  if (result?.error) {
    throw new Error(
      `npm install could not start via ${invocation.route}: ${result.error.message}`,
      { cause: result.error }
    );
  }
  if (result?.status !== 0) {
    const outcome = result?.signal
      ? `signal ${result.signal}`
      : `exit ${result?.status ?? "unknown"}`;
    throw new Error(`npm install failed via ${invocation.route} with ${outcome}`);
  }

  return invocation;
}
