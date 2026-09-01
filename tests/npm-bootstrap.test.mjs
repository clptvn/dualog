import test from "node:test";
import assert from "node:assert/strict";
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

test("the fresh installer wires dependency bootstrap through the safe helper", () => {
  assert.match(INSTALL_SOURCE, /import \{ runNpmInstallBootstrap \}/u);
  assert.match(
    INSTALL_SOURCE,
    /function runNpmInstall\(\) \{\s*runNpmInstallBootstrap\(\{ cwd: REPO_ROOT \}\);\s*\}/u
  );
  assert.doesNotMatch(INSTALL_SOURCE, /spawnSync\(\s*["']npm\.cmd["']/u);
});

test("win32 runs bundled npm-cli.js with Node and preserves metacharacter paths as argv", () => {
  const execPath = String.raw`C:\Program Files & Tools (x64)\node.exe`;
  const npmCli = path.win32.join(
    path.win32.dirname(execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  const cwd = String.raw`C:\source\review & merge (final)`;
  const calls = [];

  const invocation = runNpmInstallBootstrap({
    cwd,
    platform: "win32",
    execPath,
    env: {},
    existsSync: (candidate) => candidate === npmCli,
    spawnSyncFn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
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
    env: { npm_execpath: npmExecPath },
    existsSync: (candidate) => candidate === npmExecPath,
  });

  assert.deepEqual(invocation, {
    command: execPath,
    args: [npmExecPath, "install", "--silent"],
    route: "npm-cli-js",
  });
});

test("win32 fallback uses ComSpec with a fixed command and no interpolated paths", () => {
  const execPath = String.raw`C:\Node & Missing\node.exe`;
  const comspec = String.raw`C:\Windows & Tools\System32\cmd.exe`;
  const cwd = String.raw`C:\repo & echo PWNED (still data)`;
  const calls = [];

  runNpmInstallBootstrap({
    cwd,
    platform: "win32",
    execPath,
    env: { ComSpec: comspec },
    existsSync: () => false,
    spawnSyncFn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [
    {
      command: comspec,
      args: ["/d", "/s", "/c", "npm.cmd install --silent"],
      options: {
        cwd,
        stdio: "inherit",
        windowsHide: true,
        shell: false,
      },
    },
  ]);
  assert.equal(calls[0].args.some((arg) => arg.includes(cwd)), false);
  assert.equal(calls[0].args.some((arg) => arg.includes(execPath)), false);
  assert.equal(calls[0].args.some((arg) => arg.includes(comspec)), false);
});

test("win32 missing npm fails closed instead of reporting dependencies installed", () => {
  assert.throws(
    () =>
      runNpmInstallBootstrap({
        cwd: String.raw`C:\repo`,
        platform: "win32",
        execPath: String.raw`C:\Node\node.exe`,
        env: { ComSpec: String.raw`C:\Windows\System32\cmd.exe` },
        existsSync: () => false,
        spawnSyncFn: () => ({ status: 1 }),
      }),
    /npm install failed via comspec with exit 1/
  );

  const missingComspec = Object.assign(new Error("spawn cmd.exe ENOENT"), {
    code: "ENOENT",
  });
  assert.throws(
    () =>
      runNpmInstallBootstrap({
        cwd: String.raw`C:\repo`,
        platform: "win32",
        execPath: String.raw`C:\Node\node.exe`,
        env: {},
        existsSync: () => false,
        spawnSyncFn: () => ({ status: null, error: missingComspec }),
      }),
    /npm install could not start via comspec: spawn cmd\.exe ENOENT/
  );
});

test("non-Windows bootstrap preserves the existing npm PATH invocation", () => {
  assert.deepEqual(
    resolveNpmInstallInvocation({ platform: "darwin" }),
    {
      command: "npm",
      args: ["install", "--silent"],
      route: "path",
    }
  );
});
