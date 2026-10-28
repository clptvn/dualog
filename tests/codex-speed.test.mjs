import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildInvocationFromAdapter, resolveContext } from "../src/adapters/argv.mjs";
import { negotiate } from "../src/adapters/negotiate.mjs";
import { getAdapter } from "../src/adapters/registry.mjs";
import { buildRunnerRuntimeArg, readRunnerRuntimeDecision } from "../src/runner-lifecycle.mjs";
import { managedSession } from "./helpers/session.mjs";

const { home, dir: sessionDir, scratchDir } = managedSession("codex-speed");
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const seed = path.join(home, "seed");
fs.mkdirSync(seed);
const inherited = 'service_tier = "ultrafast"\n';
fs.writeFileSync(path.join(seed, "config.toml"), inherited);
process.env.CODEX_HOME = seed;
const registryOptions = { cwd: home, env: { XDG_CONFIG_HOME: home, XDG_CONFIG_DIRS: "" } };
const codex = getAdapter("codex", registryOptions);
const options = { projectPath: home, sessionDir, scratchDir, initialPrompt: "Review this code." };

for (const engine of codex.engines.allowed) {
  for (const speed of [undefined, "fast", "ultrafast"]) {
    test(`${engine}: ${speed ?? "omitted speed"} selects only the requested tier`, () => {
      const invocation = buildInvocationFromAdapter(codex, { ...options, engine, speed });
      const { args, env, resolution } = invocation;
      assert.equal(resolution.speed, speed ?? null);
      assert.equal(args.at(-1), options.initialPrompt);
      assert.equal(args.filter((arg) => arg.startsWith("service_tier=")).length, 1);
      assert.ok(args.includes(`service_tier="${speed ?? "default"}"`));
      if (speed) {
        assert.equal(args[args.indexOf("-p") + 1], speed);
        assert.ok(args.includes(`features.${speed}_mode=true`));
        if (engine === "headless") assert.ok(args.indexOf("exec") < args.indexOf("-p"));
        assert.equal(
          fs.readFileSync(path.join(env.CODEX_HOME, `${speed}.config.toml`), "utf8"),
          `service_tier = "${speed}"\n`
        );
      } else {
        assert.ok(!args.includes("-p"));
      }
      assert.equal(fs.readFileSync(path.join(seed, "config.toml"), "utf8"), inherited);
      assert.ok(!fs.existsSync(path.join(seed, "fast.config.toml")));
      assert.ok(!fs.existsSync(path.join(seed, "ultrafast.config.toml")));
    });
  }
}

test("model, effort and prompt text do not opt into a speed tier", () => {
  const { ctx } = resolveContext(codex, {
    ...options, model: "gpt-5.6-sol", reasoningEffort: "ultra",
    initialPrompt: "Please be fast and review the ultrafast implementation.",
    applyOperatorDefault: true,
  });
  assert.equal(ctx.speed, null);
});

test("invalid speeds and non-Codex partners fail preflight", () => {
  const claude = getAdapter("claude", registryOptions);
  for (const [adapter, speed] of [[codex, "turbo"], [codex, ""], [codex, "../fast"], [claude, "fast"], [claude, "ultrafast"]]) {
    const result = negotiate(adapter, { ...options, speed, requireBinary: false });
    assert.ok(result.errors.some((error) => error.code === "unsupported_speed"));
    assert.equal(result.resolution.speed, null);
  }
});

test("the trusted runner handoff preserves explicit speed without reading session state", () => {
  const base = { version: 2, engine: "headless", partnerCommand: process.execPath };
  for (const speed of [undefined, "fast", "ultrafast"]) {
    const decision = { ...base, ...(speed ? { speed } : {}) };
    const arg = buildRunnerRuntimeArg(decision);
    const restored = readRunnerRuntimeDecision([
      "node", "runner", "--dualog-runner-runtime=untrusted", "--runner-token=owned", arg,
    ]);
    assert.equal(restored.speed, speed);
  }
  assert.throws(() => buildRunnerRuntimeArg({ ...base, speed: "turbo" }), /invalid Codex speed/);
});
