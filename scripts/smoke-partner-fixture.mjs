#!/usr/bin/env node

// A deliberately tiny headless partner used only by smoke-wait-tool.mjs.
// Keeping it as a Node entrypoint makes the CI smoke independent of Claude,
// Codex, tmux, POSIX shells, PATHEXT, and developer-mode symlink privileges.

import fs from "node:fs";

const prompt = process.argv.at(-1) ?? "";
const resultPath = (prompt.match(/^(.*result\.md)\r?$/mu) || [])[1];
const donePath = (prompt.match(/^(.*done\.json)\r?$/mu) || [])[1];

if (!resultPath || !donePath) {
  process.stderr.write("smoke partner did not receive the completion sidecar paths\n");
  process.exit(2);
}

fs.writeFileSync(resultPath, "HERMETIC SMOKE PARTNER REPLY\n");
fs.writeFileSync(
  donePath,
  JSON.stringify({ status: "ok", result_path: resultPath })
);
process.stdout.write(
  `${JSON.stringify({ type: "result", result: "HERMETIC SMOKE PARTNER REPLY" })}\n`
);
