// Generates fake partner CLIs on disk.
//
// This is how adapters for CLIs nobody here can install still get exercised
// end to end. The fake reads the same bootstrap prompt a real partner would,
// honors (or deliberately violates) the same completion protocol, and is driven
// through the real engine. What it cannot test is whether the vendor's actual
// flags are correct -- that is what the argv snapshots and transcripts are for.

import fs from "fs";
import path from "path";
import { writeNodeCommand } from "./node-command.mjs";

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
  const reply = options.reply ?? "FAKE PARTNER REPLY";

  const script = `
import fs from "fs";
import path from "path";

const behavior = ${JSON.stringify(behavior)};
const reply = ${JSON.stringify(reply)};
const nativeOptions = ${JSON.stringify(options.native ?? {})};

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
let resultPath = (prompt.match(/^(.*result\\.md)$/mu) || [])[1];
let donePath = (prompt.match(/^(.*done\\.json)$/mu) || [])[1];

// Native Windows batch shims cannot carry literal newlines in an argv value,
// so the headless engine flattens this instruction envelope before launching
// a .cmd partner. Recover the canonical sidecar path from the protocol JSON in
// that form; real partners receive the same information without depending on
// presentation-only line breaks.
if (!resultPath) {
  const protocolStart = prompt.indexOf('{"status":"ok","result_path":');
  const protocolSuffix = ',"summary":"completed","error":null}';
  const protocolEnd =
    protocolStart >= 0 ? prompt.indexOf(protocolSuffix, protocolStart) : -1;
  if (protocolEnd > protocolStart) {
    try {
      resultPath = JSON.parse(
        prompt.slice(protocolStart, protocolEnd + protocolSuffix.length)
      ).result_path;
    } catch {}
  }
}
if (!donePath && resultPath) {
  donePath = path.join(path.dirname(resultPath), "done.json");
}

if (behavior === "native-panel") {
  const sessionDir = path.resolve(path.dirname(resultPath), "../..");
  const panelDir = path.join(sessionDir, "panel");
  const taskPrompt = fs.readFileSync(path.join(path.dirname(resultPath), "prompt.md"), "utf-8");
  if (taskPrompt.includes("## Native Delegation")) {
    if (nativeOptions.hang) {
      fs.writeFileSync(path.join(panelDir, "waiting"), "");
      await new Promise(() => setInterval(() => {}, 1000));
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(panelDir, "manifest.json"), "utf-8"));
    const events = path.join(panelDir, "events.jsonl");
    const event = (aspect, kind) => fs.appendFileSync(events, JSON.stringify({ aspect, kind }) + "\\n");
    await Promise.all(manifest.map(async ({ aspect, task }, index) => {
      event(aspect, "start");
      await new Promise((resolve) => setTimeout(resolve, 100 * (manifest.length - index)));
      if (aspect === nativeOptions.omitAspect) return;
      const declared = JSON.parse(task.match(/\\{"status":"ok","result_path":.*,"summary":"completed","error":null\\}/u)[0]);
      const report = "### Normalized Findings\\n[CORRECTNESS] src/app.ts:4 — retry loop never terminates\\nASPECT_RESULT: FINDINGS";
      fs.writeFileSync(declared.result_path, report);
      fs.writeFileSync(path.join(path.dirname(declared.result_path), "done.json"), JSON.stringify({
        status: aspect === nativeOptions.failedAspect ? "error" : "ok",
        error: aspect === nativeOptions.failedAspect ? "native child failed" : null,
      }));
      event(aspect, "end");
    }));
    if (!nativeOptions.premature && !nativeOptions.omitAspect) {
      const aggregatePath = path.join(panelDir, "aggregate_prompt.md");
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(aggregatePath)) {
        if (Date.now() > deadline) throw new Error("runner never released consolidation");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const aggregate = fs.readFileSync(aggregatePath, "utf-8");
      fs.writeFileSync(path.join(panelDir, "received_aggregate.md"), aggregate);
      const ids = [...new Set([...aggregate.matchAll(/^- (F-[a-z0-9-]+) \\[CORRECTNESS\\]/gmu)].map((match) => match[1]))];
      const dispositions = ids.map((id) => "FINDING_DISPOSITION: " + id + " | false-positive | fixture verified this is synthetic");
      fs.writeFileSync(resultPath, "### Normalized Findings\\n(none)\\n" + dispositions.join("\\n") + "\\nREVIEW_VERDICT: APPROVE");
    } else {
      fs.writeFileSync(resultPath, "### Normalized Findings\\n(none)\\nREVIEW_VERDICT: APPROVE");
    }
  } else {
    fs.writeFileSync(resultPath, reply);
  }
  fs.writeFileSync(donePath, JSON.stringify({ status: "ok", result_path: resultPath }));
  process.exit(0);
}
else if (behavior === "hang") { setInterval(() => {}, 1000); }
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

  return writeNodeCommand(dir, name, script);
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
