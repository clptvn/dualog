import fs from "fs";
import os from "os";
import path from "path";

// dualog platform helpers. Keep this file dependency-light because
// Claude hook scripts import it from the user-level hooks directory.
export function isWindows() {
  return process.platform === "win32";
}

export function homeDir() {
  return os.homedir();
}

// Sessions written from now on live here.
export function dialogsDir() {
  return path.join(homeDir(), ".dualog", "sessions");
}

// Where sessions lived before the rename. Still read so that in-flight and
// historical sessions remain visible; never written to.
export function legacyDialogsDir() {
  return path.join(homeDir(), ".claude", "dialogs");
}

/** Prefer the current root, fall back to the legacy one for existing sessions. */
export function resolveExistingSessionDir(sessionId) {
  const current = path.join(dialogsDir(), sessionId);
  if (fs.existsSync(current)) return current;
  const legacy = path.join(legacyDialogsDir(), sessionId);
  if (fs.existsSync(legacy)) return legacy;
  return current;
}

/**
 * Read an environment variable under its current name, falling back to any
 * pre-rename aliases. Keeps existing setups working without a flag day.
 */
export function envWithAliases(names, fallback = undefined) {
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value !== "") return value;
  }
  return fallback;
}

export function dialogSessionDir(sessionId) {
  return path.join(dialogsDir(), sessionId);
}

export function readStdin() {
  return fs.readFileSync(0, "utf-8");
}
