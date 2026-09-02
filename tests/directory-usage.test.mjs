import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { probeDirectoryInUse } from "../src/directory-usage.mjs";

const MODULE_URL = new URL("../src/directory-usage.mjs", import.meta.url).href;
const OPEN_PROC_MOUNT =
  "148 146 0:72 / /proc rw,relatime - proc proc rw\n";

function runProbe({
  platform = "linux",
  mountInfo = OPEN_PROC_MOUNT,
  mountInfoError = null,
  procError = null,
  deniedPid = null,
  processes = null,
  dirMode = 0o700,
  dirUid = 1000,
  includeEvidence = false,
  realpathError = null,
  lsof = { status: 1, stdout: "", stderr: "" },
} = {}) {
  const processFixtures =
    processes ??
    (deniedPid == null
      ? []
      : [{ pid: deniedPid, status: "same", cwdError: "EACCES", fdError: "EACCES" }]);
  const script = `
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const childProcess = require("node:child_process");
    const { syncBuiltinESMExports } = require("node:module");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-directory-usage-"));
    try { fs.chmodSync(dir, ${dirMode}); } catch {}
    const resolvedDir = fs.realpathSync(dir);
    const fixtures = new Map(
      ${JSON.stringify(processFixtures)}.map((fixture) => [String(fixture.pid), fixture])
    );
    const originalReadFileSync = fs.readFileSync;
    const originalReaddirSync = fs.readdirSync;
    const originalReadlinkSync = fs.readlinkSync;
    const originalRealpathSync = fs.realpathSync;
    const originalStatSync = fs.statSync;
    let spawnCalls = 0;

    Object.defineProperty(process, "platform", {
      configurable: true,
      value: ${JSON.stringify(platform)},
    });
    Object.defineProperty(process, "getuid", {
      configurable: true,
      value: () => 1000,
    });
    fs.statSync = (target, ...args) => {
      const stat = originalStatSync(target, ...args);
      if (String(target) !== resolvedDir) return stat;
      return { ...stat, uid: ${dirUid}, mode: (stat.mode & ~0o777) | ${dirMode} };
    };
    childProcess.spawnSync = () => {
      spawnCalls += 1;
      return ${JSON.stringify(lsof)};
    };
    syncBuiltinESMExports();

    const denied = (code) => {
      const error = new Error(code);
      error.code = code;
      throw error;
    };
    fs.realpathSync = (target, ...args) => {
      if (String(target) === dir && ${JSON.stringify(realpathError)} != null) {
        return denied(${JSON.stringify(realpathError)});
      }
      return originalRealpathSync(target, ...args);
    };
    fs.readFileSync = (target, ...args) => {
      if (String(target) === "/proc/self/mountinfo") {
        ${mountInfoError ? `return denied(${JSON.stringify(mountInfoError)});` : `return ${JSON.stringify(mountInfo)};`}
      }
      const statusMatch = String(target).match(/^\\/proc\\/(\\d+)\\/status$/u);
      const fixture = statusMatch ? fixtures.get(statusMatch[1]) : null;
      if (fixture) {
        if (fixture.statusError) return denied(fixture.statusError);
        if (typeof fixture.statusText === "string") return fixture.statusText;
        const currentUid = process.getuid();
        const otherUid = currentUid === 0 ? 1 : currentUid + 1;
        const uids =
          fixture.status === "different"
            ? [otherUid, otherUid, otherUid, otherUid]
            : fixture.status === "mixed"
              ? [otherUid, currentUid, otherUid, otherUid]
              : [currentUid, currentUid, currentUid, currentUid];
        return "Name:\\tfixture\\nUid:\\t" + uids.join("\\t") + "\\n";
      }
      return originalReadFileSync(target, ...args);
    };
    fs.readdirSync = (target, ...args) => {
      if (String(target) === "/proc") {
        ${procError ? `return denied(${JSON.stringify(procError)});` : "return [...fixtures.keys()];"}
      }
      const fdMatch = String(target).match(/^\\/proc\\/(\\d+)\\/fd$/u);
      const fixture = fdMatch ? fixtures.get(fdMatch[1]) : null;
      if (fixture) {
        if (fixture.fdError) return denied(fixture.fdError);
        return Object.keys(fixture.fds || {});
      }
      return originalReaddirSync(target, ...args);
    };
    fs.readlinkSync = (target, ...args) => {
      const linkMatch = String(target).match(/^\\/proc\\/(\\d+)\\/(cwd|fd\\/(.+))$/u);
      const fixture = linkMatch ? fixtures.get(linkMatch[1]) : null;
      if (fixture && linkMatch[2] === "cwd") {
        if (fixture.cwdError) return denied(fixture.cwdError);
        return fixture.cwd === "lease" ? resolvedDir : fixture.cwd || "/outside";
      }
      if (fixture && linkMatch[3]) {
        const targetValue = (fixture.fds || {})[linkMatch[3]];
        if (targetValue && typeof targetValue === "object" && targetValue.error) {
          return denied(targetValue.error);
        }
        return targetValue === "lease" ? resolvedDir : targetValue || "/outside";
      }
      return originalReadlinkSync(target, ...args);
    };

    import(${JSON.stringify(MODULE_URL)}).then((usage) => {
      const evidence = ${includeEvidence ? "usage.probeDirectoryUsageEvidence(dir)" : "{ verdict: usage.probeDirectoryInUse(dir) }"};
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(JSON.stringify({ ...evidence, spawnCalls }));
    });
  `;

  return JSON.parse(
    execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" }).trim()
  );
}

test("Linux accepts only proc mounts whose enumeration is explicitly unrestricted", () => {
  const free = [
    OPEN_PROC_MOUNT,
    "148 146 0:72 / /proc rw,hidepid=0 - proc proc rw\n",
    "148 146 0:72 / /proc rw - proc proc rw,hidepid=off\n",
  ];
  for (const mountInfo of free) {
    assert.deepEqual(runProbe({ mountInfo }), { verdict: "free", spawnCalls: 0 });
  }

  const restricted = [
    "148 146 0:72 / /proc rw - proc proc rw,hidepid=1\n",
    "148 146 0:72 / /proc rw - proc proc rw,hidepid=noaccess\n",
    "148 146 0:72 / /proc rw - proc proc rw,hidepid=2\n",
    "148 146 0:72 / /proc rw - proc proc rw,hidepid=invisible\n",
    "148 146 0:72 / /proc rw - proc proc rw,hidepid=4\n",
    "148 146 0:72 / /proc rw - proc proc rw,hidepid=ptraceable\n",
    "148 146 0:72 / /proc rw - proc proc rw,hidepid=future-mode\n",
  ];
  for (const mountInfo of restricted) {
    assert.deepEqual(runProbe({ mountInfo }), { verdict: "unknown", spawnCalls: 0 });
  }
});

test("Linux fails closed when procfs completeness cannot be established", () => {
  const cases = [
    { mountInfo: "148 146 0:72 / /other rw - proc proc rw\n" },
    { mountInfo: "148 146 0:72 /self /proc rw - proc proc rw\n" },
    { mountInfo: "148 146 0:72 / /proc rw - ext4 /dev/root rw\n" },
    { mountInfo: "malformed /proc mountinfo\n" },
    { mountInfoError: "EACCES" },
    { procError: "EACCES" },
  ];
  for (const fixture of cases) {
    assert.deepEqual(runProbe(fixture), { verdict: "unknown", spawnCalls: 0 });
  }
});

test("an incomplete Linux proc scan never delegates absence proof to lsof", () => {
  assert.deepEqual(runProbe({ deniedPid: 424242 }), {
    verdict: "unknown",
    spawnCalls: 0,
  });
});

test("Linux scopes a complete proc scan to normal same-UID lease consumers", () => {
  assert.deepEqual(
    runProbe({
      processes: [
        { pid: 410001, status: "different", cwdError: "EACCES", fdError: "EACCES" },
      ],
    }),
    { verdict: "free", spawnCalls: 0 },
    "a status-proven disjoint UID is outside the current-user 0700 lease invariant"
  );
  assert.deepEqual(
    runProbe({ processes: [{ pid: 410002, status: "same", cwd: "lease" }] }),
    { verdict: "in-use", spawnCalls: 0 }
  );
  assert.deepEqual(
    runProbe({ processes: [{ pid: 410003, status: "mixed", cwd: "lease" }] }),
    { verdict: "in-use", spawnCalls: 0 },
    "a match in any of the four Uid fields requires scanning"
  );
  assert.deepEqual(
    runProbe({
      processes: [{ pid: 410004, status: "same", cwd: "/outside", fds: { 7: "lease" } }],
    }),
    { verdict: "in-use", spawnCalls: 0 }
  );
});

test("the strict probe counts a descriptor held by its own caller", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-self-holder-"));
  fs.chmodSync(dir, 0o700);
  const auth = path.join(dir, "auth.json");
  fs.writeFileSync(auth, '{"token":"held-by-caller"}');
  const fd = fs.openSync(auth, "r");
  try {
    const expected = process.platform === "win32" ? "unknown" : "in-use";
    assert.equal(probeDirectoryInUse(dir), expected);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Linux retains on UID or same-UID visibility ambiguity", () => {
  const cases = [
    { processes: [{ pid: 420001, statusError: "EACCES" }] },
    { processes: [{ pid: 420002, statusText: "Name:\tfixture\nUid:\tgarbage\n" }] },
    { processes: [{ pid: 420003, status: "same", cwdError: "EACCES", fdError: "EACCES" }] },
    { processes: [{ pid: 420004, status: "same", cwd: "/outside", fdError: "EIO" }] },
    { dirMode: 0o755 },
    { dirUid: 1001 },
  ];
  for (const fixture of cases) {
    assert.deepEqual(runProbe(fixture), { verdict: "unknown", spawnCalls: 0 });
  }
});

test("Linux classifies only same-UID permission denial without relaxing it", () => {
  assert.deepEqual(
    runProbe({
      includeEvidence: true,
      processes: [{ pid: 425001, status: "same", cwdError: "EACCES", fdError: "EPERM" }],
    }),
    { verdict: "unknown", ambiguity: "same-uid-permission-only", spawnCalls: 0 },
    "the standalone probe must stay fail-closed while identifying the narrow cause"
  );
  assert.deepEqual(
    runProbe({
      includeEvidence: true,
      processes: [{ pid: 425002, status: "same", cwd: "lease" }],
    }),
    { verdict: "in-use", ambiguity: null, spawnCalls: 0 },
    "a readable holder remains an actual match"
  );

  const stillUnknown = [
    {
      includeEvidence: true,
      mountInfo: "148 146 0:72 / /proc rw - proc proc rw,hidepid=ptraceable\n",
    },
    { includeEvidence: true, processes: [{ pid: 425003, statusError: "EACCES" }] },
    {
      includeEvidence: true,
      processes: [{ pid: 425004, status: "same", cwd: "/outside", fdError: "EIO" }],
    },
    { includeEvidence: true, dirMode: 0o755 },
    { includeEvidence: true, dirUid: 1001 },
  ];
  for (const fixture of stillUnknown) {
    assert.deepEqual(runProbe(fixture), {
      verdict: "unknown",
      ambiguity: null,
      spawnCalls: 0,
    });
  }
});

test("Linux ignores a PID that exits between proc enumeration and status", () => {
  assert.deepEqual(
    runProbe({ processes: [{ pid: 430001, statusError: "ENOENT" }] }),
    { verdict: "free", spawnCalls: 0 }
  );
  assert.deepEqual(
    runProbe({ processes: [{ pid: 430002, statusError: "ESRCH" }] }),
    { verdict: "free", spawnCalls: 0 }
  );
});

test("non-Linux platforms preserve their existing directory probes", () => {
  assert.deepEqual(runProbe({ platform: "darwin" }), {
    verdict: "free",
    spawnCalls: 1,
  });
  assert.deepEqual(runProbe({ platform: "win32" }), {
    verdict: "unknown",
    spawnCalls: 0,
  });
});

test("only an absent path makes realpath failure read as free", () => {
  assert.deepEqual(runProbe({ realpathError: "ENOENT" }), {
    verdict: "free",
    spawnCalls: 0,
  });
  for (const realpathError of ["EACCES", "EIO", "EMFILE", "ENOTDIR"]) {
    assert.deepEqual(runProbe({ realpathError }), {
      verdict: "unknown",
      spawnCalls: 0,
    });
  }
});

test("lsof absence requires its exact clean no-match shape", () => {
  assert.deepEqual(
    runProbe({ platform: "darwin", lsof: { status: 1, stdout: "", stderr: "" } }),
    { verdict: "free", spawnCalls: 1 }
  );
  const incomplete = [
    { status: 0, stdout: "", stderr: "" },
    { status: 1, stdout: "unparseable output", stderr: "" },
    { status: 1, stdout: "", stderr: "permission warning" },
    { status: 2, stdout: "", stderr: "" },
  ];
  for (const lsof of incomplete) {
    assert.deepEqual(runProbe({ platform: "darwin", lsof }), {
      verdict: "unknown",
      spawnCalls: 1,
    });
  }
  assert.deepEqual(
    runProbe({ platform: "darwin", lsof: { status: 0, stdout: "p4242\n", stderr: "" } }),
    { verdict: "in-use", spawnCalls: 1 }
  );
});

test("native macOS lsof proves an unused private directory is free", (t) => {
  if (process.platform !== "darwin") {
    t.skip("exercises the native macOS lsof binary");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-native-lsof-free-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "precondition: the probe is private");
  assert.equal(
    probeDirectoryInUse(dir),
    "free",
    "missing, broken, or incorrectly invoked lsof must fail this native macOS smoke test"
  );
});
