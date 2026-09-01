import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMAND = fs.readFileSync(
  path.join(ROOT, ".claude", "commands", "dualog-review-pr.md"),
  "utf-8"
);

test("the installed Claude PR-review command may use the blocking wait tool", () => {
  const frontmatter = COMMAND.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
  const allowedTools = frontmatter
    .split(/\r?\n/u)
    .find((line) => line.startsWith("allowed-tools:"));

  assert.ok(allowedTools, "the command has no allowed-tools frontmatter");
  assert.match(
    allowedTools,
    /(?:^|, )mcp__dualog__wait_for_partner_response(?:, |$)/u,
    "the installer would copy a command that instructs a wait flow but cannot call the wait tool"
  );
});
