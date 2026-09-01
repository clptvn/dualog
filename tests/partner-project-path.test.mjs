import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolvePartnerRuntimeContext } from "../src/partner-invocation.mjs";

const source = (name) =>
  fs.readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf-8");

const DIALOG = source("dialog-runner.mjs");
const REVIEW = source("review-runner.mjs");
const PR_REVIEW = source("pr-review-runner.mjs");

function invocationBlocks(text) {
  return [...text.matchAll(/runPartnerCommand\(\{[\s\S]*?\n\s*\}\)/gu)].map(
    (match) => match[0]
  );
}

test("a headless runtime keeps even a Windows-looking host path unchanged", async () => {
  const hostProjectPath = String.raw`C:\Users\cameron\repo`;
  // Cursor's adapter is headless-only, so this exercises the engine-aware path
  // decision without depending on tmux, WSL, or an installed partner binary.
  const runtimeContext = await resolvePartnerRuntimeContext({
    partnerAgent: "cursor",
    partnerCommand: "cursor-agent",
    projectPath: hostProjectPath,
    log: () => {},
  });

  assert.equal(runtimeContext.engine, "headless");
  assert.equal(runtimeContext.hostProjectPath, hostProjectPath);
  assert.equal(runtimeContext.partnerProjectPath, hostProjectPath);
  assert.equal(runtimeContext.tmuxRoute, null);
  assert.equal(await runtimeContext.toPartnerPath(hostProjectPath), hostProjectPath);
});

test("dialog and review prompts name the partner-visible root", () => {
  for (const [name, text] of [
    ["dialog", DIALOG],
    ["review", REVIEW],
  ]) {
    assert.match(
      text,
      /## Project Directory\n\$\{partnerProjectPath\}/u,
      `${name} prompt must advertise the path the partner can open`
    );
    assert.doesNotMatch(
      text,
      /## Project Directory\n\$\{projectPath\}/u,
      `${name} prompt must not hard-code the host-only project path`
    );
    assert.match(
      text,
      /const runtimeContext = await resolvePartnerRuntimeContext\(\{/u,
      `${name} runner must resolve its engine and path together`
    );
    assert.match(
      text,
      /const partnerProjectPath = runtimeContext\.partnerProjectPath;/u,
      `${name} runner must derive prompt paths from the captured runtime context`
    );
    for (const block of invocationBlocks(text)) {
      assert.match(
        block,
        /\n\s*runtimeContext,/u,
        `${name} invocation must reuse the same context that built its prompt`
      );
    }
  }
});

test("every PR panel phase uses one captured partner path and runtime context", () => {
  assert.match(PR_REVIEW, /const runtimeContext = await resolvePartnerRuntimeContext\(\{/u);
  assert.match(
    PR_REVIEW,
    /const partnerProjectPath = runtimeContext\.partnerProjectPath;/u
  );

  assert.equal(
    (PR_REVIEW.match(/projectPath: partnerProjectPath,/gu) || []).length,
    3,
    "specialist, consolidation, and follow-up prompts must all use the partner path"
  );
  assert.equal(
    (PR_REVIEW.match(/runTurn\([\s\S]*?runtimeContext\n\s*\)/gu) || []).length,
    3,
    "specialist, consolidation, and follow-up invocations must reuse the captured context"
  );

  const [runTurn] = invocationBlocks(PR_REVIEW);
  assert.ok(runTurn, "PR runner must delegate through runPartnerCommand");
  assert.match(runTurn, /\n\s*projectPath,/u, "runtime still receives the native host path");
  assert.match(runTurn, /\n\s*runtimeContext,/u, "runtime must receive the captured route");
});
