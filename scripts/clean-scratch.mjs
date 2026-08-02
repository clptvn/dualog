#!/usr/bin/env node
// Report, and optionally remove, the partner scratch homes left inside archived
// sessions.
//
// Reporting is the default and deletion requires --apply, because this removes
// directories from the user's home that no other part of dualog will recreate.
// The report and the deletion run the same plan, so what you are shown is what
// would happen.

import { planScratchSweep, sweepScratch, formatBytes, SCRATCH_LEDGER } from "../src/session-scratch.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const json = args.includes("--json");
const verbose = args.includes("--verbose");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/clean-scratch.mjs [--apply] [--json] [--verbose]

  (no flags)  report what would be removed; changes nothing
  --apply     actually remove it
  --json      emit the receipt as JSON
  --verbose   list every session, including the ones being skipped

Removes only these exact directory names, from the versioned ledger:
${SCRATCH_LEDGER.map((v) => `  v${v.version}: ${Object.keys(v.homes).join(", ")}`).join("\n")}

A session is skipped unless its runner, partner terminal, and every recorded
headless group can all be proven gone. Symlinks are never followed.`);
  process.exit(0);
}

const plan = planScratchSweep();

if (!json) {
  console.log(
    apply
      ? "Removing partner scratch homes\n"
      : "Dry run — a SNAPSHOT of what would be removed. Nothing is changed, and\n" +
        "an --apply run re-proves each session inactive before touching it, so it\n" +
        "may legitimately remove less than this.\n"
  );
  for (const root of plan.roots) {
    console.log(
      `  ${root.root}  ${root.present ? `${root.sessions} entries` : "(absent)"}`
    );
  }
  console.log();
}

const receipt = sweepScratch({ apply, plan, log: verbose && !json ? (m) => console.log(`  ${m}`) : undefined });

if (json) {
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(receipt.errors.length > 0 ? 1 : 0);
}

const byAgent = new Map();
for (const target of receipt.removed) {
  const entry = byAgent.get(target.name) ?? { count: 0, bytes: 0, auth: 0, config: 0 };
  entry.count += 1;
  entry.bytes += target.bytes;
  entry.auth += target.sensitiveFiles.auth.length;
  entry.config += target.sensitiveFiles.config.length;
  byAgent.set(target.name, entry);
}

if (byAgent.size > 0) {
  console.log(apply ? "Removed:" : "Would remove:");
  for (const [name, entry] of [...byAgent].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(
      `  ${name.padEnd(18)} ${String(entry.count).padStart(4)} dirs  ` +
        `${formatBytes(entry.bytes).padStart(9)}  ` +
        `${String(entry.auth).padStart(4)} auth  ${String(entry.config).padStart(4)} secret-capable config`
    );
  }
  console.log(
    `  ${"TOTAL".padEnd(18)} ${String(receipt.totals.removed_targets).padStart(4)} dirs  ` +
      `${formatBytes(receipt.totals.removed_bytes).padStart(9)}  ` +
      `${String(receipt.totals.removed_auth).padStart(4)} auth  ` +
      `${String(receipt.totals.removed_config).padStart(4)} secret-capable config`
  );
} else {
  console.log("Nothing to remove.");
}

if (receipt.skipped.length > 0) {
  console.log(`\nSkipped ${receipt.skipped.length} session(s) that could not be proven inactive:`);
  const shown = verbose ? receipt.skipped : receipt.skipped.slice(0, 10);
  for (const skip of shown) {
    console.log(`  ${skip.sessionId}: ${skip.reason}`);
  }
  if (shown.length < receipt.skipped.length) {
    console.log(`  ... and ${receipt.skipped.length - shown.length} more (--verbose to list)`);
  }
}

if (receipt.errors.length > 0) {
  console.log(`\n${receipt.errors.length} error(s):`);
  for (const err of receipt.errors) console.log(`  ${err.path}: ${err.error}`);
}

if (!apply && receipt.totals.removed_targets > 0) {
  console.log("\nRe-run with --apply to remove these.");
}

process.exit(receipt.errors.length > 0 ? 1 : 0);
