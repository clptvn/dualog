// Generates fake partner CLIs on disk.
//
// This is how adapters for CLIs nobody here can install still get exercised
// end to end. The fake reads the same bootstrap prompt a real partner would,
// honors (or deliberately violates) the same completion protocol, and is driven
// through the real engine. What it cannot test is whether the vendor's actual
// flags are correct -- that is what the argv snapshots and transcripts are for.

import fs from "fs";
import path from "path";

/**
 * Behaviors a fake can be scripted with:
 *
 *   sidecar-ok    write result.md then done.json, exit 0        (happy path)
 *   sidecar-error write result.md and done.json status=error    (partner failed)
 *   stdout-only   emit a stream-json result event, no sidecar   (write access denied)
 *   silent        exit 0 having written nothing at all          (the nasty one)
 *   crash         exit 1 with stderr                            (died)
 *   hang          never exit                                    (hung)
 */
export function writeFakeCli(dir, name, behavior, options = {}) {
  const target = path.join(dir, name);
  const reply = options.reply ?? "FAKE PARTNER REPLY";

  const script = `#!/usr/bin/env node
import fs from "fs";

const behavior = ${JSON.stringify(behavior)};
const reply = ${JSON.stringify(reply)};

// The bootstrap reaches us the same way it reaches a real partner: as the last
// positional argument, or on stdin.
function readPrompt() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const fromArgv = positional[positional.length - 1];
  if (fromArgv && fromArgv.includes("Completion protocol is mandatory")) return fromArgv;
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return fromArgv ?? "";
  }
}

const prompt = readPrompt();
// The protocol states both sidecar paths on their own lines.
const resultPath = (prompt.match(/^(.*result\\.md)$/mu) || [])[1];
const donePath = (prompt.match(/^(.*done\\.json)$/mu) || [])[1];

if (behavior === "hang") { setInterval(() => {}, 1000); }
else if (behavior === "crash") {
  process.stderr.write("fake partner: exploded\\n");
  process.exit(1);
}
else if (behavior === "silent") { process.exit(0); }
else if (behavior === "stdout-only") {
  process.stdout.write(JSON.stringify({ type: "assistant", text: "thinking" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", result: reply }) + "\\n");
  process.exit(0);
}
else if (behavior === "sidecar-error") {
  fs.writeFileSync(resultPath, reply);
  fs.writeFileSync(donePath, JSON.stringify({ status: "error", error: "fake failure" }));
  process.exit(0);
}
else {
  fs.writeFileSync(resultPath, reply);
  fs.writeFileSync(donePath, JSON.stringify({ status: "ok", result_path: resultPath }));
  process.stdout.write(JSON.stringify({ type: "result", result: reply }) + "\\n");
  process.exit(0);
}
`;

  fs.writeFileSync(target, script);
  fs.chmodSync(target, 0o755);
  return target;
}

/** A minimal headless-capable manifest pointed at a fake binary. */
export function writeFakeAdapter(adapterDir, id, binaryPath, overrides = {}) {
  fs.mkdirSync(adapterDir, { recursive: true });
  const invokeViaNode = process.platform === "win32" && binaryPath.endsWith(".mjs");
  const binary = invokeViaNode ? process.execPath : binaryPath;
  const binaryArgs = invokeViaNode ? [binaryPath] : [];
  const declaredArgs = overrides.argv?.headless ?? [{ args: ["--run", "{{initialPrompt}}"] }];
  const argv = {
    ...overrides.argv,
    headless: declaredArgs.map((entry, index) =>
      index === 0 ? { ...entry, args: [...binaryArgs, ...(entry.args ?? [])] } : entry
    ),
  };
  const manifest = {
    id,
    displayName: id,
    binary: { default: binary },
    engines: { default: "headless", allowed: ["headless"] },
    capabilities: {
      modelFlag: true,
      reasoningEffort: false,
      toolProfiles: "none",
      addDir: false,
      writesFiles: true,
      tuiDrivable: "no",
    },
    mcp: { strategy: "none" },
    promptDelivery: { headless: "argv" },
    argv,
    completion: {
      sidecar: "always",
      stdoutTrustworthy: false,
    },
    ...overrides,
    argv,
  };
  const file = path.join(adapterDir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}
