import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  resolveWindowsSystem32Executable,
  terminateWindowsProcessTree,
} from "../src/windows-process-tree.mjs";

const NPM_INSTALL_ARGS = Object.freeze(["install", "--silent"]);
const CMD_NPM_INSTALL = "npm.cmd install --silent";
const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

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
 * Build an npm-install invocation without asking raw child_process.spawn() to
 * execute a Windows .cmd shim.
 *
 * The preferred Windows route runs npm-cli.js with the already-running Node
 * executable, keeping paths with spaces or shell metacharacters as argv values.
 * If npm's JS entrypoint cannot be located, the fallback uses the validated
 * System32 cmd.exe with a constant command string: no repository path,
 * executable path, or environment value is interpolated into shell syntax.
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

  // A trusted SystemRoot is required even for the preferred direct Node route:
  // timeout handling must be able to resolve taskkill.exe without PATH or
  // inherited executable aliases before any npm lifecycle process starts.
  const systemCmd = resolveWindowsSystem32Executable("cmd.exe", { env });
  if (!systemCmd) {
    throw new Error(
      "SystemRoot did not resolve to a trusted top-level Windows System32 directory for cmd.exe"
    );
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

  return {
    command: systemCmd,
    args: ["/d", "/s", "/c", CMD_NPM_INSTALL],
    route: "system32-cmd",
  };
}

function timeoutError(invocation, timeoutMs, termination = null) {
  const error = Object.assign(
    new Error(
      `npm install timed out via ${invocation.route} after ${timeoutMs}ms${
        termination === null || termination?.status === "succeeded"
          ? ""
          : `; ${termination?.reason || "process termination failed"}`
      }`
    ),
    { code: "ETIMEDOUT" }
  );
  if (termination) error.windowsTreeTermination = termination;
  return error;
}

function windowsBootstrapEnvironment(env) {
  const trustedCmd = resolveWindowsSystem32Executable("cmd.exe", { env });
  if (!trustedCmd) {
    throw new Error(
      "SystemRoot did not resolve to a trusted top-level Windows System32 directory for cmd.exe"
    );
  }

  // Windows environment names are case-insensitive even though JavaScript
  // objects are not. Remove every spelling before installing one canonical,
  // trusted value so npm lifecycle children cannot inherit an attacker-chosen
  // cmd.exe through a duplicate ComSpec/COMSPEC variant.
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toLowerCase() !== "comspec")
  );
  childEnv.ComSpec = trustedCmd;
  return childEnv;
}

/**
 * Run the fresh-install npm bootstrap with live Windows supervision.
 *
 * This is intentionally asynchronous. spawnSync's timeout can kill its direct
 * child, but it never exposes the live pid needed for taskkill /T, so a Windows
 * lifecycle script could outlive the installer. Keeping the ChildProcess
 * reference lets the Windows timeout terminate the complete wrapper tree
 * before streams are detached and the promise settles. POSIX intentionally
 * remains unbounded: killing only npm there could orphan lifecycle descendants,
 * while the previous synchronous implementation waited for natural completion.
 */
export async function runNpmInstallBootstrap({
  cwd,
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  existsSync = fs.existsSync,
  spawnFn = spawn,
  terminateTreeFn = terminateWindowsProcessTree,
  timeoutMs = DEFAULT_NPM_INSTALL_TIMEOUT_MS,
} = {}) {
  if (
    platform === "win32" &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new TypeError("npm install timeoutMs must be a positive safe integer");
  }

  const invocation = resolveNpmInstallInvocation({
    platform,
    execPath,
    env,
    existsSync,
  });
  const childEnv =
    platform === "win32" ? windowsBootstrapEnvironment(env) : env;
  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(invocation.command, invocation.args, {
        cwd,
        env: childEnv,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolve({ status: null, signal: null, error });
      return;
    }

    let settled = false;
    let timer;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const detach = () => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try {
          stream?.destroy?.();
        } catch {}
      }
      try {
        child.unref?.();
      } catch {}
    };

    child.once("error", (error) => finish({ status: null, signal: null, error }));
    child.once("close", (status, signal) =>
      finish({
        status: Number.isInteger(status) ? status : null,
        signal: typeof signal === "string" ? signal : null,
        error: null,
      })
    );
    if (platform === "win32") {
      timer = setTimeout(() => {
        if (settled) return;
        let termination;
        try {
          termination = terminateTreeFn(child.pid, { env: childEnv });
        } catch (error) {
          termination = {
            status: "failed",
            attempted: false,
            reason: error?.message || "Windows process-tree termination failed",
          };
        }
        // taskkill must walk the tree while the direct wrapper and its pid are
        // still live. Only detach local handles after that synchronous attempt.
        detach();
        finish({
          status: null,
          signal: null,
          error: timeoutError(invocation, timeoutMs, termination),
        });
      }, timeoutMs);
    }
  });

  if (result?.error) {
    if (result.error.code === "ETIMEDOUT") throw result.error;
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
