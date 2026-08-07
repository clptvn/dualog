import test from "node:test";
import assert from "node:assert/strict";

import {
  isWindowsPath,
  prepareTmuxInvocation,
  tmuxRoute,
} from "../src/tmux-runtime.mjs";

test("native Windows uses the default WSL distribution for tmux", () => {
  assert.deepEqual(
    tmuxRoute({ platform: "win32", env: { DUALOG_WSL_DISTRO: "Ubuntu" } }),
    {
      transport: "wsl",
      command: "wsl.exe",
      distro: "Ubuntu",
      tmuxBinary: "tmux",
    }
  );
});

test("an explicit tmux executable keeps the local route on Windows", () => {
  assert.deepEqual(
    tmuxRoute({ platform: "win32", env: { DUALOG_TMUX_BINARY: "C:\\tools\\tmux.exe" } }),
    {
      transport: "local",
      command: "C:\\tools\\tmux.exe",
      distro: null,
      tmuxBinary: "C:\\tools\\tmux.exe",
    }
  );
});

test("the WSL launch preparation converts Windows paths but preserves flags", async () => {
  const converted = [];
  const translate = async (value) => {
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
    { route: { transport: "wsl" }, convertPath: translate }
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
  });
});
