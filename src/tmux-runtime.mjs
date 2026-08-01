import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { envWithAliases } from "./platform.mjs";
import { tryGetAdapter } from "./adapters/registry.mjs";
import { isBlocked, isIdlePrompt } from "./tui/markers.mjs";

const DEFAULT_TMUX_BINARY = "tmux";
const DEFAULT_TMUX_SOCKET_NAME = "dualog";
const TMUX_EXEC_TIMEOUT_MS = 10000;
const DEFAULT_CAPTURE_LINES = 240;
const DEFAULT_CAPTURE_MAX_CHARS = 30000;
const DEFAULT_TAIL_LINES = 6;
const DEFAULT_TAIL_MAX_CHARS = 3000;

function tmuxBinary() {
  const configured =
    envWithAliases(
      ["DUALOG_TMUX_BINARY", "CODEX_DIALOG_TMUX_BINARY", "CONDUCTOR_TMUX_BINARY"],
      DEFAULT_TMUX_BINARY
    );
  const trimmed = configured.trim();
  if (!trimmed) {
    throw new Error("tmux binary path must not be empty");
  }
  return trimmed;
}

function runExecFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf-8", timeout: TMUX_EXEC_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        if (error) {
          const code =
            typeof error.code === "number"
              ? error.code
              : error.killed
                ? 124
                : 127;
          resolve({
            stdout,
            stderr: stderr || error.message,
            exitCode: code,
          });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      }
    );
  });
}

export async function runTmux(args, { allowFailure = false } = {}) {
  const result = await runExecFile(tmuxBinary(), buildTmuxArgs(args));
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(
      `tmux ${args.join(" ")} failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
  return result;
}

export async function isTmuxAvailable() {
  try {
    const result = await runTmux(["-V"], { allowFailure: true });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function buildTmuxSessionName(sessionId, label) {
  const raw = `dlg-${sessionId}-${label}`;
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 180);
  if (!sanitized) {
    throw new Error(`Invalid tmux session name derived from ${raw}`);
  }
  return sanitized;
}

export async function startTmuxSession({ sessionName, cwd, command, args, env }) {
  await prepareTmuxServer();
  const payload = buildTmuxShellPayload({ command, args, env });
  await runTmux(["new-session", "-d", "-s", sessionName, "-c", cwd, payload]);
  try {
    await configureTmuxSession(sessionName);
    const paneTarget = `${sessionName}:0.0`;
    const paneId = (
      await runTmux(["display-message", "-p", "-t", paneTarget, "#{pane_id}"])
    ).stdout.trim();
    return {
      sessionName,
      paneTarget,
      paneId,
      cwd,
      command,
      args: [...args],
      env: env ? { ...env } : undefined,
      startedAt: new Date().toISOString(),
    };
  } catch (err) {
    await runTmux(["kill-session", "-t", sessionName], { allowFailure: true });
    throw err;
  }
}

export async function sendTextToTmux(handle, text, { enter = false, submitDelayMs = 0 } = {}) {
  if (text.length > 0) {
    const bufferName = `${handle.sessionName}-input`;
    await runTmux(["set-buffer", "-b", bufferName, text]);
    await runTmux([
      "paste-buffer",
      "-p",
      "-d",
      "-b",
      bufferName,
      "-t",
      handle.paneTarget,
    ]);
  }
  if (enter) {
    if (submitDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, submitDelayMs));
    }
    await runTmux(["send-keys", "-t", handle.paneTarget, "C-m"]);
  }
}

export async function captureTmuxPane(handleOrSessionName, options = {}) {
  const handle =
    typeof handleOrSessionName === "string"
      ? {
          sessionName: handleOrSessionName,
          paneTarget: `${handleOrSessionName}:0.0`,
        }
      : handleOrSessionName;
  const lines = Number.isSafeInteger(options.lines)
    ? options.lines
    : DEFAULT_CAPTURE_LINES;
  const result = await runTmux([
    "capture-pane",
    "-p",
    "-J",
    "-S",
    `-${Math.max(1, lines)}`,
    "-t",
    handle.paneTarget,
  ]);
  return result.stdout;
}

export async function isTmuxSessionAlive(sessionName) {
  if (!sessionName || sessionName.includes(":")) return false;
  const result = await runTmux(["has-session", "-t", sessionName], {
    allowFailure: true,
  });
  return result.exitCode === 0;
}

export async function terminateTmuxSession(handleOrSessionName) {
  const handle =
    typeof handleOrSessionName === "string"
      ? {
          sessionName: handleOrSessionName,
          paneTarget: `${handleOrSessionName}:0.0`,
        }
      : handleOrSessionName;
  if (!handle?.sessionName) return;
  if (!(await isTmuxSessionAlive(handle.sessionName))) return;

  try {
    await sendTextToTmux(handle, "/exit", { enter: true });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {}
  if (!(await isTmuxSessionAlive(handle.sessionName))) return;

  try {
    await runTmux(["send-keys", "-t", handle.paneTarget, "C-c"], {
      allowFailure: true,
    });
    await runTmux(["send-keys", "-t", handle.paneTarget, "C-c"], {
      allowFailure: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {}
  if (!(await isTmuxSessionAlive(handle.sessionName))) return;

  await runTmux(["kill-session", "-t", handle.sessionName], {
    allowFailure: true,
  });
}

export function currentTerminalStatePath(sessionDir) {
  return path.join(sessionDir, "current_terminal.json");
}

export function lastTerminalStatePath(sessionDir) {
  return path.join(sessionDir, "last_terminal.json");
}

export function readTerminalState(sessionDir) {
  const current = readJson(currentTerminalStatePath(sessionDir));
  const last = readJson(lastTerminalStatePath(sessionDir));
  return { current, last };
}

export function writeTerminalState(sessionDir, state, { active = true } = {}) {
  const next = {
    schema_version: 1,
    ...state,
    updated_at: new Date().toISOString(),
  };
  writeJsonAtomic(lastTerminalStatePath(sessionDir), next);
  if (active) {
    writeJsonAtomic(currentTerminalStatePath(sessionDir), next);
  } else {
    try {
      fs.unlinkSync(currentTerminalStatePath(sessionDir));
    } catch {}
  }
  return next;
}

export async function inspectPartnerTerminal(sessionDir, options = {}) {
  const { current, last } = readTerminalState(sessionDir);
  const terminal = current || last;
  if (!terminal?.session_name) {
    return {
      active: false,
      available: await isTmuxAvailable(),
      message: "No tmux-backed partner turn has been started for this session yet.",
    };
  }

  const handle = {
    sessionName: terminal.session_name,
    paneTarget: terminal.pane_target || `${terminal.session_name}:0.0`,
  };
  const alive = await isTmuxSessionAlive(terminal.session_name);
  let captureText = null;
  let captureError = null;
  let captureTruncated = false;
  let fullCapture = null;
  let fullCaptureTruncated = false;
  const maxChars = Number.isSafeInteger(options.maxChars)
    ? options.maxChars
    : DEFAULT_CAPTURE_MAX_CHARS;
  const tailLines = Number.isSafeInteger(options.tailLines)
    ? Math.max(1, Math.min(40, options.tailLines))
    : DEFAULT_TAIL_LINES;
  const tailMaxChars = Number.isSafeInteger(options.tailMaxChars)
    ? Math.max(500, options.tailMaxChars)
    : DEFAULT_TAIL_MAX_CHARS;
  const includeFullCapture = options.includeFullCapture === true;

  if (alive) {
    try {
      captureText = await captureTmuxPane(handle, { lines: options.lines });
    } catch (err) {
      captureError = err.message;
    }
  } else {
    const fallbackCapturePath = getTerminalCapturePath(terminal);
    if (fallbackCapturePath && fs.existsSync(fallbackCapturePath)) {
      try {
        captureText = fs.readFileSync(fallbackCapturePath, "utf-8");
      } catch (err) {
        captureError = err.message;
      }
    }
  }

  if (captureText && captureText.length > maxChars) {
    fullCapture = captureText.slice(-maxChars);
    fullCaptureTruncated = true;
  } else {
    fullCapture = captureText;
  }
  const tailText = buildTailText(captureText, tailLines, tailMaxChars);
  captureTruncated = Boolean(
    captureText && tailText && captureText.length > tailText.length
  );
  const activity = analyzeTerminalActivity(captureText, terminal.agent, {
    alive,
  });
  const fallbackCapturePath = getTerminalCapturePath(terminal);

  return {
    active: Boolean(current),
    available: await isTmuxAvailable(),
    alive,
    status: terminal.status || "unknown",
    agent: terminal.agent || null,
    session_name: terminal.session_name,
    pane_target: handle.paneTarget,
    pane_id: terminal.pane_id || null,
    cwd: terminal.cwd || null,
    command: terminal.command || null,
    args: Array.isArray(terminal.args) ? terminal.args : [],
    turn_dir: terminal.turn_dir || null,
    prompt_path: terminal.prompt_path || null,
    result_path: terminal.result_path || null,
    done_path: terminal.done_path || null,
    started_at: terminal.started_at || null,
    completed_at: terminal.completed_at || null,
    updated_at: terminal.updated_at || null,
    last_capture_path: terminal.last_capture_path || fallbackCapturePath || null,
    activity,
    capture: {
      text: tailText,
      tail_text: tailText,
      full_text: includeFullCapture ? fullCapture : undefined,
      captured_at: captureText ? new Date().toISOString() : null,
      truncated: captureTruncated,
      full_truncated: includeFullCapture ? fullCaptureTruncated : undefined,
      error: captureError,
    },
  };
}

export function analyzeTerminalActivity(captureText, agent, options = {}) {
  const alive = options.alive !== false;
  const text = captureText || "";
  if (!text.trim()) {
    return {
      state: alive ? "unknown" : "not_running",
      confidence: "low",
      summary: alive ? "No terminal text captured yet." : "No live tmux session.",
    };
  }

  const lines = splitLines(text);
  const nonEmptyLines = lines.filter((line) => line.trim());
  const statusLine = findStatusLine(nonEmptyLines);
  const normalizedStatus = statusLine ? normalizeTerminalText(statusLine) : "";
  const lowerStatus = normalizedStatus.toLowerCase();
  const recentText = nonEmptyLines.slice(-8).join("\n");
  const normalizedRecent = normalizeTerminalText(recentText);
  const lowerRecent = normalizedRecent.toLowerCase();
  const tokens = normalizedStatus ? extractTokenCount(normalizedStatus) : null;
  const elapsed = normalizedStatus ? extractElapsed(normalizedStatus) : null;
  const verb = extractVerb(normalizedStatus);
  const model = extractModelLabel(nonEmptyLines);
  const hasIdlePrompt = detectIdlePrompt(nonEmptyLines, agent);
  const hasBlockedPrompt = detectBlockedPrompt(nonEmptyLines, agent);

  let state = "unknown";
  let confidence = "low";

  if (!alive) {
    state = "not_running";
    confidence = "high";
  } else if (/\b(thinking|reasoning|warping|pondering|working)\b/u.test(lowerStatus) || tokens != null) {
    state = "thinking";
    confidence = tokens != null || /\bthinking\b/u.test(lowerStatus) ? "high" : "medium";
  } else if (/bash\(|shell\(|running command|command running/u.test(lowerStatus)) {
    state = "running_command";
    confidence = "high";
  } else if (/\b(reading|read \d+ file|grep|searching|listing)\b/u.test(lowerStatus)) {
    state = "reading";
    confidence = "medium";
  } else if (/\b(writing|edit|patch|applying)\b/u.test(lowerStatus)) {
    state = "writing";
    confidence = "medium";
  } else if (/\b(starting mcp servers|booting|loading)\b/u.test(lowerStatus)) {
    state = "starting";
    confidence = "medium";
  } else if (hasBlockedPrompt) {
    // Checked ahead of idle: a blocked pane looks idle, and treating it as idle
    // is what makes a driver send the next prompt into a parked turn.
    state = "blocked";
    confidence = "high";
  } else if (hasIdlePrompt) {
    state = "idle_prompt";
    confidence = "medium";
  } else if (/bash\(|shell\(|running command|command running/u.test(lowerRecent)) {
    state = "running_command";
    confidence = "medium";
  } else if (/\b(reading|read \d+ file|grep|searching|listing)\b/u.test(lowerRecent)) {
    state = "reading";
    confidence = "low";
  } else if (/\b(writing|edit|patch|applying)\b/u.test(lowerRecent)) {
    state = "writing";
    confidence = "low";
  }

  const parts = [];
  if (model) parts.push(model);
  if (verb) parts.push(verb);
  if (tokens != null) parts.push(`${formatTokenCount(tokens)} tokens`);
  if (elapsed) parts.push(elapsed);

  return {
    state,
    confidence,
    summary: buildActivitySummary(state, parts),
    model,
    verb,
    tokens,
    elapsed,
    idle_prompt_visible: hasIdlePrompt,
    blocked_prompt_visible: hasBlockedPrompt,
    status_line: normalizedStatus || null,
  };
}

function getTerminalCapturePath(terminal) {
  if (terminal?.last_capture_path) return terminal.last_capture_path;
  if (terminal?.turn_dir) return path.join(terminal.turn_dir, "terminal-capture.txt");
  return null;
}

function buildTailText(captureText, tailLines, maxChars) {
  if (!captureText) return null;
  const tail = splitLines(captureText).slice(-tailLines).join("\n");
  if (tail.length <= maxChars) return tail;
  return tail.slice(-maxChars);
}

function splitLines(text) {
  return String(text || "").split(/\r?\n/u);
}

function normalizeTerminalText(text) {
  return String(text || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[^\x20-\x7E]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function findStatusLine(lines) {
  return [...lines]
    .slice(-16)
    .reverse()
    .find((line) => {
      const normalized = normalizeTerminalText(line).toLowerCase();
      const hasElapsed = Boolean(extractElapsed(normalized));
      return (
        hasElapsed &&
        (
          normalized.includes("tokens") ||
          normalized.includes("thinking") ||
          normalized.includes("working") ||
          normalized.includes("running") ||
          normalized.includes("reading") ||
          normalized.includes("writing") ||
          normalized.includes("effort")
        )
      );
    }) || null;
}

function extractTokenCount(text) {
  const match = String(text || "").match(/(\d+(?:\.\d+)?)\s*([km])?\s*tokens?/iu);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const multiplier =
    match[2]?.toLowerCase() === "m"
      ? 1_000_000
      : match[2]?.toLowerCase() === "k"
        ? 1_000
        : 1;
  return Math.round(value * multiplier);
}

function formatTokenCount(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function extractElapsed(text) {
  const match = String(text || "").match(/\b(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s\b/u);
  if (!match) return null;
  const parts = [];
  if (match[1]) parts.push(`${match[1]}h`);
  if (match[2]) parts.push(`${match[2]}m`);
  parts.push(`${match[3]}s`);
  return parts.join(" ");
}

function extractVerb(text) {
  const source = String(text || "");
  const explicit = source.match(/([A-Za-z][A-Za-z -]{1,40})(?:\.\.\.|\u2026)\s*\(/u);
  if (explicit) return explicit[1].trim();
  const generic = source.match(/\b(thinking|working|running|reading|writing|searching|listing)\b/iu);
  return generic ? generic[1].toLowerCase() : null;
}

function extractModelLabel(lines) {
  for (const line of lines.slice(0, 16)) {
    const normalized = normalizeTerminalText(line);
    if (/\b(Fable|Opus|Sonnet|Haiku|GPT|gpt-)\b/iu.test(normalized)) {
      return normalized.slice(0, 120);
    }
  }
  for (const line of lines.slice(0, 12)) {
    const normalized = normalizeTerminalText(line);
    if (
      /\b(Claude Code|OpenAI Codex)\b/iu.test(normalized)
    ) {
      return normalized.slice(0, 120);
    }
  }
  return null;
}

function detectIdlePrompt(lines, agent) {
  return isIdlePrompt(tryGetAdapter(agent)?.tui ?? null, lines.join("\n"));
}

// A pane parked on a plan-approval or ask-the-human step reads as idle to the
// classifier above, which would make a driver send the next prompt into a turn
// that can never advance. Adapters declaring `blocked` markers get it reported
// as its own state instead.
function detectBlockedPrompt(lines, agent) {
  return isBlocked(tryGetAdapter(agent)?.tui ?? null, lines.join("\n"));
}

function buildActivitySummary(state, parts) {
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  if (state === "thinking") return `Partner appears to be thinking${detail}.`;
  if (state === "running_command") return `Partner appears to be running a shell command${detail}.`;
  if (state === "reading") return `Partner appears to be reading or searching files${detail}.`;
  if (state === "writing") return `Partner appears to be writing or editing${detail}.`;
  if (state === "working") return `Partner appears to be working${detail}.`;
  if (state === "starting") return `Partner appears to be starting up${detail}.`;
  if (state === "blocked")
    return `Partner is waiting on a human decision and will not advance on its own${detail}.`;
  if (state === "idle_prompt") return `Partner appears to be at an idle prompt${detail}.`;
  if (state === "not_running") return `Partner tmux session is not running${detail}.`;
  return `Partner activity is unclear${detail}.`;
}

export async function terminateCurrentPartnerTerminal(sessionDir) {
  const { current } = readTerminalState(sessionDir);
  if (!current?.session_name) return false;
  const handle = {
    sessionName: current.session_name,
    paneTarget: current.pane_target || `${current.session_name}:0.0`,
  };
  await terminateTmuxSession(handle);
  writeTerminalState(
    sessionDir,
    {
      ...current,
      status: "terminated",
      completed_at: new Date().toISOString(),
    },
    { active: false }
  );
  return true;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function buildTmuxArgs(args) {
  const socketName = envWithAliases(
    ["DUALOG_TMUX_SOCKET", "CODEX_DIALOG_TMUX_SOCKET", "CONDUCTOR_TMUX_SOCKET"],
    DEFAULT_TMUX_SOCKET_NAME
  );
  const trimmedSocketName = socketName.trim();
  if (!trimmedSocketName || trimmedSocketName.includes("/") || trimmedSocketName.includes("\0")) {
    throw new Error("tmux socket name must be a non-empty name, not a path");
  }
  return ["-f", "/dev/null", "-L", trimmedSocketName, ...args];
}

async function prepareTmuxServer() {
  await runTmux(["start-server"], { allowFailure: true });
}

async function configureTmuxSession(sessionName) {
  await runTmux(["set-option", "-t", sessionName, "default-shell", "/bin/sh"], {
    allowFailure: true,
  });
  await runTmux(["set-option", "-t", sessionName, "focus-events", "off"], {
    allowFailure: true,
  });
  await runTmux(["set-window-option", "-t", `${sessionName}:0`, "remain-on-exit", "off"], {
    allowFailure: true,
  });
}

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function buildTmuxCommandPayload({ command, args, env }) {
  const parts = [];
  const envEntries = Object.entries(env || {})
    .filter(([, value]) => value != null)
    .sort(([a], [b]) => a.localeCompare(b));

  if (envEntries.length > 0) {
    parts.push("env");
    for (const [key, value] of envEntries) {
      parts.push(`${key}=${shellEscape(String(value))}`);
    }
  }

  parts.push(shellEscape(command));
  for (const arg of args || []) {
    parts.push(shellEscape(String(arg)));
  }
  return parts.join(" ");
}

function buildTmuxShellPayload({ command, args, env }) {
  return `/bin/sh -lc ${shellEscape(`exec ${buildTmuxCommandPayload({ command, args, env })}`)}`;
}

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
