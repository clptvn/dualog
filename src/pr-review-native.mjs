import fs from "fs";
import path from "path";
import { buildBootstrapPrompt, readCompletion } from "./engines/completion.mjs";
import { sleep } from "./shared.mjs";

/** One native partner owns its subagents; only the runner commits review state. */
export async function startNativePanel({
  sessionDir,
  projectPath,
  aspects,
  instructions,
  model = null,
  reasoningEffort = null,
  speed = null,
  buildPrompt,
  toPartnerPath,
  run,
}) {
  const panelDir = path.join(sessionDir, "panel");
  fs.mkdirSync(panelDir, { recursive: true });
  const entries = [];
  for (const aspect of aspects) {
    const turnDir = path.join(panelDir, aspect);
    fs.mkdirSync(turnDir, { recursive: true });
    const promptPath = path.join(turnDir, "prompt.md");
    const resultPath = path.join(turnDir, "result.md");
    const donePath = path.join(turnDir, "done.json");
    fs.writeFileSync(promptPath, buildPrompt(aspect));
    entries.push({
      aspect,
      turnDir,
      resultPath,
      donePath,
      task: buildBootstrapPrompt({
        promptPath: await toPartnerPath(promptPath),
        resultPath: await toPartnerPath(resultPath),
        donePath: await toPartnerPath(donePath),
        projectPath,
        responseInstruction:
          "You are one PR review specialist. Do not edit project files or delegate further. Write only your assigned sidecars; never write the orchestrator's completion files.",
      }),
    });
  }

  const manifestPath = path.join(panelDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(entries.map(({ aspect, task }) => ({ aspect, task })), null, 2));
  const aggregatePath = path.join(panelDir, "aggregate_prompt.md");
  const prompt = `You are the PR review orchestrator. Use native subagents to run this panel in parallel.

## Native Delegation
${instructions}
Parent model: ${model || "CLI default (inherit)"}
Parent reasoning effort: ${reasoningEffort || "CLI default (inherit)"}
Parent speed: ${speed || "standard"} (inherit; never opt into another speed)

## Panel Contract
Review only: do not edit project files. Write only the review artifacts requested here.
Read the task manifest at ${await toPartnerPath(manifestPath)}.
Launch exactly one isolated native subagent per manifest entry. Pass ONLY that
entry's task to its subagent, not this orchestrator prompt or your completion
protocol. Launch the independent tasks together, subject to the CLI's native
concurrency limit. Do not perform specialist reviews yourself. Keep the requested
model and reasoning effort above for children where the CLI supports them;
do not deliberately substitute cheaper models or use unrelated custom agents.

Wait for every subagent and verify that both assigned sidecars exist. Each child
must write its assigned result.md and then done.json before returning. Treat
missing sidecars as a failed child. If a child fails, preserve any report it produced
and write status:error with an explanation to that child's done.json. Never
replace a failure with a clean report. Do not leave children running when you
finish, including on an error or cancellation.

The Dualog runner will independently read those reports, suppress specialist
verdicts, assign durable finding IDs, and prepare the consolidation instructions.
After all children have returned, wait for this file to exist:
${await toPartnerPath(aggregatePath)}
You may poll for it with shell/Bash. Do not write or modify that file yourself.
Read it in full and follow it exactly. It contains the authoritative numbered,
sanitized reports and finding ledger. Consolidate from that file, without
silently dropping findings or importing raw specialist verdicts.

Only YOU write the outer result.md and done.json from your bootstrap, and only
AFTER following the consolidation instructions. A specialist's completion is
never completion of this review. If native delegation is unavailable, report
that failure explicitly; do not silently run the panel sequentially yourself.`;

  let finished = false;
  let released = false;
  let premature = false;
  let result;
  let failure;
  const completion = Promise.resolve()
    .then(() => run(prompt))
    .then(
      (response) => { result = response; },
      (error) => { failure = error; }
    )
    .then(() => { premature = !released; finished = true; });

  return {
    async readAspect(aspect) {
      const entry = entries.find((candidate) => candidate.aspect === aspect);
      for (;;) {
        const report = readCompletion(entry);
        if (report) {
          if (report.status === "error") throw new Error(report.error || `Native specialist ${aspect} failed`);
          return report.result;
        }
        if (finished) {
          throw new Error(`Native orchestrator ended without a report for ${aspect}: ${failure?.message || "missing completion sidecars"}`);
        }
        await sleep(250);
      }
    },
    async aggregate(aggregationPrompt) {
      const temporary = `${aggregatePath}.tmp`;
      fs.writeFileSync(temporary, aggregationPrompt);
      fs.renameSync(temporary, aggregatePath);
      released = true;
      await completion;
      if (failure) throw failure;
      if (premature) throw new Error("Native orchestrator completed before the runner released consolidation");
      return result;
    },
    async stop() {
      if (!finished) fs.writeFileSync(path.join(sessionDir, "end_signal"), "");
      await completion;
    },
  };
}
