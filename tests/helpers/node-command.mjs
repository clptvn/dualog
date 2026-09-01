import fs from "node:fs";
import path from "node:path";

/**
 * Write a tiny Node-backed executable that can be launched by execFile-style
 * code on every host. Unix uses a Node shebang; Windows uses a fixed `.cmd`
 * launcher, which also exercises the package-shim path used by real CLIs.
 */
export function writeNodeCommand(dir, name, source) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(script, source);

  if (process.platform === "win32") {
    const launcher = path.join(dir, `${name}.cmd`);
    const quote = (value) =>
      `"${String(value).replaceAll("%", "%%").replaceAll('"', '""')}"`;
    fs.writeFileSync(
      launcher,
      `@echo off\r\n${quote(process.execPath)} ${quote(script)} %*\r\n`
    );
    return launcher;
  }

  const launcher = path.join(dir, name);
  fs.writeFileSync(launcher, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(launcher, 0o755);
  return launcher;
}
