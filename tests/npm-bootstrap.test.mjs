import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveNpmInstallInvocation,
  runNpmInstallBootstrap,
} from "../scripts/npm-bootstrap.mjs";

const INSTALL_SOURCE = fs.readFileSync(
  fileURLToPath(new URL("../scripts/install.mjs", import.meta.url)),
  "utf-8"
);

function completedChild(status = 0, signal = null) {
  const child = new EventEmitter();
  child.pid = 4242;
  queueMicrotask(() => child.emit("close", status, signal));
  return child;
}

test("the fresh installer wires dependency bootstrap through the safe helper", () => {
  assert.match(INSTALL_SOURCE, /import \{ runNpmInstallBootstrap \}/u);
  assert.match(
    INSTALL_SOURCE,
    /async function runNpmInstall\(\) \{\s*await runNpmInstallBootstrap\(\{ cwd: REPO_ROOT \}\);\s*\}/u
  );
  assert.match(INSTALL_SOURCE, /async function ensureDependencies\(\)/u);
  assert.match(INSTALL_SOURCE, /await runNpmInstall\(\)/u);
  assert.match(INSTALL_SOURCE, /await ensureDependencies\(\)/u);
  assert.doesNotMatch(INSTALL_SOURCE, /spawnSync\(\s*["']npm\.cmd["']/u);
});

test("win32 runs bundled npm-cli.js with Node and preserves metacharacter paths as argv", async () => {
  const execPath = String.raw`C:\Program Files & Tools (x64)\node.exe`;
  const npmCli = path.win32.join(
    path.win32.dirname(execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  const cwd = String.raw`C:\source\review & merge (final)`;
  const env = {
    SystemRoot: String.raw`C:\Windows`,
    ComSpec: String.raw`C:\attacker-one\cmd.exe`,
    COMSPEC: String.raw`C:\attacker-two\cmd.exe`,
    cOmSpEc: String.raw`C:\attacker-three\cmd.exe`,
    DUALOG_KEEP: "yes",
  };
  const trustedEnv = {
    SystemRoot: String.raw`C:\Windows`,
    DUALOG_KEEP: "yes",
    ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
  };
  const calls = [];

  const invocation = await runNpmInstallBootstrap({
    cwd,
    platform: "win32",
    execPath,
    env,
    existsSync: (candidate) => candidate === npmCli,
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return completedChild();
    },
  });

  assert.deepEqual(invocation, {
    command: execPath,
    args: [npmCli, "install", "--silent"],
    route: "npm-cli-js",
  });
  assert.deepEqual(calls, [
    {
      command: execPath,
      args: [npmCli, "install", "--silent"],
      options: {
        cwd,
        env: trustedEnv,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
      },
    },
  ]);
});

test("win32 accepts npm's absolute npm_execpath when node.exe is a version-manager shim", () => {
  const execPath = String.raw`C:\Tools\Volta & Friends\node.exe`;
  const npmExecPath = String.raw`C:\Users\A&B\npm cache (active)\npm-cli.js`;

  const invocation = resolveNpmInstallInvocation({
    platform: "win32",
    execPath,
    env: {
      SystemRoot: String.raw`C:\Windows`,
      npm_execpath: npmExecPath,
    },
    existsSync: (candidate) => candidate === npmExecPath,
  });

  assert.deepEqual(invocation, {
    command: execPath,
    args: [npmExecPath, "install", "--silent"],
    route: "npm-cli-js",
  });
});

test("win32 fallback ignores ComSpec and uses trusted System32 with a fixed command", async () => {
  const execPath = String.raw`C:\Node & Missing\node.exe`;
  const systemCmd = String.raw`D:\WinNT\System32\cmd.exe`;
  const cwd = String.raw`C:\repo & echo PWNED (still data)`;
  const env = {
    SystemRoot: String.raw`D:\WinNT`,
    ComSpec: String.raw`C:\attacker\cmd.exe`,
    COMSPEC: String.raw`C:\also-attacker\cmd.exe`,
    cOmSpEc: String.raw`C:\third-attacker\cmd.exe`,
    DUALOG_KEEP: "yes",
  };
  const trustedEnv = {
    SystemRoot: String.raw`D:\WinNT`,
    DUALOG_KEEP: "yes",
    ComSpec: systemCmd,
  };
  const calls = [];

  await runNpmInstallBootstrap({
    cwd,
    platform: "win32",
    execPath,
    env,
    existsSync: () => false,
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      return completedChild();
    },
  });

  assert.deepEqual(calls, [
    {
      command: systemCmd,
      args: ["/d", "/s", "/c", "npm.cmd install --silent"],
      options: {
        cwd,
        env: trustedEnv,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
      },
    },
  ]);
  assert.equal(calls[0].args.some((arg) => arg.includes(cwd)), false);
  assert.equal(calls[0].args.some((arg) => arg.includes(execPath)), false);
  assert.equal(calls[0].args.some((arg) => arg.includes(systemCmd)), false);
});

test("win32 invalid SystemRoot fails closed before any executable starts", async () => {
  for (const systemRoot of [
    undefined,
    "",
    String.raw`C:\Users\test\Windows`,
    String.raw`C:\Windows\..\Temp`,
  ]) {
    for (const npmCliExists of [false, true]) {
      let spawnCalled = false;
      await assert.rejects(
        () =>
          runNpmInstallBootstrap({
            cwd: String.raw`C:\repo`,
            platform: "win32",
            execPath: String.raw`C:\Node\node.exe`,
            env: {
              ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }),
              ComSpec: String.raw`C:\attacker\cmd.exe`,
            },
            existsSync: () => npmCliExists,
            spawnFn: () => {
              spawnCalled = true;
              return completedChild();
            },
          }),
        /trusted top-level Windows System32 directory/u
      );
      assert.equal(
        spawnCalled,
        false,
        `SystemRoot ${String(systemRoot)} executed a command (npm CLI exists: ${npmCliExists})`
      );
    }
  }
});

test("win32 missing npm fails closed instead of reporting dependencies installed", async () => {
  await assert.rejects(
    () =>
      runNpmInstallBootstrap({
        cwd: String.raw`C:\repo`,
        platform: "win32",
        execPath: String.raw`C:\Node\node.exe`,
        env: { SystemRoot: String.raw`C:\Windows` },
        existsSync: () => false,
        spawnFn: () => completedChild(1),
      }),
    /npm install failed via system32-cmd with exit 1/
  );

  const missingSystemCmd = Object.assign(new Error("spawn cmd.exe ENOENT"), {
    code: "ENOENT",
  });
  await assert.rejects(
    () =>
      runNpmInstallBootstrap({
        cwd: String.raw`C:\repo`,
        platform: "win32",
        execPath: String.raw`C:\Node\node.exe`,
        env: { SystemRoot: String.raw`C:\Windows` },
        existsSync: () => false,
        spawnFn: () => {
          throw missingSystemCmd;
        },
      }),
    /npm install could not start via system32-cmd: spawn cmd\.exe ENOENT/
  );
});

test("win32 timeout terminates the exact live npm descendant tree before detaching", async () => {
  const order = [];
  const child = new EventEmitter();
  child.pid = 0xf00d;
  child.stdin = { destroy: () => order.push("destroy-stdin") };
  child.stdout = { destroy: () => order.push("destroy-stdout") };
  child.stderr = { destroy: () => order.push("destroy-stderr") };
  child.unref = () => order.push("unref");
  const env = { SystemRoot: String.raw`C:\Windows` };
  const execPath = String.raw`C:\Node\node.exe`;
  const npmCli = String.raw`C:\Node\node_modules\npm\bin\npm-cli.js`;
  let spawnedEnv;

  await assert.rejects(
    () =>
      runNpmInstallBootstrap({
        cwd: String.raw`C:\repo`,
        platform: "win32",
        execPath,
        env,
        existsSync: (candidate) => candidate === npmCli,
        spawnFn(_command, _args, options) {
          spawnedEnv = options.env;
          return child;
        },
        terminateTreeFn(pid, options) {
          order.push("taskkill-tree");
          assert.equal(pid, child.pid);
          assert.strictEqual(options.env, spawnedEnv);
          assert.deepEqual(options.env, {
            SystemRoot: String.raw`C:\Windows`,
            ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
          });
          return { status: "succeeded", attempted: true, reason: null };
        },
        timeoutMs: 5,
      }),
    (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.match(error.message, /timed out via npm-cli-js after 5ms/u);
      assert.deepEqual(error.windowsTreeTermination, {
        status: "succeeded",
        attempted: true,
        reason: null,
      });
      return true;
    }
  );

  assert.deepEqual(order, [
    "taskkill-tree",
    "destroy-stdin",
    "destroy-stdout",
    "destroy-stderr",
    "unref",
  ]);
});

test("win32 timeout reports a failed full-tree termination explicitly", async () => {
  const child = new EventEmitter();
  child.pid = 31337;
  child.unref = () => {};

  await assert.rejects(
    () =>
      runNpmInstallBootstrap({
        cwd: String.raw`C:\repo`,
        platform: "win32",
        execPath: String.raw`C:\Node\node.exe`,
        env: { SystemRoot: String.raw`C:\Windows` },
        existsSync: () => true,
        spawnFn: () => child,
        terminateTreeFn: () => ({
          status: "failed",
          attempted: true,
          reason: "taskkill.exe denied access",
        }),
        timeoutMs: 5,
      }),
    /timed out via npm-cli-js after 5ms; taskkill\.exe denied access/u
  );
});

test("non-Windows bootstrap preserves the existing npm PATH invocation", async () => {
  assert.deepEqual(
    resolveNpmInstallInvocation({ platform: "darwin" }),
    {
      command: "npm",
      args: ["install", "--silent"],
      route: "path",
    }
  );

  const calls = [];
  const child = new EventEmitter();
  child.pid = 8080;
  child.kill = () => {
    throw new Error("POSIX bootstrap must not kill only npm and orphan descendants");
  };
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    ComSpec: "/tmp/posix-value-one",
    COMSPEC: "/tmp/posix-value-two",
    cOmSpEc: "/tmp/posix-value-three",
  };
  const invocation = await runNpmInstallBootstrap({
    cwd: "/tmp/dualog bootstrap & review",
    platform: "darwin",
    env,
    // A Windows-only bound must not change the formerly unbounded native Mac
    // behavior, even when a caller supplies a very short timeout value.
    timeoutMs: 1,
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      assert.strictEqual(options.env, env);
      setTimeout(() => child.emit("close", 0, null), 15);
      return child;
    },
  });

  assert.deepEqual(invocation, {
    command: "npm",
    args: ["install", "--silent"],
    route: "path",
  });
  assert.deepEqual(calls, [
    {
      command: "npm",
      args: ["install", "--silent"],
      options: {
        cwd: "/tmp/dualog bootstrap & review",
        env,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
      },
    },
  ]);
});
