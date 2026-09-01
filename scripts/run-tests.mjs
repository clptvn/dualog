#!/usr/bin/env node

// cmd.exe does not expand `tests/*.test.mjs`, so passing that glob directly to
// Node makes the documented test command fail on Windows before a test starts.
// Enumerate the same top-level suite in JavaScript and pass explicit paths on
// every platform.

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsDir = path.join(repoRoot, "tests");
const testFiles = fs
  .readdirSync(testsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => path.join(testsDir, entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error("No tests/*.test.mjs files were found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: repoRoot,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(`Could not start the Node test runner: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  console.error(`Node test runner exited from signal ${result.signal}.`);
  process.exit(1);
}

process.exit(result.status ?? 1);
