import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildClaudeMcpRegistration,
  buildWslLifecycleInvocation,
  persistedWslEnv,
  replaceMcpServerSection,
} from "../scripts/install-utils.mjs";
import {
  isWindowsPath,
  prepareTmuxInvocation,
  probeWslPartnerCommand,
  resolveTmuxProjectContext,
  seedWslCodexAuth,
  tmuxRoute,
  translateTmuxPath,
} from "../src/tmux-runtime.mjs";

// These are deterministic contract simulations runnable on macOS/Linux CI.
// They exercise the production routing/config builders at the wsl.exe boundary,
// but they are deliberately not presented as a real Windows + WSL end-to-end
// launch. A Windows host smoke test is still required for OS integration proof.

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DISTRO = "Ubuntu-24.04";
const FAKE_WSL = "C:\\tools\\fake-wsl.exe";

const BUILTIN_ADAPTERS = Object.freeze({
  claude: JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "src", "adapters", "builtin", "claude-code.json"))
  ),
  codex: JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "src", "adapters", "builtin", "codex.json"))
  ),
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-topology-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function windowsDriveToWsl(value) {
  const match = String(value).match(/^([A-Za-z]):[\\/](.*)$/u);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

/**
 * A behavioral wsl.exe boundary: it validates the exact distribution prefix,
 * translates drive paths, and only reports the two requested partner CLIs as
 * runnable. No production branch can accidentally bypass --distribution and
 * still make this fake succeed.
 */
function fakeWslBoundary() {
  const calls = [];
  const runExecFileFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    assert.equal(command, FAKE_WSL);
    assert.deepEqual(args.slice(0, 3), ["--distribution", DISTRO, "--exec"]);

    const payload = args.slice(3);
    if (
      payload[0] === "/bin/sh" &&
      payload[1] === "-c" &&
      String(payload[2]).includes("getent passwd")
    ) {
      return { exitCode: 0, stdout: "/bin/bash\n", stderr: "" };
    }
    if (payload[0] === "wslpath") {
      return { exitCode: 0, stdout: `${windowsDriveToWsl(payload.at(-1))}\n`, stderr: "" };
    }
    if (
      payload[0] === "/bin/bash" &&
      payload[1] === "-lic" &&
      payload[2] === 'exec "$@"' &&
      ["claude", "codex"].includes(payload[4]) &&
      payload.at(-1) === "--version"
    ) {
      return { exitCode: 0, stdout: `${payload[4]} fixture\n`, stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: `unsupported fake WSL payload: ${payload}` };
  };
  return { calls, runExecFileFn };
}

function nativeRegistrationFixtures(cliStatus) {
  const env = persistedWslEnv(cliStatus, { platform: "win32" });
  return {
    claude: buildClaudeMcpRegistration({
      serverPath: "C:\\dualog\\src\\dialog-server.mjs",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      cliStatus,
      platform: "win32",
    }),
    codex: replaceMcpServerSection("", {
      serverPath: "C:\\dualog\\src\\dialog-server.mjs",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      env,
    }),
  };
}

function wslRegistrationFixtures(cliStatus) {
  const env = persistedWslEnv(cliStatus, { platform: "linux" });
  return {
    claude: buildClaudeMcpRegistration({
      serverPath: "/mnt/c/dualog/src/dialog-server.mjs",
      nodePath: "/usr/bin/node",
      cliStatus,
      platform: "linux",
    }),
    codex: replaceMcpServerSection("", {
      serverPath: "/mnt/c/dualog/src/dialog-server.mjs",
      nodePath: "/usr/bin/node",
      env,
    }),
  };
}

test("native Windows host registrations pin the same WSL distro for both Desktop hosts", () => {
  const cliStatus = {
    wsl: {
      binary: "C:\\Windows\\System32\\wsl.exe",
      binaryAvailable: true,
      distroAvailable: true,
      distro: DISTRO,
    },
  };
  const registrations = nativeRegistrationFixtures(cliStatus);

  // Claude Code and Claude Desktop's Code surface consume the same Claude MCP
  // registration. The installer must pin it just like Codex's TOML entry.
  assert.deepEqual(registrations.claude, {
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\dualog\\src\\dialog-server.mjs"],
    env: {
      DUALOG_WSL_DISTRO: DISTRO,
      DUALOG_WSL_BINARY: "C:\\Windows\\System32\\wsl.exe",
    },
  });
  assert.match(registrations.codex, /\[mcp_servers\.dualog\]/u);
  assert.match(registrations.codex, /DUALOG_WSL_DISTRO = "Ubuntu-24\.04"/u);
  assert.match(
    registrations.codex,
    /DUALOG_WSL_BINARY = "C:\\\\Windows\\\\System32\\\\wsl\.exe"/u
  );
  assert.match(registrations.codex, /C:\\\\Program Files\\\\nodejs\\\\node\.exe/u);
});

test("the Windows installer re-enters the selected WSL distro once to install both WSL hosts", () => {
  const invocation = buildWslLifecycleInvocation({
    operation: "install",
    route: { binary: FAKE_WSL, distro: DISTRO },
    nodePath: "/home/test/.nvm/versions/node/v22/bin/node",
    scriptPath: "/mnt/c/dualog/scripts/install.mjs",
    modeArgument: "--both",
  });
  assert.equal(invocation.command, FAKE_WSL);
  assert.deepEqual(invocation.args.slice(0, 3), [
    "--distribution",
    DISTRO,
    "--exec",
  ]);
  assert.ok(invocation.args.includes("DUALOG_INSTALL_HOST_ONLY=1"));
  assert.deepEqual(invocation.args.slice(-3), [
    "/mnt/c/dualog/scripts/install.mjs",
    "--both",
    "--host-only",
  ]);

  // What that nested Linux/WSL installer writes is intentionally local: it
  // must not recursively route its own host through wsl.exe again.
  const wslRegistrations = wslRegistrationFixtures({
    wsl: { distroAvailable: true, distro: DISTRO },
  });
  assert.deepEqual(wslRegistrations.claude, {
    command: "/usr/bin/node",
    args: ["/mnt/c/dualog/src/dialog-server.mjs"],
  });
  assert.doesNotMatch(wslRegistrations.codex, /DUALOG_WSL_/u);
  assert.match(wslRegistrations.codex, /command = "\/usr\/bin\/node"/u);
});

test("all four requested host-to-partner topologies keep paths and transport in one runtime", async () => {
  const cases = [
    {
      name: "native Windows Codex host -> Claude in WSL",
      host: "codex",
      partner: "claude",
      platform: "win32",
      projectPath: "C:\\work\\dualog",
      expectedProjectPath: "/mnt/c/work/dualog",
      expectedTransport: "wsl",
    },
    {
      name: "native Windows Claude Desktop/Code host -> Codex in WSL",
      host: "claude",
      partner: "codex",
      platform: "win32",
      projectPath: `\\\\wsl.localhost\\${DISTRO}\\home\\test\\dualog`,
      expectedProjectPath: "/home/test/dualog",
      expectedTransport: "wsl",
    },
    {
      name: "Claude WSL/Linux host -> Codex in the same WSL/Linux runtime",
      host: "claude",
      partner: "codex",
      platform: "linux",
      projectPath: "/home/test/dualog",
      expectedProjectPath: "/home/test/dualog",
      expectedTransport: "local",
    },
    {
      name: "Codex WSL/Linux host -> Claude in the same WSL/Linux runtime",
      host: "codex",
      partner: "claude",
      platform: "linux",
      projectPath: "/home/test/dualog",
      expectedProjectPath: "/home/test/dualog",
      expectedTransport: "local",
    },
  ];

  const cliStatus = {
    wsl: {
      binary: "C:\\Windows\\System32\\wsl.exe",
      binaryAvailable: true,
      distroAvailable: true,
      distro: DISTRO,
    },
  };
  const nativeRegistrations = nativeRegistrationFixtures(cliStatus);
  const wslRegistrations = wslRegistrationFixtures(cliStatus);

  for (const topology of cases) {
    const adapter = BUILTIN_ADAPTERS[topology.partner];
    assert.equal(adapter.binary.default, topology.partner, topology.name);
    assert.equal(adapter.engines.default, "tmux-interactive", topology.name);

    const hostRegistration =
      topology.platform === "win32"
        ? nativeRegistrations[topology.host]
        : wslRegistrations[topology.host];
    if (typeof hostRegistration === "string") {
      assert.match(hostRegistration, /\[mcp_servers\.dualog\]/u, topology.name);
    } else {
      assert.equal(hostRegistration.args.length, 1, topology.name);
    }

    const route = tmuxRoute({
      platform: topology.platform,
      env: {
        DUALOG_WSL_BINARY: FAKE_WSL,
        DUALOG_WSL_DISTRO: DISTRO,
      },
    });
    assert.equal(route.transport, topology.expectedTransport, topology.name);

    const fake = fakeWslBoundary();
    const projectContext = await resolveTmuxProjectContext(topology.projectPath, {
      route: { ...route, loginShell: "/bin/bash" },
      runExecFileFn: fake.runExecFileFn,
    });
    assert.equal(projectContext.partnerProjectPath, topology.expectedProjectPath, topology.name);

    const hostSessionPath =
      topology.platform === "win32"
        ? "C:\\Users\\test\\.dualog\\sessions\\fixture"
        : "/home/test/.dualog/sessions/fixture";
    const hostConfigPath =
      topology.platform === "win32"
        ? `${hostSessionPath}\\${topology.partner === "codex" ? "codex-home" : "claude-empty-mcp.json"}`
        : `${hostSessionPath}/${topology.partner === "codex" ? "codex-home" : "claude-empty-mcp.json"}`;
    const hostArgs =
      topology.partner === "codex"
        ? ["-C", topology.projectPath, "--add-dir", hostSessionPath]
        : ["--add-dir", topology.projectPath, "--mcp-config", hostConfigPath];
    const hostEnv =
      topology.partner === "codex"
        ? { CODEX_HOME: hostConfigPath, DUALOG_DEPTH: "1" }
        : { DUALOG_DEPTH: "1" };
    const convertPath = (value, { route: selectedRoute }) =>
      translateTmuxPath(value, {
        route: selectedRoute,
        runExecFileFn: fake.runExecFileFn,
      });
    const invocation = await prepareTmuxInvocation(
      {
        cwd: topology.projectPath,
        command: adapter.binary.default,
        args: hostArgs,
        env: hostEnv,
      },
      { route: projectContext.tmuxRoute, convertPath }
    );

    assert.equal(invocation.tmuxTransport, topology.expectedTransport, topology.name);
    assert.equal(invocation.cwd, topology.expectedProjectPath, topology.name);
    assert.equal(invocation.command, topology.partner, topology.name);
    assert.equal(invocation.args[1], topology.expectedProjectPath, topology.name);
    assert.equal(invocation.tmuxDistro, topology.platform === "win32" ? DISTRO : null);

    if (topology.platform === "win32") {
      assert.equal(
        await probeWslPartnerCommand(topology.partner, ["--version"], {
          route: projectContext.tmuxRoute,
          runExecFileFn: fake.runExecFileFn,
        }),
        "available",
        topology.name
      );
      assert.ok(fake.calls.length > 0, topology.name);
      assert.ok(
        fake.calls.every(({ args }) =>
          args.slice(0, 3).every((value, index) =>
            value === ["--distribution", DISTRO, "--exec"][index]
          )
        ),
        `${topology.name}: every WSL call must remain pinned to ${DISTRO}`
      );
      assert.ok(
        [invocation.cwd, invocation.command, ...invocation.args, ...Object.values(invocation.env)].every(
          (value) => !isWindowsPath(value)
        ),
        `${topology.name}: the Linux CLI must receive no native drive or WSL UNC paths`
      );
    } else {
      assert.equal(fake.calls.length, 0, `${topology.name}: Linux must not call wsl.exe`);
      assert.deepEqual(invocation.args, hostArgs);
      assert.deepEqual(invocation.env, hostEnv);
    }
  }
});

test("Codex-in-WSL auth seeds into an isolated native lease without exposing the token", async (t) => {
  const nativeCodexHome = path.join(tempDir(t), "codex-home");
  fs.mkdirSync(nativeCodexHome, { recursive: true });
  const secret = "fixture-token-must-not-cross-wsl-argv";
  const calls = [];
  const route = tmuxRoute({
    platform: "win32",
    env: { DUALOG_WSL_BINARY: FAKE_WSL, DUALOG_WSL_DISTRO: DISTRO },
  });

  const seeded = await seedWslCodexAuth(
    {
      nativeCodexHome,
      wslCodexHome: "/mnt/c/dualog/session/codex-home",
      route: { ...route, loginShell: "/bin/bash" },
    },
    {
      runExecFileFn: async (command, args) => {
        calls.push({ command, args: [...args] });
        fs.writeFileSync(path.join(nativeCodexHome, "auth.json"), secret, { mode: 0o600 });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }
  );

  assert.deepEqual(seeded, { seeded: true, reason: null });
  assert.equal(fs.readFileSync(path.join(nativeCodexHome, "auth.json"), "utf-8"), secret);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, FAKE_WSL);
  assert.deepEqual(calls[0].args.slice(0, 3), ["--distribution", DISTRO, "--exec"]);
  assert.match(
    calls[0].args.join("\n"),
    /CODEX_HOME:-"\$HOME\/\.codex"/u,
    "the WSL copy must source its selected distro's Codex home"
  );
  assert.doesNotMatch(calls[0].args.join("\n"), new RegExp(secret, "u"));

  let calledAgain = false;
  const nativeWins = await seedWslCodexAuth(
    {
      nativeCodexHome,
      wslCodexHome: "/mnt/c/dualog/session/codex-home",
      route: { ...route, loginShell: "/bin/bash" },
    },
    {
      runExecFileFn: async () => {
        calledAgain = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }
  );
  assert.deepEqual(nativeWins, { seeded: false, reason: "native-seed-present" });
  assert.equal(calledAgain, false, "an existing native auth seed must never be overwritten");
});

test("macOS keeps the historical native tmux route even when WSL variables leak into env", async () => {
  const route = tmuxRoute({
    platform: "darwin",
    env: {
      DUALOG_WSL_BINARY: FAKE_WSL,
      DUALOG_WSL_DISTRO: DISTRO,
    },
  });
  assert.deepEqual(route, {
    transport: "local",
    command: "tmux",
    distro: null,
    tmuxBinary: "tmux",
    tmuxSocketName: "dualog",
  });

  let translated = false;
  const invocation = await prepareTmuxInvocation(
    {
      cwd: "/Users/test/dualog",
      command: "claude",
      args: ["--add-dir", "/Users/test/dualog"],
      env: { CLAUDE_CONFIG_DIR: "/Users/test/.claude" },
    },
    {
      route,
      convertPath: async () => {
        translated = true;
        throw new Error("macOS must not enter path translation");
      },
    }
  );
  assert.equal(translated, false);
  assert.equal(invocation.cwd, "/Users/test/dualog");
  assert.equal(invocation.tmuxTransport, "local");
  assert.equal(invocation.tmuxDistro, null);
});
