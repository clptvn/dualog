// Partner-written sidecars are untrusted input.
//
// Bounding the headless output streams left the primary completion channel
// unbounded: done.json is re-read and re-parsed on every poll, and result.md is
// read in one allocation and then appended to a conversation log that
// readConversation() re-reads in full on every poll. Both are written by the
// partner, so both are sizes this process does not choose.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readCompletion,
  MAX_DONE_BYTES,
  MAX_RESULT_BYTES,
} from "../src/engines/completion.mjs";

function makeTurn(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-completion-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("an ordinary completion still reads normally", (t) => {
  const turnDir = makeTurn(t);
  const resultPath = path.join(turnDir, "result.md");
  const donePath = path.join(turnDir, "done.json");
  fs.writeFileSync(resultPath, "the final message");
  fs.writeFileSync(donePath, JSON.stringify({ status: "ok", result_path: resultPath }));

  const out = readCompletion({ turnDir, resultPath, donePath });
  assert.equal(out.status, "ok");
  assert.equal(out.result, "the final message");
});

test("an oversized done.json is refused rather than parsed every poll", (t) => {
  const turnDir = makeTurn(t);
  const resultPath = path.join(turnDir, "result.md");
  const donePath = path.join(turnDir, "done.json");
  fs.writeFileSync(resultPath, "ok");
  fs.writeFileSync(donePath, "x".repeat(MAX_DONE_BYTES + 1));

  assert.throws(
    () => readCompletion({ turnDir, resultPath, donePath }),
    /past the .* limit/
  );
});

test("an oversized result is refused before it is allocated", (t) => {
  const turnDir = makeTurn(t);
  const resultPath = path.join(turnDir, "result.md");
  const donePath = path.join(turnDir, "done.json");

  // Sparse write: the file reports its full size without costing the disk.
  const fd = fs.openSync(resultPath, "w");
  fs.ftruncateSync(fd, MAX_RESULT_BYTES + 1);
  fs.closeSync(fd);
  fs.writeFileSync(donePath, JSON.stringify({ status: "ok", result_path: resultPath }));

  assert.throws(
    () => readCompletion({ turnDir, resultPath, donePath }),
    /past the .* limit/
  );
});

test("a result exactly at the limit is still accepted", (t) => {
  const turnDir = makeTurn(t);
  const resultPath = path.join(turnDir, "result.md");
  const donePath = path.join(turnDir, "done.json");
  fs.writeFileSync(resultPath, "y".repeat(1024));
  fs.writeFileSync(donePath, JSON.stringify({ status: "ok", result_path: resultPath }));

  const out = readCompletion({ turnDir, resultPath, donePath });
  assert.equal(out.result.length, 1024);
});

// --- the conversation log as a whole -----------------------------------------

test("the log has a session-wide ceiling, not just a per-entry one", async (t) => {
  // MAX_MESSAGE_BYTES bounds ONE message. Nothing bounded how many: the round
  // budget counts partner replies, so a host could append 2 MiB entries
  // indefinitely, and every poll re-reads the result.
  const { appendMessage, MAX_CONVERSATION_BYTES } = await import("../src/shared.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-convcap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const convPath = path.join(dir, "conversation.jsonl");

  // Pre-fill to just under the ceiling without writing 64 MiB of real content.
  fs.writeFileSync(convPath, "");
  const fd = fs.openSync(convPath, "r+");
  fs.ftruncateSync(fd, MAX_CONVERSATION_BYTES - 32);
  fs.closeSync(fd);

  assert.throws(
    () => appendMessage(dir, "claude", "x".repeat(1024)),
    /conversation log would exceed/,
    "an append that would cross the ceiling is refused"
  );
});

test("id assignment stays correct for records larger than any tail window", async (t) => {
  // The previous implementation read a 64 KiB tail to find the last id. A legal
  // entry may be 2 MiB, so a large record left no parseable line in the window
  // and silently fell back to scanning the whole log under the lock -- losing
  // the optimization exactly when the log was biggest.
  const { appendMessage } = await import("../src/shared.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-bigid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "conversation.jsonl"), "");

  appendMessage(dir, "claude", "small");
  const big = appendMessage(dir, "codex", "y".repeat(256 * 1024));
  const after = appendMessage(dir, "claude", "small again");

  assert.equal(big.id, 2);
  assert.equal(after.id, 3, "the id after an oversized record must still be correct");

  // And it survives losing the sidecar entirely.
  fs.rmSync(path.join(dir, "conversation.jsonl.next-id"));
  assert.equal(appendMessage(dir, "codex", "z").id, 4, "a missing sidecar rebuilds by scanning");
});

test("a stale but syntactically valid id cache never produces a duplicate id", async (t) => {
  // The failure this guards against is worse than the scan it replaced. The
  // append lock serializes writers but does not make the JSONL write and the
  // cache update one transaction, so a crash between them -- or a swallowed
  // cache-write failure -- leaves a stale value that still parses. Reusing a
  // live id is not merely cosmetic: both runners advance lastProcessedId to the
  // highest id seen and accept only strictly greater ones, so the duplicated
  // message is skipped permanently, and clients polling with since_id miss it
  // too.
  const { appendMessage, readConversation } = await import("../src/shared.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-dupid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const convPath = path.join(dir, "conversation.jsonl");
  const cachePath = `${convPath}.next-id`;
  fs.writeFileSync(convPath, "");

  appendMessage(dir, "claude", "one");
  appendMessage(dir, "codex", "two");

  const ids = () => readConversation(dir).map((m) => m.id);
  assert.deepEqual(ids(), [1, 2]);

  // 1. A cache whose recorded size does not match the log is not describing it.
  fs.writeFileSync(cachePath, JSON.stringify({ next_id: 2, bytes: 999999 }));
  appendMessage(dir, "claude", "three");
  assert.deepEqual(ids(), [1, 2, 3], "a size mismatch must force a rebuild, not reuse id 2");

  // 2. The pre-validation format (a bare number) carries no size and is ignored.
  fs.writeFileSync(cachePath, "2");
  appendMessage(dir, "codex", "four");
  assert.deepEqual(ids(), [1, 2, 3, 4], "an unrecognized cache format must not be trusted");

  // 3. A record that landed while the cache write did not.
  const beforeCrash = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  fs.appendFileSync(
    convPath,
    JSON.stringify({ id: 5, from: "claude", content: "five", timestamp: "t" }) + "\n"
  );
  fs.writeFileSync(cachePath, JSON.stringify(beforeCrash));
  appendMessage(dir, "codex", "six");
  assert.deepEqual(ids(), [1, 2, 3, 4, 5, 6], "an interrupted write must yield the next id, not a repeat");

  // Ids must be unique above all -- that is the property runners depend on.
  const all = ids();
  assert.equal(new Set(all).size, all.length, "no duplicate ids under any interruption");
});
