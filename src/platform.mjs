import fs from "fs";
import os from "os";
import path from "path";

// claude-codex-dialog platform helpers. Keep this file dependency-light because
// Claude hook scripts import it from the user-level hooks directory.
export function isWindows() {
  return process.platform === "win32";
}

export function homeDir() {
  return os.homedir();
}

/**
 * Session storage root.
 *
 * Resolution order:
 * 1. CODEX_DIALOG_HOME (explicit override)
 * 2. Legacy default ~/.claude/dialogs (backward compatible)
 *
 * Grok-only and Codex-only hosts can set CODEX_DIALOG_HOME to e.g.
 * ~/.codex-dialog/dialogs without breaking existing Claude installs.
 */
export function dialogsDir() {
  const override = process.env.CODEX_DIALOG_HOME;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return path.join(homeDir(), ".claude", "dialogs");
}

export function dialogSessionDir(sessionId) {
  return path.join(dialogsDir(), sessionId);
}

export function readStdin() {
  return fs.readFileSync(0, "utf-8");
}
