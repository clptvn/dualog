// Headless engine, driven end to end against fake partner CLIs.
//
// Also covers user-adapter discovery: the manifests here are written to a temp
// directory and found via DUALOG_ADAPTER_PATH, which is the same path a user
// adding a brand-new CLI would take.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runHeadlessTurn, extractStdoutResult } from "../src/engines/headless.mjs";
import { resolveEngine, resolveRunnableEngine } from "../src/engines/index.mjs";
import { buildBootstrapPrompt } from "../src/engines/completion.mjs";
import { loadRegistry, resetRegistry } from "../src/adapters/registry.mjs";
import { writeFakeCli, writeFakeAdapter } from "./helpers/fake-cli.mjs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "headless-engine-"));
const ADAPTER_DIR = path.join(ROOT, "adapters");
const BIN_DIR = path.join(ROOT, "bin");
fs.mkdirSync(BIN_DIR, { recursive: true });

process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

// One fake binary + adapter per behavior under test.
const BEHAVIORS = ["sidecar-ok", "sidecar-error", "stdout-only", "silent", "crash", "hang"];
for (const behavior of BEHAVIORS) {
  const bin = writeFakeCli(BIN_DIR, `fake-${behavior}.mjs`, behavior);
  writeFakeAdapter(ADAPTER_DIR, `fake-${behavior}`, bin);
}

// stdout-trusting variant of the same fake, to prove the fallback policy.
writeFakeAdapter(
  ADAPTER_DIR,
  "fake-stdout-trusted",
  path.join(BIN_DIR, "fake-stdout-only.mjs"),
  {
    completion: {
      sidecar: "fallback",
      stdoutTrustworthy: true,
      stdout: { format: "stream-json", resultEventType: "result", resultPath: "result" },
    },
  }
);

// stdin delivery, to prove both prompt paths.
writeFakeAdapter(ADAPTER_DIR, "fake-stdin", path.join(BIN_DIR, "fake-sidecar-ok.mjs"), {
  promptDelivery: { headless: "stdin" },
  argv: { headless: [{ args: ["--run"] }] },
});

resetRegistry();
const REG = {
  env: {
    XDG_CONFIG_HOME: path.join(ROOT, "xdg"),
    XDG_CONFIG_DIRS: "",
    DUALOG_ADAPTER_PATH: ADAPTER_DIR,
  },
};
const registry = loadRegistry(REG);

const WSL_CAPABLE_ADAPTER = {
  id: "wsl-capable",
  binary: { default: "partner", versionArgs: ["--version"] },
  engines: { default: "tmux-interactive", allowed: ["tmux-interactive", "headless"] },
  __sources: ["wsl-capable.json"],
};

function setupTurn(name) {
  const sessionDir = fs.mkdtempSync(path.join(ROOT, `session-${name}-`));
  const turnDir = path.join(sessionDir, "turns", "t1");
  fs.mkdirSync(turnDir, { recursive: true });
  const promptPath = path.join(turnDir, "prompt.md");
  const resultPath = path.join(turnDir, "result.md");
  const donePath = path.join(turnDir, "done.json");
  fs.writeFileSync(promptPath, "Do the thing.");
  return {
    sessionDir,
    turnDir,
    resultPath,
    donePath,
    bootstrap: buildBootstrapPrompt({
      promptPath,
      resultPath,
      donePath,
      projectPath: ROOT,
      responseInstruction: "Respond with your analysis.",
    }),
  };
}

async function run(adapterId, overrides = {}) {
  const turn = setupTurn(adapterId);
  return runHeadlessTurn({
    adapter: registry.get(adapterId),
    partnerCommand: null,
    bootstrap: turn.bootstrap,
    projectPath: ROOT,
    sessionDir: turn.sessionDir,
    turnDir: turn.turnDir,
    resultPath: turn.resultPath,
    donePath: turn.donePath,
    model: null,
    reasoningEffort: null,
    toolProfile: "read",
    timeoutMs: 10000,
    log: () => {},
    ...overrides,
  });
}

test("a well-behaved partner returns its sidecar result", async () => {
  assert.equal(await run("fake-sidecar-ok"), "FAKE PARTNER REPLY");
});

test("prompt delivery over stdin works as well as over argv", async () => {
  assert.equal(await run("fake-stdin"), "FAKE PARTNER REPLY");
});

test("a partner reporting an error surfaces it rather than the result text", async () => {
  await assert.rejects(run("fake-sidecar-error"), (err) => {
    assert.match(err.message, /fake failure/);
    assert.equal(err.outcome, "died");
    return true;
  });
});

test("a crashed partner is reported as died, with its stderr", async () => {
  await assert.rejects(run("fake-crash"), (err) => {
    assert.equal(err.outcome, "died");
    assert.match(err.message, /exploded/);
    return true;
  });
});

test("a hung partner is killed and reported as hung, not as a crash", async () => {
  await assert.rejects(run("fake-hang", { timeoutMs: 1500 }), (err) => {
    assert.equal(err.outcome, "hung");
    return true;
  });
});

test("silent success with no sidecar is diagnosed as denied write access", async () => {
  // This is the failure mode four real CLIs exhibit: exit 0, no output, no
  // sidecar, because write tools were never registered. A bare "timeout" here
  // would send someone hunting in entirely the wrong direction.
  await assert.rejects(run("fake-silent"), (err) => {
    assert.equal(err.outcome, "stuck");
    assert.match(err.message, /could not write files/);
    assert.match(err.message, /auto-approve/);
    return true;
  });
});

test("sidecar:always does not accept a stdout result as a substitute", async () => {
  await assert.rejects(run("fake-stdout-only"), (err) => {
    assert.equal(err.outcome, "stuck");
    return true;
  });
});

test("sidecar:fallback accepts a stdout terminal event", async () => {
  assert.equal(await run("fake-stdout-trusted"), "FAKE PARTNER REPLY");
});

// --- stdout extraction ----------------------------------------------------

test("stream-json extraction takes the LAST terminal event", () => {
  // An earlier event of the same type (a sub-agent's result) must not win.
  const adapter = registry.get("fake-stdout-trusted");
  const stdout = [
    JSON.stringify({ type: "result", result: "inner subagent result" }),
    JSON.stringify({ type: "assistant", text: "still working" }),
    JSON.stringify({ type: "result", result: "the real final answer" }),
  ].join("\n");
  assert.equal(extractStdoutResult(adapter, stdout), "the real final answer");
});

test("non-JSON chatter interleaved in a stream does not break extraction", () => {
  const adapter = registry.get("fake-stdout-trusted");
  const stdout = [
    "warning: update available",
    JSON.stringify({ type: "result", result: "answer" }),
    "",
  ].join("\n");
  assert.equal(extractStdoutResult(adapter, stdout), "answer");
});

test("extraction returns null when the terminal event never arrives", () => {
  const adapter = registry.get("fake-stdout-trusted");
  assert.equal(
    extractStdoutResult(adapter, JSON.stringify({ type: "assistant", text: "hi" })),
    null
  );
});

// --- engine resolution ----------------------------------------------------

test("an explicit request for an unsupported engine is a hard error", () => {
  const adapter = registry.get("fake-sidecar-ok");
  assert.throws(
    () => resolveEngine(adapter, { requested: "tmux-interactive" }),
    /does not support engine "tmux-interactive".*fake-sidecar-ok\.json/s
  );
});

test("an unknown engine name is rejected outright", () => {
  assert.throws(
    () => resolveEngine(registry.get("fake-sidecar-ok"), { requested: "telepathy" }),
    /Unknown engine "telepathy"/
  );
});

test("an operator-level default falls through when unsupported, with a warning", () => {
  // A fleet-wide DUALOG_STRATEGY must not break the one adapter that cannot
  // honor it -- unlike an explicit per-call request, which should fail loudly.
  const messages = [];
  const engine = resolveEngine(registry.get("fake-sidecar-ok"), {
    env: { DUALOG_STRATEGY: "tmux-interactive" },
    log: (m) => messages.push(m),
  });
  assert.equal(engine, "headless");
  assert.match(messages.join("\n"), /not supported by adapter/);
});

test("an operator-level default is honored when the adapter supports it", () => {
  assert.equal(
    resolveEngine(registry.get("fake-sidecar-ok"), {
      env: { DUALOG_STRATEGY: "headless" },
    }),
    "headless"
  );
});

test("a runnable WSL partner keeps the interactive tmux engine", async () => {
  const engine = await resolveRunnableEngine(WSL_CAPABLE_ADAPTER, {
    partnerCommand: "partner",
    tmuxRouteFn: () => ({ transport: "wsl" }),
    probeTmuxAvailabilityFn: async () => "available",
    probeWslPartnerCommandFn: async (command, versionArgs) => {
      assert.equal(command, "partner");
      assert.deepEqual(versionArgs, ["--version"]);
      return "available";
    },
  });
  assert.equal(engine, "tmux-interactive");
});

test("an unavailable WSL partner falls back to its declared headless engine", async () => {
  const messages = [];
  const engine = await resolveRunnableEngine(WSL_CAPABLE_ADAPTER, {
    tmuxRouteFn: () => ({ transport: "wsl" }),
    probeTmuxAvailabilityFn: async () => "available",
    probeWslPartnerCommandFn: async () => "unavailable",
    log: (message) => messages.push(message),
  });
  assert.equal(engine, "headless");
  assert.match(messages.join("\n"), /WSL tmux is available/);
});

test("an explicit WSL tmux request fails instead of silently falling back", async () => {
  await assert.rejects(
    resolveRunnableEngine(WSL_CAPABLE_ADAPTER, {
      requested: "tmux-interactive",
      tmuxRouteFn: () => ({ transport: "wsl" }),
      probeTmuxAvailabilityFn: async () => "available",
      probeWslPartnerCommandFn: async () => "unavailable",
    }),
    /could not run there.*requires a runnable tmux partner session/s
  );
});

test("user adapters are discovered via DUALOG_ADAPTER_PATH", () => {
  // The path a user adding a brand-new CLI takes, with no source edit.
  assert.ok(registry.has("fake-sidecar-ok"));
  assert.match(registry.get("fake-sidecar-ok").__sources[0], /adapters[\\/]fake-sidecar-ok\.json$/);
});
