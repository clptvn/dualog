// Preloaded into the live MCP server process by pr-review-server-e2e.test.mjs.
// It intercepts only `gh`; every other child-process call reaches the real
// executable. `syncBuiltinESMExports` updates dialog-server.mjs's named ESM
// import, so the test exercises the real PR resolver/refresh handler without a
// POSIX-only PATH shim or a Windows .cmd wrapper.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const originalExecFileSync = childProcess.execFileSync;

function appendCall(args) {
  const logPath = process.env.DUALOG_TEST_GH_LOG;
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify(args)}\n`);
}

function nextDiff() {
  const counterPath = process.env.DUALOG_TEST_GH_COUNTER;
  let count = 0;
  if (counterPath) {
    try {
      count = Number.parseInt(fs.readFileSync(counterPath, "utf-8"), 10) || 0;
    } catch {}
    count += 1;
    fs.writeFileSync(counterPath, String(count));
  }
  const value = Math.max(1, count);
  return [
    "diff --git a/src/remote.ts b/src/remote.ts",
    "--- a/src/remote.ts",
    "+++ b/src/remote.ts",
    "@@ -1 +1 @@",
    "-export const remote = 0;",
    `+export const remote = ${value};`,
    "",
  ].join("\n");
}

childProcess.execFileSync = function fakeExecFileSync(command, args = [], options) {
  if (command !== "gh") {
    return originalExecFileSync.call(this, command, args, options);
  }

  appendCall(args);
  if (args[0] === "pr" && args[1] === "view") {
    return Buffer.from(
      JSON.stringify({
        number: 123,
        title: "Remote PR fixture",
        body: "Fetched through the fake gh boundary.",
        author: { login: "fixture-author" },
        baseRefName: "main",
        headRefName: "feature/remote",
        url: "https://example.test/pull/123",
        state: "OPEN",
        isDraft: false,
      })
    );
  }
  if (args[0] === "pr" && args[1] === "diff") {
    return Buffer.from(nextDiff());
  }
  throw new Error(`Unexpected fake gh invocation: ${JSON.stringify(args)}`);
};

syncBuiltinESMExports();
