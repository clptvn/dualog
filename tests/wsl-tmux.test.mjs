import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  inspectWslPartnerCommand,
  isWindowsPath,
  parseWslUncPath,
  prepareTmuxInvocation,
  probeWslPaneProcess,
  probeWslPartnerCommand,
  resolveTmuxProjectContext,
  resolveWslLoginShell,
  resolveWslPartnerExecutable,
  seedWslCodexAuth,
  terminateTmuxSession,
  tmuxPaneProcessStartTime,
  probeTmuxSessionSync,
  tmuxRoute,
  translateTmuxPath,
  WSL_PARTNER_EXECUTABLE_RESOLVE_SCRIPT,
} from "../src/tmux-runtime.mjs";
import {
  probePartnerPaneProcess,
  resolvePartnerRuntimeContext,
} from "../src/partner-invocation.mjs";

const WSL_ROUTE = Object.freeze({
  transport: "wsl",
  command: "wsl.exe",
  distro: "Ubuntu",
  tmuxBinary: "tmux",
  tmuxSocketName: "dualog",
});

test("native Windows uses the configured WSL distribution for tmux", () => {
  assert.deepEqual(
    tmuxRoute({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", DUALOG_WSL_DISTRO: "Ubuntu" },
    }),
    {
      ...WSL_ROUTE,
      command: "C:\\Windows\\System32\\wsl.exe",
    }
  );
});

test("native Windows resolves bare default WSL through trusted System32 only", () => {
  assert.equal(
    tmuxRoute({
      platform: "win32",
      env: {
        SystemRoot: "D:\\WinNT",
        PATH: "C:\\attacker",
        DUALOG_WSL_BINARY: "wsl.exe",
      },
    }).command,
    "D:\\WinNT\\System32\\wsl.exe"
  );

  for (const systemRoot of [
    undefined,
    "C:\\Users\\test\\Windows",
    "C:\\Windows\\..\\Temp",
    '"C:\\Windows"',
    "C:\\Windows:payload",
  ]) {
    assert.throws(
      () =>
        tmuxRoute({
          platform: "win32",
          env: {
            ...(systemRoot === undefined ? {} : { SystemRoot: systemRoot }),
            DUALOG_WSL_BINARY: "wsl.exe",
          },
        }),
      /SystemRoot did not resolve to a trusted top-level Windows System32 directory/u
    );
  }
});

test("native macOS and Linux retain the local tmux route", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(tmuxRoute({ platform, env: { DUALOG_WSL_DISTRO: "Ubuntu" } }), {
      transport: "local",
      command: "tmux",
      distro: null,
      tmuxBinary: "tmux",
      tmuxSocketName: "dualog",
    });
  }
});

test("an explicit tmux executable keeps the local route on Windows", () => {
  for (const command of ["C:\\tools\\tmux.exe", "\\\\server\\share\\tools\\tmux.com"]) {
    assert.deepEqual(
      tmuxRoute({ platform: "win32", env: { DUALOG_TMUX_BINARY: command } }),
      {
        transport: "local",
        command,
        distro: null,
        tmuxBinary: command,
        tmuxSocketName: "dualog",
      }
    );
  }
});

test("native Windows accepts only the default or a durable absolute WSL launcher", () => {
  for (const command of ["C:\\tools\\wsl.exe", "\\\\server\\share\\tools\\wsl.com"]) {
    assert.deepEqual(
      tmuxRoute({
        platform: "win32",
        env: { DUALOG_WSL_BINARY: command, DUALOG_WSL_DISTRO: "Ubuntu" },
      }),
      { ...WSL_ROUTE, command }
    );
  }
});

test("native Windows refuses wrapper-backed tmux before synchronous cleanup probes", () => {
  const unsafeCommands = [
    "C:\\tools\\tmux.cmd",
    "C:\\tools\\tmux.BAT",
    "C:\\tools\\tmux.CmD.",
    "tmux-wrapper",
    "tmux.exe",
  ];
  for (const command of unsafeCommands) {
    assert.throws(
      () =>
        tmuxRoute({
          platform: "win32",
          env: { DUALOG_TMUX_BINARY: command },
        }),
      /(?:tmux launcher on Windows.*(?:directly executable|must end in \.exe or \.com)|custom tmux launcher on Windows must be an absolute)/iu
    );

    const spawnSyncFn = () =>
      assert.fail("an unsafe native tmux wrapper must never reach a synchronous spawn");
    assert.equal(
      probeTmuxSessionSync("dlg-native-wrapper-safety", {
        platform: "win32",
        route: {
          transport: "local",
          command,
          distro: null,
          tmuxBinary: command,
        },
        spawnSyncFn,
      }),
      "unknown"
    );
  }

  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(
      tmuxRoute({
        platform,
        env: { DUALOG_TMUX_BINARY: "/opt/tools/tmux.cmd" },
      }),
      {
        transport: "local",
        command: "/opt/tools/tmux.cmd",
        distro: null,
        tmuxBinary: "/opt/tools/tmux.cmd",
        tmuxSocketName: "dualog",
      }
    );
  }
});

test("custom WSL command wrappers are refused before every synchronous cleanup probe", () => {
  for (const suffix of ["cmd", "BAT", "CmD."]) {
    const command = `C:\\tools\\wsl.${suffix}`;
    assert.throws(
      () =>
        tmuxRoute({
          platform: "win32",
          env: { DUALOG_WSL_BINARY: command },
        }),
      /directly executable binary.*\.cmd\/\.bat wrapper/iu
    );

    const route = { ...WSL_ROUTE, command };
    const spawnSyncFn = () =>
      assert.fail("an unsafe WSL wrapper must never reach a synchronous spawn");
    assert.equal(
      tmuxPaneProcessStartTime(42, {
        platform: "win32",
        transport: "wsl",
        distro: "Ubuntu",
        route,
        spawnSyncFn,
      }),
      null
    );
    assert.equal(
      probeWslPaneProcess(42, null, {
        platform: "win32",
        transport: "wsl",
        distro: "Ubuntu",
        route,
        spawnSyncFn,
      }),
      "unknown"
    );
    assert.equal(
      probeTmuxSessionSync("dlg-wrapper-safety", {
        platform: "win32",
        transport: "wsl",
        distro: "Ubuntu",
        route,
        spawnSyncFn,
      }),
      "unknown"
    );
  }

  assert.throws(
    () =>
      tmuxRoute({
        platform: "win32",
        env: { DUALOG_WSL_BINARY: "wsl-wrapper" },
      }),
    /must end in \.exe or \.com.*PATHEXT/iu
  );
  assert.throws(
    () =>
      tmuxRoute({
        platform: "win32",
        env: { DUALOG_WSL_BINARY: ".\\wsl.exe" },
      }),
    /custom WSL launcher on Windows must be an absolute drive or UNC path/iu
  );

  const extensionlessRoute = { ...WSL_ROUTE, command: "wsl-wrapper" };
  const spawnSyncFn = () =>
    assert.fail("an extensionless WSL command must never reach a synchronous spawn");
  assert.equal(
    tmuxPaneProcessStartTime(42, {
      platform: "win32",
      route: extensionlessRoute,
      spawnSyncFn,
    }),
    null
  );
  assert.equal(
    probeWslPaneProcess(42, null, {
      platform: "win32",
      route: extensionlessRoute,
      spawnSyncFn,
    }),
    "unknown"
  );
  assert.equal(
    probeTmuxSessionSync("dlg-extensionless-wsl", {
      platform: "win32",
      route: extensionlessRoute,
      spawnSyncFn,
    }),
    "unknown"
  );
});

test("persisted tmux identity is comparison-only and cross-host drift never spawns", async () => {
  const currentRoute = {
    ...WSL_ROUTE,
    command: "C:\\HostA\\wsl.exe",
    tmuxSocketName: "dualog-host-a",
  };
  const matching = {
    platform: "win32",
    route: currentRoute,
    transport: "wsl",
    distro: "ubuntu",
    tmuxLauncher: "c:/hosta/WSL.EXE",
    tmuxControlBinary: "tmux",
    tmuxSocketName: "dualog-host-a",
    requireExactIdentity: true,
  };
  const launches = [];
  assert.equal(
    probeTmuxSessionSync("dlg-exact-route", {
      ...matching,
      spawnSyncFn: (command, args) => {
        launches.push({ command, args });
        return { status: 1, stdout: "", stderr: "can't find session: dlg-exact-route" };
      },
    }),
    "absent"
  );
  assert.deepEqual(launches, [
    {
      command: "C:\\HostA\\wsl.exe",
      args: [
        "--distribution",
        "Ubuntu",
        "--exec",
        "tmux",
        "-f",
        "/dev/null",
        "-L",
        "dualog-host-a",
        "has-session",
        "-t",
        "=dlg-exact-route",
      ],
    },
  ]);

  for (const drift of [
    { tmuxLauncher: "C:\\HostB\\wsl.exe" },
    { tmuxControlBinary: "other-tmux" },
    { tmuxControlBinary: "TMUX" },
    { tmuxSocketName: "dualog-host-b" },
    { distro: "Debian" },
  ]) {
    assert.equal(
      probeTmuxSessionSync("dlg-cross-host", {
        ...matching,
        ...drift,
        spawnSyncFn: () =>
          assert.fail("recorded host A identity must never be executed by host B"),
      }),
      "unknown"
    );
  }
  assert.equal(
    probeTmuxSessionSync("dlg-legacy-route", {
      platform: "win32",
      route: currentRoute,
      transport: "wsl",
      distro: "Ubuntu",
      requireExactIdentity: true,
      spawnSyncFn: () => assert.fail("missing persisted identity must not spawn"),
    }),
    "unknown"
  );

  const previousSocket = process.env.DUALOG_TMUX_SOCKET;
  process.env.DUALOG_TMUX_SOCKET = "dualog-host-b";
  try {
    assert.equal(
      await terminateTmuxSession({
        sessionName: "dlg-host-a",
        paneTarget: "dlg-host-a:0.0",
        tmuxTransport: "local",
        tmuxDistro: null,
        tmuxLauncher: "tmux",
        tmuxControlBinary: "tmux",
        tmuxSocketName: "dualog-host-a",
        tmuxIdentityRequired: true,
      }),
      "unknown",
      "host B must refuse to terminate host A's recorded socket"
    );
  } finally {
    if (previousSocket === undefined) delete process.env.DUALOG_TMUX_SOCKET;
    else process.env.DUALOG_TMUX_SOCKET = previousSocket;
  }
});

test("tmux command identity follows the native platform's case semantics", () => {
  const darwinRoute = {
    transport: "local",
    command: "C:\\TOOLS\\TMUX",
    distro: null,
    tmuxBinary: "C:\\TOOLS\\TMUX",
    tmuxSocketName: "dualog-case",
  };
  assert.equal(
    probeTmuxSessionSync("dlg-darwin-case", {
      platform: "darwin",
      route: darwinRoute,
      transport: "local",
      distro: null,
      tmuxLauncher: "c:\\tools\\tmux",
      tmuxControlBinary: "c:\\tools\\tmux",
      tmuxSocketName: "dualog-case",
      requireExactIdentity: true,
      spawnSyncFn: () =>
        assert.fail("a case-distinct POSIX command identity must never spawn"),
    }),
    "unknown"
  );

  const windowsRoute = {
    transport: "local",
    command: "C:\\TOOLS\\TMUX.EXE",
    distro: null,
    tmuxBinary: "C:\\TOOLS\\TMUX.EXE",
    tmuxSocketName: "dualog-case",
  };
  const launches = [];
  assert.equal(
    probeTmuxSessionSync("dlg-windows-case", {
      platform: "win32",
      route: windowsRoute,
      transport: "local",
      distro: null,
      tmuxLauncher: "c:/tools/tmux.exe",
      tmuxControlBinary: "c:/tools/tmux.exe",
      tmuxSocketName: "dualog-case",
      requireExactIdentity: true,
      spawnSyncFn: (command, args) => {
        launches.push({ command, args });
        return { status: 1, stdout: "", stderr: "can't find session" };
      },
    }),
    "absent"
  );
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, windowsRoute.command);
});

test("both WSL UNC spellings are Windows paths with an explicit distro", () => {
  assert.equal(isWindowsPath("C:\\repo"), true);
  assert.equal(isWindowsPath("\\\\wsl$\\Ubuntu\\home\\cameron\\repo"), true);
  assert.equal(isWindowsPath("\\\\wsl.localhost\\Ubuntu\\home\\cameron\\repo"), true);
  assert.deepEqual(parseWslUncPath("\\\\wsl$\\Ubuntu\\home\\cameron\\repo"), {
    distro: "Ubuntu",
    linuxPath: "/home/cameron/repo",
  });
  assert.deepEqual(parseWslUncPath("\\\\wsl.localhost\\Ubuntu"), {
    distro: "Ubuntu",
    linuxPath: "/",
  });
  assert.equal(isWindowsPath("\\\\server\\share\\repo"), false);
});

test("WSL UNC paths translate directly and reject a selected-distro mismatch", async () => {
  const noProcess = async () => {
    throw new Error("UNC translation must not spawn wslpath");
  };
  assert.equal(
    await translateTmuxPath("\\\\wsl.localhost\\Ubuntu\\home\\cameron\\repo", {
      route: { ...WSL_ROUTE, loginShell: "/bin/bash" },
      runExecFileFn: noProcess,
    }),
    "/home/cameron/repo"
  );
  await assert.rejects(
    translateTmuxPath("\\\\wsl$\\Debian\\home\\cameron\\repo", {
      route: WSL_ROUTE,
      runExecFileFn: noProcess,
    }),
    /belongs to distribution "Debian".*routed to "Ubuntu"/u
  );
});

test("a WSL UNC project pins its distro and partner-visible Linux path", async () => {
  const context = await resolveTmuxProjectContext(
    "\\\\wsl.localhost\\Ubuntu\\home\\cameron\\repo",
    {
      route: { ...WSL_ROUTE, distro: null },
      runExecFileFn: async () => {
        throw new Error("the UNC distro should avoid a default-distro probe");
      },
    }
  );
  assert.equal(context.partnerProjectPath, "/home/cameron/repo");
  assert.equal(context.tmuxDistro, "Ubuntu");
  assert.equal(context.tmuxRoute.distro, "Ubuntu");
});

test("partner runtime context keeps explicit headless execution host-native", async () => {
  const context = await resolvePartnerRuntimeContext({
    partnerAgent: "codex",
    partnerCommand: "codex.cmd",
    projectPath: "C:\\repo",
    requestedEngine: "headless",
    log: () => {},
  });
  assert.equal(context.engine, "headless");
  assert.equal(context.partnerProjectPath, "C:\\repo");
  assert.equal(context.tmuxRoute, null);
  assert.equal(await context.toPartnerPath("C:\\repo\\diff.patch"), "C:\\repo\\diff.patch");
  assert.equal(Object.isFrozen(context), true);
});

test("the four Codex and Claude Windows/WSL partner topologies keep their intended route", async () => {
  for (const [label, partnerAgent, partnerCommand, resolvedCommand] of [
    ["Codex Desktop -> Claude WSL", "claude", "claude", "/opt/claude/bin/claude"],
    ["Claude Desktop -> Codex WSL", "codex", "codex", "/opt/codex/bin/codex"],
  ]) {
    const context = await resolvePartnerRuntimeContext(
      {
        partnerAgent,
        partnerCommand,
        projectPath: "C:\\reviewed",
      },
      {
        platform: "win32",
        tmuxRouteFn: () => WSL_ROUTE,
        resolveWslLoginShellFn: async () => "/bin/bash",
        resolveRunnableEngineFn: async (adapter, options) => {
          assert.equal(
            await options.probeWslPartnerCommandFn(
              partnerCommand,
              adapter.binary.versionArgs
            ),
            "available",
            label
          );
          return "tmux-interactive";
        },
        probeWslPartnerCommandFn: async (command, _versionArgs, { route }) => {
          assert.equal(command, resolvedCommand, label);
          assert.equal(route.distro, "Ubuntu", label);
          return "available";
        },
        resolveTmuxProjectContextFn: async (hostProjectPath, { route }) => ({
          hostProjectPath,
          partnerProjectPath: "/mnt/c/reviewed",
          tmuxTransport: "wsl",
          tmuxDistro: route.distro,
          tmuxRoute: route,
          tmuxLauncher: route.command,
          tmuxControlBinary: route.tmuxBinary,
          tmuxSocketName: route.tmuxSocketName,
        }),
        resolveWslPartnerExecutableFn: async (command, { projectPath, route }) => {
          assert.equal(command, partnerCommand, label);
          assert.equal(projectPath, "/mnt/c/reviewed", label);
          assert.equal(route.distro, "Ubuntu", label);
          return resolvedCommand;
        },
      }
    );
    assert.equal(context.tmuxTransport, "wsl", label);
    assert.equal(context.tmuxDistro, "Ubuntu", label);
    assert.equal(context.partnerCommand, resolvedCommand, label);
  }

  for (const [label, partnerAgent, partnerCommand] of [
    ["Claude WSL -> Codex WSL", "codex", "codex"],
    ["Codex WSL -> Claude WSL", "claude", "claude"],
  ]) {
    const route = {
      transport: "local",
      command: "tmux",
      distro: null,
      tmuxBinary: "tmux",
      tmuxSocketName: "dualog",
    };
    const context = await resolvePartnerRuntimeContext(
      {
        partnerAgent,
        partnerCommand,
        projectPath: "/home/test/reviewed",
      },
      {
        platform: "linux",
        tmuxRouteFn: () => route,
        resolveRunnableEngineFn: async () => "tmux-interactive",
        resolveTmuxProjectContextFn: async (hostProjectPath) => ({
          hostProjectPath,
          partnerProjectPath: hostProjectPath,
          tmuxTransport: "local",
          tmuxDistro: null,
          tmuxRoute: route,
          tmuxLauncher: "tmux",
          tmuxControlBinary: "tmux",
          tmuxSocketName: "dualog",
        }),
        resolveWslPartnerExecutableFn: async () =>
          assert.fail(`${label} must use native Linux resolution`),
      }
    );
    assert.equal(context.tmuxTransport, "local", label);
    assert.equal(context.partnerCommand, partnerCommand, label);
  }
});

test("missing WSL falls back to native headless unless tmux was explicit", async () => {
  for (const [partnerAgent, partnerCommand] of [
    ["claude", "claude.cmd"],
    ["codex", "codex.cmd"],
  ]) {
    const context = await resolvePartnerRuntimeContext(
      {
        partnerAgent,
        partnerCommand,
        projectPath: "C:\\repo",
        log: () => {},
      },
      {
        tmuxRouteFn: () => ({ ...WSL_ROUTE, distro: null }),
        resolveWslRouteDistroFn: async () => {
          throw new Error("WSL has no default distribution");
        },
      }
    );
    assert.equal(context.engine, "headless");
    assert.equal(context.partnerProjectPath, "C:\\repo");
    assert.equal(context.tmuxRoute, null);

    await assert.rejects(
      resolvePartnerRuntimeContext(
        {
          partnerAgent,
          partnerCommand,
          projectPath: "C:\\repo",
          requestedEngine: "tmux-interactive",
          log: () => {},
        },
        {
          tmuxRouteFn: () => ({ ...WSL_ROUTE, distro: null }),
          resolveWslRouteDistroFn: async () => {
            throw new Error("WSL has no default distribution");
          },
        }
      ),
      /WSL has no default distribution/u
    );
  }
});

test("partner runtime context reuses one inferred distro for prompts and extra paths", async () => {
  const context = await resolvePartnerRuntimeContext(
    {
      partnerAgent: "codex",
      partnerCommand: "codex",
      projectPath: "\\\\wsl.localhost\\Ubuntu\\home\\cameron\\repo",
      log: () => {},
    },
    {
      tmuxRouteFn: () => ({ ...WSL_ROUTE, distro: null }),
      resolveWslLoginShellFn: async () => "/bin/bash",
      resolveRunnableEngineFn: async (_adapter, options) => {
        assert.equal(options.tmuxRouteFn().distro, "Ubuntu");
        return "tmux-interactive";
      },
    }
  );
  assert.equal(context.engine, "tmux-interactive");
  assert.equal(context.partnerProjectPath, "/home/cameron/repo");
  assert.equal(context.tmuxDistro, "Ubuntu");
  assert.equal(
    await context.toPartnerPath(
      "\\\\wsl$\\Ubuntu\\home\\cameron\\repo\\.dualog\\diff.patch"
    ),
    "/home/cameron/repo/.dualog/diff.patch"
  );
});

test("partner runtime context pins the default distro before any availability probe", async () => {
  const events = [];
  const context = await resolvePartnerRuntimeContext(
    {
      partnerAgent: "codex",
      partnerCommand: "codex",
      projectPath: "C:\\repo",
      log: () => {},
    },
    {
      tmuxRouteFn: () => ({ ...WSL_ROUTE, distro: null }),
      resolveWslRouteDistroFn: async (route) => {
        events.push("pin-distro");
        return { ...route, distro: "Ubuntu" };
      },
      resolveWslLoginShellFn: async (route) => {
        events.push(`shell-${route.distro}`);
        return "/bin/bash";
      },
      resolveRunnableEngineFn: async (_adapter, options) => {
        events.push(`probe-${options.tmuxRouteFn().distro}`);
        return "tmux-interactive";
      },
      resolveTmuxProjectContextFn: async (projectPath, { route }) => {
        events.push(`translate-${route.distro}`);
        return {
          hostProjectPath: projectPath,
          partnerProjectPath: "/mnt/c/repo",
          tmuxTransport: "wsl",
          tmuxDistro: route.distro,
          tmuxRoute: route,
        };
      },
    }
  );
  assert.deepEqual(events, [
    "pin-distro",
    "shell-Ubuntu",
    "probe-Ubuntu",
    "translate-Ubuntu",
  ]);
  assert.equal(context.tmuxDistro, "Ubuntu");
});

test("default WSL selection is resolved once and reused for wslpath", async () => {
  const calls = [];
  const context = await resolveTmuxProjectContext("C:\\repo", {
    route: { ...WSL_ROUTE, distro: null },
    runExecFileFn: async (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return { exitCode: 0, stdout: "Ubuntu\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "/mnt/c/repo\n", stderr: "" };
    },
  });
  assert.equal(context.partnerProjectPath, "/mnt/c/repo");
  assert.equal(context.tmuxDistro, "Ubuntu");
  assert.deepEqual(calls[1].args.slice(0, 5), [
    "--distribution",
    "Ubuntu",
    "--exec",
    "wslpath",
    "-a",
  ]);
});

test("WSL probes use the resolved interactive login shell with positional argv", async () => {
  const resolutionCalls = [];
  const loginShell = await resolveWslLoginShell(WSL_ROUTE, {
    cache: new Map(),
    runExecFileFn: async (command, args) => {
      resolutionCalls.push({ command, args });
      return { exitCode: 0, stdout: "/bin/zsh\n", stderr: "" };
    },
  });
  assert.equal(loginShell, "/bin/zsh");
  assert.equal(resolutionCalls[0].args[3], "/bin/sh");

  const command = 'claude; printf "must-not-run"';
  let invocation = null;
  const status = await probeWslPartnerCommand(command, ["--version"], {
    route: { ...WSL_ROUTE, loginShell },
    runExecFileFn: async (wslCommand, args) => {
      invocation = { wslCommand, args };
      return { exitCode: 0, stdout: "fixture", stderr: "" };
    },
  });
  assert.equal(status, "available");
  assert.deepEqual(invocation.args.slice(3, 7), [
    "/bin/zsh",
    "-lic",
    'exec "$@"',
    "dualog-wsl-probe",
  ]);
  assert.equal(invocation.args[7], command);
  assert.equal(invocation.args[8], "--version");
  assert.equal(invocation.args[5].includes(command), false);
});

test("WSL command inspection retains the bounded first version line", async () => {
  let invocation = null;
  const inspected = await inspectWslPartnerCommand(
    "/opt/claude/bin/claude",
    ["--version"],
    {
      route: { ...WSL_ROUTE, loginShell: "/bin/bash" },
      runExecFileFn: async (command, args) => {
        invocation = { command, args };
        return {
          exitCode: 0,
          stdout: "2.1.258 (Claude Code)\nignored second line\n",
          stderr: "",
        };
      },
    }
  );

  assert.deepEqual(inspected, {
    availability: "available",
    version: "2.1.258 (Claude Code)",
  });
  assert.equal(invocation.command, "wsl.exe");
  assert.deepEqual(invocation.args.slice(-2), [
    "/opt/claude/bin/claude",
    "--version",
  ]);
});

test("WSL executable resolution pins the default distro and keeps dynamic values out of shell text", async () => {
  const calls = [];
  const resolved = await resolveWslPartnerExecutable("claude", {
    projectPath: "C:\\reviewed repo & $meta",
    route: { ...WSL_ROUTE, distro: null },
    resolveWslLoginShellFn: async (route) => {
      assert.equal(route.distro, "Ubuntu-24.04");
      return "/bin/bash";
    },
    runExecFileFn: async (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return { exitCode: 0, stdout: "Ubuntu-24.04\n", stderr: "" };
      }
      if (args.includes("wslpath")) {
        return { exitCode: 0, stdout: "/mnt/c/reviewed repo & $meta\n", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: "login chatter\n\0/usr/local/bin/claude\0",
        stderr: "",
      };
    },
  });

  assert.equal(resolved, "/usr/local/bin/claude");
  const invocation = calls.at(-1);
  assert.equal(invocation.command, "wsl.exe");
  assert.deepEqual(invocation.args.slice(0, 3), [
    "--distribution",
    "Ubuntu-24.04",
    "--exec",
  ]);
  const scriptIndex = invocation.args.indexOf(WSL_PARTNER_EXECUTABLE_RESOLVE_SCRIPT);
  assert.ok(scriptIndex >= 0);
  assert.equal(invocation.args[scriptIndex].includes("reviewed repo"), false);
  assert.deepEqual(invocation.args.slice(scriptIndex + 1), [
    "dualog-wsl-resolve-partner",
    "claude",
    "/mnt/c/reviewed repo & $meta",
  ]);
});

test("WSL executable resolution rejects explicit relative partner paths before execution", async () => {
  for (const command of ["./claude", "bin/claude", ".\\claude"]) {
    await assert.rejects(
      resolveWslPartnerExecutable(command, {
        projectPath: "/work/reviewed",
        route: WSL_ROUTE,
        resolveWslLoginShellFn: async () =>
          assert.fail("a relative command must fail before selecting a login shell"),
        runExecFileFn: async () =>
          assert.fail("a relative command must fail before invoking WSL"),
      }),
      /is relative/u
    );
  }
});

test("the fixed WSL resolver rejects project PATH shims and symlink crossings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-wsl-command-"));
  const project = path.join(root, "reviewed");
  const trusted = path.join(root, "trusted");
  fs.mkdirSync(project);
  fs.mkdirSync(trusted);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const executable = (dir, name) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(filePath, 0o755);
    return filePath;
  };
  const projectClaude = executable(project, "claude");
  const trustedClaude = executable(trusted, "trusted-claude");
  const run = (command, searchPath) =>
    spawnSync(
      "/bin/sh",
      [
        "-c",
        WSL_PARTNER_EXECUTABLE_RESOLVE_SCRIPT,
        "dualog-wsl-resolver-test",
        command,
        project,
      ],
      {
        env: { ...process.env, PATH: searchPath },
        encoding: "utf-8",
      }
    );

  assert.equal(run("claude", `${project}:${trusted}:/usr/bin:/bin`).status, 66);
  assert.equal(run("claude", `.:${trusted}:/usr/bin:/bin`).status, 66);
  assert.equal(run(projectClaude, `${trusted}:/usr/bin:/bin`).status, 66);

  const safe = run(trustedClaude, `${project}:${trusted}:/usr/bin:/bin`);
  assert.equal(safe.status, 0);
  assert.equal(safe.stdout, `\0${fs.realpathSync(trustedClaude)}\0`);

  fs.symlinkSync(projectClaude, path.join(trusted, "linked-claude"));
  assert.equal(run("linked-claude", `${trusted}:/usr/bin:/bin`).status, 68);
  fs.symlinkSync(trustedClaude, path.join(project, "escape-claude"));
  assert.equal(
    run(path.join(project, "escape-claude"), `${trusted}:/usr/bin:/bin`).status,
    66
  );
});

test("check_adapter pins only a safe absolute executable in the selected WSL distro", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-check-adapter-wsl-"));
  const project = path.join(root, "reviewed");
  const trusted = path.join(root, "trusted");
  fs.mkdirSync(project);
  fs.mkdirSync(trusted);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const executable = (dir, name, body = "exit 0") => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(filePath, 0o755);
    return filePath;
  };
  const projectClaude = executable(project, "claude");
  const trustedClaude = executable(trusted, "claude");
  const linkedToProject = path.join(trusted, "linked-claude");
  fs.symlinkSync(projectClaude, linkedToProject);
  // The resolver deliberately uses an interactive-login argv shape. This
  // hermetic stand-in preserves that shape without reading the test host's
  // shell profile, which would make PATH-dependent planting cases nondeterministic.
  const loginShell = executable(
    trusted,
    "bash",
    '[ "$1" = "-lic" ] || exit 64\nshift\nexec /bin/sh -c "$@"'
  );

  const resolveAsCheckAdapter = async (partnerCommand, searchPath) => {
    const probes = [];
    const contextPromise = resolvePartnerRuntimeContext(
      {
        partnerAgent: "claude",
        partnerCommand,
        // check_adapter supplies process.cwd(); this fixture is its translated
        // partner-visible equivalent inside the selected distribution.
        projectPath: project,
        requestedEngine: "tmux-interactive",
      },
      {
        platform: "win32",
        tmuxRouteFn: () => ({ ...WSL_ROUTE, distro: null }),
        resolveWslRouteDistroFn: async (route) => ({
          ...route,
          distro: "Ubuntu-24.04",
        }),
        resolveWslLoginShellFn: async (route) => {
          assert.equal(route.distro, "Ubuntu-24.04");
          return loginShell;
        },
        resolveTmuxProjectContextFn: async (hostProjectPath, { route }) => ({
          hostProjectPath,
          partnerProjectPath: project,
          tmuxTransport: "wsl",
          tmuxDistro: route.distro,
          tmuxRoute: route,
          tmuxLauncher: route.command,
          tmuxControlBinary: route.tmuxBinary,
          tmuxSocketName: route.tmuxSocketName,
        }),
        resolveWslPartnerExecutableFn: (command, options) =>
          resolveWslPartnerExecutable(command, {
            ...options,
            resolveWslLoginShellFn: async () => loginShell,
            runExecFileFn: async (_command, args) => {
              const execAt = args.indexOf("--exec");
              assert.ok(execAt >= 0, "the resolver must use fixed WSL --exec argv");
              const child = spawnSync(args[execAt + 1], args.slice(execAt + 2), {
                env: { ...process.env, PATH: searchPath },
                encoding: "utf-8",
              });
              return {
                exitCode: child.status ?? 127,
                stdout: child.stdout ?? "",
                stderr: child.stderr ?? child.error?.message ?? "",
              };
            },
          }),
        resolveRunnableEngineFn: async (adapter, options) => {
          const status = await options.probeWslPartnerCommandFn(
            partnerCommand,
            adapter.binary.versionArgs
          );
          assert.equal(status, "available");
          return "tmux-interactive";
        },
        probeWslPartnerCommandFn: async (command, _versionArgs, { route }) => {
          probes.push(command);
          assert.equal(route.distro, "Ubuntu-24.04");
          assert.equal(path.posix.isAbsolute(command), true);
          return "available";
        },
      }
    );
    return { contextPromise, probes };
  };

  for (const [label, command, searchPath] of [
    ["absolute project PATH entry", "claude", `${project}:/usr/bin:/bin`],
    ["relative PATH entry", "claude", `.:${trusted}:/usr/bin:/bin`],
    ["explicit relative command", "./claude", `${trusted}:/usr/bin:/bin`],
    ["explicit project command", projectClaude, `${trusted}:/usr/bin:/bin`],
    ["trusted symlink into project", linkedToProject, `${trusted}:/usr/bin:/bin`],
  ]) {
    const { contextPromise, probes } = await resolveAsCheckAdapter(command, searchPath);
    await assert.rejects(contextPromise, /inside the reviewed project|is relative/u, label);
    assert.deepEqual(probes, [], `${label} must fail before the version probe`);
  }

  const safe = await resolveAsCheckAdapter(
    trustedClaude,
    `${project}:${trusted}:/usr/bin:/bin`
  );
  const context = await safe.contextPromise;
  const canonical = fs.realpathSync(trustedClaude);
  assert.equal(context.partnerCommand, canonical);
  assert.equal(context.tmuxDistro, "Ubuntu-24.04");
  assert.deepEqual(safe.probes, [canonical]);
});

test("the WSL launch preparation converts Windows paths and carries its route", async () => {
  const converted = [];
  const translate = async (value, { route }) => {
    assert.equal(route.distro, "Ubuntu");
    if (!isWindowsPath(value)) return value;
    converted.push(value);
    return value.replace(/^C:\\/, "/mnt/c/").replaceAll("\\", "/");
  };

  const invocation = await prepareTmuxInvocation(
    {
      cwd: "C:\\repo",
      command: "C:\\tools\\partner.exe",
      args: ["--add-dir", "C:\\repo", "--sandbox", "workspace-write"],
      env: { CODEX_HOME: "C:\\runtime\\codex-home", DUALOG_ROLE: "partner" },
    },
    { route: WSL_ROUTE, convertPath: translate }
  );

  assert.deepEqual(converted, [
    "C:\\runtime\\codex-home",
    "C:\\repo",
    "C:\\tools\\partner.exe",
    "C:\\repo",
  ]);
  assert.deepEqual(invocation, {
    cwd: "/mnt/c/repo",
    command: "/mnt/c/tools/partner.exe",
    args: ["--add-dir", "/mnt/c/repo", "--sandbox", "workspace-write"],
    env: { CODEX_HOME: "/mnt/c/runtime/codex-home", DUALOG_ROLE: "partner" },
    tmuxTransport: "wsl",
    tmuxDistro: "Ubuntu",
    tmuxRoute: WSL_ROUTE,
    tmuxLauncher: "wsl.exe",
    tmuxControlBinary: "tmux",
    tmuxSocketName: "dualog",
  });
});

test("launch preparation rejects paths spanning WSL distributions", async () => {
  await assert.rejects(
    prepareTmuxInvocation(
      {
        cwd: "\\\\wsl$\\Ubuntu\\home\\cameron\\repo",
        command: "codex",
        args: ["--add-dir", "\\\\wsl.localhost\\Debian\\tmp"],
        env: {},
      },
      { route: { ...WSL_ROUTE, distro: null } }
    ),
    /multiple distributions: Ubuntu, Debian/u
  );
});

test("WSL process probes use the recorded distro", () => {
  const calls = [];
  const verdict = probeWslPaneProcess(42, "Mon Sep  1 10:00:00 2026", {
    route: WSL_ROUTE,
    spawnSyncFn: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "Mon Sep  1 10:00:00 2026\n", stderr: "" };
    },
  });
  assert.equal(verdict, "alive");
  assert.equal(calls[0].command, "wsl.exe");
  assert.deepEqual(calls[0].args.slice(0, 4), [
    "--distribution",
    "Ubuntu",
    "--exec",
    "ps",
  ]);
});

test("success-wait probing never sends a WSL pane PID to the native probe", () => {
  let nativeCalls = 0;
  let wslCalls = 0;
  const verdict = probePartnerPaneProcess(
    {
      panePid: 42,
      paneStartedAt: "started",
      tmuxTransport: "wsl",
      tmuxDistro: "Ubuntu",
      tmuxRoute: WSL_ROUTE,
    },
    {
      probeNativeProcessFn: () => {
        nativeCalls += 1;
        return "absent";
      },
      probeWslPaneProcessFn: (pid, startedAt, options) => {
        wslCalls += 1;
        assert.equal(pid, 42);
        assert.equal(startedAt, "started");
        assert.equal(options.distro, "Ubuntu");
        return "alive";
      },
    }
  );
  assert.equal(verdict, "alive");
  assert.equal(wslCalls, 1);
  assert.equal(nativeCalls, 0);
});

test("WSL Codex auth seeding preserves a native seed and never returns secret text", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-wsl-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nativeCodexHome = path.join(root, "codex-home");
  fs.mkdirSync(nativeCodexHome);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "C:\\host-codex-home";
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });
  const calls = [];
  const seeded = await seedWslCodexAuth(
    {
      nativeCodexHome,
      wslCodexHome: "/mnt/c/runtime/codex-home",
      route: { ...WSL_ROUTE, loginShell: "/bin/bash" },
    },
    {
      runExecFileFn: async (command, args, options) => {
        calls.push({ command, args });
        assert.equal(
          Object.keys(options.env).some((name) => name.toUpperCase() === "CODEX_HOME"),
          false,
          "the host CODEX_HOME must not shadow WSL's login-shell CODEX_HOME"
        );
        fs.writeFileSync(path.join(nativeCodexHome, "auth.json"), '{"token":"secret"}');
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }
  );
  assert.deepEqual(seeded, { seeded: true, reason: null });
  assert.equal(calls[0].command, "wsl.exe");
  assert.deepEqual(calls[0].args.slice(0, 4), [
    "--distribution",
    "Ubuntu",
    "--exec",
    "/bin/bash",
  ]);
  assert.equal(calls[0].args[4], "-lic");
  assert.match(calls[0].args.join(" "), /1048576/u, "the WSL source must be size-bounded");
  assert.match(calls[0].args.join(" "), /chmod 600/u, "the copied auth must be private");
  assert.match(calls[0].args.join(" "), /CODEX_HOME/u, "WSL's custom CODEX_HOME is honored");
  assert.equal(JSON.stringify(seeded).includes("secret"), false);

  const failedHome = path.join(root, "failed-codex-home");
  fs.mkdirSync(failedHome);
  const failed = await seedWslCodexAuth(
    {
      nativeCodexHome: failedHome,
      wslCodexHome: "/mnt/c/runtime/failed-codex-home",
      route: { ...WSL_ROUTE, loginShell: "/bin/bash" },
    },
    {
      runExecFileFn: async () => ({
        exitCode: 4,
        stdout: '{"token":"must-not-escape"}',
        stderr: "copy failed after reading secret",
      }),
    }
  );
  assert.deepEqual(failed, { seeded: false, reason: "wsl-copy-failed" });
  assert.equal(JSON.stringify(failed).includes("must-not-escape"), false);

  const preserved = await seedWslCodexAuth(
    {
      nativeCodexHome,
      wslCodexHome: "/mnt/c/runtime/codex-home",
      route: { ...WSL_ROUTE, loginShell: "/bin/bash" },
    },
    {
      runExecFileFn: async () => {
        throw new Error("native auth must win without invoking WSL");
      },
    }
  );
  assert.deepEqual(preserved, { seeded: false, reason: "native-seed-present" });
});

test(
  "WSL Codex auth copy script works in a local POSIX shell",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-wsl-auth-shell-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceHome = path.join(root, "source home");
    const targetHome = path.join(root, "target home");
    fs.mkdirSync(sourceHome);
    fs.mkdirSync(targetHome);
    fs.writeFileSync(path.join(sourceHome, "auth.json"), '{"token":"test-only"}');

    let script = null;
    await seedWslCodexAuth(
      {
        nativeCodexHome: targetHome,
        wslCodexHome: targetHome,
        route: { ...WSL_ROUTE, loginShell: "/bin/bash" },
      },
      {
        runExecFileFn: async (_command, args) => {
          script = args[args.indexOf("-lic") + 1];
          return { exitCode: 3, stdout: "", stderr: "" };
        },
      }
    );

    const result = spawnSync(
      "/bin/sh",
      ["-lc", script, "dualog-auth-test", targetHome],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: sourceHome },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const targetAuth = path.join(targetHome, "auth.json");
    assert.equal(fs.readFileSync(targetAuth, "utf8"), '{"token":"test-only"}');
    assert.equal(fs.statSync(targetAuth).mode & 0o777, 0o600);

    const attackedHome = path.join(root, "attacked home");
    const outside = path.join(root, "outside.json");
    fs.mkdirSync(attackedHome);
    fs.writeFileSync(outside, "unchanged");
    fs.symlinkSync(outside, path.join(attackedHome, "auth.json"));
    const refused = spawnSync(
      "/bin/sh",
      ["-lc", script, "dualog-auth-test", attackedHome],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: sourceHome },
      }
    );
    assert.equal(refused.status, 4);
    assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
  }
);
