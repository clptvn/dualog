// A session directory that satisfies the containment boundary.
//
// prepareConfigIsolation() now proves, before it creates anything, that the
// path it is about to write to lies inside a session directory that dualog
// itself owns -- a direct, validly-named child of `~/.dualog/sessions` (or of
// the legacy root, for a session that already exists there). Tests used to hand
// it an arbitrary `mkdtempSync` path, which is precisely the shape the
// assertion exists to reject: it is how a live auth.json was once written into
// a repository's working tree.
//
// So a test that exercises the isolation path has to look like the product.
// HOME is redirected to a throwaway directory and the session is created
// beneath it, which keeps the real `~/.dualog` untouched while letting
// dialogsDir() resolve normally. node:test runs each FILE in its own process,
// so mutating the environment at module scope stays inside that file.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Redirect HOME to a throwaway directory and create one session under it.
 *
 * `label` is embedded in the session id, so it must satisfy the session-id
 * pattern (`[\w-]+`) -- an id the platform layer rejects would fail the
 * assertion for the wrong reason and make the test look like it caught
 * something it did not.
 */
export function managedSession(label = "test", { keepAdapterSeeds = [] } = {}) {
  if (!/^[\w-]+$/.test(label)) {
    throw new Error(`managedSession: label ${JSON.stringify(label)} must match /^[\\w-]+$/`);
  }

  // Redirecting HOME also moves every adapter's config directory, because those
  // are home-relative by default. That is usually the point -- but a case that
  // deliberately asserts against the machine's REAL cache (live model
  // discovery, for instance) would silently degrade to the static list and skip
  // itself, losing coverage without saying so. Such a case pins the seed
  // variable at the real home explicitly, so the redirect stays a redirect and
  // does not become an unannounced opt-out.
  const realHome = os.homedir();
  for (const { env, dir } of keepAdapterSeeds) {
    if (!process.env[env]) process.env[env] = path.join(realHome, dir);
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dualog-${label}-home-`));
  process.env.HOME = home;
  // Windows resolution order, mirrored so the same helper works there.
  process.env.USERPROFILE = home;
  process.env.HOMEDRIVE = "";
  process.env.HOMEPATH = home;

  const sessionId = `dialog-${label}-0000`;
  const dir = path.join(home, ".dualog", "sessions", sessionId);
  fs.mkdirSync(dir, { recursive: true });

  return { home, sessionId, dir, scratchDir: managedLease() };
}

/**
 * A runtime lease directory that satisfies the lease containment boundary.
 *
 * Partner homes no longer live in the session directory: they live in a
 * per-turn lease under `~/.dualog/runtime`, which is removed as soon as the
 * turn's process is proven gone. `assertManagedLeasePath()` requires a direct,
 * exactly-named child of that root, so -- exactly as with sessions -- a test
 * that hands the isolation path an arbitrary temp directory is handing it the
 * shape the assertion exists to reject.
 *
 * This creates the directory directly rather than going through
 * `allocateLease()`, because these tests exercise argv and env construction
 * rather than the lease lifecycle: they need a valid destination, not a turn
 * pointer and a state machine. The lifecycle has its own suite.
 *
 * Call after HOME is redirected -- the root resolves from os.homedir().
 */
export function managedLease() {
  const id = crypto.randomBytes(16).toString("hex");
  const dir = path.join(os.homedir(), ".dualog", "runtime", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
