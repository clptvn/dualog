// What an agent id means, and what happens to one we do not recognize.
//
// This exists because deleting the golden-snapshot equivalence gate silently
// removed the only coverage of normalizeAgent(). Nothing showed it: the test
// COUNT dropped by exactly the 15 equivalence cases, every remaining test
// passed, and the snapshots were byte-identical. An adversarial review found it
// by mutation -- changing normalizeAgent to map unknown ids to "claude" left
// the entire suite green.
//
// normalizeAgent runs on every start_dialog/start_code_review, in both runners,
// and on every partner turn, so "nothing tests it" was not an acceptable state
// to leave behind.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeAgent } from "../src/shared.mjs";
import { getAdapter, resetRegistry } from "../src/adapters/registry.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// Built-ins only: a user- or project-level manifest on the machine running this
// would otherwise change which ids resolve.
//
// The XDG path must be a real throwaway directory, NOT "". registry.mjs reads
// `env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")`, and the empty
// string is falsy -- so "" silently selected the developer's actual
// ~/.config/dualog/adapters, which is the opposite of what the comment above
// promised.
const XDG_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-agentnorm-xdg-"));
after(() => fs.rmSync(XDG_SANDBOX, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

resetRegistry();
const registryOptions = {
  cwd: REPO_ROOT,
  env: { XDG_CONFIG_HOME: XDG_SANDBOX, XDG_CONFIG_DIRS: "", DUALOG_ADAPTER_PATH: "" },
};

test("a well-formed id is passed through verbatim, never coerced to the fallback", () => {
  // The distinction that matters, and the one a stale comment in the snapshot
  // file got backwards: normalizeAgent does NOT check the id against the
  // registry. It checks the SHAPE. An id that could name an adapter is returned
  // as given, whether or not such an adapter exists -- so a typo reaches
  // getAdapter() and fails there, by name, instead of being silently rewritten
  // into a different partner.
  for (const id of ["codex", "claude", "goose", "grok", "opencode", "qwen", "cursor-agent"]) {
    assert.equal(normalizeAgent(id, "codex"), id, id);
  }
  assert.equal(
    normalizeAgent("definitely-not-a-real-agent", "codex"),
    "definitely-not-a-real-agent",
    "an unknown but well-formed id must NOT become the fallback"
  );
});

test("only a malformed or absent id falls back", () => {
  for (const id of ["NOT VALID!", "has space", "", "  ", null, undefined, 42, {}, ["codex"]]) {
    assert.equal(
      normalizeAgent(id, "codex"),
      "codex",
      `${JSON.stringify(id)} is not a usable id and must fall back`
    );
  }
  // The fallback is the caller's, not a hardcoded one.
  assert.equal(normalizeAgent(null, "claude"), "claude");
});

test("a typo'd partner fails by name rather than silently running someone else", () => {
  // This is the consequence of the pass-through above, and the reason it is the
  // right behaviour: coercing an unknown id to a default would start a turn
  // with a partner the caller never asked for.
  const id = normalizeAgent("codx", "codex");
  assert.equal(id, "codx", "precondition: the typo survives normalization");
  assert.throws(
    () => getAdapter(id, registryOptions),
    /Unknown agent "codx"\. Available: .*claude.*codex/,
    "and must be refused with the available ids listed"
  );
});

test("case and surrounding whitespace are not silently accepted as the same agent", () => {
  // Pinning current behaviour deliberately: if these ever start normalizing,
  // that is a decision to make on purpose, not to discover through a partner
  // being selected by a near-miss.
  assert.equal(normalizeAgent("CODEX", "claude"), "claude", "uppercase is not a valid id shape");
  assert.equal(normalizeAgent(" codex", "claude"), "claude", "a leading space is not trimmed");
});
