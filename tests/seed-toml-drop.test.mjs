// Seeding the real config is what makes a partner's PROJECT-LOCAL config work.
//
// codex merges a project's .codex/config.toml over the global one. A project
// table that only disables a global server -- `enabled = false` and nothing
// else -- has no transport to merge with when the global file is absent, so
// codex rejects the entire file and exits 1. Isolating CODEX_HOME without
// carrying config.toml is what produced that, and it made every project with a
// project-local codex config unusable through dualog while projects without one
// worked fine.
//
// Carrying the config brings dualog's own MCP server along with it, and a
// partner that can call dualog can open its own dialogs. These cover the strip
// that prevents it, including the spellings a naive matcher misses.

import test from "node:test";
import assert from "node:assert/strict";

import { dropTomlTables } from "../src/adapters/env.mjs";

test("the named table and its subtables are removed", () => {
  const out = dropTomlTables(
    [
      "[mcp_servers.github]",
      'command = "gh"',
      "",
      "[mcp_servers.dualog]",
      'command = "node"',
      "",
      "[mcp_servers.dualog.env]",
      'FOO = "bar"',
      "",
      "[mcp_servers.fly]",
      'command = "flyctl"',
    ].join("\n"),
    ["mcp_servers.dualog"]
  );

  assert.ok(!out.includes("dualog"), "no trace of the dropped server survives");
  assert.ok(out.includes("[mcp_servers.github]"), "earlier tables survive");
  assert.ok(out.includes("[mcp_servers.fly]"), "dropping stops at the next table");
});

test("a quoted table name is the same table", () => {
  // `[mcp_servers."dualog"]` and `[mcp_servers.dualog]` are one table in TOML.
  // A stripper that only understood the bare form would leave the partner able
  // to call dualog while reporting success.
  const out = dropTomlTables('[mcp_servers."dualog"]\ncommand = "node"\n', [
    "mcp_servers.dualog",
  ]);
  assert.ok(!out.includes("command"), "the quoted spelling is dropped too");
});

test("a name that merely starts with the target is kept", () => {
  const out = dropTomlTables(
    '[mcp_servers.dualog_backup]\ncommand = "node"\n',
    ["mcp_servers.dualog"]
  );
  assert.ok(out.includes("dualog_backup"), "prefix match must not over-remove");
});

test("array-of-tables headers are handled", () => {
  const out = dropTomlTables('[[mcp_servers.dualog]]\ncommand = "node"\n[other]\nx = 1\n', [
    "mcp_servers.dualog",
  ]);
  assert.ok(!out.includes("command"));
  assert.ok(out.includes("[other]"));
});

test("a bracket line inside a multi-line string is not a header", () => {
  // Resuming on content would splice the tail of a value back into the file.
  const src = [
    "[keep]",
    'note = """',
    "[mcp_servers.dualog]",
    'still inside the string"""',
    "",
    "[after]",
    "x = 1",
  ].join("\n");
  const out = dropTomlTables(src, ["mcp_servers.dualog"]);
  assert.ok(out.includes("still inside the string"), "string content is preserved");
  assert.ok(out.includes("[after]"));
});

test("the trust table and every other server survive", () => {
  // The whole point of seeding: trust removes the startup prompt, and the
  // global servers are the merge target the project config overrides.
  const src = [
    'model_context_window = 1000000',
    "",
    '[projects."/Users/cameron/Documents/promptable"]',
    'trust_level = "trusted"',
    "",
    "[mcp_servers.supabase]",
    'url = "https://mcp.supabase.com/mcp?project_ref=abc"',
    "",
    "[mcp_servers.dualog]",
    'command = "node"',
  ].join("\n");
  const out = dropTomlTables(src, ["mcp_servers.dualog"]);

  assert.ok(out.includes('trust_level = "trusted"'), "trust must be carried");
  assert.ok(out.includes("[mcp_servers.supabase]"), "merge target must be carried");
  assert.ok(out.includes("model_context_window"), "top-level settings survive");
  assert.ok(!out.includes('command = "node"'), "dualog is gone");
});

test("an empty or absent target list changes nothing", () => {
  const src = "[mcp_servers.dualog]\ncommand = \"node\"\n";
  assert.equal(dropTomlTables(src, []), src);
  assert.equal(dropTomlTables(src, undefined), src);
});
