import fs from "fs";
import path from "path";
import { dialogsDir } from "./platform.mjs";
import { isProcessAlive, readStatus } from "./shared.mjs";

/** Soft cap on simultaneously active runners (overridable). */
export function maxActiveSessions() {
  const raw = Number(process.env.CODEX_DIALOG_MAX_ACTIVE_SESSIONS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 3;
}

/** Retention days for ended sessions (0 = never auto-delete whole sessions). */
export function retentionDays() {
  const raw = Number(process.env.CODEX_DIALOG_RETENTION_DAYS);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 14;
}

export function maxDiffBytes() {
  const raw = Number(process.env.CODEX_DIALOG_MAX_DIFF_BYTES);
  if (Number.isFinite(raw) && raw > 10_000) return Math.floor(raw);
  return 400_000; // ~400 KB of diff text
}

/**
 * Remove heavy partner artifacts while keeping conversation/status/problem.
 * Safe to call on ended sessions; also safe mid-session for cache dirs only.
 */
export function pruneSessionHeavyArtifacts(sessionDir, { aggressive = false } = {}) {
  if (!sessionDir || !fs.existsSync(sessionDir)) {
    return { pruned: [], bytes_reclaimed_estimate: 0 };
  }

  const targets = [
    path.join(sessionDir, "codex-home", ".tmp"),
    path.join(sessionDir, "codex-home", "plugins"),
    path.join(sessionDir, "codex-home", "cache"),
    path.join(sessionDir, "codex-home", "logs_2.sqlite-wal"),
    path.join(sessionDir, "codex-home", "logs_2.sqlite-shm"),
    path.join(sessionDir, "codex-home", "memories_1.sqlite-wal"),
    path.join(sessionDir, "codex-home", "memories_1.sqlite-shm"),
    path.join(sessionDir, "grok-home", "sessions"),
    path.join(sessionDir, "grok-home", "logs"),
    path.join(sessionDir, "grok-home", "marketplace-cache"),
  ];

  if (aggressive) {
    // Full partner homes — only after end_dialog (conversation kept).
    targets.push(path.join(sessionDir, "codex-home"));
    targets.push(path.join(sessionDir, "grok-home"));
  }

  const pruned = [];
  let bytes = 0;

  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    try {
      bytes += estimateSize(target);
      fs.rmSync(target, { recursive: true, force: true });
      pruned.push(path.relative(sessionDir, target) || target);
    } catch {
      // best-effort
    }
  }

  // Drop large terminal captures under turns/ but keep result.md / done.json / prompt.md
  const turnsDir = path.join(sessionDir, "turns");
  if (fs.existsSync(turnsDir)) {
    try {
      for (const turn of fs.readdirSync(turnsDir)) {
        const capture = path.join(turnsDir, turn, "terminal-capture.txt");
        if (fs.existsSync(capture)) {
          try {
            bytes += fs.statSync(capture).size;
            fs.rmSync(capture, { force: true });
            pruned.push(path.relative(sessionDir, capture));
          } catch {}
        }
      }
    } catch {}
  }

  return { pruned, bytes_reclaimed_estimate: bytes };
}

function estimateSize(targetPath) {
  try {
    const st = fs.statSync(targetPath);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let total = 0;
    const stack = [targetPath];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const p = path.join(dir, ent.name);
        try {
          if (ent.isDirectory()) stack.push(p);
          else total += fs.statSync(p).size;
        } catch {}
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export function sessionIsActive(sessionDir, status) {
  if (!status) return false;
  if (fs.existsSync(path.join(sessionDir, "end_signal"))) return false;
  if (status.runner_pid && isProcessAlive(status.runner_pid)) return true;
  // runner_pid null but no end_signal and recently started — treat inactive if pid missing
  return false;
}

export function listSessionIds(root = dialogsDir()) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter(
      (d) =>
        d.startsWith("dialog-") ||
        d.startsWith("review-") ||
        d.startsWith("group-")
    );
}

export function countActiveSessions(root = dialogsDir()) {
  let n = 0;
  for (const id of listSessionIds(root)) {
    const dir = path.join(root, id);
    const status = readStatus(dir);
    if (sessionIsActive(dir, status)) n += 1;
  }
  return n;
}

export function assertUnderActiveSessionLimit(root = dialogsDir()) {
  const max = maxActiveSessions();
  const active = countActiveSessions(root);
  if (active >= max) {
    throw new Error(
      `Active session limit reached (${active}/${max}). End an existing session with end_dialog, or raise CODEX_DIALOG_MAX_ACTIVE_SESSIONS.`
    );
  }
  return { active, max };
}

/**
 * Truncate oversized diffs so partner context is not destroyed.
 */
export function capDiffText(diff, maxBytes = maxDiffBytes()) {
  const text = String(diff || "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { diff: text, truncated: false, original_bytes: bytes, max_bytes: maxBytes };
  }
  // Truncate on a line boundary when possible
  let cut = text.slice(0, maxBytes);
  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > maxBytes * 0.8) cut = cut.slice(0, lastNl);
  const notice =
    `\n\n---\n[codex-dialog] DIFF TRUNCATED: showing first ~${maxBytes} bytes of ${bytes}. ` +
    `Raise CODEX_DIALOG_MAX_DIFF_BYTES or narrow diff_target if the partner needs the rest.\n`;
  return {
    diff: cut + notice,
    truncated: true,
    original_bytes: bytes,
    max_bytes: maxBytes,
  };
}

/**
 * Delete ended sessions older than retention days. Never deletes active runners.
 * Retention 0 disables whole-session deletion (heavy-artifact prune only when requested).
 */
export function pruneExpiredSessions(root = dialogsDir(), { days = retentionDays() } = {}) {
  if (!days || days <= 0) {
    return { deleted: [], pruned_heavy: [], skipped_active: 0 };
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const deleted = [];
  const pruned_heavy = [];
  let skipped_active = 0;

  for (const id of listSessionIds(root)) {
    const dir = path.join(root, id);
    const status = readStatus(dir);
    if (sessionIsActive(dir, status)) {
      skipped_active += 1;
      continue;
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (status?.started_at) {
      const t = Date.parse(status.started_at);
      if (Number.isFinite(t)) mtime = Math.max(mtime, t);
    }
    if (mtime >= cutoff) {
      // Still reclaim heavy caches on old-but-retained sessions when listing
      const r = pruneSessionHeavyArtifacts(dir, { aggressive: false });
      if (r.pruned.length) pruned_heavy.push({ session_id: id, ...r });
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      deleted.push(id);
    } catch {}
  }

  return { deleted, pruned_heavy, skipped_active, retention_days: days };
}
