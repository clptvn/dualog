#!/usr/bin/env node
// PostToolUse hook for Read tool only.
// Removes the read file from any session-scoped marker files.
// Only exact canonical path matches clear — no substring, no directory bypass.

import fs from "fs";
import path from "path";
import os from "os";
import { readHookPayload } from "../platform.mjs";

// PostToolUse: the call has already run, so blocking is meaningless. Failing
// here is less severe than in mark-needs-investigation -- this hook only CLEARS
// a marker, so a failed read leaves the guard armed rather than disarmed, which
// errs safe. It still must not be silent: the read the operator just performed
// will not count toward satisfying the investigation requirement.
const { payload, outcome } = readHookPayload();
if (outcome === "unreadable" || outcome === "invalid") {
  process.stderr.write(
    `dualog investigation cleaner: received ${outcome} hook input; this file read was not credited against the investigation requirement.\n`
  );
  process.exit(0);
}
if (outcome !== "ok" || !payload) process.exit(0);

const filePath = payload.tool_input?.file_path;
if (!filePath) process.exit(0);

let canonical;
try {
  canonical = fs.realpathSync(filePath);
} catch {
  canonical = path.resolve(filePath);
}

const tmpDir = os.tmpdir();
const prefix = "dualog-required-reads-";
let entries;
try {
  entries = fs.readdirSync(tmpDir).filter((f) => f.startsWith(prefix));
} catch {
  process.exit(0);
}

for (const entry of entries) {
  const markerPath = path.join(tmpDir, entry);
  let content;
  try {
    content = fs.readFileSync(markerPath, "utf-8");
  } catch {
    continue;
  }

  // __any__ fallback: any Read clears it (we can't scope to a session from
  // a Read hook, but __any__ is already the degraded mode — one real Read
  // is sufficient to unblock)
  if (content.trim() === "__any__") {
    try { fs.unlinkSync(markerPath); } catch {}
    continue;
  }

  const lines = content.split("\n").filter((l) => l.trim());
  const remaining = lines.filter((l) => l.trim() !== canonical);

  if (remaining.length === 0) {
    try { fs.unlinkSync(markerPath); } catch {}
  } else if (remaining.length < lines.length) {
    fs.writeFileSync(markerPath, remaining.join("\n") + "\n");
  }
}

process.exit(0);
