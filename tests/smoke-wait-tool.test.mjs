import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeNodeCommand } from "./helpers/node-command.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const smokePath = path.join(repoRoot, "scripts", "smoke-wait-tool.mjs");

test("wait-tool smoke is hermetic and needs no vendor CLI or tmux on PATH", async (t) => {
  const outerHome = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-smoke-contract-"));
  const forbiddenBin = path.join(outerHome, "forbidden-vendor-bin");
  for (const command of ["claude", "codex", "tmux"]) {
    writeNodeCommand(
      forbiddenBin,
      command,
      `process.stderr.write(${JSON.stringify(`FORBIDDEN_VENDOR_EXECUTABLE:${command}\\n`)}); process.exit(97);`
    );
  }
  t.after(() =>
    fs.rmSync(outerHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  );

  const result = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [smokePath],
      {
        cwd: repoRoot,
        timeout: 30000,
        windowsHide: true,
        encoding: "utf-8",
        env: {
          ...process.env,
          // Keep system process probes (ps/tasklist) available, but shadow
          // every vendor dependency with a sentinel that makes accidental use
          // fail loudly. The smoke itself must select its Node fixture instead.
          PATH: `${forbiddenBin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
          HOME: outerHome,
          USERPROFILE: outerHome,
          HOMEDRIVE: "",
          HOMEPATH: outerHome,
          DUALOG_SMOKE_RUNNER_AUDIT: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `smoke failed without vendor executables: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`
            )
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });

  assert.match(
    result.stdout,
    /wait_for_partner_response smoke checks passed; verified 7 started runner processes exited/u,
    "the smoke must account for both real tool runners and all five liveness fixtures"
  );
  const auditLine = result.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith("DUALOG_SMOKE_RUNNER_AUDIT="));
  assert.ok(auditLine, "the smoke did not emit its runner cleanup audit");
  const audit = JSON.parse(auditLine.slice("DUALOG_SMOKE_RUNNER_AUDIT=".length));
  assert.equal(audit.length, 7, "every process created as a runner must be audited");
  for (const runner of audit) {
    assert.ok(Number.isSafeInteger(runner.pid) && runner.pid > 0);
    assert.ok(
      runner.final_probe === "gone" || runner.final_probe === "reused",
      `runner ${runner.pid} remained ${runner.final_probe}`
    );
    assert.throws(
      () => process.kill(runner.pid, 0),
      (err) => err?.code === "ESRCH",
      `runner pid ${runner.pid} still existed after the smoke exited`
    );
  }
  assert.doesNotMatch(result.stderr, /not found|ENOENT|requires a runnable tmux/iu);
  assert.doesNotMatch(
    result.stderr,
    /FORBIDDEN_VENDOR_EXECUTABLE/u,
    "the smoke must not invoke Claude, Codex, or tmux"
  );
  assert.deepEqual(fs.readdirSync(outerHome), ["forbidden-vendor-bin"]);
});
