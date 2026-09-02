import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  assertSafeConfigWriteTarget,
  atomicWriteFile,
  buildClaudeMcpRegistration,
  buildWslLifecycleInvocation,
  effectiveExplicitWslSelection,
  findPersistedWslDistro,
  findPersistedWslRegistrations,
  findPersistedWslSettings,
  formatInstallEnvironment,
  probeInstallEnvironment,
  planWslUninstallTargets,
  persistedWslEnv,
  preflightExplicitWslSelection,
  prepareWindowsCommandInvocation,
  readJsonConfig,
  removeMcpServerConfig,
  removeMcpServerSections,
  replaceMcpServerSection,
  resolveCodexPaths,
  resolveWslRoute,
  runInstallProbe,
  validateExplicitWslSelection,
  writeJsonConfig,
} from "../scripts/install-utils.mjs";
import { InstallTransaction } from "../scripts/install-transaction.mjs";
import {
  assertSafeWslLauncher,
  normalizeWslLoginShell,
  wslLoginShellArgs,
} from "../src/wsl-shell.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const HISTORICAL_PLATFORM_HELPER_HEADER = [
  'import fs from "fs";',
  'import os from "os";',
  'import path from "path";',
  "",
  "// claude-codex-dialog platform helpers. Keep this file dependency-light because",
  "// Claude hook scripts import it from the user-level hooks directory.",
  "",
].join("\n");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-installer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Codex config and skills honor CODEX_HOME", () => {
  const paths = resolveCodexPaths({
    env: { CODEX_HOME: path.join("", "custom", "codex-home") },
    home: path.join("", "ignored", "home"),
  });
  assert.equal(paths.root, path.resolve("custom", "codex-home"));
  assert.equal(paths.config, path.join(paths.root, "config.toml"));
  assert.equal(paths.skills, path.join(paths.root, "skills"));

  const fallback = resolveCodexPaths({ env: { CODEX_HOME: "" }, home: "/users/test" });
  assert.equal(fallback.root, path.join("/users/test", ".codex"));
});

test("malformed JSON fails closed and remains byte-for-byte unchanged", (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, ".claude.json");
  const malformed = '{"mcpServers": { "keep": true }';
  fs.writeFileSync(configPath, malformed);

  assert.throws(
    () => readJsonConfig(configPath),
    /Refusing to overwrite malformed JSON config/
  );
  assert.equal(fs.readFileSync(configPath, "utf-8"), malformed);
});

test("JSON and TOML writes replace through a temporary sibling", (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, "nested", "settings.json");
  writeJsonConfig(configPath, { keep: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf-8")), { keep: true });

  atomicWriteFile(configPath, '{"keep":false}\n');
  assert.equal(fs.readFileSync(configPath, "utf-8"), '{"keep":false}\n');
  assert.deepEqual(
    fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith(".tmp")),
    []
  );
});

test("atomic config writes preserve valid symlinks and refuse dangling ones", (t) => {
  const dir = tempDir(t);
  const realPath = path.join(dir, "real-config.json");
  const linkPath = path.join(dir, "linked-config.json");
  const danglingPath = path.join(dir, "dangling-config.json");
  const missingTarget = path.join(dir, "missing-config.json");
  fs.writeFileSync(realPath, '{"old":true}\n');
  try {
    fs.symlinkSync(realPath, linkPath, "file");
    fs.symlinkSync(missingTarget, danglingPath, "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symbolic links are unavailable in this test environment");
      return;
    }
    throw error;
  }

  atomicWriteFile(linkPath, '{"new":true}\n');
  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(linkPath, "utf-8"), '{"new":true}\n');
  assert.equal(fs.readFileSync(realPath, "utf-8"), '{"new":true}\n');

  assert.throws(
    () => atomicWriteFile(danglingPath, '{"new":true}\n'),
    /Refusing to replace dangling symbolic link config/
  );
  assert.equal(fs.lstatSync(danglingPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(missingTarget), false);
});

test("atomic config writes preserve a symbolic-link parent directory", (t) => {
  const dir = tempDir(t);
  const realDir = path.join(dir, "real-config-dir");
  const linkedDir = path.join(dir, "linked-config-dir");
  fs.mkdirSync(realDir);
  try {
    fs.symlinkSync(realDir, linkedDir, "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symbolic links are unavailable in this test environment");
      return;
    }
    throw error;
  }

  const linkedConfig = path.join(linkedDir, "config.toml");
  atomicWriteFile(linkedConfig, 'created = true\n');
  assert.equal(fs.lstatSync(linkedDir).isSymbolicLink(), true);
  assert.equal(
    fs.readFileSync(path.join(realDir, "config.toml"), "utf-8"),
    'created = true\n'
  );
});

test("atomic config writes refuse to split hard-linked files", (t) => {
  const dir = tempDir(t);
  const realPath = path.join(dir, "real-config.toml");
  const linkedPath = path.join(dir, "linked-config.toml");
  fs.writeFileSync(realPath, 'old = true\n');
  fs.linkSync(realPath, linkedPath);
  const original = fs.statSync(realPath);

  assert.throws(
    () => atomicWriteFile(linkedPath, 'new = true\n'),
    /Refusing to replace multiply linked config.*atomic rename would split its hard links/
  );
  assert.equal(fs.readFileSync(realPath, "utf-8"), 'old = true\n');
  assert.equal(fs.readFileSync(linkedPath, "utf-8"), 'old = true\n');
  assert.equal(fs.statSync(linkedPath).ino, original.ino);
  assert.equal(fs.statSync(linkedPath).nlink, 2);
});

test("config prevalidation rejects directories and non-regular files without reading them", (t) => {
  const dir = tempDir(t);
  const directoryTarget = path.join(dir, "config-directory");
  fs.mkdirSync(directoryTarget);
  assert.throws(
    () => readJsonConfig(directoryTarget),
    /resolved target .* is not a regular file/
  );
  const fileParent = path.join(dir, "file-parent");
  fs.writeFileSync(fileParent, "not a directory");
  assert.throws(
    () => assertSafeConfigWriteTarget(path.join(fileParent, "config.json")),
    /parent (?:component is not a directory|.+ does not resolve to a directory)/
  );

  if (process.platform !== "win32") {
    const fifoPath = path.join(dir, "config-fifo");
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf-8" });
    if (created.status === 0) {
      assert.equal(fs.lstatSync(fifoPath).isFIFO(), true);
      assert.throws(
        () => readJsonConfig(fifoPath),
        /resolved target .* is not a regular file/
      );
    }
  }
});

test("TOML removal handles quoted and unquoted current and legacy tables with CRLF", () => {
  const input = [
    'theme = "dark"',
    "",
    '[mcp_servers."dualog"]',
    'command = "old"',
    '[mcp_servers."dualog".env]',
    'TOKEN = "owned"',
    "[[mcp_servers.dualog.metadata]]",
    'name = "owned array entry"',
    "",
    "[mcp_servers.codex-dialog]",
    'command = "legacy"',
    "[mcp_servers.'codex-dialog'.env]",
    'TOKEN = "legacy"',
    "",
    "[mcp_servers.dualogger]",
    'command = "keep"',
    "",
    "[features]",
    "enabled = true",
    "",
  ].join("\r\n");

  const removed = removeMcpServerSections(input);
  assert.doesNotMatch(removed, /mcp_servers\.(?:["']?dualog["']?|["']?codex-dialog["']?)(?:\]|\.)/);
  assert.doesNotMatch(removed, /owned array entry/);
  assert.match(removed, /\[mcp_servers\.dualogger\]/);
  assert.match(removed, /\[features\]\r\nenabled = true/);

  const normalized = removeMcpServerConfig(input);
  assert.equal(normalized.replaceAll("\r\n", "").includes("\n"), false);
  assert.ok(normalized.endsWith("\r\n"));
});

test("TOML removal preserves table-looking text in multiline strings", () => {
  for (const delimiter of ['"""', "'''"]) {
    for (const newline of ["\n", "\r\n"]) {
      const input = [
        `notes = ${delimiter}`,
        "[mcp_servers.dualog]",
        "keep = this is string content",
        delimiter,
        "[mcp_servers.dualog]",
        'command = "remove"',
        "[real]",
        "x = 1",
        "",
      ].join(newline);
      const expected = [
        `notes = ${delimiter}`,
        "[mcp_servers.dualog]",
        "keep = this is string content",
        delimiter,
        "[real]",
        "x = 1",
        "",
      ].join(newline);

      assert.equal(removeMcpServerSections(input), expected);
      assert.equal(removeMcpServerConfig(input), expected);
      const replaced = replaceMcpServerSection(input, {
        serverPath: "/repo/src/dialog-server.mjs",
        nodePath: "/usr/local/bin/node",
      });
      assert.ok(replaced.startsWith(expected.trimEnd()));
      assert.match(
        replaced,
        /\[mcp_servers\.dualog\]\r?\ncommand = "\/usr\/local\/bin\/node"/
      );
    }
  }
});

test("TOML removal ignores table-looking text inside multiline strings in an owned table", () => {
  for (const delimiter of ['"""', "'''"]) {
    const input = [
      "[mcp_servers.dualog]",
      `notes = ${delimiter}`,
      "[real]",
      "this header is still owned string content",
      delimiter,
      'command = "remove"',
      "[real]",
      "x = 1",
      "",
    ].join("\n");

    assert.equal(
      removeMcpServerSections(input),
      ["[real]", "x = 1", ""].join("\n")
    );
  }
});

test("TOML table scanners ignore header-shaped nested array values", () => {
  for (const newline of ["\n", "\r\n"]) {
    const input = [
      "[mcp_servers.dualog]",
      'command = "node"',
      "metadata = [",
      "  [1],",
      "  [2]",
      "]",
      "[real]",
      "x = 1",
      "",
    ].join(newline);
    const expected = ["[real]", "x = 1", ""].join(newline);

    assert.equal(removeMcpServerSections(input), expected);
    assert.equal(removeMcpServerConfig(input), expected);
    const replaced = replaceMcpServerSection(input, {
      serverPath: "/repo/src/dialog-server.mjs",
      nodePath: "/usr/local/bin/node",
    });
    assert.match(replaced, /\[real\]\r?\nx = 1/);
    assert.doesNotMatch(replaced, /^\s*\[1\],?$/m);
    assert.equal(
      (replaced.match(/^\[mcp_servers\.dualog\]$/gm) ?? []).length,
      1
    );
  }
});

test("TOML removal stops at unrelated quoted headers containing brackets", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const unrelatedHeader of [
      '["unrelated]table"]',
      "['unrelated]table']",
    ]) {
      const input = [
        "[mcp_servers.dualog]",
        'command = "old"',
        unrelatedHeader,
        'secret = "keep"',
        "[next]",
        "x = 1",
        "",
      ].join(newline);
      const expected = [
        unrelatedHeader,
        'secret = "keep"',
        "[next]",
        "x = 1",
        "",
      ].join(newline);

      assert.equal(removeMcpServerSections(input), expected);
      assert.equal(removeMcpServerConfig(input), expected);
      const replaced = replaceMcpServerSection(input, {
        serverPath: "/repo/src/dialog-server.mjs",
        nodePath: "/usr/local/bin/node",
      });
      assert.match(replaced, /secret = "keep"/);
      assert.ok(replaced.includes(unrelatedHeader));
    }
  }
});

test("TOML multiline basic quote runs do not hide the following table", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const quoteCount of [4, 5, 6]) {
      const input = [
        "[mcp_servers.dualog]",
        'notes = """abc' + "\\" + '"'.repeat(quoteCount),
        '["unrelated"]',
        'secret = "keep"',
        "[next]",
        "x = 1",
        "",
      ].join(newline);
      const expected = [
        '["unrelated"]',
        'secret = "keep"',
        "[next]",
        "x = 1",
        "",
      ].join(newline);

      assert.equal(removeMcpServerSections(input), expected);
      assert.equal(removeMcpServerConfig(input), expected);
      assert.match(
        replaceMcpServerSection(input, {
          serverPath: "/repo/src/dialog-server.mjs",
          nodePath: "/usr/local/bin/node",
        }),
        /secret = "keep"/
      );
    }
  }
});

test("TOML scanners decode escaped basic keys before matching owned tables", () => {
  for (const newline of ["\n", "\r\n"]) {
    const escapedRoot = '["mcp\\u005fservers"."dua\\u006Cog"]';
    const escapedEnv = '["mcp\\u005fservers"."dua\\U0000006Cog"."e\\u006Ev"]';
    const input = [
      escapedRoot,
      'command = "old"',
      escapedEnv,
      'DUALOG_WSL_DISTRO = "Ubuntu-Escaped"',
      'DUALOG_WSL_BINARY = "escaped-wsl.exe"',
      "[real]",
      "x = 1",
      "",
    ].join(newline);

    assert.equal(
      removeMcpServerSections(input),
      ["[real]", "x = 1", ""].join(newline)
    );
    assert.deepEqual(
      findPersistedWslRegistrations({ codexToml: input }).codex,
      { distro: "Ubuntu-Escaped", binary: "escaped-wsl.exe" }
    );
    const replaced = replaceMcpServerSection(input, {
      serverPath: "/repo/src/dialog-server.mjs",
      nodePath: "/usr/local/bin/node",
    });
    assert.equal(
      (replaced.match(/^\[mcp_servers\.dualog\]$/gm) ?? []).length,
      1
    );
    assert.doesNotMatch(replaced, /mcp\\u005fservers|dua\\u006Cog/);

    const escapedInlineEnv = [
      escapedRoot,
      '"e\\u006Ev" = { "DUALOG_WSL_DISTRO" = "Ubuntu-Inline", "DUALOG_WSL_BINARY" = "inline-wsl.exe" }',
      "",
    ].join(newline);
    assert.deepEqual(
      findPersistedWslRegistrations({ codexToml: escapedInlineEnv }).codex,
      { distro: "Ubuntu-Inline", binary: "inline-wsl.exe" }
    );
  }
});

test("TOML replacement collapses all old spellings to one atomic-ready table", () => {
  const input = [
    "[mcp_servers.dualog]",
    'command = "first"',
    '[mcp_servers."dualog"]',
    'command = "second"',
    "[mcp_servers.codex-dialog]",
    'command = "legacy"',
    "[features]",
    "enabled = true",
    "",
  ].join("\n");
  const replaced = replaceMcpServerSection(input, {
    serverPath: "C:\\repo\\src\\dialog-server.mjs",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    env: {
      DUALOG_WSL_DISTRO: "Ubuntu-24.04",
      DUALOG_WSL_BINARY: "C:\\Windows\\System32\\wsl.exe",
    },
  });

  assert.equal((replaced.match(/\[mcp_servers\.dualog\]/g) ?? []).length, 1);
  assert.doesNotMatch(replaced, /codex-dialog/);
  assert.match(replaced, /\[features\]\nenabled = true/);
  assert.match(replaced, /command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/);
  assert.match(replaced, /DUALOG_WSL_DISTRO = "Ubuntu-24\.04"/);
  assert.match(replaced, /DUALOG_WSL_BINARY = "C:\\\\Windows\\\\System32\\\\wsl\.exe"/);
});

test("legacy-only migration never removes the current Dualog table", () => {
  const input = [
    "[mcp_servers.dualog]",
    'command = "current"',
    '[mcp_servers."codex-dialog"]',
    'command = "legacy"',
    "",
  ].join("\r\n");
  const migrated = removeMcpServerConfig(input, ["codex-dialog"]);
  assert.match(migrated, /\[mcp_servers\.dualog\]\r\ncommand = "current"/);
  assert.doesNotMatch(migrated, /codex-dialog/);
});

test("persisted WSL route discovery ignores multiline TOML examples", () => {
  for (const delimiter of ['"""', "'''"]) {
    for (const newline of ["\n", "\r\n"]) {
      const exampleOnly = [
        `notes = ${delimiter}`,
        "[mcp_servers.dualog]",
        'env = { DUALOG_WSL_DISTRO = "Fake", DUALOG_WSL_BINARY = "fake.cmd" }',
        delimiter,
        "[real]",
        "x = 1",
        "",
      ].join(newline);
      assert.deepEqual(
        findPersistedWslRegistrations({ codexToml: exampleOnly }).codex,
        { distro: null, binary: null }
      );
      assert.deepEqual(
        planWslUninstallTargets({ codexToml: exampleOnly }),
        { targets: [], unresolved: [] }
      );

      const installed = [
        "[mcp_servers.dualog]",
        `notes = ${delimiter}`,
        "[other.table]",
        "this is still string content",
        delimiter,
        'env = { DUALOG_WSL_DISTRO = "Ubuntu-Real", DUALOG_WSL_BINARY = "wsl-real.exe" }',
        "",
      ].join(newline);
      assert.deepEqual(
        findPersistedWslRegistrations({ codexToml: installed }).codex,
        { distro: "Ubuntu-Real", binary: "wsl-real.exe" }
      );
      assert.equal(
        planWslUninstallTargets({ codexToml: installed }).targets.length,
        1
      );
    }
  }
});

test("persisted WSL route parsing ignores comments and quoted examples", () => {
  for (const newline of ["\n", "\r\n"]) {
    const exampleOnly = [
      "[mcp_servers.dualog]",
      '# Example: DUALOG_WSL_DISTRO = "VictimDistro"',
      '# Example: DUALOG_WSL_BINARY = "C:\\\\tools\\\\fake-wsl.cmd"',
      'notes = "DUALOG_WSL_DISTRO = \\"QuotedFake\\""',
      'metadata = { example = "DUALOG_WSL_BINARY = \\"quoted-fake.cmd\\"" }',
      "",
    ].join(newline);
    assert.deepEqual(
      findPersistedWslRegistrations({ codexToml: exampleOnly }).codex,
      { distro: null, binary: null }
    );
    const plan = planWslUninstallTargets({ codexToml: exampleOnly });
    assert.deepEqual(plan.targets, []);
    assert.equal(plan.unresolved.length, 1);
    assert.deepEqual(plan.unresolved[0].route, { distro: null, binary: null });
  }
});

test("persisted WSL route round-trips quoted delimiters and survives nested arrays", () => {
  const binary = "C:\\Bob'''s\\Tools, Inc\\wsl}custom.exe";
  for (const newline of ["\n", "\r\n"]) {
    const emitted = replaceMcpServerSection(
      ["[unrelated]", "values = [", "  [1],", "]", ""].join(newline),
      {
        serverPath: "C:\\repo\\src\\dialog-server.mjs",
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        env: {
          DUALOG_WSL_DISTRO: "Ubuntu-24.04",
          DUALOG_WSL_BINARY: binary,
        },
      }
    );
    assert.deepEqual(
      findPersistedWslRegistrations({ codexToml: emitted }).codex,
      { distro: "Ubuntu-24.04", binary }
    );
    assert.deepEqual(planWslUninstallTargets({ codexToml: emitted }).targets, [
      {
        route: { distro: "Ubuntu-24.04", binary },
        removeClaude: false,
        removeCodex: true,
      },
    ]);

    const envSubtable = [
      '[mcp_servers."dualog".env]',
      'DUALOG_WSL_DISTRO = "Ubuntu-\\U0001F680"',
      `DUALOG_WSL_BINARY = ${JSON.stringify(binary)}`,
      "",
    ].join(newline);
    assert.deepEqual(
      findPersistedWslRegistrations({ codexToml: envSubtable }).codex,
      { distro: "Ubuntu-🚀", binary }
    );
  }
});

test("persisted WSL distro is recovered from Claude or quoted Codex registration", () => {
  assert.equal(
    findPersistedWslDistro({
      claudeConfig: {
        mcpServers: { dualog: { env: { DUALOG_WSL_DISTRO: "Ubuntu-Claude" } } },
      },
      codexToml:
        '[mcp_servers."dualog"]\nenv = { DUALOG_WSL_DISTRO = "Ubuntu-Codex" }\n',
    }),
    "Ubuntu-Claude"
  );
  assert.equal(
    findPersistedWslDistro({
      codexToml:
        '[mcp_servers."dualog"]\r\nenv = { DUALOG_WSL_DISTRO = "Ubuntu-Codex" }\r\n',
    }),
    "Ubuntu-Codex"
  );
  assert.deepEqual(
    findPersistedWslSettings({
      codexToml:
        '[mcp_servers."dualog"]\r\nenv = { DUALOG_WSL_DISTRO = "Ubuntu-Codex", DUALOG_WSL_BINARY = "C:\\\\tools\\\\wsl.exe" }\r\n',
    }),
    { distro: "Ubuntu-Codex", binary: "C:\\tools\\wsl.exe" }
  );
});

test("divergent native host pins produce two scoped WSL uninstall targets", () => {
  const input = {
    claudeConfig: {
      mcpServers: {
        dualog: {
          env: {
            DUALOG_WSL_DISTRO: "Ubuntu-Claude",
            DUALOG_WSL_BINARY: "C:\\tools\\wsl.exe",
          },
        },
      },
    },
    codexToml:
      '[mcp_servers."dualog"]\nenv = { DUALOG_WSL_DISTRO = "Ubuntu-Codex", DUALOG_WSL_BINARY = "C:\\\\tools\\\\wsl.exe" }\n',
  };
  assert.deepEqual(findPersistedWslRegistrations(input), {
    claude: { distro: "Ubuntu-Claude", binary: "C:\\tools\\wsl.exe" },
    codex: { distro: "Ubuntu-Codex", binary: "C:\\tools\\wsl.exe" },
  });
  assert.deepEqual(planWslUninstallTargets(input), {
    targets: [
      {
        route: { distro: "Ubuntu-Claude", binary: "C:\\tools\\wsl.exe" },
        removeClaude: true,
        removeCodex: false,
      },
      {
        route: { distro: "Ubuntu-Codex", binary: "C:\\tools\\wsl.exe" },
        removeClaude: false,
        removeCodex: true,
      },
    ],
    unresolved: [],
  });
});

test("matching native host pins coalesce into one --both WSL uninstall", () => {
  const targets = planWslUninstallTargets({
    claudeConfig: {
      mcpServers: { dualog: { env: { DUALOG_WSL_DISTRO: "Ubuntu" } } },
    },
    codexToml:
      '[mcp_servers.dualog]\nenv = { DUALOG_WSL_DISTRO = "ubuntu" }\n',
  });
  assert.deepEqual(targets, {
    targets: [
      {
        route: { distro: "Ubuntu", binary: null },
        removeClaude: true,
        removeCodex: true,
      },
    ],
    unresolved: [],
  });
});

test("a binary-only override preserves divergent persisted distros", () => {
  const targets = planWslUninstallTargets({
    explicitRoute: { distro: null, binary: "D:\\portable\\wsl.exe" },
    claudeConfig: {
      mcpServers: { dualog: { env: { DUALOG_WSL_DISTRO: "Ubuntu" } } },
    },
    codexToml:
      '[mcp_servers.dualog]\nenv = { DUALOG_WSL_DISTRO = "Debian" }\n',
  });
  assert.deepEqual(targets, {
    targets: [
      {
        route: { distro: "Ubuntu", binary: "D:\\portable\\wsl.exe" },
        removeClaude: true,
        removeCodex: false,
      },
      {
        route: { distro: "Debian", binary: "D:\\portable\\wsl.exe" },
        removeClaude: false,
        removeCodex: true,
      },
    ],
    unresolved: [],
  });
});

test("missing persisted distro is unresolved and never guessed from today's default", () => {
  assert.deepEqual(planWslUninstallTargets({
    claudeConfig: { mcpServers: { dualog: { command: "node" } } },
    codexToml: '[mcp_servers."dualog"]\ncommand = "node"\n',
  }), {
    targets: [],
    unresolved: [
      {
        route: { distro: null, binary: null },
        removeClaude: true,
        removeCodex: false,
      },
      {
        route: { distro: null, binary: null },
        removeClaude: false,
        removeCodex: true,
      },
    ],
  });
});

test("no registration and a second uninstall are idempotent no-ops for WSL", () => {
  assert.deepEqual(planWslUninstallTargets({}), {
    targets: [],
    unresolved: [],
  });
  assert.deepEqual(
    planWslUninstallTargets({
      claudeConfig: { mcpServers: { unrelated: { command: "keep" } } },
      codexToml: '[mcp_servers.unrelated]\ncommand = "keep"\n',
    }),
    { targets: [], unresolved: [] }
  );
});

test("native Claude/Desktop registration pins the verified WSL distro", () => {
  const cliStatus = {
    wsl: {
      distroAvailable: true,
      distro: "Ubuntu-24.04",
      binaryAvailable: true,
      binary: "C:\\tools\\wsl.exe",
    },
  };
  assert.deepEqual(
    buildClaudeMcpRegistration({
      serverPath: "C:\\repo\\src\\dialog-server.mjs",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      cliStatus,
      platform: "win32",
    }),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\repo\\src\\dialog-server.mjs"],
      env: {
        DUALOG_WSL_DISTRO: "Ubuntu-24.04",
        DUALOG_WSL_BINARY: "C:\\tools\\wsl.exe",
      },
    }
  );
  assert.deepEqual(
    buildClaudeMcpRegistration({
      serverPath: "/repo/src/dialog-server.mjs",
      nodePath: "/usr/bin/node",
      cliStatus,
      platform: "darwin",
    }),
    {
      command: "/usr/bin/node",
      args: ["/repo/src/dialog-server.mjs"],
    }
  );
});

function windowsProbeStub(calls) {
  return (command, args) => {
    calls.push([command, [...args]]);
    if (command === "claude") return { status: 1 };
    if (command === "codex") return { status: 0 };
    if (command === "tmux") return { status: 1 };
    if (command !== "C:\\tools\\custom-wsl.exe") {
      return { status: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
    }
    if (args[0] === "--status") return { status: 0 };
    if (args.at(-1) === "true") return { status: 0 };
    if (args.at(-1) === 'printf "%s" "$WSL_DISTRO_NAME"') {
      return { status: 0, stdout: "Ubuntu-24.04\n" };
    }
    if (args.some((arg) => String(arg).includes("getent passwd"))) {
      return { status: 0, stdout: "/bin/bash\n" };
    }
    const pathMarker = args.find((arg) => String(arg).startsWith("__DUALOG_WSL_PATH_"));
    if (pathMarker) {
      return {
        status: 0,
        stdout: `interactive startup banner 99\n${pathMarker}\n/home/test/.nvm/node\n`,
      };
    }
    const marker = args.find((arg) => String(arg).startsWith("__DUALOG_WSL_PROBE_"));
    if (args.includes("node") && args.at(-1) === "--version") {
      return { status: 0, stdout: `banner version 1\n${marker}\nv22.18.0\n` };
    }
    if (args.includes("tmux") && args.at(-1) === "-V") return { status: 0 };
    if (args.includes("claude")) return { status: 0 };
    if (args.includes("codex")) return { status: 0 };
    return { status: 1 };
  };
}

test("Windows probe separates host and WSL availability and pins the selected distro", async () => {
  const calls = [];
  const status = await probeInstallEnvironment(windowsProbeStub(calls), {
    platform: "win32",
    env: { DUALOG_WSL_BINARY: "C:\\tools\\custom-wsl.exe" },
    cwd: "C:\\repo",
  });

  assert.deepEqual(status.host, { claude: false, codex: true, tmux: false });
  assert.deepEqual(
    {
      binary: status.wsl.binary,
      distro: status.wsl.distro,
      binaryAvailable: status.wsl.binaryAvailable,
      distroAvailable: status.wsl.distroAvailable,
      node: status.wsl.node,
      nodePath: status.wsl.nodePath,
      tmux: status.wsl.tmux,
      claude: status.wsl.claude,
      codex: status.wsl.codex,
    },
    {
      binary: "C:\\tools\\custom-wsl.exe",
      distro: "Ubuntu-24.04",
      binaryAvailable: true,
      distroAvailable: true,
      node: true,
      nodePath: "/home/test/.nvm/node",
      tmux: true,
      claude: true,
      codex: true,
    }
  );
  const postDetection = calls.slice(
    calls.findIndex(([, args]) => args.at(-1) === 'printf "%s" "$WSL_DISTRO_NAME"') + 1
  );
  assert.ok(
    postDetection
      .filter(([command]) => command === "C:\\tools\\custom-wsl.exe")
      .every(([, args]) => args.includes("Ubuntu-24.04")),
    "every runtime probe after default discovery must use the exact distro"
  );

  const report = formatInstallEnvironment(status).join("\n");
  assert.match(report, /Windows host:[\s\S]*Claude Code CLI: not found/);
  assert.match(report, /WSL \(distribution Ubuntu-24\.04\):[\s\S]*Claude Code CLI:  OK/);
});

test("nested WSL lifecycle calls use the verified node and cannot recurse", () => {
  const route = {
    binary: "wsl.exe",
    distro: "Ubuntu-24.04",
    loginShell: "/bin/bash",
  };
  const install = buildWslLifecycleInvocation({
    operation: "install",
    route,
    nodePath: "/home/test/.nvm/node",
    scriptPath: "/mnt/c/repo/scripts/install.mjs",
    modeArgument: "--both",
  });
  assert.equal(install.command, "wsl.exe");
  assert.deepEqual(install.args, [
    "--distribution",
    "Ubuntu-24.04",
    "--exec",
    "/bin/bash",
    "-lic",
    'exec "$@"',
    "dualog-wsl",
    "env",
    "DUALOG_INSTALL_HOST_ONLY=1",
    "/home/test/.nvm/node",
    "/mnt/c/repo/scripts/install.mjs",
    "--both",
    "--host-only",
  ]);

  const uninstall = buildWslLifecycleInvocation({
    operation: "uninstall",
    route,
    nodePath: "/usr/bin/node",
    scriptPath: "/mnt/c/repo/scripts/uninstall.mjs",
    modeArgument: "--codex",
  });
  assert.ok(uninstall.args.includes("DUALOG_UNINSTALL_HOST_ONLY=1"));
  assert.equal(uninstall.args.at(-1), "--host-only");
});

test("WSL login-shell argv keeps shell paths and command arguments non-executable", () => {
  assert.equal(
    normalizeWslLoginShell("/bin/bash; touch /tmp/dualog-injected"),
    "/bin/sh"
  );
  assert.equal(normalizeWslLoginShell("/usr/bin/fish"), "/bin/sh");

  const dynamic = 'claude; printf "injected"';
  const args = wslLoginShellArgs("/bin/bash", 'exec "$@"', {
    arg0: "dualog-test",
    args: [dynamic, "$(touch /tmp/dualog-injected)"],
  });
  assert.deepEqual(args.slice(0, 4), [
    "/bin/bash",
    "-lic",
    'exec "$@"',
    "dualog-test",
  ]);
  assert.equal(args[4], dynamic);
  assert.equal(args[5], "$(touch /tmp/dualog-injected)");
  assert.equal(args[2].includes(dynamic), false);
});

test(
  "interactive login mode sees PATH setup below Ubuntu's bashrc guard",
  { skip: process.platform === "win32" || !fs.existsSync("/bin/bash") },
  (t) => {
    const root = tempDir(t);
    const bin = path.join(root, "nvm bin");
    const executable = path.join(bin, "dualog-nvm-node-fixture");
    const bashrc = path.join(root, "bashrc");
    const bashProfile = path.join(root, ".bash_profile");
    fs.mkdirSync(bin);
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(
      bashrc,
      [
        "case $- in",
        "  *i*) ;;",
        "  *) return;;",
        "esac",
        `export PATH=${JSON.stringify(bin)}:$PATH`,
        "",
      ].join("\n")
    );
    // A login shell reads a profile, which in a normal Ubuntu home sources
    // .bashrc. Model that relationship explicitly: --rcfile is ignored by a
    // login shell and made this fixture test Bash option trivia instead of the
    // WSL environment shape the installer depends on.
    fs.writeFileSync(bashProfile, '. "$HOME/bashrc"\n');

    const command = "command -v dualog-nvm-node-fixture";
    const env = { ...process.env, HOME: root };
    const nonInteractive = spawnSync(
      "/bin/bash",
      ["-lc", command],
      { encoding: "utf8", env }
    );
    const interactive = spawnSync(
      "/bin/bash",
      ["-lic", command],
      { encoding: "utf8", env }
    );
    assert.notEqual(nonInteractive.status, 0);
    assert.equal(interactive.status, 0, interactive.stderr);
    assert.equal(interactive.stdout.trim(), executable);
  }
);

test("non-Windows probe preserves local-only behavior", async () => {
  const calls = [];
  const runSync = (command) => {
    calls.push(command);
    return { status: 0 };
  };
  const status = await probeInstallEnvironment(runSync, {
    platform: "darwin",
    env: { DUALOG_WSL_DISTRO: "must-not-be-used" },
    cwd: "/repo",
  });
  assert.deepEqual(status.host, { claude: true, codex: true, tmux: true });
  assert.equal(status.wsl, null);
  assert.deepEqual(calls, ["claude", "codex", "tmux"]);
  assert.deepEqual(formatInstallEnvironment(status), [
    "  Claude Code CLI OK",
    "  Codex CLI OK",
    "  tmux OK",
  ]);
});

test("explicit native-Windows WSL selections fail closed when unavailable", () => {
  const unavailable = {
    platform: "win32",
    wsl: {
      binary: "custom-wsl.exe",
      binaryAvailable: false,
      distroAvailable: false,
    },
  };

  assert.throws(
    () =>
      validateExplicitWslSelection(
        { wslBinary: "custom-wsl.exe", wslDistro: null },
        unavailable,
        { platform: "win32" }
      ),
    /Requested WSL binary "custom-wsl\.exe" could not be launched.*no native MCP registration was written/
  );
  assert.throws(
    () =>
      validateExplicitWslSelection(
        { wslBinary: null, wslDistro: "Missing-Distro" },
        unavailable,
        { platform: "win32" }
      ),
    /Requested WSL distribution "Missing-Distro" is unavailable.*no native MCP registration was written/
  );
  assert.throws(
    () =>
      validateExplicitWslSelection(
        { wslBinary: "custom-wsl.exe", wslDistro: null },
        {
          platform: "win32",
          wsl: {
            binary: "custom-wsl.exe",
            binaryAvailable: true,
            distroAvailable: false,
          },
        },
        { platform: "win32" }
      ),
    /Requested WSL binary "custom-wsl\.exe" could not execute its default WSL distribution.*no native MCP registration was written/
  );

  assert.doesNotThrow(() =>
    validateExplicitWslSelection(
      { wslBinary: "custom-wsl.exe", wslDistro: "Ubuntu-24.04" },
      {
        platform: "win32",
        wsl: { binaryAvailable: true, distroAvailable: true },
      },
      { platform: "win32" }
    )
  );
  assert.doesNotThrow(() =>
    validateExplicitWslSelection(
      { wslBinary: "ignored.exe", wslDistro: "ignored" },
      { platform: "darwin", wsl: null },
      { platform: "darwin" }
    )
  );
});

test("documented WSL environment overrides are explicit hard constraints", async () => {
  assert.deepEqual(
    effectiveExplicitWslSelection(
      { installClaude: true, wslBinary: null, wslDistro: null },
      {
        env: {
          DUALOG_WSL_BINARY: "env-wsl.exe",
          DUALOG_WSL_DISTRO: "Env-Distro",
        },
      }
    ),
    {
      installClaude: true,
      wslBinary: "env-wsl.exe",
      wslDistro: "Env-Distro",
    }
  );

  await assert.rejects(
    preflightExplicitWslSelection(
        { wslBinary: null, wslDistro: null },
        {
          platform: "win32",
          env: {
            SystemRoot: "C:\\Windows",
            DUALOG_WSL_DISTRO: "Missing-From-Env",
          },
          runProbe: (command, args) =>
            args.includes("--distribution")
              ? { status: 1 }
              : { status: 0 },
        }
      ),
    /Requested WSL distribution "Missing-From-Env" is unavailable/
  );
});

test("installer validates explicit WSL selection before native registration", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts", "install.mjs"), "utf-8");
  const transaction = source.lastIndexOf("const transaction = new InstallTransaction({");
  const preflight = source.indexOf("preflightExplicitWslSelection(mode");
  const configPreflight = source.lastIndexOf("prevalidateConfigTargets(mode);");
  const migration = source.lastIndexOf("stageLegacyInstall(transaction, mode);");
  const dependencies = source.indexOf("ensureDependencies();");
  const claudeArtifacts = source.lastIndexOf("stageClaudeCommandsAndHooks(transaction, logStep)");
  const codexArtifacts = source.lastIndexOf("stageCodexSkills(transaction, logStep)");
  const claudeRegistration = source.lastIndexOf(
    "stageClaudeRegistrations(transaction, cliStatus, logStep)"
  );
  const codexRegistration = source.lastIndexOf(
    "stageCodexRegistration(transaction, cliStatus, logStep)"
  );
  const commit = source.lastIndexOf("transaction.commit();");
  assert.ok(preflight >= 0, "installer must preflight an explicit WSL route");
  assert.ok(transaction >= 0, "installer must acquire its transaction lock");
  assert.ok(transaction < preflight, "the lock must precede every fallible setup step");
  assert.ok(configPreflight >= 0, "installer must prevalidate every config write target");
  assert.ok(configPreflight < dependencies);
  assert.ok(preflight < dependencies);
  assert.ok(preflight < claudeRegistration);
  assert.ok(preflight < codexRegistration);
  assert.ok(claudeArtifacts < claudeRegistration);
  assert.ok(codexArtifacts < codexRegistration);
  assert.ok(migration < claudeRegistration);
  assert.ok(migration < codexRegistration);
  assert.ok(claudeRegistration < commit);
  assert.ok(codexRegistration < commit);
});

test("explicit WSL preflight fails before callers can mutate user files", async () => {
  let mutationReached = false;
  await assert.rejects(
    async () => {
      await preflightExplicitWslSelection(
        { wslBinary: "C:\\missing\\wsl.exe", wslDistro: "Missing-Distro" },
        {
          platform: "win32",
          runProbe: () => ({
            status: null,
            pid: undefined,
            error: Object.assign(new Error("not found"), { code: "ENOENT" }),
          }),
        }
      );
      mutationReached = true;
    },
    /Requested WSL binary .* could not be launched/
  );
  assert.equal(mutationReached, false);
});

test("binary-only WSL preflight probes the default route before mutation", async () => {
  const calls = [];
  const customBinary = "C:\\tools\\custom-wsl.exe";
  const status = await preflightExplicitWslSelection(
    { wslBinary: customBinary, wslDistro: null },
    {
      platform: "win32",
      cwd: "C:\\repo",
      runProbe: (command, args, options) => {
        calls.push({ command, args: [...args], options });
        return { status: 0 };
      },
    }
  );

  assert.deepEqual(
    calls.map(({ command, args }) => ({ command, args })),
    [
      { command: customBinary, args: ["--status"] },
      { command: customBinary, args: ["--exec", "true"] },
    ]
  );
  assert.ok(calls.every(({ options }) => options.timeout === 10000));
  assert.ok(calls.every(({ options }) => options.cwd === "C:\\repo"));
  assert.equal(status.wsl.binaryAvailable, true);
  assert.equal(status.wsl.distroAvailable, true);
  assert.equal(status.wsl.requestedDistro, null);
});

test("binary-only WSL preflight fails closed when the default route cannot execute", async () => {
  const calls = [];
  const customBinary = "C:\\tools\\custom-wsl.exe";
  let mutationReached = false;

  await assert.rejects(
    async () => {
      await preflightExplicitWslSelection(
        { wslBinary: customBinary, wslDistro: null },
        {
          platform: "win32",
          runProbe: (command, args) => {
            calls.push([command, [...args]]);
            return { status: args[0] === "--status" ? 0 : 1 };
          },
        }
      );
      mutationReached = true;
    },
    /could not execute its default WSL distribution.*no native MCP registration was written/
  );

  assert.equal(mutationReached, false);
  assert.deepEqual(calls, [
    [customBinary, ["--status"]],
    [customBinary, ["--exec", "true"]],
  ]);
});

test("custom WSL binaries require stable absolute Windows paths before probing", async () => {
  for (const binary of [
    ".\\tools\\wsl.exe",
    "corp-wsl.exe",
    "corp-wsl",
    "\\tools\\wsl.exe",
  ]) {
    const calls = [];
    await assert.rejects(
      preflightExplicitWslSelection(
        { wslBinary: binary, wslDistro: "Ubuntu" },
        {
          platform: "win32",
          runProbe: (...args) => {
            calls.push(args);
            return { status: 0 };
          },
        }
      ),
      binary === "corp-wsl"
        ? /must end in \.exe or \.com.*PATHEXT/iu
        : /must be an absolute drive or UNC path/iu
    );
    assert.deepEqual(calls, [], `${binary} must fail before any WSL probe`);
  }

  assert.equal(
    assertSafeWslLauncher("wsl.exe", { platform: "win32" }),
    "wsl.exe"
  );
  assert.equal(
    assertSafeWslLauncher("C:\\tools\\wsl.exe", { platform: "win32" }),
    "C:\\tools\\wsl.exe"
  );
  assert.equal(
    assertSafeWslLauncher("\\\\server\\share\\wsl.exe", {
      platform: "win32",
    }),
    "\\\\server\\share\\wsl.exe"
  );
});

test("explicit WSL preflight remains a native Darwin no-op", async () => {
  const calls = [];
  const status = await preflightExplicitWslSelection(
    { wslBinary: "custom-wsl.exe", wslDistro: null },
    {
      platform: "darwin",
      runProbe: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
    }
  );

  assert.equal(status, null);
  assert.deepEqual(calls, []);
});

test("a custom WSL binary is persisted only after its distro route succeeds", () => {
  const customBinary = "C:\\tools\\custom-wsl.exe";
  const unverified = {
    wsl: {
      binary: customBinary,
      binaryAvailable: true,
      distroAvailable: false,
    },
  };
  const verified = {
    wsl: {
      ...unverified.wsl,
      distroAvailable: true,
    },
  };

  assert.deepEqual(persistedWslEnv(unverified, { platform: "win32" }), {});
  assert.deepEqual(persistedWslEnv(verified, { platform: "win32" }), {
    DUALOG_WSL_BINARY: customBinary,
  });
  assert.deepEqual(
    persistedWslEnv(
      { wsl: { ...verified.wsl, binary: "corp-wsl.exe" } },
      { platform: "win32" }
    ),
    {}
  );
  assert.deepEqual(
    persistedWslEnv(
      { wsl: { ...verified.wsl, binary: "wsl.exe" } },
      { platform: "win32", env: { SystemRoot: "D:\\WinNT" } }
    ),
    { DUALOG_WSL_BINARY: "D:\\WinNT\\System32\\wsl.exe" }
  );
  assert.deepEqual(persistedWslEnv(verified, { platform: "darwin" }), {});
});

test("timed-out Windows installer probes terminate while the wrapper is live", async () => {
  const child = new EventEmitter();
  child.pid = 4729;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls++; };
  let wrapperLive = true;
  const terminated = [];
  const result = await runInstallProbe(
    "claude.cmd",
    ["--version"],
    {
      timeout: 5,
      env: { SystemRoot: "C:\\Windows", ComSpec: "C:\\attacker\\cmd.exe" },
      stdio: ["ignore", "pipe", "pipe"],
    },
    {
      platform: "win32",
      spawnFn: () => child,
      terminateTreeFn: (pid) => {
        assert.equal(wrapperLive, true, "tree kill must precede wrapper close/detach");
        terminated.push(pid);
        wrapperLive = false;
        return { status: "succeeded", attempted: true };
      },
    }
  );
  assert.deepEqual(terminated, [4729]);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.windowsTreeTermination.status, "succeeded");
  assert.equal(child.unrefCalls, 1);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test("pre-bootstrap CLI .cmd probes stay escaped while WSL .cmd launchers fail closed", async () => {
  const direct = prepareWindowsCommandInvocation(
    "C:\\Tools & Stuff\\claude.cmd",
    ["--version", "value & echo PWNED"],
    {
      env: {
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\attacker\\cmd.exe",
      },
    },
    { platform: "win32" }
  );
  assert.equal(direct.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(direct.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(direct.options.windowsVerbatimArguments, true);
  assert.equal(direct.options.env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(
    Object.keys(direct.options.env).filter(
      (key) => key.toLocaleLowerCase("en-US") === "comspec"
    ).length,
    1
  );
  assert.match(direct.args[3], /\^&/u);
  assert.doesNotMatch(direct.args[3], /(?<!\^)&/u);

  let invalidRootLaunches = 0;
  const invalidRoot = runInstallProbe(
    "claude.cmd",
    ["--version"],
    { env: { SystemRoot: "C:\\Users\\test\\Windows" } },
    {
      platform: "win32",
      spawnFn: () => {
        invalidRootLaunches += 1;
        throw new Error("must not execute");
      },
    }
  );
  assert.match((await invalidRoot).error.message, /trusted top-level Windows System32/u);
  assert.equal(invalidRootLaunches, 0);

  const posixOptions = { env: { ComSpec: "keep-me" } };
  assert.deepEqual(
    prepareWindowsCommandInvocation(
      "/opt/tools/claude.cmd",
      ["--version"],
      posixOptions,
      { platform: "darwin" }
    ),
    { command: "/opt/tools/claude.cmd", args: ["--version"], options: posixOptions }
  );

  const extensionlessLaunches = [];
  const ambientComSpecBefore = Object.entries(process.env).filter(
    ([key]) => key.toLocaleLowerCase("en-US") === "comspec"
  );
  const extensionlessResult = runInstallProbe(
    "claude",
    ["--version"],
    {
      env: {
        SystemRoot: "C:\\Windows",
        COMSPEC: "C:\\attacker\\cmd.exe",
        comspec: "C:\\other-attacker\\cmd.exe",
      },
    },
    {
      platform: "win32",
      spawnFn: (command, args, options) => {
        assert.equal(
          process.env.comspec,
          "C:\\Windows\\System32\\cmd.exe",
          "cross-spawn's synchronous parser must not see ambient ComSpec"
        );
        extensionlessLaunches.push({ command, args, options });
        const child = new EventEmitter();
        child.pid = 9123;
        child.stdout = null;
        child.stderr = null;
        setImmediate(() => child.emit("close", 0, null));
        return child;
      },
    }
  );
  assert.equal((await extensionlessResult).status, 0);
  assert.equal(extensionlessLaunches.length, 1);
  assert.equal(
    extensionlessLaunches[0].options.env.ComSpec,
    "C:\\Windows\\System32\\cmd.exe"
  );
  assert.equal(
    Object.keys(extensionlessLaunches[0].options.env).filter(
      (key) => key.toLocaleLowerCase("en-US") === "comspec"
    ).length,
    1,
    "cross-spawn must see one trusted command processor regardless of env casing"
  );
  assert.deepEqual(
    Object.entries(process.env).filter(
      ([key]) => key.toLocaleLowerCase("en-US") === "comspec"
    ),
    ambientComSpecBefore,
    "the temporary parser guard must restore the parent environment exactly"
  );

  const launches = [];
  let nextPid = 8100;
  const spawnFn = (command, args, options) => {
    launches.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = null;
    child.stderr = null;
    child.unref = () => {};
    setImmediate(() => child.emit("close", 0, null));
    return child;
  };
  await assert.rejects(
    preflightExplicitWslSelection(
      {
        wslBinary: "C:\\Tools & Stuff\\wsl.cmd",
        wslDistro: "Ubuntu & echo PWNED",
      },
      { platform: "win32", env: {}, spawnFn }
    ),
    /directly executable binary.*\.cmd\/\.bat wrapper/iu
  );
  assert.equal(launches.length, 0, "unsafe WSL launchers must fail before spawn");
});

test("selected WSL lifecycle completes before native mutation and never uses sync launchers", () => {
  const installSource = fs.readFileSync(
    path.join(REPO_ROOT, "scripts", "install.mjs"),
    "utf-8"
  );
  const uninstallSource = fs.readFileSync(
    path.join(REPO_ROOT, "scripts", "uninstall.mjs"),
    "utf-8"
  );
  const lifecycle = installSource.lastIndexOf(
    "await configureWslHosts(spawn, mode, cliStatus, logStep)"
  );
  assert.ok(lifecycle >= 0);
  assert.ok(
    lifecycle <
      installSource.lastIndexOf("stageClaudeRegistrations(transaction, cliStatus, logStep)")
  );
  assert.ok(
    lifecycle <
      installSource.lastIndexOf("stageCodexRegistration(transaction, cliStatus, logStep)")
  );
  assert.doesNotMatch(installSource, /spawn\.sync\(/u);
  assert.doesNotMatch(uninstallSource, /spawnSync\(/u);
  assert.ok(
    uninstallSource.indexOf("await removeWslHosts(mode)") <
      uninstallSource.lastIndexOf("removeClaudeMcp()")
  );
});

test("an old or unreported WSL Node version is not treated as installable", async () => {
  const runSync = (command, args) => {
    if (["claude", "codex", "tmux"].includes(command)) return { status: 1 };
    if (args[0] === "--status" || args.at(-1) === "true") return { status: 0 };
    if (args.at(-1) === 'printf "%s" "$WSL_DISTRO_NAME"') {
      return { status: 0, stdout: "Ubuntu\n" };
    }
    if (args.some((arg) => String(arg).includes("getent passwd"))) {
      return { status: 0, stdout: "/bin/bash\n" };
    }
    const pathMarker = args.find((arg) => String(arg).startsWith("__DUALOG_WSL_PATH_"));
    if (pathMarker) {
      return { status: 0, stdout: `${pathMarker}\n/usr/bin/node\n` };
    }
    const marker = args.find((arg) => String(arg).startsWith("__DUALOG_WSL_PROBE_"));
    if (args.includes("node") && args.at(-1) === "--version") {
      return { status: 0, stdout: `${marker}\nv16.20.2\n` };
    }
    return { status: 1 };
  };
  const status = await probeInstallEnvironment(runSync, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    cwd: "C:\\repo",
  });
  assert.equal(status.wsl.node, false);
  assert.equal(status.wsl.nodeVersion, "v16.20.2");
});

test("installer default WSL route is exact while custom and POSIX routes are preserved", () => {
  assert.deepEqual(
    resolveWslRoute({
      platform: "win32",
      env: { SystemRoot: "D:\\WinNT", PATH: "C:\\attacker" },
    }),
    { binary: "D:\\WinNT\\System32\\wsl.exe", distro: null }
  );
  assert.deepEqual(
    resolveWslRoute({
      platform: "win32",
      env: {
        SystemRoot: "C:\\Windows",
        DUALOG_WSL_BINARY: "C:\\vendor\\wsl.exe",
        DUALOG_WSL_DISTRO: "Ubuntu",
      },
    }),
    { binary: "C:\\vendor\\wsl.exe", distro: "Ubuntu" }
  );
  assert.deepEqual(
    resolveWslRoute({
      platform: "darwin",
      env: { DUALOG_WSL_BINARY: "/opt/wsl-test", DUALOG_WSL_DISTRO: "ignored" },
    }),
    { binary: "/opt/wsl-test", distro: "ignored" }
  );
  assert.throws(
    () =>
      resolveWslRoute({
        platform: "win32",
        env: { SystemRoot: "C:\\Temp\\Windows" },
      }),
    /trusted top-level Windows System32/u
  );
});

test("PowerShell wrappers expose a scoped distro selector and host-only recursion guard", () => {
  for (const [file, argsName] of [
    ["install.ps1", "InstallArgs"],
    ["uninstall.ps1", "UninstallArgs"],
  ]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
    assert.match(source, /\[string\]\$Distro/);
    assert.match(source, /\[string\]\$WslBinary/);
    assert.match(source, /\[switch\]\$HostOnly/);
    assert.match(source, /DUALOG_WSL_DISTRO/);
    assert.match(source, /DUALOG_WSL_BINARY/);
    assert.match(source, /finally\s*\{/);
    assert.match(source, /\$PreviousDistro/);
    assert.match(source, /\$PreviousWslBinary/);
    assert.match(source, /--host-only/);
    assert.match(
      source,
      new RegExp(`\\$${argsName} \\+= @\\("--wsl-distro", \\$Distro\\)`)
    );
    assert.match(
      source,
      new RegExp(`\\$${argsName} \\+= @\\("--wsl-binary", \\$WslBinary\\)`)
    );
    assert.match(source, /Get-Command node/);
    assert.match(source, /& \$NodeCommand\.Source/);
  }
});

test("installer and uninstaller retain the PR review command and skill", () => {
  for (const file of ["scripts/install.mjs", "scripts/uninstall.mjs"]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
    assert.match(source, /CLAUDE_COMMANDS[\s\S]*"dualog-review-pr"/);
    assert.match(source, /CODEX_SKILLS[\s\S]*"dualog-review-pr"/);
    assert.doesNotMatch(source, /claude_desktop_config\.json/);
  }
});

test("installer migrates the oldest Claude layout through exact owned fields", (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, "codex-home");
  const claudeDir = path.join(home, ".claude");
  const hooksRoot = path.join(claudeDir, "hooks");
  const legacyHookDir = path.join(hooksRoot, "codex-dialog");
  const currentHookDir = path.join(hooksRoot, "dualog");
  const legacyEnforce = path.join(legacyHookDir, "enforce-investigation.sh");
  const legacyClear = path.join(legacyHookDir, "clear-investigation.sh");
  const legacyMark = path.join(legacyHookDir, "mark-needs-investigation.mjs");
  const currentClear = path.join(currentHookDir, "clear-investigation.mjs");
  const unrelatedClear = path.join(home, "custom-hooks", "clear-investigation.mjs");
  const legacyPlatform = path.join(hooksRoot, "codex-dialog-platform.mjs");
  const genericPlatform = path.join(hooksRoot, "platform.mjs");
  const settingsPath = path.join(claudeDir, "settings.json");
  const claudeConfigPath = path.join(home, ".claude.json");
  const unrelatedHook = "/usr/local/bin/team-dualog-hook --keep";
  const unrelatedPlatformContent = [
    'export const description = "dualog platform helpers";',
    'export const oldPath = "hooks/codex-dialog/clear-investigation.sh";',
    "",
  ].join("\n");

  fs.mkdirSync(legacyHookDir, { recursive: true });
  fs.mkdirSync(path.dirname(unrelatedClear), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(legacyEnforce, "#!/usr/bin/env bash\n");
  fs.writeFileSync(legacyClear, "#!/usr/bin/env bash\n");
  fs.writeFileSync(legacyMark, "// historical Node hook\n");
  fs.writeFileSync(legacyPlatform, HISTORICAL_PLATFORM_HELPER_HEADER);
  fs.writeFileSync(genericPlatform, unrelatedPlatformContent);
  fs.writeFileSync(unrelatedClear, "// unrelated\n");
  fs.writeFileSync(
    claudeConfigPath,
    `${JSON.stringify(
      {
        mcpServers: {
          dualog: null,
          "codex-dialog": null,
          unrelated: { command: "keep-current-config" },
        },
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        note: "mcp__codex-dialog__send_message hooks/codex-dialog/ platform helper",
        mcpServers: {
          dualog: null,
          "codex-dialog": null,
          unrelated: { command: "keep-historical-config" },
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp__codex-dialog__send_message",
              hooks: [
                { type: "command", command: `bash ${legacyEnforce}` },
                { type: "command", command: unrelatedHook },
              ],
            },
          ],
          PostToolUse: [
            { matcher: "CustomEmpty", hooks: [] },
            { matcher: "CustomMetadata", note: "no hooks by design" },
            {
              matcher: "mcp__codex-dialog__wait_for_partner_response",
              hooks: [
                { type: "command", command: `node ${legacyMark}` },
                { type: "command", command: unrelatedHook },
              ],
            },
            {
              matcher: "Grep",
              hooks: [
                { type: "command", command: `node "${currentClear}"` },
                { type: "command", command: `node "${unrelatedClear}"` },
              ],
            },
            {
              matcher: "Glob",
              hooks: [{ type: "command", command: `bash ${legacyClear}` }],
            },
            {
              matcher: "Read",
              hooks: [{ type: "command", command: `node "${unrelatedClear}"` }],
            },
          ],
        },
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(path.join(codexHome, "config.toml"), "");

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--both", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        DUALOG_INSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);

  const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
  assert.equal(Object.hasOwn(claudeConfig.mcpServers, "codex-dialog"), false);
  assert.equal(claudeConfig.mcpServers.unrelated.command, "keep-current-config");
  assert.equal(claudeConfig.mcpServers.dualog.command, process.execPath);

  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  assert.deepEqual(settings.mcpServers, {
    unrelated: { command: "keep-historical-config" },
  });
  assert.equal(
    settings.note,
    "mcp__codex-dialog__send_message hooks/codex-dialog/ platform helper"
  );
  assert.equal(
    settings.hooks.PreToolUse.some(
      (entry) => entry.matcher === "mcp__dualog__send_message"
    ),
    true
  );
  const allCommands = Object.values(settings.hooks)
    .flat()
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command);
  assert.equal(allCommands.includes(unrelatedHook), true);
  assert.equal(allCommands.includes(`node "${unrelatedClear}"`), true);
  assert.equal(allCommands.some((command) => command?.includes(legacyHookDir)), false);
  assert.equal(
    Object.values(settings.hooks)
      .flat()
      .some((entry) => entry.matcher?.startsWith("mcp__codex-dialog__")),
    false
  );
  assert.equal(
    settings.hooks.PostToolUse.some(
      (entry) =>
        ["Grep", "Glob"].includes(entry.matcher) &&
        entry.hooks?.some((hook) => hook.command === `node "${currentClear}"`)
    ),
    false
  );
  assert.equal(fs.existsSync(legacyHookDir), false);
  assert.equal(fs.existsSync(legacyPlatform), false);
  assert.equal(fs.readFileSync(genericPlatform, "utf-8"), unrelatedPlatformContent);
});

test("Codex-only upgrade leaves current and unrelated Claude config byte-for-byte unchanged", (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, "codex-home");
  const claudeDir = path.join(home, ".claude");
  const claudeConfigPath = path.join(home, ".claude.json");
  const settingsPath = path.join(claudeDir, "settings.json");
  const legacyCommand = path.join(claudeDir, "commands", "codex-review-code.md");
  const legacyHookDir = path.join(claudeDir, "hooks", "codex-dialog");
  const legacyPlatform = path.join(claudeDir, "hooks", "codex-dialog-platform.mjs");
  const legacySkill = path.join(codexHome, "skills", "claude-review-code", "SKILL.md");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const claudeConfig =
    '{ "mcpServers": { "dualog": { "command": "keep-current" }, "codex-dialog": null, "team-dualog": null } }\n';
  const settings =
    `{\n  "mcpServers": { "dualog": { "command": "keep-historical-current" }, "codex-dialog": null, "team-dualog": null },\n  "hooks": { "PreToolUse": [{ "matcher": "mcp__codex-dialog__send_message", "hooks": [{ "type": "command", "command": "node ${path.join(legacyHookDir, "enforce-investigation.mjs").replaceAll("\\", "\\\\")}" }] }] },\n  "note": "mcp__codex-dialog__substring and hooks/codex-dialog/example must stay"\n}\n`;
  fs.mkdirSync(path.dirname(legacyCommand), { recursive: true });
  fs.mkdirSync(legacyHookDir, { recursive: true });
  fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
  fs.writeFileSync(claudeConfigPath, claudeConfig);
  fs.writeFileSync(settingsPath, settings);
  fs.writeFileSync(legacyCommand, "legacy Claude command\n");
  fs.writeFileSync(
    path.join(legacyHookDir, "enforce-investigation.mjs"),
    "// legacy Claude hook\n"
  );
  fs.writeFileSync(legacyPlatform, HISTORICAL_PLATFORM_HELPER_HEADER);
  fs.writeFileSync(legacySkill, "legacy Codex skill\n");
  fs.writeFileSync(
    codexConfigPath,
    [
      "[mcp_servers.codex-dialog]",
      'command = "legacy"',
      "",
      "[mcp_servers.dualog]",
      'command = "old-current"',
      "",
      "[mcp_servers.unrelated]",
      'command = "keep"',
      "",
    ].join("\n")
  );

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--codex", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        DUALOG_INSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(fs.readFileSync(claudeConfigPath, "utf-8"), claudeConfig);
  assert.equal(fs.readFileSync(settingsPath, "utf-8"), settings);
  assert.equal(fs.readFileSync(legacyCommand, "utf-8"), "legacy Claude command\n");
  assert.equal(fs.existsSync(legacyHookDir), true);
  assert.equal(fs.existsSync(legacyPlatform), true);
  assert.equal(fs.existsSync(path.dirname(legacySkill)), false);
  const codexConfig = fs.readFileSync(codexConfigPath, "utf-8");
  assert.match(codexConfig, /\[mcp_servers\.dualog\]/u);
  assert.match(codexConfig, /\[mcp_servers\.unrelated\]/u);
  assert.doesNotMatch(codexConfig, /codex-dialog/u);
});

test("Claude-only upgrade leaves current and legacy Codex artifacts byte-for-byte unchanged", (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, "codex-home");
  const claudeDir = path.join(home, ".claude");
  const claudeConfigPath = path.join(home, ".claude.json");
  const settingsPath = path.join(claudeDir, "settings.json");
  const legacyCommand = path.join(claudeDir, "commands", "codex-review-code.md");
  const legacyHookDir = path.join(claudeDir, "hooks", "codex-dialog");
  const legacyHook = path.join(legacyHookDir, "enforce-investigation.sh");
  const legacySkill = path.join(codexHome, "skills", "claude-review-code", "SKILL.md");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codexConfig = [
    "[mcp_servers.codex-dialog]",
    'command = "keep-legacy"',
    "",
    "[mcp_servers.dualog]",
    'command = "keep-current"',
    "",
    "[mcp_servers.unrelated]",
    'command = "keep-unrelated"',
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(legacyCommand), { recursive: true });
  fs.mkdirSync(legacyHookDir, { recursive: true });
  fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
  fs.writeFileSync(legacyCommand, "legacy Claude command\n");
  fs.writeFileSync(legacyHook, "#!/usr/bin/env bash\n");
  fs.writeFileSync(legacySkill, "legacy Codex skill\n");
  fs.writeFileSync(codexConfigPath, codexConfig);
  fs.writeFileSync(
    claudeConfigPath,
    `${JSON.stringify({
      mcpServers: {
        dualog: { command: "old-current" },
        "codex-dialog": null,
        unrelated: { command: "keep" },
      },
    })}\n`
  );
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({
      mcpServers: {
        dualog: null,
        "codex-dialog": null,
        unrelated: { command: "keep-settings" },
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "mcp__codex-dialog__send_message",
            hooks: [{ type: "command", command: `bash ${legacyHook}` }],
          },
        ],
      },
    })}\n`
  );

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--claude", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        DUALOG_INSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(fs.readFileSync(codexConfigPath, "utf-8"), codexConfig);
  assert.equal(fs.readFileSync(legacySkill, "utf-8"), "legacy Codex skill\n");
  assert.equal(fs.existsSync(legacyCommand), false);
  assert.equal(fs.existsSync(legacyHookDir), false);
  const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
  assert.equal(Object.hasOwn(claudeConfig.mcpServers, "codex-dialog"), false);
  assert.equal(claudeConfig.mcpServers.dualog.command, process.execPath);
  assert.equal(claudeConfig.mcpServers.unrelated.command, "keep");
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf-8")).mcpServers, {
    unrelated: { command: "keep-settings" },
  });
});

test("active install transaction blocks mutation and preserves live and historical registrations", (t) => {
  const home = tempDir(t);
  const claudeDir = path.join(home, ".claude");
  const hooksRoot = path.join(claudeDir, "hooks");
  const blockedCurrentHooks = path.join(hooksRoot, "dualog");
  const legacyHookDir = path.join(hooksRoot, "codex-dialog");
  const legacyHook = path.join(legacyHookDir, "enforce-investigation.sh");
  const legacyCommand = path.join(claudeDir, "commands", "codex-review-code.md");
  const claudeConfigPath = path.join(home, ".claude.json");
  const settingsPath = path.join(claudeDir, "settings.json");
  const claudeConfig =
    '{ "mcpServers": { "dualog": { "command": "working-current" }, "codex-dialog": { "command": "working-legacy" }, "unrelated": null } }\n';
  const settings = `${JSON.stringify({
    mcpServers: {
      dualog: { command: "working-historical-current" },
      "codex-dialog": { command: "working-historical-legacy" },
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "mcp__codex-dialog__send_message",
          hooks: [{ type: "command", command: `bash ${legacyHook}` }],
        },
      ],
    },
  })}\n`;

  fs.mkdirSync(legacyHookDir, { recursive: true });
  fs.mkdirSync(path.dirname(legacyCommand), { recursive: true });
  fs.writeFileSync(legacyHook, "#!/usr/bin/env bash\n");
  fs.writeFileSync(legacyCommand, "legacy command\n");
  fs.writeFileSync(blockedCurrentHooks, "not a directory\n");
  fs.writeFileSync(claudeConfigPath, claudeConfig);
  fs.writeFileSync(settingsPath, settings);
  const activeTransaction = new InstallTransaction({
    home,
    allowedLogicalPaths: new Set(),
  });
  t.after(() => activeTransaction.abort());

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--claude", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DUALOG_INSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another Dualog installer is still active/u);
  assert.equal(fs.readFileSync(claudeConfigPath, "utf-8"), claudeConfig);
  assert.equal(fs.readFileSync(settingsPath, "utf-8"), settings);
  assert.equal(fs.readFileSync(legacyCommand, "utf-8"), "legacy command\n");
  assert.equal(fs.readFileSync(legacyHook, "utf-8"), "#!/usr/bin/env bash\n");
  assert.equal(fs.readFileSync(blockedCurrentHooks, "utf-8"), "not a directory\n");
});

test("Codex-only install ignores malformed unselected Claude configs", (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, "codex-home");
  const claudeDir = path.join(home, ".claude");
  const claudeConfigPath = path.join(home, ".claude.json");
  const settingsPath = path.join(claudeDir, "settings.json");
  const legacyCommand = path.join(claudeDir, "commands", "codex-review-code.md");
  const malformedClaude = '{"mcpServers":{"codex-dialog":';
  const malformedSettings = '{"hooks":{"PreToolUse":';
  fs.mkdirSync(path.dirname(legacyCommand), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(claudeConfigPath, malformedClaude);
  fs.writeFileSync(settingsPath, malformedSettings);
  fs.writeFileSync(legacyCommand, "keep legacy Claude command\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), "");

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--codex", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        DUALOG_INSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(fs.readFileSync(claudeConfigPath, "utf-8"), malformedClaude);
  assert.equal(fs.readFileSync(settingsPath, "utf-8"), malformedSettings);
  assert.equal(fs.readFileSync(legacyCommand, "utf-8"), "keep legacy Claude command\n");
});

test("Claude-only install ignores an invalid unselected Codex config target", (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, "codex-home");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const legacySkill = path.join(codexHome, "skills", "claude-review-code", "SKILL.md");
  fs.mkdirSync(codexConfigPath, { recursive: true });
  fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
  fs.writeFileSync(legacySkill, "keep legacy Codex skill\n");
  fs.writeFileSync(path.join(home, ".claude.json"), "{}\n");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--claude", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        DUALOG_INSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(fs.statSync(codexConfigPath).isDirectory(), true);
  assert.equal(fs.readFileSync(legacySkill, "utf-8"), "keep legacy Codex skill\n");
});

test("uninstaller removes only exact Dualog hook commands", (t) => {
  const root = tempDir(t);
  const home = path.join(root, "home with spaces");
  fs.mkdirSync(home, { recursive: true });
  const claudeDir = path.join(home, ".claude");
  const hooksRoot = path.join(claudeDir, "hooks");
  const currentHook = path.join(
    hooksRoot,
    "dualog",
    "enforce-investigation.mjs"
  );
  const legacyHook = path.join(
    hooksRoot,
    "codex-dialog",
    "mark-needs-investigation.mjs"
  );
  const legacyShellHook = path.join(
    hooksRoot,
    "codex-dialog",
    "enforce-investigation.sh"
  );
  const unrelatedHooks = [
    '"/usr/local/bin/team-dualog-lint" --check',
    `node "${path.join(home, "other-dualog", "enforce-investigation.mjs")}"`,
    `node "${currentHook}" --extra`,
    `bash "${currentHook}"`,
    `node "${legacyShellHook}"`,
    `node "${legacyHook}.backup"`,
  ];
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.mkdirSync(path.dirname(currentHook), { recursive: true });
  fs.mkdirSync(path.dirname(legacyHook), { recursive: true });
  fs.writeFileSync(currentHook, "// owned current hook\n");
  fs.writeFileSync(legacyHook, "// owned legacy hook\n");
  fs.writeFileSync(legacyShellHook, "# owned historical shell hook\n");
  fs.writeFileSync(path.join(home, ".claude.json"), "{}\n");
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            { matcher: "CustomEmpty", hooks: [] },
            { matcher: "CustomMetadata", note: "no hooks by design" },
            {
              matcher: "Write",
              hooks: [
                { type: "command", command: `node "${currentHook}"` },
                { type: "command", command: `node ${legacyHook}` },
                { type: "command", command: `bash ${legacyShellHook}` },
                ...unrelatedHooks.map((command) => ({ type: "command", command })),
              ],
            },
          ],
        },
      },
      null,
      2
    )}\n`
  );

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "uninstall.mjs"), "--claude", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DUALOG_UNINSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.equal(
    result.status,
    0,
    `uninstaller stderr:\n${result.stderr}\nstdout:\n${result.stdout}`
  );
  const updated = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  const writeEntry = updated.hooks.PostToolUse.find((entry) => entry.matcher === "Write");
  assert.deepEqual(
    writeEntry.hooks.map((hook) => hook.command),
    unrelatedHooks
  );
  assert.deepEqual(updated.hooks.PostToolUse.slice(0, 2), [
    { matcher: "CustomEmpty", hooks: [] },
    { matcher: "CustomMetadata", note: "no hooks by design" },
  ]);
  assert.equal(fs.existsSync(path.join(hooksRoot, "dualog")), false);
  assert.equal(fs.existsSync(path.join(hooksRoot, "codex-dialog")), false);
});

test("uninstaller leaves unrelated Claude hook settings byte-for-byte unchanged", (t) => {
  const home = tempDir(t);
  const settingsPath = path.join(home, ".claude", "settings.json");
  const claudeConfigPath = path.join(home, ".claude.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const originalClaudeConfig = '{ "mcpServers": { "team-dualog": null } }\n';
  fs.writeFileSync(claudeConfigPath, originalClaudeConfig);
  const original = '{\n  "hooks": {\n    "PreToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/team-dualog-lint"}]}]\n  }\n}\n';
  fs.writeFileSync(settingsPath, original);

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "uninstall.mjs"), "--claude", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DUALOG_UNINSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(fs.readFileSync(settingsPath, "utf-8"), original);
  assert.equal(fs.readFileSync(claudeConfigPath, "utf-8"), originalClaudeConfig);
});

test("uninstaller removes the authentic pre-rename install and preserves unrelated config", (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, "codex-home");
  const claudeDir = path.join(home, ".claude");
  const legacyCommand = path.join(claudeDir, "commands", "codex-review-code.md");
  const legacyHookDir = path.join(claudeDir, "hooks", "codex-dialog");
  const legacyHook = path.join(legacyHookDir, "enforce-investigation.sh");
  const legacyPlatform = path.join(claudeDir, "hooks", "codex-dialog-platform.mjs");
  const unrelatedGenericPlatform = path.join(claudeDir, "hooks", "platform.mjs");
  const legacySkill = path.join(codexHome, "skills", "claude-review-code", "SKILL.md");
  const settingsPath = path.join(claudeDir, "settings.json");
  const claudeConfigPath = path.join(home, ".claude.json");
  const codexConfigPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(path.dirname(legacyCommand), { recursive: true });
  fs.mkdirSync(legacyHookDir, { recursive: true });
  fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
  fs.writeFileSync(legacyCommand, "legacy command\n");
  fs.writeFileSync(legacyHook, "legacy hook\n");
  fs.writeFileSync(legacyPlatform, HISTORICAL_PLATFORM_HELPER_HEADER);
  const unrelatedPlatformContent =
    'export const description = "mentions dualog platform helpers but is not owned";\n';
  fs.writeFileSync(unrelatedGenericPlatform, unrelatedPlatformContent);
  fs.writeFileSync(legacySkill, "legacy skill\n");
  fs.writeFileSync(
    claudeConfigPath,
    `${JSON.stringify(
      {
        mcpServers: {
          "codex-dialog": null,
          dualog: null,
          unrelated: { command: "keep" },
        },
      },
      null,
      2
    )}\n`
  );
  const unrelatedHook = "/usr/local/bin/unrelated-hook --keep";
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        mcpServers: {
          "codex-dialog": null,
          dualog: null,
          unrelatedSettings: { command: "keep-settings" },
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp__codex-dialog__send_message",
              hooks: [
                { type: "command", command: `bash ${legacyHook}` },
                { type: "command", command: unrelatedHook },
              ],
            },
          ],
        },
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    codexConfigPath,
    [
      "[mcp_servers.codex-dialog]",
      'command = "node"',
      'args = ["/old/dialog-server.mjs"]',
      "",
      "[mcp_servers.unrelated]",
      'command = "keep"',
      "",
    ].join("\n")
  );

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "uninstall.mjs"), "--both", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        DUALOG_UNINSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.equal(fs.existsSync(legacyCommand), false);
  assert.equal(fs.existsSync(legacyHookDir), false);
  assert.equal(fs.existsSync(legacyPlatform), false);
  assert.equal(fs.readFileSync(unrelatedGenericPlatform, "utf-8"), unrelatedPlatformContent);
  assert.equal(fs.existsSync(path.dirname(legacySkill)), false);
  const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
  assert.deepEqual(claudeConfig.mcpServers, { unrelated: { command: "keep" } });
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  assert.deepEqual(settings.mcpServers, {
    unrelatedSettings: { command: "keep-settings" },
  });
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [
    { type: "command", command: unrelatedHook },
  ]);
  const codexConfig = fs.readFileSync(codexConfigPath, "utf-8");
  assert.doesNotMatch(codexConfig, /codex-dialog/u);
  assert.match(codexConfig, /mcp_servers\.unrelated/u);
});

test("unsafe legacy WSL launchers are skipped while native registrations are removed", (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, "codex-home");
  const claudeConfigPath = path.join(home, ".claude.json");
  const codexConfigPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    claudeConfigPath,
    `${JSON.stringify(
      {
        mcpServers: {
          unrelated: { command: "keep" },
          dualog: {
            command: "node",
            env: {
              DUALOG_WSL_DISTRO: "Ubuntu",
              DUALOG_WSL_BINARY: "C:\\legacy\\wsl.cmd",
            },
          },
        },
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    codexConfigPath,
    [
      "[mcp_servers.unrelated]",
      'command = "keep"',
      "",
      "[mcp_servers.dualog]",
      'command = "node"',
      'env = { DUALOG_WSL_DISTRO = "Ubuntu", DUALOG_WSL_BINARY = "C:\\\\legacy\\\\wsl.cmd" }',
      "",
    ].join("\n")
  );

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
  };
  for (const name of [
    "DUALOG_UNINSTALL_HOST_ONLY",
    "DUALOG_WSL_BINARY",
    "DUALOG_WSL_DISTRO",
  ]) {
    delete env[name];
  }
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      path.join(REPO_ROOT, "tests", "helpers", "fake-win32-platform.cjs"),
      path.join(REPO_ROOT, "scripts", "uninstall.mjs"),
      "--both",
    ],
    { cwd: REPO_ROOT, env, encoding: "utf-8", timeout: 30000 }
  );

  assert.equal(
    result.status,
    0,
    `uninstaller stderr:\n${result.stderr}\nstdout:\n${result.stdout}`
  );
  assert.match(result.stdout, /Skipping unsafe legacy WSL lifecycle route/);
  assert.match(result.stdout, /Native MCP registration will still be removed/);
  const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
  assert.deepEqual(claudeConfig.mcpServers, {
    unrelated: { command: "keep" },
  });
  const codexConfig = fs.readFileSync(codexConfigPath, "utf-8");
  assert.match(codexConfig, /\[mcp_servers\.unrelated\]/);
  assert.doesNotMatch(codexConfig, /mcp_servers\.dualog/);
});

test("macOS entrypoints preserve valid final config symlinks", (t) => {
  if (process.platform === "win32") {
    t.skip("this test exercises POSIX final-component symlink semantics");
    return;
  }
  const home = tempDir(t);
  const codexHome = path.join(home, "codex-home");
  const targets = path.join(home, "real-configs");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(targets, { recursive: true });

  const links = {
    claude: path.join(home, ".claude.json"),
    settings: path.join(home, ".claude", "settings.json"),
    codex: path.join(codexHome, "config.toml"),
  };
  const real = {
    claude: path.join(targets, "claude.json"),
    settings: path.join(targets, "settings.json"),
    codex: path.join(targets, "config.toml"),
  };
  fs.writeFileSync(real.claude, "{}\n");
  fs.writeFileSync(real.settings, "{}\n");
  fs.writeFileSync(real.codex, 'theme = "dark"\n');
  try {
    for (const key of Object.keys(links)) fs.symlinkSync(real[key], links[key], "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symbolic links are unavailable in this test environment");
      return;
    }
    throw error;
  }

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    DUALOG_INSTALL_HOST_ONLY: "1",
    DUALOG_UNINSTALL_HOST_ONLY: "1",
  };
  const install = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--both", "--host-only"],
    { cwd: REPO_ROOT, env, encoding: "utf-8", timeout: 30000 }
  );
  assert.equal(install.status, 0, `installer stderr:\n${install.stderr}\nstdout:\n${install.stdout}`);
  for (const link of Object.values(links)) {
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  }
  assert.equal(JSON.parse(fs.readFileSync(real.claude, "utf-8")).mcpServers.dualog.command, process.execPath);
  assert.ok(JSON.parse(fs.readFileSync(real.settings, "utf-8")).hooks);
  assert.match(fs.readFileSync(real.codex, "utf-8"), /\[mcp_servers\.dualog\]/);

  const uninstall = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "uninstall.mjs"), "--both", "--host-only"],
    { cwd: REPO_ROOT, env, encoding: "utf-8", timeout: 30000 }
  );
  assert.equal(
    uninstall.status,
    0,
    `uninstaller stderr:\n${uninstall.stderr}\nstdout:\n${uninstall.stdout}`
  );
  for (const link of Object.values(links)) {
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  }
  assert.equal(JSON.parse(fs.readFileSync(real.claude, "utf-8")).mcpServers, undefined);
  assert.doesNotMatch(fs.readFileSync(real.codex, "utf-8"), /mcp_servers\.dualog/);
});

test("entrypoints install and uninstall entirely inside isolated homes", (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, "custom-codex-home");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    DUALOG_INSTALL_HOST_ONLY: "1",
    DUALOG_UNINSTALL_HOST_ONLY: "1",
  };
  const install = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--both", "--host-only"],
    { cwd: REPO_ROOT, env, encoding: "utf-8", timeout: 30000 }
  );
  assert.equal(install.status, 0, `installer stderr:\n${install.stderr}\nstdout:\n${install.stdout}`);

  const claudeConfig = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf-8"));
  assert.equal(claudeConfig.mcpServers.dualog.command, process.execPath);
  assert.deepEqual(claudeConfig.mcpServers.dualog.args, [
    path.join(REPO_ROOT, "src", "dialog-server.mjs"),
  ]);
  assert.ok(
    fs.existsSync(path.join(home, ".claude", "commands", "dualog-review-pr.md"))
  );
  assert.ok(fs.existsSync(path.join(codexHome, "skills", "dualog-review-pr", "SKILL.md")));
  const codexConfig = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.match(codexConfig, /\[mcp_servers\.dualog\]/);
  assert.match(codexConfig, new RegExp(JSON.stringify(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const uninstall = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "uninstall.mjs"), "--both", "--host-only"],
    { cwd: REPO_ROOT, env, encoding: "utf-8", timeout: 30000 }
  );
  assert.equal(
    uninstall.status,
    0,
    `uninstaller stderr:\n${uninstall.stderr}\nstdout:\n${uninstall.stdout}`
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf-8")).mcpServers,
    undefined
  );
  assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8"), "");
  assert.equal(
    fs.existsSync(path.join(home, ".claude", "commands", "dualog-review-pr.md")),
    false
  );
  assert.equal(
    fs.existsSync(path.join(codexHome, "skills", "dualog-review-pr")),
    false
  );
});

test("entrypoint prevalidation leaves legacy files untouched when JSON is malformed", (t) => {
  const home = tempDir(t);
  const codexHome = path.join(home, "custom-codex-home");
  const legacyCommand = path.join(
    home,
    ".claude",
    "commands",
    "codex-review-code.md"
  );
  const legacyHooks = path.join(home, ".claude", "hooks", "codex-dialog");
  const legacySkill = path.join(codexHome, "skills", "claude-review-code", "SKILL.md");
  fs.mkdirSync(path.dirname(legacyCommand), { recursive: true });
  fs.mkdirSync(legacyHooks, { recursive: true });
  fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
  fs.writeFileSync(legacyCommand, "keep command");
  fs.writeFileSync(path.join(legacyHooks, "keep.mjs"), "keep hook");
  fs.writeFileSync(legacySkill, "keep skill");
  const malformedPath = path.join(home, ".claude.json");
  const malformed = '{"mcpServers":{"codex-dialog":';
  fs.writeFileSync(malformedPath, malformed);

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--both", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        DUALOG_INSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite malformed JSON config/);
  assert.equal(fs.readFileSync(malformedPath, "utf-8"), malformed);
  assert.equal(fs.readFileSync(legacyCommand, "utf-8"), "keep command");
  assert.equal(fs.readFileSync(path.join(legacyHooks, "keep.mjs"), "utf-8"), "keep hook");
  assert.equal(fs.readFileSync(legacySkill, "utf-8"), "keep skill");
});

test("dangling Codex config prevalidation fails before legacy migration", (t) => {
  if (process.platform === "win32") {
    t.skip("this test exercises POSIX dangling-symlink semantics");
    return;
  }
  const home = tempDir(t);
  const codexHome = path.join(home, "codex-home");
  const legacyCommand = path.join(
    home,
    ".claude",
    "commands",
    "codex-review-code.md"
  );
  const configPath = path.join(codexHome, "config.toml");
  fs.mkdirSync(path.dirname(legacyCommand), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(legacyCommand, "keep command");
  try {
    fs.symlinkSync(path.join(home, "missing-codex-config.toml"), configPath, "file");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symbolic links are unavailable in this test environment");
      return;
    }
    throw error;
  }

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--both", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        DUALOG_INSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to replace dangling symbolic link config/);
  assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(legacyCommand, "utf-8"), "keep command");
});

test("dangling config parent prevalidation fails before legacy migration", (t) => {
  if (process.platform === "win32") {
    t.skip("this test exercises POSIX dangling-directory-symlink semantics");
    return;
  }
  const home = tempDir(t);
  const codexHome = path.join(home, "dangling-codex-home");
  const legacyCommand = path.join(
    home,
    ".claude",
    "commands",
    "codex-review-code.md"
  );
  fs.mkdirSync(path.dirname(legacyCommand), { recursive: true });
  fs.writeFileSync(legacyCommand, "keep command");
  try {
    fs.symlinkSync(path.join(home, "missing-codex-home"), codexHome, "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("symbolic links are unavailable in this test environment");
      return;
    }
    throw error;
  }

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "install.mjs"), "--both", "--host-only"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexHome,
        DUALOG_INSTALL_HOST_ONLY: "1",
      },
      encoding: "utf-8",
      timeout: 30000,
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /parent .* is a dangling or unresolvable symbolic link/);
  assert.equal(fs.lstatSync(codexHome).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(legacyCommand, "utf-8"), "keep command");
});

test("dependency validation names every declared runtime package", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts", "install.mjs"), "utf-8");
  for (const dependency of ["@modelcontextprotocol/sdk", "cross-spawn", "zod"]) {
    assert.match(source, new RegExp(JSON.stringify(dependency).slice(1, -1).replace("/", "\\/")));
  }
  assert.match(source, /\["zod", "zod"\]/u, "probe the runtime's package-root import");
  assert.doesNotMatch(source, /zod\/v4/u, "valid zod 3.24 installs must not be rejected");
  assert.match(source, /runtime dependencies are still unavailable/);
});
