import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  resolveWindowsSystem32Executable,
  terminateWindowsProcessTree,
} from "../src/windows-process-tree.mjs";
import {
  DEFAULT_WSL_LOGIN_SHELL,
  assertSafeWslLauncher,
  normalizeWslLoginShell,
  wslLoginShellArgs,
  wslLoginShellProbeArgs,
} from "../src/wsl-shell.mjs";

const MCP_SERVER_NAMES = Object.freeze(["dualog", "codex-dialog"]);
const WSL_BINARY_ENV = Object.freeze([
  "DUALOG_WSL_BINARY",
  "CODEX_DIALOG_WSL_BINARY",
  "CONDUCTOR_WSL_BINARY",
]);
const WSL_DISTRO_ENV = Object.freeze([
  "DUALOG_WSL_DISTRO",
  "CODEX_DIALOG_WSL_DISTRO",
  "CONDUCTOR_WSL_DISTRO",
]);

function firstConfigured(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return null;
}

function isDefaultWslLauncher(value) {
  return String(value).trim().toLowerCase() === "wsl.exe";
}

function exactWslBinary(
  value,
  { platform = process.platform, env = process.env } = {}
) {
  const candidate = String(value ?? "wsl.exe").trim();
  if (platform !== "win32") return candidate;
  if (isDefaultWslLauncher(candidate)) {
    const resolved = resolveWindowsSystem32Executable("wsl.exe", { env });
    if (!resolved) {
      throw new Error(
        "SystemRoot did not resolve to a trusted top-level Windows System32 directory for wsl.exe"
      );
    }
    return resolved;
  }
  return assertSafeWslLauncher(candidate, { platform });
}

function exactWindowsCommandEnvironment(env) {
  const cmd = resolveWindowsSystem32Executable("cmd.exe", { env });
  if (!cmd) {
    throw new Error(
      "SystemRoot did not resolve to a trusted top-level Windows System32 directory for cmd.exe"
    );
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (key.toLocaleLowerCase("en-US") !== "comspec") sanitized[key] = value;
  }
  sanitized.ComSpec = cmd;
  return sanitized;
}

function spawnWithExactAmbientComSpec(spawnFn, command, args, options) {
  const trustedComSpec = options?.env?.ComSpec;
  if (!trustedComSpec) return spawnFn(command, args, options);

  // cross-spawn resolves an extensionless command before it creates the child.
  // When that resolution lands on a .cmd shim, its parser reads the parent
  // process's lowercase `comspec` instead of the child options environment.
  // Keep that synchronous parser boundary exact too, then restore the parent
  // immediately; JavaScript cannot interleave another probe before spawnFn
  // returns its ChildProcess.
  const previous = Object.entries(process.env).filter(
    ([key]) => key.toLocaleLowerCase("en-US") === "comspec"
  );
  for (const [key] of previous) delete process.env[key];
  process.env.comspec = trustedComSpec;
  try {
    return spawnFn(command, args, options);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.toLocaleLowerCase("en-US") === "comspec") delete process.env[key];
    }
    for (const [key, value] of previous) process.env[key] = value;
  }
}

function assertResolvableConfigParent(filePath) {
  let cursor = path.dirname(path.resolve(filePath));
  while (true) {
    let entry;
    try {
      entry = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        cursor = parent;
        continue;
      }
      throw new Error(
        `Refusing to write config ${filePath}: a parent component is not a directory`,
        { cause: error }
      );
    }

    let realParent;
    try {
      realParent = fs.realpathSync(cursor);
    } catch (error) {
      throw new Error(
        `Refusing to write config ${filePath}: parent ${cursor} is a dangling or unresolvable symbolic link`,
        { cause: error }
      );
    }
    const realEntry = fs.lstatSync(realParent);
    if (!realEntry.isDirectory()) {
      throw new Error(
        `Refusing to write config ${filePath}: parent ${cursor} does not resolve to a directory`
      );
    }
    // realpathSync validated every existing component leading to this nearest
    // ancestor. Any missing descendants may now be created safely later.
    return;
  }
}

/**
 * Resolve the file an atomic config write must replace. A valid final symlink
 * is intentional user configuration on macOS/Linux, so preserve the symlink
 * and replace its real target. A dangling link has no unambiguous target, and
 * replacing one name of a hard-linked file would silently split the aliases.
 */
export function assertSafeConfigWriteTarget(filePath) {
  let entry;
  try {
    entry = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      assertResolvableConfigParent(filePath);
      return null;
    }
    if (error?.code === "ENOTDIR") {
      throw new Error(
        `Refusing to write config ${filePath}: a parent component is not a directory`,
        { cause: error }
      );
    }
    throw error;
  }

  let targetPath;
  try {
    targetPath = fs.realpathSync(filePath);
  } catch (error) {
    if (entry.isSymbolicLink() && error?.code === "ENOENT") {
      throw new Error(
        `Refusing to replace dangling symbolic link config ${filePath}; restore or remove its target first`,
        { cause: error }
      );
    }
    throw error;
  }
  const target = fs.lstatSync(targetPath);
  if (!target.isFile()) {
    throw new Error(
      `Refusing to replace config ${filePath}: resolved target ${targetPath} is not a regular file`
    );
  }
  if (target.nlink > 1) {
    throw new Error(
      `Refusing to replace multiply linked config ${filePath}; an atomic rename would split its hard links`
    );
  }
  return { entry, target, targetPath };
}

/** Resolve the Codex user config root exactly once for installers and uninstallers. */
export function resolveCodexPaths({ env = process.env, home = os.homedir() } = {}) {
  const configured = firstConfigured(env, ["CODEX_HOME"]);
  const root = configured ? path.resolve(configured) : path.join(home, ".codex");
  return {
    root,
    config: path.join(root, "config.toml"),
    skills: path.join(root, "skills"),
  };
}

/** Read a JSON object without ever treating malformed existing data as an empty config. */
export function readJsonConfig(filePath) {
  const target = assertSafeConfigWriteTarget(filePath);
  if (!target) return {};

  const raw = fs.readFileSync(target.targetPath, "utf-8").replace(/^\uFEFF/, "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Refusing to overwrite malformed JSON config ${filePath}: ${err.message}`,
      { cause: err }
    );
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(
      `Refusing to overwrite JSON config ${filePath}: expected a top-level object`
    );
  }
  return parsed;
}

/**
 * Replace a file through a temporary sibling so a crash cannot leave a partial
 * JSON or TOML document behind. A sibling is required: rename is only atomic
 * when source and destination are on the same filesystem.
 */
export function atomicWriteFile(filePath, content) {
  let existingTarget = assertSafeConfigWriteTarget(filePath);
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });

  // If the file does not exist, resolve its parent after mkdir so writes
  // through a directory symlink still place the temp file beside the real
  // destination and preserve that parent symlink.
  if (!existingTarget) existingTarget = assertSafeConfigWriteTarget(filePath);
  const targetPath =
    existingTarget?.targetPath ??
    path.join(fs.realpathSync(parent), path.basename(filePath));
  const targetParent = path.dirname(targetPath);
  const mode = existingTarget ? existingTarget.target.mode & 0o777 : 0o600;

  const tempPath = path.join(
    targetParent,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", mode);
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {}
    throw err;
  }
}

export function writeJsonConfig(filePath, config) {
  atomicWriteFile(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

export function persistedWslEnv(
  cliStatus,
  { platform = process.platform, env: hostEnv = process.env } = {}
) {
  if (platform !== "win32") return {};
  const env = {};
  if (cliStatus?.wsl?.distroAvailable && cliStatus.wsl.distro) {
    env.DUALOG_WSL_DISTRO = cliStatus.wsl.distro;
  }
  if (
    cliStatus?.wsl?.binaryAvailable &&
    cliStatus.wsl.distroAvailable &&
    cliStatus.wsl.binary
  ) {
    try {
      const binary = exactWslBinary(cliStatus.wsl.binary, {
        platform,
        env: hostEnv,
      });
      env.DUALOG_WSL_BINARY = binary;
    } catch {
      // Never emit a route that Desktop cannot reproduce. The explicit
      // installer preflight reports the actionable error before mutation.
    }
  }
  return env;
}

/**
 * Fail closed when a native-Windows caller explicitly selected a WSL route.
 *
 * A best-effort/default WSL probe may warn and leave the native registration
 * unpinned, but an explicit selection is a user constraint. Silently dropping
 * it would let a later Desktop launch route through a different default distro
 * or binary.
 */
export function validateExplicitWslSelection(
  mode,
  cliStatus,
  { platform = process.platform } = {}
) {
  if (platform !== "win32") return;

  const requestedBinary = mode?.wslBinary?.trim?.() || null;
  const requestedDistro = mode?.wslDistro?.trim?.() || null;
  const wsl = cliStatus?.wsl;

  if (requestedBinary && !wsl?.binaryAvailable) {
    throw new Error(
      `Requested WSL binary ${JSON.stringify(requestedBinary)} could not be launched. ` +
        "Check -WslBinary/--wsl-binary and try again; no native MCP registration was written."
    );
  }
  if (requestedDistro && !wsl?.distroAvailable) {
    throw new Error(
      `Requested WSL distribution ${JSON.stringify(requestedDistro)} is unavailable through ` +
        `${JSON.stringify(wsl?.binary ?? requestedBinary ?? "wsl.exe")}. ` +
        "Check -Distro/--wsl-distro and try again; no native MCP registration was written."
    );
  }
  if (requestedBinary && !requestedDistro && !wsl?.distroAvailable) {
    throw new Error(
      `Requested WSL binary ${JSON.stringify(requestedBinary)} could not execute its default WSL distribution. ` +
        "Check that the default distribution is installed and runnable, or pass -Distro/--wsl-distro; " +
        "no native MCP registration was written."
    );
  }
}

/** Resolve CLI and documented environment route overrides as hard constraints. */
export function effectiveExplicitWslSelection(
  mode = {},
  { env = process.env } = {}
) {
  return {
    ...mode,
    wslBinary: mode.wslBinary || firstConfigured(env, WSL_BINARY_ENV),
    wslDistro: mode.wslDistro || firstConfigured(env, WSL_DISTRO_ENV),
  };
}

const WINDOWS_CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCmdCommand(value) {
  return String(value).replace(WINDOWS_CMD_META, "^$1");
}

function escapeWindowsCmdArgument(value, doubleEscapeMetaChars) {
  let escaped = String(value)
    .replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"")
    .replace(/(?=(\\+?)?)\1$/g, "$1$1");
  escaped = `"${escaped}"`.replace(WINDOWS_CMD_META, "^$1");
  return doubleEscapeMetaChars
    ? escaped.replace(WINDOWS_CMD_META, "^$1")
    : escaped;
}

/** Dependency-free, argv-escaped `.cmd`/`.bat` launching before bootstrap. */
export function prepareWindowsCommandInvocation(
  command,
  args,
  options,
  { platform = process.platform } = {}
) {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
    return { command, args, options };
  }
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu.test(command);
  const shellCommand = [
    escapeWindowsCmdCommand(command),
    ...args.map((arg) => escapeWindowsCmdArgument(arg, doubleEscape)),
  ].join(" ");
  const env = exactWindowsCommandEnvironment(options.env ?? process.env);
  return {
    command: env.ComSpec,
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    options: { ...options, env, windowsVerbatimArguments: true },
  };
}

/** Run one bounded probe while its exact wrapper PID is still supervised. */
export function runInstallProbe(
  command,
  args,
  options = {},
  {
    platform = process.platform,
    spawnFn = spawn,
    terminateTreeFn = terminateWindowsProcessTree,
  } = {}
) {
  const timeoutMs =
    Number.isSafeInteger(options.timeout) && options.timeout > 0
      ? options.timeout
      : 10000;
  const maxBuffer =
    Number.isSafeInteger(options.maxBuffer) && options.maxBuffer > 0
      ? options.maxBuffer
      : 1024 * 1024;
  return new Promise((resolve) => {
    let child;
    try {
      const spawnOptions = {
        cwd: options.cwd,
        env:
          platform === "win32"
            ? exactWindowsCommandEnvironment(options.env ?? process.env)
            : options.env,
        windowsHide: options.windowsHide,
        stdio: options.stdio,
      };
      const invocation = prepareWindowsCommandInvocation(
        command,
        args,
        spawnOptions,
        { platform }
      );
      child =
        platform === "win32"
          ? spawnWithExactAmbientComSpec(
              spawnFn,
              invocation.command,
              invocation.args,
              invocation.options
            )
          : spawnFn(invocation.command, invocation.args, invocation.options);
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error, pid: null });
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer = null;
    const text = (chunks) => Buffer.concat(chunks).toString("utf-8");
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: null,
        stdout: text(stdout),
        stderr: text(stderr),
        pid: child.pid ?? null,
        ...result,
      });
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
    const terminateLiveProbe = (code, message) => {
      if (settled) return;
      const error = Object.assign(new Error(message), { code });
      let windowsTreeTermination = null;
      if (platform === "win32") {
        // This call occurs before detaching or resolving, while child.pid is
        // still the live cmd.exe/.cmd wrapper and taskkill can walk its tree.
        windowsTreeTermination = terminateTreeFn(child.pid);
      } else {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      detach();
      finish({ error, windowsTreeTermination });
    };
    const collect = (chunks, chunk, currentBytes, streamName) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const available = Math.max(0, maxBuffer - currentBytes);
      if (available > 0) chunks.push(bytes.subarray(0, available));
      if (bytes.length > available) {
        terminateLiveProbe(
          "ENOBUFS",
          `${command} ${streamName} exceeded the ${maxBuffer}-byte probe limit`
        );
      }
      return currentBytes + Math.min(bytes.length, available);
    };

    child.stdout?.on("data", (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes, "stdout");
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes, "stderr");
    });
    child.once("error", (error) => finish({ error }));
    child.once("close", (status, signal) =>
      finish({ status: Number.isInteger(status) ? status : null, signal })
    );
    timer = setTimeout(
      () => terminateLiveProbe("ETIMEDOUT", `${command} probe timed out after ${timeoutMs}ms`),
      timeoutMs
    );
  });
}

/**
 * Validate an explicit WSL route before dependency installation, legacy
 * migration, or any other user-home mutation. This intentionally uses Node's
 * built-in async spawn with live supervision because cross-spawn may not exist
 * on a fresh clone.
 */
export async function preflightExplicitWslSelection(
  mode,
  {
    platform = process.platform,
    env = process.env,
    cwd = process.cwd(),
    runProbe = null,
    spawnFn = spawn,
    terminateTreeFn = terminateWindowsProcessTree,
  } = {}
) {
  const explicit = effectiveExplicitWslSelection(mode, { env });
  if (platform !== "win32" || (!explicit.wslBinary && !explicit.wslDistro)) {
    return null;
  }

  const route = {
    binary: exactWslBinary(explicit.wslBinary || "wsl.exe", {
      platform,
      env,
    }),
    distro: explicit.wslDistro || null,
  };
  const supervisedRun =
    runProbe ??
    ((command, args, options) =>
      runInstallProbe(command, args, options, {
        platform,
        spawnFn,
        terminateTreeFn,
      }));
  const binaryProbe = await invoke(supervisedRun, route.binary, ["--status"], { cwd });
  const binaryAvailable = executableStarted(binaryProbe);
  const distroProbe = binaryAvailable
    ? await invoke(supervisedRun, route.binary, wslArgs(["true"], { route }), { cwd })
    : null;
  const status = {
    platform,
    host: { claude: false, codex: false, tmux: false },
    wsl: {
      ...route,
      requestedDistro: route.distro,
      binaryAvailable,
      distroAvailable: succeeded(distroProbe),
    },
  };
  validateExplicitWslSelection(explicit, status, { platform });
  return status;
}

/** Build the Claude/Desktop registration without reading or writing a user home. */
export function buildClaudeMcpRegistration({
  serverPath,
  nodePath = process.execPath,
  cliStatus = null,
  platform = process.platform,
}) {
  const env = persistedWslEnv(cliStatus, { platform });
  return {
    command: nodePath,
    args: [serverPath],
    ...(Object.keys(env).length ? { env } : {}),
  };
}

function splitLinesWithEndings(content) {
  if (!content) return [];
  const lines = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (match[0] === "") break;
    lines.push({ body: match[1], ending: match[2] });
  }
  return lines;
}

function unquoteTomlKey(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1);
    let decoded = "";
    for (let cursor = 0; cursor < inner.length; cursor++) {
      const character = inner[cursor];
      if (character !== "\\") {
        decoded += character;
        continue;
      }
      const escape = inner[++cursor];
      const simple = {
        b: "\b",
        t: "\t",
        n: "\n",
        f: "\f",
        r: "\r",
        '"': '"',
        "\\": "\\",
      }[escape];
      if (simple !== undefined) {
        decoded += simple;
        continue;
      }
      if (escape !== "u" && escape !== "U") return null;
      const width = escape === "u" ? 4 : 8;
      const hex = inner.slice(cursor + 1, cursor + 1 + width);
      if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) return null;
      const codePoint = Number.parseInt(hex, 16);
      if (
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return null;
      }
      decoded += String.fromCodePoint(codePoint);
      cursor += width;
    }
    return decoded;
  }
  return trimmed;
}

function parseTomlTableHeader(line) {
  let cursor = 0;
  while (/\s/.test(line[cursor] ?? "")) cursor++;
  if (line[cursor] !== "[") return null;
  const arrayTable = line[cursor + 1] === "[";
  cursor += arrayTable ? 2 : 1;
  const pathStart = cursor;
  let quote = null;

  while (cursor < line.length) {
    const character = line[cursor];
    if (quote === '"') {
      if (character === '"' && !isEscapedTomlBasicDelimiter(line, cursor)) {
        quote = null;
      }
      cursor++;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      cursor++;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor++;
      continue;
    }
    if (character !== "]") {
      cursor++;
      continue;
    }
    if (arrayTable && line[cursor + 1] !== "]") return null;
    const path = line.slice(pathStart, cursor).trim();
    cursor += arrayTable ? 2 : 1;
    const remainder = line.slice(cursor);
    if (!path || !/^\s*(?:#.*)?$/.test(remainder)) return null;
    return { path, arrayTable };
  }
  return null;
}

function mcpServerHeaderInfo(line) {
  const header = parseTomlTableHeader(line);
  if (!header) return null;
  const headerPath = header.path;

  // Server names and subtable segments may be bare, basic quoted, or literal
  // quoted. Parse the complete suffix so route recovery can distinguish the
  // root table from its `.env` subtable without matching arbitrary prose.
  const dotted = headerPath.match(
    /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))\s*\.\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))(.*)$/
  );
  if (!dotted || unquoteTomlKey(dotted[1]) !== "mcp_servers") return null;
  const serverName = unquoteTomlKey(dotted[2]);
  if (serverName === null) return null;
  const subtables = [];
  let rest = dotted[3].trim();
  while (rest) {
    const suffix = rest.match(
      /^\.\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))(.*)$/
    );
    if (!suffix) return null;
    const subtable = unquoteTomlKey(suffix[1]);
    if (subtable === null) return null;
    subtables.push(subtable);
    rest = suffix[2].trim();
  }
  return {
    serverName,
    subtables,
  };
}

function mcpServerNameFromHeader(line) {
  return mcpServerHeaderInfo(line)?.serverName ?? null;
}

function isTomlTableHeader(line) {
  return parseTomlTableHeader(line) !== null;
}

function isEscapedTomlBasicDelimiter(line, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function tomlStructuralStateAfterLine(line, initialState) {
  const state = {
    ...initialState,
    encounteredMultilineDelimiter: false,
  };
  let cursor = 0;

  while (cursor < line.length) {
    if (state.multilineDelimiter) {
      const closing = line.indexOf(state.multilineDelimiter, cursor);
      if (closing === -1) return state;
      if (
        state.multilineDelimiter === '"""' &&
        isEscapedTomlBasicDelimiter(line, closing)
      ) {
        // The first quote may be escaped while an overlapping run beginning at
        // the next quote is the real closing delimiter (`\\""""`). Advance
        // one byte so that valid TOML close is still observed.
        cursor = closing + 1;
        continue;
      }
      state.multilineDelimiter = null;
      cursor = closing + 3;
      continue;
    }

    const character = line[cursor];
    if (character === "#") break;

    if (character === '"') {
      if (line.startsWith('"""', cursor)) {
        state.encounteredMultilineDelimiter = true;
        state.multilineDelimiter = '"""';
        cursor += 3;
        continue;
      }
      cursor++;
      while (cursor < line.length) {
        if (line[cursor] === '"' && !isEscapedTomlBasicDelimiter(line, cursor)) {
          cursor++;
          break;
        }
        cursor++;
      }
      continue;
    }

    if (character === "'") {
      if (line.startsWith("'''", cursor)) {
        state.encounteredMultilineDelimiter = true;
        state.multilineDelimiter = "'''";
        cursor += 3;
        continue;
      }
      const closing = line.indexOf("'", cursor + 1);
      cursor = closing === -1 ? line.length : closing + 1;
      continue;
    }

    if (character === "[") state.arrayDepth++;
    else if (character === "]") state.arrayDepth = Math.max(0, state.arrayDepth - 1);
    else if (character === "{") state.inlineTableDepth++;
    else if (character === "}") {
      state.inlineTableDepth = Math.max(0, state.inlineTableDepth - 1);
    }

    cursor++;
  }

  return state;
}

function tomlLinesWithContext(content) {
  const contexts = [];
  let state = {
    multilineDelimiter: null,
    arrayDepth: 0,
    inlineTableDepth: 0,
  };
  for (const line of splitLinesWithEndings(content)) {
    const beganInsideMultiline = state.multilineDelimiter !== null;
    const beganInsideCollection =
      state.arrayDepth > 0 || state.inlineTableDepth > 0;
    const isTopLevelTableHeader =
      !beganInsideMultiline &&
      !beganInsideCollection &&
      isTomlTableHeader(line.body);
    if (!isTopLevelTableHeader) {
      state = tomlStructuralStateAfterLine(line.body, state);
    } else {
      state = { ...state, encounteredMultilineDelimiter: false };
    }
    contexts.push({
      ...line,
      beganInsideMultiline,
      beganInsideCollection,
      isTopLevelTableHeader,
      touchesMultiline:
        beganInsideMultiline ||
        state.multilineDelimiter !== null ||
        state.encounteredMultilineDelimiter,
    });
  }
  return contexts;
}

/** Remove current and pre-rename MCP tables, including quoted names and subtables. */
export function removeMcpServerSections(content, names = MCP_SERVER_NAMES) {
  const targets = new Set(names);
  const kept = [];
  let skipping = false;

  for (const line of tomlLinesWithContext(content)) {
    if (line.isTopLevelTableHeader) {
      const serverName = mcpServerNameFromHeader(line.body);
      if (serverName && targets.has(serverName)) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) kept.push(line.body + line.ending);
  }
  return kept.join("");
}

export function newlineFor(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function trimTrailingWhitespaceAndNewlines(content) {
  return content.replace(/[\t ]*(?:\r\n|\n|\r)*$/, "");
}

/** Replace any dualog/legacy spelling with one canonical dualog table. */
export function replaceMcpServerSection(
  content,
  { serverPath, nodePath = process.execPath, env = {} }
) {
  const newline = newlineFor(content);
  const stripped = trimTrailingWhitespaceAndNewlines(
    removeMcpServerSections(content, MCP_SERVER_NAMES)
  );
  const section = [
    "[mcp_servers.dualog]",
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(serverPath)}]`,
    ...(Object.keys(env).length
      ? [
          `env = { ${Object.entries(env)
            .map(([key, value]) => `${key} = ${JSON.stringify(String(value))}`)
            .join(", ")} }`,
        ]
      : []),
    "",
  ].join(newline);
  return `${stripped ? `${stripped}${newline}${newline}` : ""}${section}`;
}

/** Remove owned MCP tables and leave a conventional final newline when non-empty. */
export function removeMcpServerConfig(content, names = MCP_SERVER_NAMES) {
  const newline = newlineFor(content);
  const removed = removeMcpServerSections(content, names);
  if (removed === content) return content;
  const stripped = trimTrailingWhitespaceAndNewlines(removed);
  return stripped ? `${stripped}${newline}` : "";
}

function decodeSimpleTomlString(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^("(?:[^"\\]|\\.)*")/);
    if (!match) return null;
    return unquoteTomlKey(match[1]);
  }
  const literal = trimmed.match(/^'([^']*)'/);
  return literal ? literal[1] : null;
}

function parseSimpleTomlAssignment(line) {
  const assignment = line.match(
    /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))\s*=\s*(.*)$/
  );
  if (!assignment) return null;
  const key = unquoteTomlKey(assignment[1]);
  return key === null ? null : { key, value: assignment[2] };
}

function inlineTomlTableBodyForKey(line, key) {
  const assignment = parseSimpleTomlAssignment(line);
  if (assignment?.key !== key) return null;
  const value = assignment.value.trimStart();
  if (!value.startsWith("{")) return null;

  const start = 1;
  let braceDepth = 1;
  let quote = null;
  for (let cursor = start; cursor < value.length; cursor++) {
    const character = value[cursor];
    if (quote === '"') {
      if (character === '"' && !isEscapedTomlBasicDelimiter(value, cursor)) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return null;
    if (character === "{") braceDepth++;
    else if (character === "}") {
      braceDepth--;
      if (braceDepth === 0) {
        const remainder = value.slice(cursor + 1);
        if (!/^\s*(?:#.*)?$/.test(remainder)) return null;
        return value.slice(start, cursor);
      }
    }
  }
  return null;
}

function splitTomlInlineEntries(body) {
  const entries = [];
  let start = 0;
  let quote = null;
  let arrayDepth = 0;
  let tableDepth = 0;
  let end = body.length;

  for (let cursor = 0; cursor < body.length; cursor++) {
    const character = body[cursor];
    if (quote === '"') {
      if (character === '"' && !isEscapedTomlBasicDelimiter(body, cursor)) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      end = cursor;
      break;
    }
    if (character === "[") arrayDepth++;
    else if (character === "]") arrayDepth = Math.max(0, arrayDepth - 1);
    else if (character === "{") tableDepth++;
    else if (character === "}") tableDepth = Math.max(0, tableDepth - 1);
    else if (character === "," && arrayDepth === 0 && tableDepth === 0) {
      entries.push(body.slice(start, cursor));
      start = cursor + 1;
    }
  }
  entries.push(body.slice(start, end));
  return entries;
}

function simpleTomlAssignmentValue(line, key) {
  const assignment = parseSimpleTomlAssignment(line);
  return assignment?.key === key
    ? decodeSimpleTomlString(assignment.value)
    : null;
}

function findCodexMcpEnvValue(codexToml, key) {
  let dualogSubtables = null;
  for (const line of tomlLinesWithContext(codexToml)) {
    if (line.isTopLevelTableHeader) {
      const header = mcpServerHeaderInfo(line.body);
      dualogSubtables =
        header?.serverName === "dualog" ? header.subtables : null;
      continue;
    }
    // Persisted routing is emitted as an ordinary basic string. Conservatively
    // ignore multiline/collection content so examples, comments, and nested
    // arrays cannot be mistaken for an installed route.
    if (
      dualogSubtables === null ||
      line.beganInsideMultiline ||
      line.beganInsideCollection ||
      line.touchesMultiline
    ) {
      continue;
    }

    let decoded = null;
    if (dualogSubtables.length === 0) {
      const envBody = inlineTomlTableBodyForKey(line.body, "env");
      if (envBody !== null) {
        for (const entry of splitTomlInlineEntries(envBody)) {
          decoded = simpleTomlAssignmentValue(entry, key);
          if (decoded !== null) break;
        }
      }
    } else if (
      dualogSubtables.length === 1 &&
      dualogSubtables[0] === "env"
    ) {
      decoded = simpleTomlAssignmentValue(line.body, key);
    }
    if (decoded?.trim()) return decoded.trim();
  }
  return null;
}

function hasCodexMcpRegistration(codexToml) {
  return tomlLinesWithContext(codexToml).some(
    (line) =>
      line.isTopLevelTableHeader &&
      mcpServerNameFromHeader(line.body) === "dualog"
  );
}

/** Recover each native host's independently pinned WSL route. */
export function findPersistedWslRegistrations({
  claudeConfig = null,
  codexToml = "",
} = {}) {
  const claudeEnv = claudeConfig?.mcpServers?.dualog?.env ?? {};
  const clean = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    claude: {
      distro: clean(claudeEnv.DUALOG_WSL_DISTRO),
      binary: clean(claudeEnv.DUALOG_WSL_BINARY),
    },
    codex: {
      distro: findCodexMcpEnvValue(codexToml, "DUALOG_WSL_DISTRO"),
      binary: findCodexMcpEnvValue(codexToml, "DUALOG_WSL_BINARY"),
    },
  };
}

/** Recover the preferred native WSL route pinned in Claude and/or Codex. */
export function findPersistedWslSettings(options = {}) {
  const registrations = findPersistedWslRegistrations(options);
  const value = (key) => {
    const field = key === "DUALOG_WSL_DISTRO" ? "distro" : "binary";
    return registrations.claude[field] ?? registrations.codex[field];
  };
  return {
    distro: value("DUALOG_WSL_DISTRO"),
    binary: value("DUALOG_WSL_BINARY"),
  };
}

/**
 * Plan nested WSL removals without losing a host whose route differs.
 * Matching routes coalesce into one `--both` run; divergent Claude and Codex
 * pins remain separate scoped runs so neither registration is orphaned.
 */
export function planWslUninstallTargets({
  removeClaude = true,
  removeCodex = true,
  explicitRoute = null,
  claudeConfig = null,
  codexToml = "",
} = {}) {
  const registrations = findPersistedWslRegistrations({ claudeConfig, codexToml });
  const candidates = [];
  const claudePresent = Object.prototype.hasOwnProperty.call(
    claudeConfig?.mcpServers ?? {},
    "dualog"
  );
  const codexPresent = hasCodexMcpRegistration(codexToml);
  if (removeClaude && claudePresent) {
    candidates.push({ route: registrations.claude, removeClaude: true, removeCodex: false });
  }
  if (removeCodex && codexPresent) {
    candidates.push({ route: registrations.codex, removeClaude: false, removeCodex: true });
  }

  // An exact explicit distro can recover an orphan whose native registration
  // is already absent. A binary path alone cannot: it still provides no safe
  // distribution target, so an idempotent second uninstall remains a no-op.
  if (candidates.length === 0 && explicitRoute?.distro) {
    candidates.push({
      route: { distro: explicitRoute.distro, binary: explicitRoute.binary ?? null },
      removeClaude,
      removeCodex,
    });
  }

  for (const candidate of candidates) {
    candidate.route = {
      distro: explicitRoute?.distro ?? candidate.route.distro,
      binary: explicitRoute?.binary ?? candidate.route.binary,
    };
  }

  const grouped = new Map();
  const unresolved = [];
  for (const candidate of candidates) {
    if (!candidate.route.distro) {
      unresolved.push(candidate);
      continue;
    }
    const normalizedBinary = candidate.route.binary || "wsl.exe";
    const key = `${normalizedBinary.toLocaleLowerCase("en-US")}\0${
      candidate.route.distro?.toLocaleLowerCase("en-US") || ""
    }`;
    const previous = grouped.get(key);
    if (previous) {
      previous.removeClaude ||= candidate.removeClaude;
      previous.removeCodex ||= candidate.removeCodex;
    } else {
      grouped.set(key, {
        route: { ...candidate.route },
        removeClaude: candidate.removeClaude,
        removeCodex: candidate.removeCodex,
      });
    }
  }
  return { targets: [...grouped.values()], unresolved };
}

/** Backward-compatible narrow accessor used by older installer tests/callers. */
export function findPersistedWslDistro(options = {}) {
  return findPersistedWslSettings(options).distro;
}

export function resolveWslRoute({
  env = process.env,
  platform = process.platform,
} = {}) {
  return {
    binary: exactWslBinary(firstConfigured(env, WSL_BINARY_ENV) ?? "wsl.exe", {
      platform,
      env,
    }),
    distro: firstConfigured(env, WSL_DISTRO_ENV),
  };
}

export function wslArgs(commandArgs, { route }) {
  return [
    ...(route.distro ? ["--distribution", route.distro] : []),
    "--exec",
    ...commandArgs,
  ];
}

export function wslShellArgs(
  command,
  args = [],
  { route, outputMarker = null } = {}
) {
  const program = outputMarker
    ? 'output_marker=$1; shift; printf "%s\\n" "$output_marker"; exec "$@"'
    : 'exec "$@"';
  return wslArgs(
    wslLoginShellArgs(route?.loginShell, program, {
      arg0: "dualog-wsl",
      args: [...(outputMarker ? [outputMarker] : []), command, ...args],
    }),
    { route }
  );
}

/** Build the guarded nested install/uninstall call used by native Windows. */
export function buildWslLifecycleInvocation({
  operation,
  route,
  nodePath,
  scriptPath,
  modeArgument,
}) {
  if (operation !== "install" && operation !== "uninstall") {
    throw new Error(`Unknown WSL lifecycle operation: ${operation}`);
  }
  if (!route?.binary || !route?.distro || !nodePath || !scriptPath || !modeArgument) {
    throw new Error("WSL lifecycle invocation requires a binary, distro, node, script, and mode");
  }
  const sentinel =
    operation === "install"
      ? "DUALOG_INSTALL_HOST_ONLY=1"
      : "DUALOG_UNINSTALL_HOST_ONLY=1";
  return {
    command: route.binary,
    args: wslShellArgs(
      "env",
      [sentinel, nodePath, scriptPath, modeArgument, "--host-only"],
      { route }
    ),
  };
}

async function invoke(runProbe, command, args, { capture = false, cwd } = {}) {
  try {
    return await runProbe(command, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
      timeout: 10000,
      windowsHide: true,
    });
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error };
  }
}

function succeeded(result) {
  return result?.status === 0;
}

function executableStarted(result) {
  return Boolean(result) && !result.error && Number.isInteger(result.status);
}

function parseNodeMajor(stdout) {
  const match = String(stdout ?? "").match(/^v(\d+)(?:\.|$)/mu);
  return match ? Number(match[1]) : null;
}

async function resolveInstallerWslLoginShell(runProbe, route, { cwd } = {}) {
  const probe = await invoke(
    runProbe,
    route.binary,
    wslArgs(wslLoginShellProbeArgs(), { route }),
    { cwd, capture: true }
  );
  return succeeded(probe)
    ? normalizeWslLoginShell(String(probe.stdout ?? ""))
    : DEFAULT_WSL_LOGIN_SHELL;
}

function framedWslProbeOutput(stdout, marker) {
  const output = String(stdout ?? "");
  const index = output.indexOf(marker);
  if (index === -1) return null;
  const after = output.slice(index + marker.length);
  if (after.startsWith("\r\n")) return after.slice(2);
  if (after.startsWith("\n")) return after.slice(1);
  return null;
}

async function probeWslCommandPath(runProbe, route, command, { cwd } = {}) {
  const marker = `__DUALOG_WSL_PATH_${randomUUID()}__`;
  const program = [
    "command_name=$1",
    "output_marker=$2",
    'resolved=$(command -v "$command_name" 2>/dev/null) || exit 127',
    'case "$resolved" in /*) ;; *) exit 126;; esac',
    '[ -x "$resolved" ] && [ ! -d "$resolved" ] || exit 126',
    'printf "%s\\n%s\\n" "$output_marker" "$resolved"',
  ].join("; ");
  const result = await invoke(
    runProbe,
    route.binary,
    wslArgs(
      wslLoginShellArgs(route.loginShell, program, {
        arg0: "dualog-wsl-command-path",
        args: [command, marker],
      }),
      { route }
    ),
    { cwd, capture: true }
  );
  if (!succeeded(result)) return null;
  const framed = framedWslProbeOutput(result.stdout, marker);
  if (framed == null) return null;
  const candidate = framed.split(/\r?\n/u, 1)[0];
  return candidate.startsWith("/") && !candidate.includes("\0")
    ? candidate
    : null;
}

/**
 * Probe the same two execution environments the runtime uses. This function
 * only launches version/status commands; it never reads or writes user config.
 */
export async function probeInstallEnvironment(
  runProbe,
  {
    platform = process.platform,
    env = process.env,
    cwd = process.cwd(),
  } = {}
) {
  const [hostClaudeProbe, hostCodexProbe, hostTmuxProbe] = await Promise.all([
    invoke(runProbe, "claude", ["--version"], { cwd }),
    invoke(runProbe, "codex", ["--version"], { cwd }),
    invoke(runProbe, "tmux", ["-V"], { cwd }),
  ]);
  const hostClaude = succeeded(hostClaudeProbe);
  const hostCodex = succeeded(hostCodexProbe);
  const hostTmux = succeeded(hostTmuxProbe);
  const status = {
    platform,
    host: { claude: hostClaude, codex: hostCodex, tmux: hostTmux },
    wsl: null,
  };
  if (platform !== "win32") return status;

  const requestedRoute = resolveWslRoute({ env, platform });
  const binaryProbe = await invoke(runProbe, requestedRoute.binary, ["--status"], { cwd });
  const binary = executableStarted(binaryProbe);
  const distro =
    binary &&
    succeeded(
      await invoke(
        runProbe,
        requestedRoute.binary,
        wslArgs(["true"], { route: requestedRoute }),
        { cwd }
      )
    );

  let detectedDistro = null;
  if (distro) {
    const detected = await invoke(
      runProbe,
      requestedRoute.binary,
      wslArgs(["/bin/sh", "-c", 'printf "%s" "$WSL_DISTRO_NAME"'], {
        route: requestedRoute,
      }),
      { cwd, capture: true }
    );
    if (succeeded(detected)) detectedDistro = String(detected.stdout ?? "").trim() || null;
  }
  const route = {
    binary: requestedRoute.binary,
    // Pin the default selected during install so a later default-distro change
    // cannot silently route Desktop-launched sessions somewhere else.
    distro: requestedRoute.distro ?? detectedDistro,
  };
  route.loginShell = distro
    ? await resolveInstallerWslLoginShell(runProbe, route, { cwd })
    : DEFAULT_WSL_LOGIN_SHELL;

  const probeWslShell = async (command, args = [], capture = false) => {
    if (!distro) return { status: null, stdout: "", stderr: "" };
    const outputMarker = `__DUALOG_WSL_PROBE_${randomUUID()}__`;
    const result = await invoke(
      runProbe,
      route.binary,
      wslShellArgs(command, args, { route, outputMarker }),
      { cwd, capture }
    );
    if (!capture) return result;
    const framed = framedWslProbeOutput(result.stdout, outputMarker);
    return { ...result, stdout: framed ?? "" };
  };

  const nodeProbe = await probeWslShell("node", ["--version"], true);
  const nodeMajor = succeeded(nodeProbe) ? parseNodeMajor(nodeProbe.stdout) : null;
  const nodePath = distro
    ? await probeWslCommandPath(runProbe, route, "node", { cwd })
    : null;
  const [tmuxProbe, claudeProbe, codexProbe] = await Promise.all([
    distro ? probeWslShell("tmux", ["-V"]) : { status: null },
    probeWslShell("claude", ["--version"]),
    probeWslShell("codex", ["--version"]),
  ]);
  status.wsl = {
    ...route,
    requestedDistro: requestedRoute.distro,
    binaryAvailable: binary,
    distroAvailable: distro,
    node: succeeded(nodeProbe) && nodeMajor !== null && nodeMajor >= 18 && Boolean(nodePath),
    nodeVersion: succeeded(nodeProbe) ? String(nodeProbe.stdout ?? "").trim() || null : null,
    nodePath,
    tmux: succeeded(tmuxProbe),
    claude: succeeded(claudeProbe),
    codex: succeeded(codexProbe),
  };
  return status;
}

export function formatInstallEnvironment(status) {
  const ok = (value) => (value ? "OK" : "not found");
  if (status.platform !== "win32") {
    return [
      status.host.claude
        ? "  Claude Code CLI OK"
        : "  WARNING: Claude Code CLI not found on PATH.",
      status.host.codex ? "  Codex CLI OK" : "  WARNING: Codex CLI not found on PATH.",
      status.host.tmux ? "  tmux OK" : "  WARNING: tmux not found on PATH. Partner sessions require tmux.",
    ];
  }

  const wsl = status.wsl;
  const distroLabel = wsl.distro ? `distribution ${wsl.distro}` : "default distribution";
  return [
    "  Windows host:",
    `    Claude Code CLI: ${ok(status.host.claude)}`,
    `    Codex CLI:       ${ok(status.host.codex)}`,
    `    tmux:            ${ok(status.host.tmux)}`,
    `  WSL (${distroLabel}):`,
    `    ${wsl.binary}:         ${ok(wsl.binaryAvailable)}`,
    `    Distribution:    ${wsl.distroAvailable ? "OK" : "unavailable"}`,
    `    Node.js >= 18:    ${ok(wsl.node)}`,
    `    tmux:             ${ok(wsl.tmux)}`,
    `    Claude Code CLI:  ${ok(wsl.claude)}`,
    `    Codex CLI:        ${ok(wsl.codex)}`,
  ];
}
