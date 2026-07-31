import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccd-test-"));
process.env.CODEX_DIALOG_HOME = path.join(TMP, "dialogs");

const {
  normalizeAgent,
  normalizeHostAgent,
  normalizePartnerAgent,
  getAgentDisplayName,
  KNOWN_HOST_AGENTS,
  KNOWN_PARTNER_AGENTS,
} = await import("../src/shared.mjs");

const {
  capDiffText,
  pruneSessionHeavyArtifacts,
  maxDiffBytes,
  countActiveSessions,
  assertUnderActiveSessionLimit,
} = await import("../src/session-maintenance.mjs");

const { dialogsDir } = await import("../src/platform.mjs");

describe("agent normalization", () => {
  it("accepts grok as host including aliases", () => {
    assert.equal(normalizeHostAgent("grok"), "grok");
    assert.equal(normalizeHostAgent("grok-build"), "grok");
    assert.equal(normalizeHostAgent("GROK_BUILD"), "grok");
    assert.ok(KNOWN_HOST_AGENTS.includes("grok"));
  });

  it("does not accept grok as a partner", () => {
    assert.equal(normalizePartnerAgent("grok", "codex"), "codex");
    assert.deepEqual(KNOWN_PARTNER_AGENTS, ["claude", "codex"]);
  });

  it("display names cover all hosts", () => {
    assert.equal(getAgentDisplayName("claude"), "Claude");
    assert.equal(getAgentDisplayName("codex"), "Codex");
    assert.equal(getAgentDisplayName("grok"), "Grok");
    assert.equal(normalizeAgent("unknown", "codex"), "codex");
  });
});

describe("dialogs dir override", () => {
  it("respects CODEX_DIALOG_HOME", () => {
    assert.equal(dialogsDir(), path.join(TMP, "dialogs"));
  });
});

describe("diff capping", () => {
  it("leaves small diffs alone", () => {
    const r = capDiffText("hello\n", 1000);
    assert.equal(r.truncated, false);
    assert.equal(r.diff, "hello\n");
  });

  it("truncates large diffs with a notice", () => {
    const big = "x".repeat(50_000);
    const r = capDiffText(big, 1000);
    assert.equal(r.truncated, true);
    assert.ok(r.diff.includes("DIFF TRUNCATED"));
    assert.ok(Buffer.byteLength(r.diff, "utf8") < 50_000);
    assert.equal(typeof maxDiffBytes(), "number");
  });
});

describe("session heavy artifact prune", () => {
  it("removes codex-home caches while keeping conversation", () => {
    const sessionDir = path.join(TMP, "dialogs", "dialog-1-deadbeef");
    fs.mkdirSync(path.join(sessionDir, "codex-home", "plugins", "cache"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sessionDir, "codex-home", ".tmp"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "codex-home", "plugins", "cache", "blob.bin"),
      Buffer.alloc(1024)
    );
    fs.writeFileSync(path.join(sessionDir, "conversation.jsonl"), '{"id":1}\n');
    fs.writeFileSync(path.join(sessionDir, "status.json"), "{}");

    const result = pruneSessionHeavyArtifacts(sessionDir, { aggressive: true });
    assert.ok(result.pruned.length > 0);
    assert.ok(fs.existsSync(path.join(sessionDir, "conversation.jsonl")));
    assert.ok(!fs.existsSync(path.join(sessionDir, "codex-home", "plugins")));
  });
});

describe("active session limit", () => {
  it("counts zero when no sessions", () => {
    // use isolated empty subdir via env already set
    const n = countActiveSessions(path.join(TMP, "empty-limit"));
    assert.equal(n, 0);
    process.env.CODEX_DIALOG_MAX_ACTIVE_SESSIONS = "5";
    assert.doesNotThrow(() =>
      assertUnderActiveSessionLimit(path.join(TMP, "empty-limit"))
    );
  });
});

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
});
