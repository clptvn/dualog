import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InstallTransaction,
  fingerprintInstallPath,
  recoverPendingInstallTransaction,
} from "../scripts/install-transaction.mjs";

function tempHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dualog txn home with spaces "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function seedSelectedHosts(home) {
  const paths = {
    command: path.join(home, ".claude", "commands", "dualog-review-code.md"),
    hooks: path.join(home, ".claude", "hooks", "dualog"),
    hookSibling: path.join(home, ".claude", "hooks", "unrelated-user-hook.mjs"),
    legacyCommand: path.join(home, ".claude", "commands", "codex-review-code.md"),
    skill: path.join(home, ".codex", "skills", "dualog-review-code"),
    claudeConfig: path.join(home, ".claude.json"),
    codexConfig: path.join(home, ".codex", "config.toml"),
  };
  write(paths.command, "old command\n");
  write(path.join(paths.hooks, "old-hook.mjs"), "old hook\n");
  write(paths.hookSibling, "unrelated sibling\n");
  write(paths.legacyCommand, "legacy command\n");
  write(path.join(paths.skill, "SKILL.md"), "old skill\n");
  write(paths.claudeConfig, '{"mcpServers":{"dualog":{"command":"old"}}}\n');
  write(paths.codexConfig, '[mcp_servers.dualog]\ncommand = "old"\n');
  return paths;
}

function stageSelectedHosts(transaction, paths) {
  transaction.stageFile(paths.command, "new command\n");
  transaction.stageTree(paths.hooks, (stage) => {
    write(path.join(stage, "new-hook.mjs"), "new hook\n");
  });
  transaction.stageTree(paths.skill, (stage) => {
    write(path.join(stage, "SKILL.md"), "new skill\n");
  });
  transaction.stageDelete(paths.legacyCommand);
  // Configs are deliberately last, matching install.mjs.
  transaction.stageFile(paths.claudeConfig, '{"mcpServers":{"dualog":{"command":"new"}}}\n');
  transaction.stageFile(paths.codexConfig, '[mcp_servers.dualog]\ncommand = "new"\n');
}

function snapshots(paths) {
  return Object.fromEntries(
    Object.entries(paths).map(([name, filePath]) => [name, fingerprintInstallPath(filePath)])
  );
}

function assertSnapshots(paths, expected) {
  assert.deepEqual(snapshots(paths), expected);
}

function testIdentityProvider({
  bootId = "test-boot",
  host = "test-host",
  processState = "alive",
  startTime = "test-process-generation",
} = {}) {
  return {
    bootIdentity: () => ({
      host,
      id: bootId,
      source: "test-precise-boot",
      precise: true,
    }),
    processStartTime: () => startTime,
    probeProcess: () => processState,
  };
}

function exitedOwnerRecovery(home, allowedLogicalPaths) {
  const transactionDirectory = path.join(home, ".dualog", "install-transactions");
  const lockPath = path.join(transactionDirectory, "install.lock");
  let recorded = null;
  if (fs.existsSync(lockPath)) recorded = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  if (!recorded && fs.existsSync(transactionDirectory)) {
    const candidate = fs
      .readdirSync(transactionDirectory)
      .find((name) => name.endsWith(".candidate"));
    if (candidate) {
      recorded = JSON.parse(
        fs.readFileSync(path.join(transactionDirectory, candidate), "utf-8")
      );
    }
  }
  assert.ok(recorded?.boot?.precise, "test precondition: recorded precise boot identity");
  return recoverPendingInstallTransaction({
    home,
    allowedLogicalPaths,
    identityProvider: {
      bootIdentity: () => recorded.boot,
      processStartTime: () => "recovery-process-generation",
      probeProcess: () => "absent",
    },
  });
}

test("--both failure in the second host restores every current artifact and config exactly", (t) => {
  const home = tempHome(t);
  const paths = seedSelectedHosts(home);
  const before = snapshots(paths);
  const allowedLogicalPaths = new Set(Object.values(paths).filter((entry) => entry !== paths.hookSibling));
  const transaction = new InstallTransaction({
    home,
    allowedLogicalPaths,
    faultInjector({ phase, index }) {
      if (phase === "after-operation" && index === 5) {
        throw new Error("injected Codex host failure");
      }
    },
  });
  stageSelectedHosts(transaction, paths);
  assert.throws(() => transaction.commit(), /injected Codex host failure/u);
  assertSnapshots(paths, before);
  assert.equal(fs.readFileSync(paths.hookSibling, "utf-8"), "unrelated sibling\n");
  assert.equal(fs.existsSync(path.join(home, ".dualog", "install-transactions", "current.json")), false);
});

test("next run rolls an interrupted swap back without guessing", (t) => {
  const home = tempHome(t);
  const paths = seedSelectedHosts(home);
  const before = snapshots(paths);
  const allowedLogicalPaths = new Set(Object.values(paths).filter((entry) => entry !== paths.hookSibling));
  const transaction = new InstallTransaction({
    home,
    allowedLogicalPaths,
    faultInjector({ phase, index }) {
      if (phase === "after-operation" && index === 5) {
        const error = new Error("simulated process crash");
        error.dualogSimulatedCrash = true;
        throw error;
      }
    },
  });
  stageSelectedHosts(transaction, paths);
  assert.throws(() => transaction.commit(), /simulated process crash/u);
  assert.equal(
    fs.existsSync(path.join(home, ".dualog", "install-transactions", "current.json")),
    true
  );
  assert.equal(exitedOwnerRecovery(home, allowedLogicalPaths), true);
  assertSnapshots(paths, before);
  assert.equal(fs.readFileSync(paths.hookSibling, "utf-8"), "unrelated sibling\n");
});

test("committed crash recovery keeps the complete new generation and only removes backups", (t) => {
  const home = tempHome(t);
  const paths = seedSelectedHosts(home);
  const allowedLogicalPaths = new Set(Object.values(paths).filter((entry) => entry !== paths.hookSibling));
  const transaction = new InstallTransaction({
    home,
    allowedLogicalPaths,
    faultInjector({ phase }) {
      if (phase === "after-committed") {
        const error = new Error("simulated committed crash");
        error.dualogSimulatedCrash = true;
        throw error;
      }
    },
  });
  stageSelectedHosts(transaction, paths);
  assert.throws(() => transaction.commit(), /simulated committed crash/u);
  const committed = snapshots(paths);
  assert.equal(exitedOwnerRecovery(home, allowedLogicalPaths), true);
  assertSnapshots(paths, committed);
  assert.equal(fs.readFileSync(paths.command, "utf-8"), "new command\n");
  assert.equal(fs.readFileSync(path.join(paths.hooks, "new-hook.mjs"), "utf-8"), "new hook\n");
  assert.equal(fs.readFileSync(path.join(paths.skill, "SKILL.md"), "utf-8"), "new skill\n");
  assert.equal(fs.readFileSync(paths.hookSibling, "utf-8"), "unrelated sibling\n");
});

test("rollback restores initially absent selected-host paths as absent", (t) => {
  const home = tempHome(t);
  const command = path.join(home, ".claude", "commands", "dualog-review-code.md");
  const config = path.join(home, ".codex", "config.toml");
  const allowedLogicalPaths = new Set([command, config]);
  const transaction = new InstallTransaction({
    home,
    allowedLogicalPaths,
    faultInjector({ phase, index }) {
      if (phase === "after-operation" && index === 1) throw new Error("injected failure");
    },
  });
  transaction.stageFile(command, "new command\n");
  transaction.stageFile(config, "new config\n");
  assert.throws(() => transaction.commit(), /injected failure/u);
  assert.equal(fs.existsSync(command), false);
  assert.equal(fs.existsSync(config), false);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
});

test("lock publication crashes never leave a canonical empty lock", (t) => {
  const home = tempHome(t);
  const target = path.join(home, "artifact.txt");
  const allowedLogicalPaths = new Set([target]);
  const transactionDirectory = path.join(home, ".dualog", "install-transactions");
  const canonicalLock = path.join(transactionDirectory, "install.lock");

  assert.throws(
    () =>
      new InstallTransaction({
        home,
        allowedLogicalPaths,
        faultInjector({ phase }) {
          if (phase === "after-lock-candidate") {
            const error = new Error("crash before lock publication");
            error.dualogSimulatedCrash = true;
            throw error;
          }
        },
      }),
    /crash before lock publication/u
  );
  assert.equal(fs.existsSync(canonicalLock), false);
  const candidates = fs
    .readdirSync(transactionDirectory)
    .filter((name) => name.endsWith(".candidate"));
  assert.equal(candidates.length, 1);
  assert.ok(fs.statSync(path.join(transactionDirectory, candidates[0])).size > 0);
  assert.equal(exitedOwnerRecovery(home, allowedLogicalPaths), true);
  assert.equal(fs.existsSync(canonicalLock), false);

  // A real crash during candidate creation can leave an incomplete private
  // file, but it was never eligible for canonical publication.
  const partial = path.join(
    transactionDirectory,
    ".install.lock.0123456789abcdef.candidate"
  );
  fs.writeFileSync(partial, "");
  assert.equal(
    recoverPendingInstallTransaction({
      home,
      allowedLogicalPaths,
      identityProvider: testIdentityProvider({ processState: "absent" }),
    }),
    true
  );
  assert.equal(fs.existsSync(partial), false);
});

test("published locks are complete and atomic no-clobber acquisition preserves the owner", (t) => {
  const home = tempHome(t);
  const target = path.join(home, "artifact.txt");
  const allowedLogicalPaths = new Set([target]);
  const transactionDirectory = path.join(home, ".dualog", "install-transactions");
  const canonicalLock = path.join(transactionDirectory, "install.lock");
  assert.throws(
    () =>
      new InstallTransaction({
        home,
        allowedLogicalPaths,
        faultInjector({ phase }) {
          if (phase === "after-lock-acquired") {
            const error = new Error("crash after lock publication");
            error.dualogSimulatedCrash = true;
            throw error;
          }
        },
      }),
    /crash after lock publication/u
  );
  const published = fs.readFileSync(canonicalLock, "utf-8");
  assert.ok(published.length > 0);
  assert.equal(JSON.parse(published).pid, process.pid);
  assert.equal(exitedOwnerRecovery(home, allowedLogicalPaths), true);

  const owner = new InstallTransaction({ home, allowedLogicalPaths });
  const ownerLock = fs.readFileSync(canonicalLock, "utf-8");
  assert.throws(
    () => new InstallTransaction({ home, allowedLogicalPaths }),
    /EEXIST/u
  );
  assert.equal(fs.readFileSync(canonicalLock, "utf-8"), ownerLock);
  assert.equal(
    fs.readdirSync(transactionDirectory).some((name) => name.endsWith(".candidate")),
    false
  );
  owner.abort();
});

test("journal write and staged rename failures restore original bytes", (t) => {
  const home = tempHome(t);
  const target = path.join(home, "owned artifact.txt");
  write(target, "original\n");
  const before = fingerprintInstallPath(target);
  let committingWrites = 0;
  const writeFailure = new InstallTransaction({
    home,
    allowedLogicalPaths: new Set([target]),
    faultInjector({ phase, journalPhase }) {
      if (phase === "before-journal-write" && journalPhase === "committing") {
        committingWrites++;
        if (committingWrites === 2) throw new Error("injected journal write failure");
      }
    },
  });
  writeFailure.stageFile(target, "replacement\n");
  assert.throws(() => writeFailure.commit(), /injected journal write failure/u);
  assert.equal(fingerprintInstallPath(target), before);

  const renameFailure = new InstallTransaction({
    home,
    allowedLogicalPaths: new Set([target]),
    faultInjector({ phase }) {
      if (phase === "before-stage-rename") throw new Error("injected rename failure");
    },
  });
  renameFailure.stageFile(target, "replacement\n");
  assert.throws(() => renameFailure.commit(), /injected rename failure/u);
  assert.equal(fingerprintInstallPath(target), before);
});

test("rollback failure preserves journal, backups, and quarantine for next-run recovery", (t) => {
  const home = tempHome(t);
  const first = path.join(home, "first artifact.txt");
  const second = path.join(home, "second artifact.txt");
  write(first, "first original\n");
  write(second, "second original\n");
  const allowedLogicalPaths = new Set([first, second]);
  const before = [fingerprintInstallPath(first), fingerprintInstallPath(second)];
  let commitFailed = false;
  let rollbackFailed = false;
  const transaction = new InstallTransaction({
    home,
    allowedLogicalPaths,
    faultInjector({ phase, index }) {
      if (phase === "after-operation" && index === 1 && !commitFailed) {
        commitFailed = true;
        throw new Error("injected commit failure");
      }
      if (phase === "before-rollback-operation" && index === 1 && !rollbackFailed) {
        rollbackFailed = true;
        throw new Error("injected rollback failure");
      }
    },
  });
  transaction.stageFile(first, "first replacement\n");
  transaction.stageFile(second, "second replacement\n");
  assert.throws(
    () => transaction.commit(),
    /exact rollback remains pending/u
  );
  const transactionDirectory = path.join(home, ".dualog", "install-transactions");
  const journalPath = path.join(transactionDirectory, "current.json");
  const lockPath = path.join(transactionDirectory, "install.lock");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf-8"));
  assert.equal(journal.phase, "rollback_pending");
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.existsSync(journal.operations[0].backupPath), true);
  assert.equal(fs.existsSync(journal.operations[1].quarantinePath), true);
  transaction.abort();
  assert.equal(fs.existsSync(journalPath), true, "abort must preserve recovery state");
  assert.equal(exitedOwnerRecovery(home, allowedLogicalPaths), true);
  assert.deepEqual(
    [fingerprintInstallPath(first), fingerprintInstallPath(second)],
    before
  );
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(fs.existsSync(lockPath), false);
});

test("cleanup failure after the committed marker never rolls back", (t) => {
  const home = tempHome(t);
  const target = path.join(home, "owned artifact.txt");
  write(target, "original\n");
  const allowedLogicalPaths = new Set([target]);
  let cleanupFailed = false;
  const transaction = new InstallTransaction({
    home,
    allowedLogicalPaths,
    faultInjector({ phase }) {
      if (phase === "before-cleanup-path" && !cleanupFailed) {
        cleanupFailed = true;
        throw new Error("injected cleanup failure");
      }
    },
  });
  transaction.stageFile(target, "committed replacement\n");
  assert.throws(() => transaction.commit(), /cleanup remains pending/u);
  const journalPath = path.join(
    home,
    ".dualog",
    "install-transactions",
    "current.json"
  );
  assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf-8")).phase, "committed");
  assert.equal(fs.readFileSync(target, "utf-8"), "committed replacement\n");
  transaction.abort();
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(exitedOwnerRecovery(home, allowedLogicalPaths), true);
  assert.equal(fs.readFileSync(target, "utf-8"), "committed replacement\n");
  assert.equal(fs.existsSync(journalPath), false);
});

test("lock identity distinguishes precise prior boot, reused PID, and unknown generation", (t) => {
  const priorBootHome = tempHome(t);
  const target = path.join(priorBootHome, "artifact.txt");
  const allowedLogicalPaths = new Set([target]);
  const priorOwner = new InstallTransaction({
    home: priorBootHome,
    allowedLogicalPaths,
    identityProvider: testIdentityProvider({ bootId: "boot-before-restart", startTime: "old" }),
  });
  const priorReasons = [];
  assert.equal(
    recoverPendingInstallTransaction({
      home: priorBootHome,
      allowedLogicalPaths,
      identityProvider: testIdentityProvider({
        bootId: "boot-after-restart",
        startTime: "new-installer",
      }),
      faultInjector({ phase, reason }) {
        if (phase === "after-stale-lock-observed") priorReasons.push(reason);
      },
    }),
    true
  );
  assert.deepEqual(priorReasons, ["the lock belongs to a precise prior boot"]);
  priorOwner.abort();

  const reusedHome = tempHome(t);
  const reusedTarget = path.join(reusedHome, "artifact.txt");
  const reusedAllowed = new Set([reusedTarget]);
  const reusedOwner = new InstallTransaction({
    home: reusedHome,
    allowedLogicalPaths: reusedAllowed,
    identityProvider: testIdentityProvider({ startTime: "original-generation" }),
  });
  const reusedReasons = [];
  assert.equal(
    recoverPendingInstallTransaction({
      home: reusedHome,
      allowedLogicalPaths: reusedAllowed,
      identityProvider: testIdentityProvider({ startTime: "reused-generation" }),
      faultInjector({ phase, reason }) {
        if (phase === "after-stale-lock-observed") reusedReasons.push(reason);
      },
    }),
    true
  );
  assert.deepEqual(reusedReasons, ["the lock PID has been reused"]);
  reusedOwner.abort();

  const unknownHome = tempHome(t);
  const unknownTarget = path.join(unknownHome, "artifact.txt");
  const unknownAllowed = new Set([unknownTarget]);
  const unknownOwner = new InstallTransaction({
    home: unknownHome,
    allowedLogicalPaths: unknownAllowed,
    identityProvider: testIdentityProvider({ startTime: "recorded-generation" }),
  });
  const lockPath = path.join(unknownHome, ".dualog", "install-transactions", "install.lock");
  const originalLock = fs.readFileSync(lockPath, "utf-8");
  assert.throws(
    () =>
      recoverPendingInstallTransaction({
        home: unknownHome,
        allowedLogicalPaths: unknownAllowed,
        identityProvider: testIdentityProvider({ startTime: null }),
      }),
    /process generation is unavailable/u
  );
  assert.equal(fs.readFileSync(lockPath, "utf-8"), originalLock);
  unknownOwner.abort();
});

test("host mismatch fails closed before matching or differing boot IDs", (t) => {
  for (const { label, currentBootId } of [
    { label: "matching boot id", currentBootId: "shared-boot-id" },
    { label: "differing boot id", currentBootId: "other-boot-id" },
  ]) {
    const home = tempHome(t);
    const target = path.join(home, `${label}.txt`);
    const allowedLogicalPaths = new Set([target]);
    const owner = new InstallTransaction({
      home,
      allowedLogicalPaths,
      identityProvider: testIdentityProvider({
        host: "recorded-host",
        bootId: "shared-boot-id",
        startTime: "recorded-generation",
      }),
    });
    const lockPath = path.join(home, ".dualog", "install-transactions", "install.lock");
    const originalLock = fs.readFileSync(lockPath, "utf-8");
    assert.throws(
      () =>
        recoverPendingInstallTransaction({
          home,
          allowedLogicalPaths,
          identityProvider: testIdentityProvider({
            host: "different-host",
            bootId: currentBootId,
            startTime: "different-generation",
          }),
        }),
      /lock boot belongs to a different host/u,
      label
    );
    assert.equal(fs.readFileSync(lockPath, "utf-8"), originalLock, label);
    owner.abort();
  }
});

test("a lagging stale-lock observer cannot delete a newer live lock", (t) => {
  const home = tempHome(t);
  const target = path.join(home, "artifact.txt");
  const allowedLogicalPaths = new Set([target]);
  const staleOwner = new InstallTransaction({
    home,
    allowedLogicalPaths,
    identityProvider: testIdentityProvider({ startTime: "stale-generation" }),
  });
  const contenderIdentity = testIdentityProvider({ startTime: "winner-generation" });
  let winner = null;
  let interleaved = false;
  assert.throws(
    () =>
      recoverPendingInstallTransaction({
        home,
        allowedLogicalPaths,
        identityProvider: contenderIdentity,
        faultInjector({ phase }) {
          if (phase !== "after-stale-lock-observed" || interleaved) return;
          interleaved = true;
          assert.equal(
            recoverPendingInstallTransaction({
              home,
              allowedLogicalPaths,
              identityProvider: testIdentityProvider({ startTime: "first-contender" }),
            }),
            true
          );
          winner = new InstallTransaction({
            home,
            allowedLogicalPaths,
            identityProvider: contenderIdentity,
          });
        },
      }),
    /Another Dualog installer is still active/u
  );
  assert.ok(winner);
  const lockPath = path.join(home, ".dualog", "install-transactions", "install.lock");
  const liveLock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  assert.equal(liveLock.id, winner.lock.id);
  assert.equal(liveLock.ownerStartTime, "winner-generation");
  winner.abort();
  staleOwner.abort();
});

test("identity failure happens before a canonical lock or install artifact is created", (t) => {
  const home = tempHome(t);
  const target = path.join(home, "artifact.txt");
  assert.throws(
    () =>
      new InstallTransaction({
        home,
        allowedLogicalPaths: new Set([target]),
        identityProvider: {
          bootIdentity: () => null,
          processStartTime: () => "unused",
          probeProcess: () => "unknown",
        },
      }),
    /precise boot identity is unavailable/u
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(
    fs.existsSync(path.join(home, ".dualog", "install-transactions", "install.lock")),
    false
  );
  assert.equal(fs.existsSync(path.join(home, ".dualog")), false);
});
