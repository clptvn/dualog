// The contract every adapter must satisfy, parameterized over the whole
// registry. New adapters get these checks for free; a manifest that passes here
// is structurally sound even for a CLI nobody on this machine can run.
//
// What this CANNOT prove is that the vendor's flags are spelled correctly. That
// is what the golden argv snapshots (reviewable diffs) and recorded transcripts
// (marker matching) are for.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adapterSearchPath,
  listAdapters,
  resetRegistry,
} from "../src/adapters/registry.mjs";
import { modelEntries } from "../src/adapters/schema.mjs";
import { buildInvocationFromAdapter } from "../src/adapters/argv.mjs";
import { negotiate } from "../src/adapters/negotiate.mjs";
import { isReady, isIdlePrompt, isBlocked } from "../src/tui/markers.mjs";
import { clearRecursionSentinel } from "./helpers/sentinel.mjs";
import { managedSession } from "./helpers/session.mjs";

// These tests assert the sentinel's baseline ("depth 1 for a partner spawned by
// a non-partner"). That claim is only about the code when the baseline is ours,
// so drop any depth inherited from a dualog partner running this suite.
clearRecursionSentinel();

const { home: ROOT, dir: SESSION_DIR, scratchDir: SCRATCH_DIR } = managedSession("contract");
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

// Isolate from any adapters this developer has installed locally.
resetRegistry();
const ADAPTERS = listAdapters({
  env: { XDG_CONFIG_HOME: path.join(ROOT, "xdg"), XDG_CONFIG_DIRS: "" },
});

const BOOTSTRAP = "Completion protocol is mandatory: write result.md then done.json";

function invoke(adapter, engine, toolProfile) {
  return buildInvocationFromAdapter(adapter, {
    engine,
    projectPath: "/fixture/project",
    sessionDir: SESSION_DIR,
    scratchDir: SCRATCH_DIR,
    sessionName: "fixture-session",
    model: "fixture-model",
    reasoningEffort: adapter.reasoningEfforts[0] ?? null,
    toolProfile,
    initialPrompt: BOOTSTRAP,
  });
}

test("the registry is non-empty", () => {
  assert.ok(ADAPTERS.length >= 7, `only ${ADAPTERS.length} adapters loaded`);
});

test("explicit adapter directories use the host path-list delimiter", () => {
  const first = path.join(ROOT, "explicit-one");
  const second = path.join(ROOT, "explicit-two");
  const searchPath = adapterSearchPath({
    cwd: ROOT,
    env: {
      XDG_CONFIG_HOME: path.join(ROOT, "xdg"),
      XDG_CONFIG_DIRS: "",
      DUALOG_ADAPTER_PATH: [first, second].join(path.delimiter),
    },
  });

  assert.deepEqual(searchPath.slice(-2), [path.resolve(first), path.resolve(second)]);
});

for (const adapter of ADAPTERS) {
  const id = adapter.id;
  const profiles = Object.keys(adapter.toolProfiles);
  const toolProfiles = profiles.length ? profiles : [adapter.defaultToolProfile];

  for (const engine of adapter.engines.allowed) {
    for (const toolProfile of toolProfiles) {
      test(`contract[${id}] builds argv for ${engine} / ${toolProfile}`, () => {
        const { command, args, env } = invoke(adapter, engine, toolProfile);

        assert.equal(typeof command, "string");
        assert.ok(command.length > 0, "empty command");

        for (const [i, arg] of args.entries()) {
          // Empty strings are legitimate (a flag that takes an empty value, as
          // qwen's --allowed-mcp-server-names does). null/undefined are not.
          assert.equal(typeof arg, "string", `args[${i}] is ${typeof arg}`);
          assert.ok(
            !arg.includes("{{"),
            `args[${i}] has an unresolved placeholder: ${arg}`
          );
        }

        // The recursion guard is not optional for any adapter, ever.
        assert.equal(env.DUALOG_ROLE, "partner");
        assert.equal(env.DUALOG_DEPTH, "1");
      });

      test(`contract[${id}] delivers the prompt exactly as declared for ${engine}`, () => {
        const { args } = invoke(adapter, engine, toolProfile);
        const inArgv = args.some((a) => a.includes(BOOTSTRAP));
        const declared = adapter.promptDelivery[engine];
        if (declared === "argv") {
          assert.ok(inArgv, `promptDelivery says argv but the prompt is not in argv`);
        } else {
          // A prompt that leaks into argv when it is meant to go over stdin or
          // a paste would be sent twice.
          assert.ok(!inArgv, `promptDelivery is "${declared}" but the prompt is in argv`);
        }
      });
    }
  }

  test(`contract[${id}] declares markers consistent with its engines`, () => {
    if (adapter.engines.allowed.includes("tmux-interactive")) {
      const ready = (adapter.tui?.readyAll?.length ?? 0) + (adapter.tui?.readyAny?.length ?? 0);
      assert.ok(ready > 0, "tmux-capable adapter has no ready markers");
    }
    // A marker in both sets makes one of them unreachable, since blocked is
    // evaluated first.
    const idle = new Set(adapter.tui?.idle ?? []);
    for (const marker of adapter.tui?.blocked ?? []) {
      assert.ok(
        !idle.has(marker),
        `"${marker}" is both an idle and a blocked marker, so idle can never win`
      );
    }
  });

  test(`contract[${id}] marker sets never match an empty pane`, () => {
    // A marker that matches "" would report every pane as ready or idle.
    assert.equal(isReady(adapter.tui, ""), false);
    assert.equal(isIdlePrompt(adapter.tui, ""), false);
    assert.equal(isBlocked(adapter.tui, ""), false);
    assert.equal(isReady(adapter.tui, "   \n  \n"), false);
  });

  test(`contract[${id}] negotiates without throwing and reports honestly`, () => {
    const result = negotiate(adapter, {
      engine: adapter.engines.default,
      toolProfile: "read",
      requireBinary: false,
    });
    assert.ok(Array.isArray(result.errors));
    assert.ok(Array.isArray(result.warnings));
    // Every warning must name the manifest it came from, or it is untraceable.
    for (const w of [...result.errors, ...result.warnings]) {
      assert.ok(w.source, `warning ${w.code} has no source`);
      assert.ok(w.message, `warning ${w.code} has no message`);
    }
  });

  test(`contract[${id}] reports a missing binary as a blocking error`, () => {
    const result = negotiate(adapter, {
      engine: adapter.engines.default,
      partnerCommand: "definitely-not-installed-anywhere-xyz",
      requireBinary: true,
    });
    assert.ok(
      result.errors.some((e) => e.code === "binary_not_found"),
      "a missing binary should block, not warn"
    );
  });

  test(`contract[${id}] every declared defaultEffort is one this model accepts`, () => {
    // The schema rejects this at load, so a failure here means the invariant
    // did not survive the registry's layer merge -- a user manifest that
    // narrows `efforts` without restating `defaultEffort`, for instance.
    for (const entry of modelEntries(adapter)) {
      if (entry.defaultEffort == null) continue;
      assert.ok(
        (entry.efforts ?? []).includes(entry.defaultEffort),
        `${entry.id}: defaultEffort "${entry.defaultEffort}" is not in [${(entry.efforts ?? []).join(", ")}]`
      );
    }
  });

  test(`contract[${id}] per-model efforts stay within the adapter's declared set`, () => {
    // reasoningEfforts is the union of what the CLI will parse. A model that
    // claims an effort outside it means one of the two tables is stale.
    const declared = new Set(adapter.reasoningEfforts);
    for (const entry of modelEntries(adapter)) {
      for (const effort of entry.efforts ?? []) {
        assert.ok(
          declared.has(effort),
          `${entry.id} accepts "${effort}", which is absent from ${id}'s reasoningEfforts`
        );
      }
    }
  });

  test(`contract[${id}] an adapter that cannot write files never relies on sidecars`, () => {
    if (!adapter.capabilities.writesFiles) {
      assert.notEqual(adapter.completion.sidecar, "always");
      assert.ok(adapter.completion.stdoutTrustworthy);
    }
  });
}

// --- The inversion --------------------------------------------------------
//
// claude-opus-4-6 and claude-sonnet-4-6 accept `max` but NOT `xhigh`, which
// breaks any code that treats efforts as an ordered ladder where the higher
// value implies the lower. Claude never rejects the bad combination -- it
// silently clamps to `high` -- so this table is the only place the truth exists.
// Enforcement lands in negotiate(); this pins the data it will read.

test("claude-sonnet-4-6 accepts max but not xhigh", () => {
  const claude = ADAPTERS.find((a) => a.id === "claude");
  assert.ok(claude, "the claude adapter is missing");

  const sonnet = modelEntries(claude).find((m) => m.id === "claude-sonnet-4-6");
  assert.ok(sonnet, "claude-sonnet-4-6 is not declared");
  assert.ok(sonnet.efforts, "claude-sonnet-4-6 declares no efforts at all");
  assert.ok(sonnet.efforts.includes("max"), "max should be valid for claude-sonnet-4-6");
  assert.ok(
    !sonnet.efforts.includes("xhigh"),
    "xhigh is NOT valid for claude-sonnet-4-6; Claude would silently run it at high"
  );

  // The union still carries xhigh, because other Claude models do accept it.
  assert.ok(claude.reasoningEfforts.includes("xhigh"));

  // The same inversion, on the other model that has it.
  const opus46 = modelEntries(claude).find((m) => m.id.startsWith("claude-opus-4-6"));
  assert.ok(opus46, "claude-opus-4-6 is not declared");
  assert.deepEqual(opus46.efforts, ["low", "medium", "high", "max"]);
});

// --- Golden argv across every adapter -------------------------------------

test("argv for every adapter and engine", (t) => {
  const matrix = {};
  // SCRATCH_DIR first: the lease path is where partner homes now live, and it
  // is a sibling of neither the session nor the home, so it needs its own token.
  const redact = (text) =>
    text
      .split(SCRATCH_DIR)
      .join("<SCRATCH_DIR>")
      .split(SESSION_DIR)
      .join("<SESSION_DIR>")
      .split(os.homedir())
      .join("<HOME>")
      .replaceAll("\\", "/");

  for (const adapter of ADAPTERS) {
    for (const engine of adapter.engines.allowed) {
      const { command, args, env } = invoke(adapter, engine, adapter.defaultToolProfile);
      matrix[`${adapter.id}/${engine}`] = {
        command,
        args: args.map((a) => redact(a)),
        env: Object.fromEntries(
          Object.entries(env).map(([k, v]) => [
            k,
            redact(String(v)),
          ])
        ),
      };
    }
  }
  t.assert.snapshot(matrix);
});
