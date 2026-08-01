import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Tear down a tmux server owned by a test file, socket file included.
 *
 * `kill-server` stops the server but deliberately leaves its socket inode on
 * disk, so a suite that only kills servers still deposits one file per run in
 * the tmux socket directory. Since each test file keys its socket by pid, every
 * run leaks a new one and they never get reused.
 *
 * The socket path depends on TMUX_TMPDIR and the uid, so ask tmux for it while
 * the server is still answering, and fall back to the documented default layout
 * when there is nothing alive to ask.
 */
export function killTmuxServer(socketName) {
  let socketPath = null;

  const probe = spawnSync(
    "tmux",
    ["-L", socketName, "display-message", "-p", "#{socket_path}"],
    { encoding: "utf-8" }
  );
  if (probe.status === 0 && probe.stdout) {
    socketPath = probe.stdout.trim() || null;
  }

  spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });

  if (!socketPath) {
    const tmpDir = process.env.TMUX_TMPDIR || "/tmp";
    const uid = typeof process.getuid === "function" ? process.getuid() : "";
    socketPath = path.join(tmpDir, `tmux-${uid}`, socketName);
  }

  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Already gone, never created, or not ours to remove -- all fine.
  }
}
