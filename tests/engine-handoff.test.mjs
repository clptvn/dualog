import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAdapter, resetRegistry } from "../src/adapters/registry.mjs";
import { resolveRunnableEngine } from "../src/engines/index.mjs";
import { resolvePartnerRuntimeContext } from "../src/partner-invocation.mjs";
import {
  buildRunnerRuntimeArg,
  buildRunnerTokenArg,
  readRunnerRuntimeDecision,
  readRunnerToken,
} from "../src/runner-lifecycle.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = (name) =>
  fs.readFileSync(path.join(REPO_ROOT, "src", name), "utf-8");

const SERVER_SOURCE = source("dialog-server.mjs");
const INVOCATION_SOURCE = source("partner-invocation.mjs");
const RUNNER_SOURCES = Object.freeze({
  dialog: source("dialog-runner.mjs"),
  review: source("review-runner.mjs"),
  pr_review: source("pr-review-runner.mjs"),
});

function between(text, start, end) {
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end, startAt + start.length);
  assert.ok(startAt >= 0 && endAt > startAt, `could not isolate ${start}`);
  return text.slice(startAt, endAt);
}

function objectCallBlocks(text, callee) {
  return [
    ...text.matchAll(
      new RegExp(`${callee}\\(\\{[\\s\\S]*?\\n\\s*\\}\\)`, "gu")
    ),
  ].map((match) => match[0]);
}

resetRegistry();
const codexAdapter = getAdapter("codex", {
  cwd: REPO_ROOT,
  env: { XDG_CONFIG_HOME: "/nonexistent", XDG_CONFIG_DIRS: "" },
});
const WSL_ROUTE = Object.freeze({
  transport: "wsl",
  command: "wsl.exe",
  distro: null,
  tmuxBinary: "tmux",
  tmuxSocketName: "dualog",
});

test("the preflight runtime decision round-trips exactly and legacy runners remain automatic", () => {
  const decisions = [
    {
      version: 1,
      engine: "headless",
      tmuxTransport: null,
      tmuxDistro: null,
      tmuxLauncher: null,
      tmuxControlBinary: null,
      tmuxSocketName: null,
    },
    {
      version: 1,
      engine: "tmux-interactive",
      tmuxTransport: "local",
      tmuxDistro: null,
      tmuxLauncher: "tmux",
      tmuxControlBinary: "tmux",
      tmuxSocketName: "dualog",
    },
    {
      version: 1,
      engine: "tmux-interactive",
      tmuxTransport: "wsl",
      tmuxDistro: "Ubuntu 24.04",
      tmuxLauncher: "wsl.exe",
      tmuxControlBinary: "tmux",
      tmuxSocketName: "dualog",
    },
  ];
  for (const decision of decisions) {
    const arg = buildRunnerRuntimeArg(decision);
    assert.match(arg, /^--dualog-runner-runtime=/u);
    assert.deepEqual(
      readRunnerRuntimeDecision([
        "node",
        "runner.mjs",
        buildRunnerTokenArg("real"),
        arg,
      ]),
      decision
    );
  }

  assert.equal(
    readRunnerRuntimeDecision(["node", "runner.mjs"]),
    null,
    "a direct or older runner launch with no preflight flag keeps automatic resolution"
  );
  assert.throws(
    () =>
      buildRunnerRuntimeArg({
        engine: "headless",
        tmuxTransport: null,
        tmuxDistro: null,
      }),
    /unsupported version/u
  );
  assert.throws(
    () =>
      buildRunnerRuntimeArg({
        version: 1,
        engine: "automatic",
        tmuxTransport: null,
        tmuxDistro: null,
      }),
    /unknown engine/u
  );
  assert.throws(
    () =>
      buildRunnerRuntimeArg({
        version: 1,
        engine: "tmux-interactive",
        tmuxTransport: "wsl",
        tmuxDistro: null,
      }),
    /must pin a distribution/u
  );
  assert.throws(
    () =>
      readRunnerRuntimeDecision([
        "node",
        "runner.mjs",
        buildRunnerTokenArg("real"),
        "--dualog-runner-runtime=not-base64-json",
      ]),
    /invalid runtime decision/u
  );
  const headlessArg = buildRunnerRuntimeArg(decisions[0]);
  const localArg = buildRunnerRuntimeArg(decisions[1]);
  assert.throws(
    () =>
      readRunnerRuntimeDecision([
        "node",
        "runner.mjs",
        buildRunnerTokenArg("real"),
        headlessArg,
        localArg,
      ]),
    /more than one runtime decision/u
  );

  assert.deepEqual(
    readRunnerRuntimeDecision([
      "node",
      "runner.mjs",
      headlessArg,
      buildRunnerTokenArg("real"),
      localArg,
    ]),
    decisions[1],
    "a user-controlled positional value must not collide with the internal runner flag"
  );
  assert.deepEqual(
    readRunnerRuntimeDecision([
      "node",
      "runner.mjs",
      headlessArg,
      "--runner-token=attacker-data",
      headlessArg,
      buildRunnerTokenArg("real"),
      localArg,
    ]),
    decisions[1],
    "only internal controls after the final server token belong to the runner protocol"
  );
  assert.equal(
    readRunnerToken([
      "node",
      "runner.mjs",
      "--runner-token=attacker-data",
      buildRunnerTokenArg("real"),
    ]),
    "real"
  );
});

test("an automatic Windows fallback becomes the actual pinned runner engine", async () => {
  const unavailableWsl = {
    partnerCommand: "codex",
    tmuxRouteFn: () => ({ transport: "wsl" }),
    probeTmuxAvailabilityFn: async () => "missing",
    probeWslPartnerCommandFn: async () => "unavailable",
  };

  // Preflight is still automatic, so native Windows may make its documented
  // WSL-unavailable fallback to headless.
  const preflightEngine = await resolveRunnableEngine(codexAdapter, unavailableWsl);
  assert.equal(preflightEngine, "headless");

  // Crossing the process boundary turns the reported choice into an explicit
  // pin. The runtime context and eventual invocation must therefore agree with
  // the value the start response/status reported.
  const runnerDecision = readRunnerRuntimeDecision([
    "node",
    "dialog-runner.mjs",
    buildRunnerTokenArg("real"),
    buildRunnerRuntimeArg({
      version: 1,
      engine: preflightEngine,
      tmuxTransport: null,
      tmuxDistro: null,
    }),
  ]);
  const runtimeContext = await resolvePartnerRuntimeContext({
    partnerAgent: "codex",
    partnerCommand: "codex",
    projectPath: "C:\\work\\dualog",
    requestedEngine: runnerDecision.engine,
    pinnedTmuxTransport: runnerDecision.tmuxTransport,
    pinnedTmuxDistro: runnerDecision.tmuxDistro,
  });
  assert.equal(runtimeContext.engine, preflightEngine);
  assert.equal(runtimeContext.requestedEngine, preflightEngine);
  assert.equal(runtimeContext.partnerProjectPath, "C:\\work\\dualog");

  await assert.rejects(
    resolvePartnerRuntimeContext(
      {
        partnerAgent: "codex",
        partnerCommand: "codex",
        projectPath: "C:\\work\\dualog",
        requestedEngine: "headless",
      },
      {
        resolveRunnableEngineFn: async () => "tmux-interactive",
      }
    ),
    /Preflight selected engine "headless".*resolved "tmux-interactive"/u,
    "an injected or changed resolver may not violate the reported engine"
  );

  // Conversely, an already-pinned interactive choice may fail if tmux vanishes
  // between processes; it may not silently change the engine after reporting.
  await assert.rejects(
    resolveRunnableEngine(codexAdapter, {
      ...unavailableWsl,
      requested: "tmux-interactive",
    }),
    /requires a runnable tmux partner session/u
  );
});

test("preflight command identity uses native platform case semantics", async () => {
  const currentRoute = {
    transport: "local",
    command: "C:\\TOOLS\\TMUX.EXE",
    distro: null,
    tmuxBinary: "C:\\TOOLS\\TMUX.EXE",
    tmuxSocketName: "dualog-case",
  };
  const input = {
    partnerAgent: "codex",
    partnerCommand: "codex",
    projectPath: "/work/dualog",
    requestedEngine: "tmux-interactive",
    pinnedTmuxTransport: "local",
    pinnedTmuxDistro: null,
    pinnedTmuxLauncher: "c:/tools/tmux.exe",
    pinnedTmuxControlBinary: "c:/tools/tmux.exe",
    pinnedTmuxSocketName: "dualog-case",
  };
  const dependencies = (platform) => ({
    platform,
    tmuxRouteFn: () => ({ ...currentRoute }),
    resolveWslRouteDistroFn: async (route) => route,
    resolveRunnableEngineFn: async () => "tmux-interactive",
    resolveTmuxProjectContextFn: async (hostProjectPath, { route }) => ({
      hostProjectPath,
      partnerProjectPath: hostProjectPath,
      tmuxTransport: route.transport,
      tmuxDistro: route.distro,
      tmuxRoute: route,
      tmuxLauncher: route.command,
      tmuxControlBinary: route.tmuxBinary,
      tmuxSocketName: route.tmuxSocketName,
    }),
  });

  await assert.rejects(
    resolvePartnerRuntimeContext(input, dependencies("darwin")),
    /Preflight selected tmux launcher/u,
    "Darwin must not accept a case-distinct command identity"
  );
  const windowsContext = await resolvePartnerRuntimeContext(
    input,
    dependencies("win32")
  );
  assert.equal(windowsContext.tmuxLauncher, currentRoute.command);
  assert.equal(windowsContext.tmuxControlBinary, currentRoute.tmuxBinary);
});

test("an inferred WSL UNC distro is pinned across preflight and runner route drift", async () => {
  const projectPath = "\\\\wsl.localhost\\Ubuntu\\home\\test\\dualog";
  const makeProjectContext = async (hostProjectPath, { route }) => ({
    hostProjectPath,
    partnerProjectPath: "/home/test/dualog",
    tmuxTransport: route.transport,
    tmuxDistro: route.distro,
    tmuxRoute: route,
    tmuxLauncher: route.command,
    tmuxControlBinary: route.tmuxBinary,
    tmuxSocketName: route.tmuxSocketName,
  });

  const preflight = await resolvePartnerRuntimeContext(
    { partnerAgent: "codex", partnerCommand: "codex", projectPath },
    {
      tmuxRouteFn: () => ({ ...WSL_ROUTE }),
      resolveWslLoginShellFn: async () => "/bin/bash",
      resolveRunnableEngineFn: async (_adapter, options) => {
        assert.equal(options.tmuxRouteFn().distro, "Ubuntu");
        return "tmux-interactive";
      },
      resolveTmuxProjectContextFn: makeProjectContext,
    }
  );
  const decision = {
    version: 1,
    engine: preflight.engine,
    tmuxTransport: preflight.tmuxTransport,
    tmuxDistro: preflight.tmuxDistro,
    tmuxLauncher: preflight.tmuxLauncher,
    tmuxControlBinary: preflight.tmuxControlBinary,
    tmuxSocketName: preflight.tmuxSocketName,
  };
  assert.deepEqual(decision, {
    version: 1,
    engine: "tmux-interactive",
    tmuxTransport: "wsl",
    tmuxDistro: "Ubuntu",
    tmuxLauncher: "wsl.exe",
    tmuxControlBinary: "tmux",
    tmuxSocketName: "dualog",
  });

  const runnerDecision = readRunnerRuntimeDecision([
    "node",
    "review-runner.mjs",
    buildRunnerTokenArg("real"),
    buildRunnerRuntimeArg(decision),
  ]);
  const runner = await resolvePartnerRuntimeContext(
    {
      partnerAgent: "codex",
      partnerCommand: "codex",
      projectPath,
      requestedEngine: runnerDecision.engine,
      pinnedTmuxTransport: runnerDecision.tmuxTransport,
      pinnedTmuxDistro: runnerDecision.tmuxDistro,
      pinnedTmuxLauncher: runnerDecision.tmuxLauncher,
      pinnedTmuxControlBinary: runnerDecision.tmuxControlBinary,
      pinnedTmuxSocketName: runnerDecision.tmuxSocketName,
    },
    {
      // Simulate the default WSL distro changing after the start response. The
      // preflight namespace pin must win before path and availability checks.
      tmuxRouteFn: () => ({ ...WSL_ROUTE, distro: "Debian" }),
      resolveWslLoginShellFn: async (route) => {
        assert.equal(route.distro, "Ubuntu");
        return "/bin/bash";
      },
      resolveRunnableEngineFn: async (_adapter, options) => {
        assert.equal(options.requested, "tmux-interactive");
        assert.equal(options.tmuxRouteFn().distro, "Ubuntu");
        return "tmux-interactive";
      },
      resolveTmuxProjectContextFn: makeProjectContext,
    }
  );
  assert.equal(runner.engine, decision.engine);
  assert.equal(runner.tmuxTransport, decision.tmuxTransport);
  assert.equal(runner.tmuxDistro, decision.tmuxDistro);
  assert.equal(runner.tmuxLauncher, decision.tmuxLauncher);
  assert.equal(runner.tmuxControlBinary, decision.tmuxControlBinary);
  assert.equal(runner.tmuxSocketName, decision.tmuxSocketName);

  await assert.rejects(
    resolvePartnerRuntimeContext(
      {
        partnerAgent: "codex",
        partnerCommand: "codex",
        projectPath: "\\\\wsl$\\Debian\\home\\test\\dualog",
        requestedEngine: decision.engine,
        pinnedTmuxTransport: decision.tmuxTransport,
        pinnedTmuxDistro: decision.tmuxDistro,
      },
      { tmuxRouteFn: () => ({ ...WSL_ROUTE }) }
    ),
    /belongs to distribution "Debian".*routed to "Ubuntu"/u
  );

  // A native tmux override appearing after preflight is a real transport
  // change. It must fail rather than passing that native path into WSL.
  await assert.rejects(
    resolvePartnerRuntimeContext(
      {
        partnerAgent: "codex",
        partnerCommand: "codex",
        projectPath,
        requestedEngine: decision.engine,
        pinnedTmuxTransport: decision.tmuxTransport,
        pinnedTmuxDistro: decision.tmuxDistro,
      },
      {
        tmuxRouteFn: () => ({
          transport: "local",
          command: "operator-tmux",
          distro: null,
          tmuxBinary: "operator-tmux",
        }),
      }
    ),
    /Preflight selected wsl tmux.*now resolves local/u
  );

  await assert.rejects(
    resolvePartnerRuntimeContext(
      {
        partnerAgent: "codex",
        partnerCommand: "codex",
        projectPath: "C:\\work\\dualog",
        requestedEngine: decision.engine,
        pinnedTmuxTransport: "local",
        pinnedTmuxDistro: null,
      },
      { tmuxRouteFn: () => ({ ...WSL_ROUTE, distro: "Ubuntu" }) }
    ),
    /Preflight selected local tmux.*now resolves wsl/u
  );
});

test("all three start tools persist, report, and pass one engine selection", () => {
  const preflightRegion = between(
    SERVER_SOURCE,
    "async function preflightPartner",
    "function describeEffort"
  );
  assert.match(preflightRegion, /resolvePartnerRuntimeContext\(\{/u);
  assert.match(preflightRegion, /projectPath: projectPath \|\| process\.cwd\(\),/u);
  assert.match(preflightRegion, /tmuxRoute: runtimeContext\.tmuxRoute,/u);

  const startRegions = {
    dialog: between(SERVER_SOURCE, 'server.tool(\n  "start_dialog"', "// ── Code Review Tools"),
    review: between(SERVER_SOURCE, 'server.tool(\n  "start_code_review"', 'server.tool(\n  "get_review_summary"'),
    pr_review: between(SERVER_SOURCE, 'server.tool(\n  "start_pr_review"', 'server.tool(\n  "get_pr_review_report"'),
  };

  for (const [name, region] of Object.entries(startRegions)) {
    assert.equal(
      (region.match(/buildRunnerRuntimeArg\(preflight\.runtimeDecision\)/gu) ?? []).length,
      1,
      `${name} must put exactly one engine pin in its detached runner argv`
    );
    assert.equal(
      (region.match(/engine: preflight\.engine,/gu) ?? []).length,
      2,
      `${name} must persist and report the same preflight engine`
    );
    assert.equal(
      (region.match(/tmux_transport: preflight\.runtimeDecision\.tmuxTransport,/gu) ?? [])
        .length,
      2,
      `${name} must persist and report the same tmux transport`
    );
    assert.equal(
      (region.match(/tmux_distro: preflight\.runtimeDecision\.tmuxDistro,/gu) ?? [])
        .length,
      2,
      `${name} must persist and report the same WSL distro`
    );
  }

  for (const [name, runnerSource] of Object.entries(RUNNER_SOURCES)) {
    assert.match(
      runnerSource,
      /const PREFLIGHT_RUNTIME = readRunnerRuntimeDecision\(\);/u,
      `${name} reads the runtime pin`
    );
    const contexts = objectCallBlocks(runnerSource, "resolvePartnerRuntimeContext");
    assert.equal(contexts.length, 1, `${name} must make one runtime decision`);
    assert.match(contexts[0], /requestedEngine: PREFLIGHT_ENGINE,/u);
    assert.match(contexts[0], /pinnedTmuxTransport: PREFLIGHT_RUNTIME\?\.tmuxTransport/u);
    assert.match(contexts[0], /pinnedTmuxDistro: PREFLIGHT_RUNTIME\?\.tmuxDistro/u);
    assert.match(contexts[0], /pinnedTmuxLauncher: PREFLIGHT_RUNTIME\?\.tmuxLauncher/u);
    assert.match(
      contexts[0],
      /pinnedTmuxControlBinary: PREFLIGHT_RUNTIME\?\.tmuxControlBinary/u
    );
    assert.match(contexts[0], /pinnedTmuxSocketName: PREFLIGHT_RUNTIME\?\.tmuxSocketName/u);

    const turns = objectCallBlocks(runnerSource, "runPartnerCommand");
    const expectedTurns = name === "review" ? 2 : 1;
    assert.equal(turns.length, expectedTurns, `${name} turn count changed`);
    for (const turn of turns) {
      assert.match(turn, /engine: PREFLIGHT_ENGINE,/u, `${name} turn lost the engine pin`);
      assert.match(turn, /runtimeContext,/u, `${name} turn lost the matching runtime context`);
    }
  }

  assert.match(
    INVOCATION_SOURCE,
    /buildInvocationFromAdapter\(adapter,\s*\{\s*engine: selectedRuntimeContext\.engine,/u,
    "the interactive turn must select argv with its pinned engine"
  );
});
