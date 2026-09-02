import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isValidDotNetTicks,
  probeProcess,
  processStartTime,
} from "../src/process-probe.mjs";
import { resolveWindowsSystem32Executable } from "../src/windows-process-tree.mjs";

const SCHEMA_VERSION = 1;
const TXN_DIR_NAME = "install-transactions";
const JOURNAL_NAME = "current.json";
const LOCK_NAME = "install.lock";
const LOCK_CANDIDATE_PATTERN = /^\.install\.lock\.([a-f0-9]{16})\.candidate$/u;
const LOCK_TAKEOVER_PATTERN = /^\.install\.lock\.([a-f0-9]{16})\.takeover$/u;
const WINDOWS_BOOT_TIME_SCRIPT = [
  "$PSModuleAutoloadingPreference = 'None';",
  "$cimModule = [IO.Path]::Combine($PSHOME, 'Modules', 'CimCmdlets', 'CimCmdlets.psd1');",
  "Microsoft.PowerShell.Core\\Import-Module -Name $cimModule -Force -ErrorAction Stop;",
  "$os = CimCmdlets\\Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -ErrorAction Stop;",
  "$boot = $os.LastBootUpTime;",
  "if ($null -eq $boot) { exit 1 };",
  "[Console]::Out.Write($boot.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))",
].join(" ");

let cachedInstallerBootIdentity;

function stablePath(value) {
  return path.resolve(String(value));
}

export function installerBootIdentity() {
  if (cachedInstallerBootIdentity !== undefined) return cachedInstallerBootIdentity;
  let host;
  try {
    host = os.hostname();
  } catch {
    cachedInstallerBootIdentity = null;
    return null;
  }
  if (process.platform === "linux") {
    try {
      const id = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      cachedInstallerBootIdentity = id
        ? { host, id, source: "boot-id", precise: true }
        : null;
      return cachedInstallerBootIdentity;
    } catch {}
  } else if (["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform)) {
    try {
      const output = execFileSync("sysctl", ["-n", "kern.boottime"], {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const seconds = /sec\s*=\s*(\d+)/u.exec(output);
      if (seconds) {
        cachedInstallerBootIdentity = {
          host,
          id: `kern.boottime:${seconds[1]}`,
          source: "kern.boottime",
          precise: true,
        };
        return cachedInstallerBootIdentity;
      }
    } catch {}
  } else if (process.platform === "win32") {
    const powershell = resolveWindowsSystem32Executable("powershell.exe", {
      subdirectories: ["WindowsPowerShell", "v1.0"],
    });
    if (powershell) {
      try {
        const output = execFileSync(
          powershell,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_BOOT_TIME_SCRIPT],
          {
            encoding: "utf-8",
            timeout: 5000,
            maxBuffer: 4096,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
          }
        );
        if (isValidDotNetTicks(output)) {
          cachedInstallerBootIdentity = {
            host,
            id: `win32.last-boot-up-time:${output}`,
            source: "win32.last-boot-up-time",
            precise: true,
          };
          return cachedInstallerBootIdentity;
        }
      } catch {}
    }
  }
  cachedInstallerBootIdentity = null;
  return null;
}

function defaultIdentityProvider() {
  return {
    bootIdentity: installerBootIdentity,
    processStartTime,
    probeProcess,
  };
}

function validPreciseBoot(boot) {
  return (
    boot !== null &&
    typeof boot === "object" &&
    boot.precise === true &&
    typeof boot.host === "string" &&
    boot.host.length > 0 &&
    typeof boot.id === "string" &&
    boot.id.length > 0 &&
    typeof boot.source === "string" &&
    boot.source.length > 0
  );
}

function captureOwnerIdentity(identityProvider, id, extra = {}) {
  const boot = identityProvider.bootIdentity();
  if (!validPreciseBoot(boot)) {
    throw new Error("Cannot acquire Dualog install lock: precise boot identity is unavailable");
  }
  const ownerStartTime = identityProvider.processStartTime(process.pid);
  if (typeof ownerStartTime !== "string" || ownerStartTime.length === 0) {
    throw new Error("Cannot acquire Dualog install lock: process generation is unavailable");
  }
  return { id, pid: process.pid, ownerStartTime, boot, ...extra };
}

function sameLockGeneration(left, right) {
  return (
    left?.id === right?.id &&
    left?.pid === right?.pid &&
    left?.ownerStartTime === right?.ownerStartTime &&
    left?.boot?.precise === true &&
    right?.boot?.precise === true &&
    left.boot.host === right.boot.host &&
    left.boot.id === right.boot.id &&
    left.boot.source === right.boot.source
  );
}

function lockOwnerVerdict(lock, identityProvider) {
  const currentBoot = identityProvider.bootIdentity();
  if (!validPreciseBoot(currentBoot)) {
    return { state: "unknown", reason: "the current precise boot identity is unavailable" };
  }
  if (lock.boot.host !== currentBoot.host) {
    return { state: "unknown", reason: "the lock boot belongs to a different host" };
  }
  if (lock.boot.source !== currentBoot.source) {
    return { state: "unknown", reason: "the precise boot identity source changed" };
  }
  if (lock.boot.id !== currentBoot.id) {
    return { state: "stale", reason: "the lock belongs to a precise prior boot" };
  }
  const processState = identityProvider.probeProcess(lock.pid);
  if (processState === "absent") {
    return { state: "stale", reason: "the lock owner process is absent" };
  }
  if (processState !== "alive") {
    return {
      state: "unknown",
      reason: `the lock owner process cannot be verified (${processState})`,
    };
  }
  const currentStartTime = identityProvider.processStartTime(lock.pid);
  if (typeof currentStartTime !== "string" || currentStartTime.length === 0) {
    return { state: "unknown", reason: "the lock owner process generation is unavailable" };
  }
  if (currentStartTime !== lock.ownerStartTime) {
    return { state: "stale", reason: "the lock PID has been reused" };
  }
  return { state: "live", reason: "the lock owner process generation is still alive" };
}

export function fingerprintInstallPath(targetPath) {
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
  const hash = crypto.createHash("sha256");
  const visit = (entryPath, relative) => {
    const entry = fs.lstatSync(entryPath);
    const mode = entry.mode & 0o777;
    if (entry.isSymbolicLink()) {
      hash.update(`L\0${relative}\0${mode}\0${fs.readlinkSync(entryPath)}\0`);
      return;
    }
    if (entry.isDirectory()) {
      hash.update(`D\0${relative}\0${mode}\0`);
      for (const name of fs.readdirSync(entryPath).sort()) {
        visit(path.join(entryPath, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported install artifact type at ${entryPath}`);
    }
    hash.update(`F\0${relative}\0${mode}\0${entry.size}\0`);
    hash.update(fs.readFileSync(entryPath));
    hash.update("\0");
  };
  visit(targetPath, "");
  const kind = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file";
  return `${kind}:${hash.digest("hex")}`;
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
    // Windows commonly refuses directory handles. The same-directory rename
    // protocol and durable journal still provide recoverability there.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function durableWriteFile(filePath, content, mode = 0o600) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temp, "wx", mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, filePath);
    fsyncDirectory(parent);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
}

function durableCreateFile(filePath, content, mode) {
  let fd;
  try {
    fd = fs.openSync(filePath, "wx", mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    throw error;
  }
}

function fsyncTree(root) {
  const stat = fs.lstatSync(root);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(root)) fsyncTree(path.join(root, name));
    fsyncDirectory(root);
    return;
  }
  if (!stat.isFile()) return;
  const fd = fs.openSync(root, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sameFingerprint(actual, expected) {
  return actual === expected;
}

function exists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function readJsonStrict(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new Error(`Cannot safely recover ${label} ${filePath}: ${error.message}`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cannot safely recover ${label} ${filePath}: expected a JSON object`);
  }
  return parsed;
}

function transactionPaths(home) {
  const directory = path.join(home, ".dualog", TXN_DIR_NAME);
  return {
    directory,
    journal: path.join(directory, JOURNAL_NAME),
    lock: path.join(directory, LOCK_NAME),
  };
}

function lockCandidatePath(paths, id) {
  return path.join(paths.directory, `.install.lock.${id}.candidate`);
}

function validateLock(lock, label = "lock") {
  if (
    !/^[a-f0-9]{16}$/u.test(lock.id ?? "") ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 0 ||
    typeof lock.ownerStartTime !== "string" ||
    lock.ownerStartTime.length === 0 ||
    !validPreciseBoot(lock.boot)
  ) {
    throw new Error(`Refusing ambiguous Dualog install ${label} recovery`);
  }
  return lock;
}

function acquireInstallLock(
  paths,
  id,
  identityProvider,
  faultInjector,
  extra = {},
  preparedLock = null
) {
  const candidate = lockCandidatePath(paths, id);
  const lock = preparedLock ?? captureOwnerIdentity(identityProvider, id, extra);
  const content = `${JSON.stringify(lock)}\n`;
  let acquired = false;
  try {
    durableCreateFile(candidate, content, 0o600);
    fsyncDirectory(paths.directory);
    faultInjector?.({ phase: "after-lock-candidate", candidatePath: candidate });

    // A hard link publishes the already-complete, fsynced candidate at the
    // canonical name and fails with EEXIST instead of replacing another lock.
    fs.linkSync(candidate, paths.lock);
    acquired = true;
    fsyncDirectory(paths.directory);
    faultInjector?.({ phase: "after-lock-acquired", candidatePath: candidate });

    removePath(candidate);
    fsyncDirectory(paths.directory);
  } catch (error) {
    if (error?.dualogSimulatedCrash === true) throw error;
    if (acquired) releaseCanonicalLock(paths, lock, "aborted");
    removePath(candidate);
    fsyncDirectory(paths.directory);
    throw error;
  }
  return lock;
}

function inspectLockCandidates(paths) {
  if (!exists(paths.directory)) return [];
  const candidates = [];
  for (const name of fs.readdirSync(paths.directory)) {
    const match = LOCK_CANDIDATE_PATTERN.exec(name);
    if (!match) continue;
    const candidatePath = path.join(paths.directory, name);
    const entry = fs.lstatSync(candidatePath);
    if (!entry.isFile()) {
      throw new Error(`Refusing ambiguous Dualog install lock candidate ${candidatePath}`);
    }
    let lock = null;
    try {
      lock = validateLock(readJsonStrict(candidatePath, "lock candidate"), "lock candidate");
      if (lock.id !== match[1]) {
        throw new Error(`Lock candidate identity mismatch at ${candidatePath}`);
      }
    } catch (error) {
      candidates.push({ path: candidatePath, lock: null, error });
      continue;
    }
    candidates.push({ path: candidatePath, lock, error: null });
  }
  return candidates;
}

function recoverLockCandidates(paths, candidates, identityProvider) {
  for (const candidate of candidates) {
    if (candidate.error) {
      // A partial private candidate was never eligible for canonical
      // publication. Recovery owns the canonical lock before reaching here.
      removePath(candidate.path);
      continue;
    }
    const verdict = lockOwnerVerdict(candidate.lock, identityProvider);
    if (verdict.state !== "stale") {
      throw new Error(`Cannot recover Dualog install lock candidate: ${verdict.reason}`);
    }
    removePath(candidate.path);
  }
  if (candidates.length > 0) fsyncDirectory(paths.directory);
}

function takeoverClaimPath(paths, staleId) {
  return path.join(paths.directory, `.install.lock.${staleId}.takeover`);
}

function readTakeoverClaim(claimPath) {
  const entry = fs.lstatSync(claimPath);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Refusing ambiguous Dualog install takeover claim ${claimPath}`);
  }
  const claim = readJsonStrict(path.join(claimPath, "claim.json"), "takeover claim");
  if (
    !/^[a-f0-9]{16}$/u.test(claim.token ?? "") ||
    !sameLockGeneration(validateLock(claim.owner, "takeover owner"), claim.owner) ||
    !sameLockGeneration(validateLock(claim.expectedLock, "takeover target"), claim.expectedLock)
  ) {
    throw new Error(`Refusing ambiguous Dualog install takeover claim ${claimPath}`);
  }
  return claim;
}

function publishTakeoverClaim(paths, expectedLock, identityProvider) {
  const claimPath = takeoverClaimPath(paths, expectedLock.id);
  const token = crypto.randomBytes(8).toString("hex");
  const stagePath = `${claimPath}.stage-${token}`;
  const claim = {
    token,
    owner: captureOwnerIdentity(identityProvider, token),
    expectedLock,
  };
  fs.mkdirSync(stagePath, { mode: 0o700 });
  try {
    durableCreateFile(
      path.join(stagePath, "claim.json"),
      `${JSON.stringify(claim)}\n`,
      0o600
    );
    fsyncDirectory(stagePath);
    fs.renameSync(stagePath, claimPath);
    fsyncDirectory(paths.directory);
    return { claimPath, claim };
  } catch (error) {
    removePath(stagePath);
    throw error;
  }
}

function archiveStaleTakeoverClaim(paths, claimPath, claim) {
  const archivePath = `${claimPath}.stale-${claim.token}`;
  try {
    fs.renameSync(claimPath, archivePath);
    fsyncDirectory(paths.directory);
    return true;
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error?.code)) return false;
    throw error;
  }
}

function releaseTakeoverClaim(paths, claimPath, claim) {
  if (!exists(claimPath)) return;
  const current = readTakeoverClaim(claimPath);
  if (current.token !== claim.token) {
    throw new Error("Refusing to release a takeover claim owned by another generation");
  }
  const retiredPath = `${claimPath}.retired-${claim.token}`;
  fs.renameSync(claimPath, retiredPath);
  fsyncDirectory(paths.directory);
  // Keep the non-empty generation marker. It makes every delayed contender's
  // rename fail instead of moving a fresh claim at the canonical claim path.
}

function inspectTakeoverClaims(paths) {
  if (!exists(paths.directory)) return [];
  const claims = [];
  for (const name of fs.readdirSync(paths.directory)) {
    const match = LOCK_TAKEOVER_PATTERN.exec(name);
    if (!match) continue;
    const claimPath = path.join(paths.directory, name);
    const claim = readTakeoverClaim(claimPath);
    claims.push({ claimPath, claim });
  }
  return claims;
}

function acquireTakeoverClaim(paths, expectedLock, identityProvider) {
  const claimPath = takeoverClaimPath(paths, expectedLock.id);
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!exists(claimPath)) {
      try {
        return publishTakeoverClaim(paths, expectedLock, identityProvider);
      } catch (error) {
        if (exists(claimPath)) continue;
        throw error;
      }
    }
    const existing = readTakeoverClaim(claimPath);
    if (!sameLockGeneration(existing.expectedLock, expectedLock)) {
      throw new Error("Refusing a takeover claim for a different lock generation");
    }
    const verdict = lockOwnerVerdict(existing.owner, identityProvider);
    if (verdict.state !== "stale") {
      throw new Error(`Cannot take over Dualog install lock: ${verdict.reason}`);
    }
    archiveStaleTakeoverClaim(paths, claimPath, existing);
  }
  throw new Error("Dualog install takeover-claim contention did not settle");
}

function retireStaleCanonicalLock(
  paths,
  expectedLock,
  identityProvider,
  faultInjector = null,
  reason = "stale owner"
) {
  faultInjector?.({ phase: "after-stale-lock-observed", lock: expectedLock, reason });
  const takeover = acquireTakeoverClaim(paths, expectedLock, identityProvider);
  const current = exists(paths.lock)
    ? validateLock(readJsonStrict(paths.lock, "lock"))
    : null;
  if (!current || !sameLockGeneration(current, expectedLock)) {
    releaseTakeoverClaim(paths, takeover.claimPath, takeover.claim);
    return null;
  }
  faultInjector?.({ phase: "after-takeover-claim", lock: expectedLock });
  fs.renameSync(paths.lock, path.join(takeover.claimPath, "retired.lock"));
  fsyncDirectory(paths.directory);
  return takeover;
}

function releaseCanonicalLock(paths, expectedLock, kind = "released") {
  const claimPath = path.join(paths.directory, `.install.lock.${expectedLock.id}.${kind}`);
  let claimed = false;
  try {
    fs.linkSync(paths.lock, claimPath);
    claimed = true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code !== "EEXIST") throw error;
  }
  const claim = validateLock(readJsonStrict(claimPath, "release claim"));
  if (!sameLockGeneration(claim, expectedLock)) {
    if (claimed) removePath(claimPath);
    throw new Error("Refusing to release a Dualog install lock owned by another generation");
  }
  const current = exists(paths.lock)
    ? validateLock(readJsonStrict(paths.lock, "lock"))
    : null;
  if (!current) return true;
  if (!sameLockGeneration(current, expectedLock)) {
    throw new Error("Refusing to release a replaced Dualog install lock");
  }
  // The no-clobber claim is generation-specific. Every cooperating remover of
  // this generation observes it; no later lock can acquire the canonical name
  // until this exact generation has been unlinked.
  fs.unlinkSync(paths.lock);
  fsyncDirectory(paths.directory);
  return true;
}

function expectedSibling(target, id, index, suffix) {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.dualog-${id}-${index}.${suffix}`
  );
}

function plausibleResolvedTarget(logicalPath, targetPath) {
  const logical = stablePath(logicalPath);
  const target = stablePath(targetPath);
  try {
    const entry = fs.lstatSync(logical);
    if (entry.isSymbolicLink()) {
      const linked = path.resolve(path.dirname(logical), fs.readlinkSync(logical));
      let resolved = linked;
      try {
        resolved = fs.realpathSync(linked);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        resolved = path.join(fs.realpathSync(path.dirname(linked)), path.basename(linked));
      }
      if (stablePath(resolved) === target) return true;
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  try {
    return (
      stablePath(path.join(fs.realpathSync(path.dirname(logical)), path.basename(logical))) ===
      target
    );
  } catch {
    return false;
  }
}

function validateJournal(journal, allowedLogicalPaths) {
  if (
    journal.schema !== SCHEMA_VERSION ||
    !/^[a-f0-9]{16}$/u.test(journal.id ?? "") ||
    ![
      "prepared",
      "committing",
      "rolling_back",
      "rollback_pending",
      "rolled_back",
      "committed",
    ].includes(journal.phase) ||
    !Array.isArray(journal.operations) ||
    !Array.isArray(journal.createdDirectories)
  ) {
    throw new Error("Refusing ambiguous Dualog install recovery journal");
  }
  const allowed = new Set([...allowedLogicalPaths].map(stablePath));
  journal.operations.forEach((operation, index) => {
    if (
      !allowed.has(stablePath(operation.logicalPath)) ||
      !["replace", "delete"].includes(operation.action) ||
      !plausibleResolvedTarget(operation.logicalPath, operation.targetPath) ||
      stablePath(operation.stagePath) !==
        stablePath(expectedSibling(operation.targetPath, journal.id, index, "stage")) ||
      stablePath(operation.backupPath) !==
        stablePath(expectedSibling(operation.targetPath, journal.id, index, "backup")) ||
      stablePath(operation.quarantinePath) !==
        stablePath(expectedSibling(operation.targetPath, journal.id, index, "quarantine"))
    ) {
      throw new Error(`Refusing unsafe Dualog install recovery operation ${index}`);
    }
  });
  return journal;
}

function writeJournal(journalPath, journal, faultInjector = null) {
  faultInjector?.({
    phase: "before-journal-write",
    journalPhase: journal.phase,
    journal,
  });
  durableWriteFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function verifyFinalState(journal, committed) {
  for (const operation of journal.operations) {
    const actual = fingerprintInstallPath(operation.targetPath);
    const expected = committed
      ? operation.action === "replace"
        ? operation.stagedFingerprint
        : null
      : operation.originalFingerprint;
    if (!sameFingerprint(actual, expected)) {
      throw new Error(
        `Dualog install recovery found an unexpected live artifact at ${operation.logicalPath}`
      );
    }
  }
}

function restoreOperation(operation) {
  const target = fingerprintInstallPath(operation.targetPath);
  const stage = fingerprintInstallPath(operation.stagePath);
  const backup = fingerprintInstallPath(operation.backupPath);
  const quarantine = fingerprintInstallPath(operation.quarantinePath);
  const original = operation.originalFingerprint;
  const staged = operation.stagedFingerprint;

  if (operation.action === "delete") {
    if (backup !== null) {
      if (!sameFingerprint(backup, original) || target !== null || quarantine !== null) {
        throw new Error(`Ambiguous delete rollback for ${operation.logicalPath}`);
      }
      fs.renameSync(operation.backupPath, operation.targetPath);
      fsyncDirectory(path.dirname(operation.targetPath));
    } else if (!sameFingerprint(target, original)) {
      throw new Error(`Cannot prove delete rollback state for ${operation.logicalPath}`);
    }
    return;
  }

  if (backup !== null) {
    if (!sameFingerprint(backup, original)) {
      throw new Error(`Backup identity changed for ${operation.logicalPath}`);
    }
    if (target !== null) {
      if (!sameFingerprint(target, staged) || quarantine !== null) {
        throw new Error(`Installed artifact identity changed for ${operation.logicalPath}`);
      }
      fs.renameSync(operation.targetPath, operation.quarantinePath);
    } else if (quarantine !== null && !sameFingerprint(quarantine, staged)) {
      throw new Error(`Rollback quarantine identity changed for ${operation.logicalPath}`);
    }
    fs.renameSync(operation.backupPath, operation.targetPath);
    fsyncDirectory(path.dirname(operation.targetPath));
    return;
  }

  if (original !== null) {
    if (!sameFingerprint(target, original)) {
      throw new Error(`Cannot prove original artifact state for ${operation.logicalPath}`);
    }
    if (stage !== null && !sameFingerprint(stage, staged)) {
      throw new Error(`Staged artifact identity changed for ${operation.logicalPath}`);
    }
    if (quarantine !== null && !sameFingerprint(quarantine, staged)) {
      throw new Error(`Rollback quarantine identity changed for ${operation.logicalPath}`);
    }
    return;
  }

  if (target !== null) {
    if (!sameFingerprint(target, staged) || quarantine !== null) {
      throw new Error(`Cannot prove new artifact identity for ${operation.logicalPath}`);
    }
    fs.renameSync(operation.targetPath, operation.quarantinePath);
    fsyncDirectory(path.dirname(operation.targetPath));
  } else if (quarantine !== null && !sameFingerprint(quarantine, staged)) {
    throw new Error(`Rollback quarantine identity changed for ${operation.logicalPath}`);
  }
}

function removeCreatedDirectories(journal) {
  for (const directory of [...journal.createdDirectories].reverse()) {
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
    }
  }
}

function cleanupTransactionFiles(journal, faultInjector = null) {
  for (const operation of journal.operations) {
    for (const ownedPath of [
      operation.stagePath,
      operation.backupPath,
      operation.quarantinePath,
    ]) {
      faultInjector?.({
        phase: "before-cleanup-path",
        cleanupPath: ownedPath,
        operation,
      });
      removePath(ownedPath);
    }
  }
}

function rollbackJournal(paths, journal, faultInjector = null) {
  journal.phase = "rolling_back";
  writeJournal(paths.journal, journal, faultInjector);
  const operations = [...journal.operations].reverse();
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    faultInjector?.({ phase: "before-rollback-operation", index, operation });
    restoreOperation(operation);
  }
  verifyFinalState(journal, false);
  journal.phase = "rolled_back";
  writeJournal(paths.journal, journal, faultInjector);
  cleanupTransactionFiles(journal, faultInjector);
  removeCreatedDirectories(journal);
  removePath(paths.journal);
  fsyncDirectory(paths.directory);
}

function markRollbackPending(paths, journal) {
  journal.phase = "rollback_pending";
  try {
    // Do not reuse the failing injector here: this is the best-effort durable
    // marker that tells the next run to resume exact rollback.
    writeJournal(paths.journal, journal);
  } catch {
    // An older committing/rolling_back journal is still rollback-directed.
    // Preserve it and every recovery artifact rather than risking deletion.
  }
}

function finalizeCommitted(paths, journal, faultInjector = null) {
  verifyFinalState(journal, true);
  cleanupTransactionFiles(journal, faultInjector);
  removePath(paths.journal);
  fsyncDirectory(paths.directory);
}

function cleanupOrphanStages(paths, id, allowedLogicalPaths) {
  const parents = new Set();
  for (const logical of allowedLogicalPaths) {
    try {
      parents.add(fs.realpathSync(path.dirname(stablePath(logical))));
    } catch {}
  }
  const marker = `.dualog-${id}-`;
  for (const parent of parents) {
    for (const name of fs.readdirSync(parent)) {
      if (!name.includes(marker) || !name.endsWith(".stage")) continue;
      removePath(path.join(parent, name));
    }
  }
}

export function recoverPendingInstallTransaction({
  home,
  allowedLogicalPaths,
  identityProvider = defaultIdentityProvider(),
  faultInjector = null,
}) {
  const paths = transactionPaths(home);
  const initialCandidates = inspectLockCandidates(paths);
  const initialClaims = inspectTakeoverClaims(paths);
  if (
    !exists(paths.lock) &&
    !exists(paths.journal) &&
    initialCandidates.length === 0 &&
    initialClaims.length === 0
  ) {
    return false;
  }

  const heldTakeovers = [];
  const orphanIds = new Set();
  let recoveryLock = null;

  for (let attempt = 0; attempt < 16 && !recoveryLock; attempt++) {
    for (const candidate of inspectLockCandidates(paths)) {
      if (!candidate.lock) continue;
      const verdict = lockOwnerVerdict(candidate.lock, identityProvider);
      if (verdict.state !== "stale") {
        throw new Error(`Cannot recover Dualog install lock candidate: ${verdict.reason}`);
      }
    }
    for (const existing of inspectTakeoverClaims(paths)) {
      if (heldTakeovers.some((held) => held.claim.token === existing.claim.token)) {
        continue;
      }
      const verdict = lockOwnerVerdict(existing.claim.owner, identityProvider);
      if (verdict.state !== "stale") {
        throw new Error(`Cannot recover Dualog install takeover claim: ${verdict.reason}`);
      }
      const takeover = acquireTakeoverClaim(
        paths,
        existing.claim.expectedLock,
        identityProvider
      );
      const current = exists(paths.lock)
        ? validateLock(readJsonStrict(paths.lock, "lock"))
        : null;
      if (current && sameLockGeneration(current, existing.claim.expectedLock)) {
        fs.renameSync(paths.lock, path.join(takeover.claimPath, "retired.lock"));
        fsyncDirectory(paths.directory);
      }
      heldTakeovers.push(takeover);
      orphanIds.add(existing.claim.expectedLock.id);
    }

    if (exists(paths.lock)) {
      const existing = validateLock(readJsonStrict(paths.lock, "lock"));
      const verdict = lockOwnerVerdict(existing, identityProvider);
      if (verdict.state === "live") {
        throw new Error(`Another Dualog installer is still active: ${verdict.reason}`);
      }
      if (verdict.state !== "stale") {
        throw new Error(`Cannot recover Dualog install lock: ${verdict.reason}`);
      }
      orphanIds.add(existing.id);
      const takeover = retireStaleCanonicalLock(
        paths,
        existing,
        identityProvider,
        faultInjector,
        verdict.reason
      );
      if (takeover) heldTakeovers.push(takeover);
      continue;
    }

    const recoveryId = crypto.randomBytes(8).toString("hex");
    try {
      recoveryLock = acquireInstallLock(
        paths,
        recoveryId,
        identityProvider,
        faultInjector,
        { recoveryFor: exists(paths.journal) ? readJsonStrict(paths.journal, "journal").id : null }
      );
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  if (!recoveryLock) throw new Error("Dualog install lock recovery contention did not settle");

  try {
    recoverLockCandidates(paths, inspectLockCandidates(paths), identityProvider);
    for (const id of orphanIds) cleanupOrphanStages(paths, id, allowedLogicalPaths);

    if (exists(paths.journal)) {
      const journal = validateJournal(
        readJsonStrict(paths.journal, "journal"),
        allowedLogicalPaths
      );
      if (journal.phase === "committed") finalizeCommitted(paths, journal);
      else if (journal.phase === "rolled_back") {
        verifyFinalState(journal, false);
        cleanupTransactionFiles(journal);
        removeCreatedDirectories(journal);
        removePath(paths.journal);
      } else rollbackJournal(paths, journal);
    }

    for (const takeover of heldTakeovers.reverse()) {
      releaseTakeoverClaim(paths, takeover.claimPath, takeover.claim);
    }
    releaseCanonicalLock(paths, recoveryLock, "recovered");
    fsyncDirectory(paths.directory);
    return true;
  } catch (error) {
    // Recovery itself owns the canonical generation. Preserve that lock and all
    // claims/artifacts so the next process can prove this owner stale and resume.
    throw error;
  }
}

export class InstallTransaction {
  constructor({
    home,
    allowedLogicalPaths,
    faultInjector = null,
    identityProvider = defaultIdentityProvider(),
  }) {
    this.paths = transactionPaths(home);
    this.allowedLogicalPaths = new Set([...allowedLogicalPaths].map(stablePath));
    this.faultInjector = faultInjector;
    this.identityProvider = identityProvider;
    this.journal = {
      schema: SCHEMA_VERSION,
      id: crypto.randomBytes(8).toString("hex"),
      phase: "prepared",
      operations: [],
      createdDirectories: [],
    };
    this.closed = false;
    this.commitStarted = false;
    const preparedLock = captureOwnerIdentity(
      this.identityProvider,
      this.journal.id
    );
    fs.mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
    this.lock = acquireInstallLock(
      this.paths,
      this.journal.id,
      this.identityProvider,
      this.faultInjector,
      {},
      preparedLock
    );
  }

  ensureDirectory(directory) {
    const missing = [];
    let cursor = stablePath(directory);
    while (!exists(cursor)) {
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    fs.mkdirSync(directory, { recursive: true });
    for (const created of missing.reverse()) {
      if (!this.journal.createdDirectories.includes(created)) {
        this.journal.createdDirectories.push(created);
      }
    }
  }

  resolvedSiblingTarget(logicalPath) {
    const logical = stablePath(logicalPath);
    if (!this.allowedLogicalPaths.has(logical)) {
      throw new Error(`Install transaction target is not allow-listed: ${logical}`);
    }
    this.ensureDirectory(path.dirname(logical));
    return path.join(fs.realpathSync(path.dirname(logical)), path.basename(logical));
  }

  addOperation({
    logicalPath,
    targetPath,
    action,
    populate = null,
    mode = 0o600,
    expectedOriginalFingerprint = undefined,
  }) {
    if (this.closed) throw new Error("Install transaction is already closed");
    const logical = stablePath(logicalPath);
    const target = stablePath(targetPath);
    if (!this.allowedLogicalPaths.has(logical) || !plausibleResolvedTarget(logical, target)) {
      throw new Error(`Unsafe install transaction target: ${logical}`);
    }
    const index = this.journal.operations.length;
    const originalFingerprint = fingerprintInstallPath(target);
    if (
      expectedOriginalFingerprint !== undefined &&
      !sameFingerprint(originalFingerprint, expectedOriginalFingerprint)
    ) {
      throw new Error(`Install target changed while staging: ${logical}`);
    }
    const operation = {
      logicalPath: logical,
      targetPath: target,
      action,
      originalFingerprint,
      stagedFingerprint: null,
      stagePath: expectedSibling(target, this.journal.id, index, "stage"),
      backupPath: expectedSibling(target, this.journal.id, index, "backup"),
      quarantinePath: expectedSibling(target, this.journal.id, index, "quarantine"),
    };
    for (const ownedPath of [
      operation.stagePath,
      operation.backupPath,
      operation.quarantinePath,
    ]) {
      if (exists(ownedPath)) throw new Error(`Transaction sibling already exists: ${ownedPath}`);
    }
    if (action === "replace") {
      try {
        populate(operation.stagePath, mode);
        fsyncTree(operation.stagePath);
        operation.stagedFingerprint = fingerprintInstallPath(operation.stagePath);
        if (operation.stagedFingerprint === null) {
          throw new Error(`Install transaction did not stage ${logical}`);
        }
      } catch (error) {
        removePath(operation.stagePath);
        throw error;
      }
    }
    this.journal.operations.push(operation);
    return operation;
  }

  stageFile(
    logicalPath,
    content,
    { targetPath = null, mode = 0o600, expectedOriginalFingerprint = undefined } = {}
  ) {
    const target = targetPath ?? this.resolvedSiblingTarget(logicalPath);
    return this.addOperation({
      logicalPath,
      targetPath: target,
      action: "replace",
      mode,
      expectedOriginalFingerprint,
      populate: (stage, fileMode) => durableCreateFile(stage, content, fileMode),
    });
  }

  stageTree(
    logicalPath,
    populate,
    { targetPath = null, mode = 0o700, expectedOriginalFingerprint = undefined } = {}
  ) {
    const target = targetPath ?? this.resolvedSiblingTarget(logicalPath);
    return this.addOperation({
      logicalPath,
      targetPath: target,
      action: "replace",
      mode,
      expectedOriginalFingerprint,
      populate: (stage, directoryMode) => {
        fs.mkdirSync(stage, { mode: directoryMode });
        populate(stage);
      },
    });
  }

  stageDelete(
    logicalPath,
    { targetPath = null, expectedOriginalFingerprint = undefined } = {}
  ) {
    if (targetPath === null && fingerprintInstallPath(stablePath(logicalPath)) === null) {
      return null;
    }
    const target = targetPath ?? this.resolvedSiblingTarget(logicalPath);
    if (fingerprintInstallPath(target) === null) return null;
    return this.addOperation({
      logicalPath,
      targetPath: target,
      action: "delete",
      expectedOriginalFingerprint,
    });
  }

  prepare() {
    writeJournal(this.paths.journal, this.journal, this.faultInjector);
  }

  commit() {
    if (this.closed) throw new Error("Install transaction is already closed");
    this.commitStarted = true;
    try {
      this.prepare();
      this.journal.phase = "committing";
      writeJournal(this.paths.journal, this.journal, this.faultInjector);
      for (let index = 0; index < this.journal.operations.length; index++) {
        const operation = this.journal.operations[index];
        if (
          !sameFingerprint(
            fingerprintInstallPath(operation.targetPath),
            operation.originalFingerprint
          )
        ) {
          throw new Error(`Install target changed while staging: ${operation.logicalPath}`);
        }
        if (
          operation.action === "replace" &&
          !sameFingerprint(
            fingerprintInstallPath(operation.stagePath),
            operation.stagedFingerprint
          )
        ) {
          throw new Error(`Staged install artifact changed: ${operation.logicalPath}`);
        }
        if (operation.originalFingerprint !== null) {
          fs.renameSync(operation.targetPath, operation.backupPath);
        }
        if (operation.action === "replace") {
          this.faultInjector?.({ phase: "before-stage-rename", index, operation });
          fs.renameSync(operation.stagePath, operation.targetPath);
        }
        fsyncDirectory(path.dirname(operation.targetPath));
        writeJournal(this.paths.journal, this.journal, this.faultInjector);
        this.faultInjector?.({ phase: "after-operation", index, operation });
      }
      verifyFinalState(this.journal, true);
      this.journal.phase = "committed";
      writeJournal(this.paths.journal, this.journal, this.faultInjector);
    } catch (error) {
      if (error?.dualogSimulatedCrash === true) {
        this.closed = true;
        throw error;
      }
      try {
        rollbackJournal(this.paths, this.journal, this.faultInjector);
        releaseCanonicalLock(this.paths, this.lock, "rolled-back");
        this.closed = true;
      } catch (rollbackError) {
        markRollbackPending(this.paths, this.journal);
        this.closed = true;
        throw new AggregateError(
          [error, rollbackError],
          "Dualog install failed and exact rollback remains pending; rerun setup to recover"
        );
      }
      throw error;
    }

    // The committed marker is the point of no return. Cleanup is idempotent
    // and may be resumed by the next installer, but must never trigger rollback.
    try {
      this.faultInjector?.({ phase: "after-committed", index: -1, operation: null });
      finalizeCommitted(this.paths, this.journal, this.faultInjector);
      releaseCanonicalLock(this.paths, this.lock, "committed");
      fsyncDirectory(this.paths.directory);
      this.closed = true;
    } catch (error) {
      this.closed = true;
      if (error?.dualogSimulatedCrash === true) throw error;
      throw new Error(
        "Dualog install committed, but cleanup remains pending; rerun setup to finalize it",
        { cause: error }
      );
    }
  }

  abort() {
    if (this.closed || this.commitStarted) return;
    for (const operation of this.journal.operations) {
      removePath(operation.stagePath);
      removePath(operation.backupPath);
      removePath(operation.quarantinePath);
    }
    removeCreatedDirectories(this.journal);
    removePath(this.paths.journal);
    releaseCanonicalLock(this.paths, this.lock, "aborted");
    this.closed = true;
  }
}

export function copyTreeContents(source, destination) {
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) {
      fs.mkdirSync(to, { mode: stat.mode & 0o777 });
      copyTreeContents(from, to);
    } else if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else if (stat.isFile()) {
      durableCreateFile(to, fs.readFileSync(from), stat.mode & 0o777);
    } else {
      throw new Error(`Unsupported install source type at ${from}`);
    }
  }
}
