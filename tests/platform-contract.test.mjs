// platform.mjs owns its own preconditions.
//
// This module is imported by five hook scripts from the user-level hooks
// directory, which makes it the shared trust boundary for all of them. It used
// to push validation and error handling out to callers: four callers each
// re-implemented a session-id guard (a fifth open-coded the path join), and
// readStdin() could throw past a hook's error handling entirely. These tests
// pin the contract in the module rather than in the callers' memory.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  assertManagedSessionPath,
  assertSeedFileName,
  dialogSessionDir,
  dialogsDir,
  envWithAliases,
  isValidSessionId,
  legacyDialogsDir,
  readStdin,
  resolveExistingSessionDir,
} from "../src/platform.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// --- session id validation --------------------------------------------------

test("a session id that could escape the sessions root is refused, not joined", () => {
  // path.join(root, "../../etc") lands on /etc. Nothing in this module used to
  // stop that; safety depended entirely on every caller remembering to check.
  const escaping = ["..", "../..", "../../../../etc", "sess/../../../.ssh", "a/../../b"];
  for (const id of escaping) {
    assert.equal(isValidSessionId(id), false, `${id} should not validate`);
    assert.throws(() => dialogSessionDir(id), /invalid session id/, `dialogSessionDir(${id})`);
    assert.throws(
      () => resolveExistingSessionDir(id),
      /invalid session id/,
      `resolveExistingSessionDir(${id})`
    );
  }
});

test("a leading slash is contained rather than escaping, but is still refused", () => {
  // path.join normalizes "/etc/passwd" into a relative segment, so this one was
  // never a traversal -- the audit that raised it had that part wrong. It is
  // rejected anyway because it is not a session id shape.
  assert.equal(path.join(dialogsDir(), "/etc/passwd"), path.join(dialogsDir(), "etc/passwd"));
  assert.equal(isValidSessionId("/etc/passwd"), false);
  assert.throws(() => dialogSessionDir("/etc/passwd"), /invalid session id/);
});

test("real session ids still resolve", () => {
  for (const id of ["dialog-1785626252196-13df2e0d", "review-1785614730341-7c2f2734", "a_b-1"]) {
    assert.equal(isValidSessionId(id), true, id);
    assert.equal(dialogSessionDir(id), path.join(dialogsDir(), id));
  }
});

test("non-string ids are refused rather than coerced", () => {
  for (const id of [null, undefined, 42, {}, ["dialog-1-a"]]) {
    assert.equal(isValidSessionId(id), false, String(id));
    assert.throws(() => dialogSessionDir(id), /invalid session id/);
  }
});

// --- legacy session resolution ----------------------------------------------

/**
 * Run a snippet against platform.mjs with HOME pointed at a throwaway directory.
 *
 * These cases have to create session directories, and doing that under the real
 * HOME both mutates the user's data and fails outright on a restricted or
 * read-only home. Because dialogsDir()/legacyDialogsDir() derive from
 * os.homedir() at call time, overriding HOME in a child process isolates them
 * completely.
 */
function inTempHome(t, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out = execFileSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(path.join(REPO_ROOT, "src/platform.mjs"))}).then(async (m) => { ${body} })`],
    {
      encoding: "utf-8",
      // os.homedir() reads HOME on POSIX but USERPROFILE (or HOMEDRIVE+HOMEPATH)
      // on Windows. Overriding only HOME would leave a Windows child writing
      // probe sessions into the user's real profile, which the cleanup below
      // would never touch.
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HOMEDRIVE: "",
        HOMEPATH: home,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return { home, out: out.trim() };
}

test("a session that exists only under the legacy root is still found", (t) => {
  // The MCP server resolves through the legacy root; the hooks did not. For any
  // pre-rename session a hook therefore failed its existence check and exited 0
  // -- which means ALLOW -- so the guard silently stopped applying.
  const { home, out } = inTempHome(t, `
    const fsx = await import("node:fs");
    const px = await import("node:path");
    const id = "dialog-1-legacyprobe";
    const legacy = px.join(m.legacyDialogsDir(), id);
    fsx.mkdirSync(legacy, { recursive: true });
    console.log(JSON.stringify({
      resolved: m.resolveExistingSessionDir(id),
      legacy,
      currentExists: fsx.existsSync(px.join(m.dialogsDir(), id)),
    }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.currentExists, false, "precondition: not in the current root");
  assert.equal(r.resolved, r.legacy, "a legacy-only session must resolve to the legacy path");
  assert.ok(r.legacy.startsWith(home), "the probe must live under the throwaway home");
});

test("the current root wins when a session exists in both", (t) => {
  const { out } = inTempHome(t, `
    const fsx = await import("node:fs");
    const px = await import("node:path");
    const id = "dialog-1-bothprobe";
    const current = px.join(m.dialogsDir(), id);
    fsx.mkdirSync(px.join(m.legacyDialogsDir(), id), { recursive: true });
    fsx.mkdirSync(current, { recursive: true });
    console.log(JSON.stringify({ resolved: m.resolveExistingSessionDir(id), current }));
  `);
  const r = JSON.parse(out);
  assert.equal(r.resolved, r.current);
});

test("importing shared.mjs survives a home where the sessions root cannot be created", (t) => {
  // Six modules import shared.mjs at file top, three of them process entry
  // points, and the hooks import it before their own try/catch exists. An
  // unwritable HOME used to surface as an unhandled module-load exception.
  //
  // Using a FILE as the home directory makes mkdir fail on every platform;
  // "/dev/null/not-a-directory" only fails on Unix and would silently pass
  // elsewhere without testing anything.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-badhome-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const notADirectory = path.join(dir, "home-is-a-file");
  fs.writeFileSync(notADirectory, "not a directory");

  const res = spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(path.join(REPO_ROOT, "src/shared.mjs"))}).then(() => console.log("IMPORT_OK"))`],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: notADirectory,
        USERPROFILE: notADirectory,
        HOMEDRIVE: "",
        HOMEPATH: notADirectory,
      },
      timeout: 20000,
    }
  );
  assert.equal(res.status, 0, `import should not crash; stderr: ${res.stderr}`);
  assert.match(String(res.stdout), /IMPORT_OK/);
});

test("EAGAIN mid-stream never discards bytes (portable, no pty required)", () => {
  // The pty case below is the real-world reproduction, but it is silently
  // skipped wherever python is absent -- which means no coverage at all on
  // those machines for the contract that matters most. Injecting the read
  // primitive pins the same behavior deterministically on every platform:
  // EAGAIN, then bytes, then EAGAIN again, then EOF.
  const payload = '{"tool_input":{"session_id":"dialog-1-abc"}}';
  const child = `
    const fs = await import("node:fs");
    const real = fs.default.readSync;
    const script = ["EAGAIN", ${JSON.stringify(payload)}, "EAGAIN", "EOF"];
    let step = 0;
    fs.default.readSync = (fd, buf) => {
      const next = script[Math.min(step++, script.length - 1)];
      if (next === "EAGAIN") {
        const err = new Error("EAGAIN");
        err.code = "EAGAIN";
        throw err;
      }
      if (next === "EOF") return 0;
      return Buffer.from(next, "utf-8").copy(buf);
    };
    const v = m.readStdin();
    fs.default.readSync = real;
    console.log(JSON.stringify({ text: v }));
  `;
  const out = execFileSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(path.join(REPO_ROOT, "src/platform.mjs"))}).then(async (m) => { ${child} })`],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(
    parsed.text,
    payload,
    "bytes delivered between EAGAINs must be preserved by the public readStdin()"
  );
});

test("every hook resolves sessions the same way the server does", () => {
  // A hook that only checks the current root cannot see a legacy session, and
  // its existence check fails open. Pin this at the source level: all four
  // session-aware hooks must go through the legacy-aware resolver.
  const hooks = [
    "enforce-investigation.mjs",
    "enforce-resolution.mjs",
    "mark-needs-investigation.mjs",
    "require-lgtm-or-cap.mjs",
  ];
  for (const hook of hooks) {
    const src = fs.readFileSync(path.join(REPO_ROOT, "src/hooks", hook), "utf-8");
    assert.match(src, /resolveExistingSessionDir/, `${hook} must use the legacy-aware resolver`);
    assert.doesNotMatch(
      src,
      /dialogSessionDir\(/,
      `${hook} must not resolve against the current root only`
    );
    assert.doesNotMatch(
      src,
      /path\.join\(\s*dialogsDir\(\)/,
      `${hook} must not open-code the session path join`
    );
  }
});

// --- envWithAliases ---------------------------------------------------------

test("a bare string is a hard error, not a silently wrong value", () => {
  // Strings are iterable, so this used to iterate CHARACTERS. Every env name
  // here contains "_", and POSIX shells set $_ to the last executed binary, so
  // the call returned a path to the node binary where a millisecond count was
  // expected -- then fed it to parsePositiveInt.
  assert.throws(
    () => envWithAliases("DUALOG_IDLE_SHUTDOWN_MS"),
    /must be an array/,
    "a bare string must fail loudly"
  );
  for (const bad of [null, undefined, 42, { 0: "A" }]) {
    assert.throws(() => envWithAliases(bad), /must be an array/, String(bad));
  }
});

test("arrays still resolve in order, with the fallback last", () => {
  const key = `DUALOG_TEST_${process.pid}`;
  const alias = `CODEX_DIALOG_TEST_${process.pid}`;
  delete process.env[key];
  delete process.env[alias];

  assert.equal(envWithAliases([key, alias], "fallback"), "fallback");
  assert.equal(envWithAliases([key, alias]), undefined, "no fallback argument means undefined");

  process.env[alias] = "from-alias";
  assert.equal(envWithAliases([key, alias], "fallback"), "from-alias");
  process.env[key] = "from-primary";
  assert.equal(envWithAliases([key, alias], "fallback"), "from-primary");

  process.env[key] = "";
  assert.equal(envWithAliases([key, alias], "fallback"), "from-alias", "empty is skipped");

  delete process.env[key];
  delete process.env[alias];
});

// --- readStdin --------------------------------------------------------------

test("readStdin returns a string rather than throwing when stdin is empty", () => {
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(path.join(REPO_ROOT, "src/platform.mjs"))}).then((m) => {
         const v = m.readStdin();
         console.log(JSON.stringify({ type: typeof v, len: v.length }));
       })`,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.type, "string");
  assert.equal(parsed.len, 0);
});

test("a hook whose stdin raises EAGAIN does not fail open with a stack trace", (t) => {
  // The failure that matters. fs.readFileSync(0) throws EAGAIN when stdin is a
  // non-blocking pty. readStdin() was unguarded and is the FIRST statement in
  // every hook, so the throw escaped as an uncaught error: Node printed a stack
  // trace and exited 1 -- and for a Claude Code PreToolUse hook, exit 1 is a
  // NON-BLOCKING error, so the tool call proceeded and the guard was silently
  // skipped. A safety check must never fail in that direction.
  const python = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" });
  if (python.status !== 0) {
    t.skip("python3 with the pty module is required to create a non-blocking tty");
    return;
  }

  const script = `
import os, pty, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.set_blocking(0, False)
    os.execv(sys.argv[1], [sys.argv[1], "-e",
        "import(process.argv[1]).then(m => { const t0 = Date.now(); const v = m.readStdin(); process.stdout.write('RESULT:' + JSON.stringify({ text: v, ms: Date.now() - t0 })) })",
        sys.argv[2]])
# Write AFTER the child is already retrying, and leave the pty OPEN: bytes
# available with no EOF is the interleaving that used to lose the payload.
time.sleep(0.05)
os.write(fd, b'{"tool_input":{"session_id":"dialog-1-abc"}}\\n')
out = b""
deadline = time.time() + 15
try:
    while time.time() < deadline:
        chunk = os.read(fd, 1024)
        if not chunk: break
        out += chunk
        if b"RESULT:" in out: break
except OSError:
    pass
try:
    os.kill(pid, 9)
except OSError:
    pass
os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
`;

  const res = spawnSync(
    "python3",
    ["-c", script, process.execPath, path.join(REPO_ROOT, "src/platform.mjs")],
    { encoding: "utf-8", timeout: 30000 }
  );

  const report = String(res.stdout || "") + String(res.stderr || "");
  assert.doesNotMatch(report, /at readStdin/, "no stack trace should reach the user");

  const marker = report.indexOf("RESULT:");
  assert.notEqual(marker, -1, `no result produced; got: ${report.slice(-300)}`);
  const parsed = JSON.parse(report.slice(marker + "RESULT:".length).split("\n")[0]);

  // The whole point. readFileSync(0) consumes the available bytes and THEN
  // raises EAGAIN waiting for an EOF that never comes, so a retry resumes past
  // the payload and returns "" -- the hook then treats a valid message as
  // unparseable and exits 0, which is the original fail-open with the stack
  // trace removed. Verified against the old implementation: RESULT:"".
  assert.match(
    parsed.text,
    /"session_id":"dialog-1-abc"/,
    "the payload must survive EAGAIN rather than being discarded by the retry"
  );
});

// --- hook input policy, pinned behaviorally -----------------------------------
//
// The reader tests above prove readHookPayload classifies input. These prove the
// HOOKS act on that classification, which is where the fail-open actually lived:
// an earlier fix handled "unreadable" and left "invalid" exiting 0, so piping a
// truncated document silently disabled every gate.

const PRE_TOOL_GATES = [
  "enforce-investigation.mjs",
  "enforce-resolution.mjs",
  "require-lgtm-or-cap.mjs",
];
const POST_TOOL_HOOKS = ["mark-needs-investigation.mjs", "clear-investigation.mjs"];

function runHook(hook, stdin) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, "src/hooks", hook)], {
    input: stdin,
    encoding: "utf-8",
    timeout: 20000,
  });
}

test("a PreToolUse gate BLOCKS on non-empty malformed input", () => {
  for (const hook of PRE_TOOL_GATES) {
    const res = runHook(hook, '{"tool_input":');
    assert.equal(res.status, 2, `${hook} must block truncated input (exit 2), not wave it through`);
    assert.match(res.stderr, /BLOCKED/, `${hook} must say why it blocked`);
    assert.match(res.stderr, /invalid/, `${hook} should name the input problem`);
  }
});

test("a PreToolUse gate stays out of the way on a clean empty read", () => {
  // Nothing arrived and nothing was claimed, so there is no decision to make.
  // This is the one benign case and must not become a blanket block.
  for (const hook of PRE_TOOL_GATES) {
    const res = runHook(hook, "");
    assert.equal(res.status, 0, `${hook} must allow a clean empty read`);
    assert.equal(res.stderr.trim(), "", `${hook} should be silent for benign input`);
  }
});

test("a PreToolUse gate passes valid input through to its own logic", () => {
  // A well-formed payload for a session that does not exist: the gate parses it,
  // finds nothing to enforce, and exits 0 -- reaching its real logic rather than
  // bailing at the input stage.
  for (const hook of PRE_TOOL_GATES) {
    const res = runHook(hook, JSON.stringify({ tool_input: { session_id: "dialog-1-nonexistent" } }));
    assert.equal(res.status, 0, `${hook} should accept a valid payload`);
  }
});

test("a PostToolUse hook reports bad input loudly but never blocks", () => {
  // The call already ran, so exit 2 would be theatre. Silence is the real
  // hazard, but the two hooks fail in opposite directions and must say so
  // accurately: mark-needs-investigation ARMS the guard, so failing there
  // disarms it; clear-investigation only CLEARS a marker, so failing there
  // leaves the guard armed and merely fails to credit a read.
  const consequences = {
    "mark-needs-investigation.mjs": /not armed/,
    "clear-investigation.mjs": /not credited/,
  };
  for (const hook of POST_TOOL_HOOKS) {
    const res = runHook(hook, '{"tool_response":');
    assert.equal(res.status, 0, `${hook} must not block a completed call`);
    assert.match(res.stderr, /invalid hook input/, `${hook} must report the bad input`);
    assert.match(res.stderr, consequences[hook], `${hook} must name its OWN consequence`);
  }
});

test("a closed pipe is a clean EOF, not exhaustion", () => {
  // Distinct from malformed input: nothing arrived at all. Forced with a tiny
  // budget and a stdin that never delivers.
  const res = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "src/hooks/require-lgtm-or-cap.mjs")],
    {
      input: "",
      encoding: "utf-8",
      env: { ...process.env, DUALOG_STDIN_BUDGET_MS: "20" },
      timeout: 20000,
    }
  );
  // Named for what it actually proves. A pipe that closes delivers EOF, which
  // is the benign "empty" outcome even under a tiny budget -- exhaustion needs a
  // stdin that stays open and silent, which only the pty case produces. Pinning
  // this matters because a naive tightening could easily start blocking here and
  // break every hook invoked with no input.
  assert.equal(res.status, 0);
  assert.equal(res.stderr.trim(), "");
});

test("an adapter that drops the model resolves to null rather than echoing it back", async () => {
  // capabilities.modelFlag:false is schema-valid and documented for custom
  // adapters. resolveContext() then drops the model and emits `dropped_model`,
  // so the start response must NOT report the requested value as if it survived
  // -- that would certify a selection the invocation never makes. No shipped
  // adapter sets this today, which is exactly why it needs a test.
  const { getAdapter } = await import("../src/adapters/registry.mjs");
  const { negotiate } = await import("../src/adapters/negotiate.mjs");

  const base = getAdapter("cursor");
  const noModelFlag = { ...base, capabilities: { ...base.capabilities, modelFlag: false } };
  const result = negotiate(noModelFlag, {
    engine: noModelFlag.engines.default,
    toolProfile: "read",
    model: "some-model",
    requireBinary: false,
  });

  assert.equal(result.resolution.model, null, "the resolved model must be null when it is dropped");
  assert.ok(
    result.notices.some((n) => n.code === "dropped_model"),
    "the drop must be reported"
  );
});

test("the start handlers carry the RESOLVED model, not the requested one", () => {
  // Source-level, because asserting the response shape end to end would mean
  // spawning a real runner. The regression is precisely that `preflight.model`
  // was computed and then ignored while `preflight.effort` was used, so pin
  // that both are consumed and that the raw request is not what travels.
  const src = fs.readFileSync(path.join(REPO_ROOT, "src/dialog-server.mjs"), "utf-8");
  assert.equal(
    (src.match(/const effectiveModel = preflight\.model;/g) || []).length,
    2,
    "both start tools must derive the model from the preflight result"
  );
  assert.equal(
    (src.match(/model: effectiveModel \?\? "default",/g) || []).length,
    2,
    "both start responses must echo the resolved model"
  );
  // Scoped deliberately: `model: model || null` also appears inside
  // preflightPartner(), where passing the REQUESTED model into negotiate() is
  // correct. Only the persisted status and the runner argv must carry the
  // resolved value, so assert on those two shapes rather than on the string
  // appearing anywhere in the file -- the first draft of this test failed on
  // exactly that false positive.
  assert.equal(
    (src.match(/reasoning_effort: effectiveReasoningEffort,\n\s+model: effectiveModel \?\? null,/g) || []).length,
    2,
    "both status documents must persist the resolved model"
  );
  assert.equal(
    (src.match(/effectiveReasoningEffort \|\| "",\n\s+effectiveModel \|\| "",/g) || []).length,
    2,
    "both runner argv lists must pass the resolved model"
  );
});

// --- containment of partner scratch directories ------------------------------
//
// prepareConfigIsolation() renders a manifest template and creates the result,
// then copies credentials into it. Until assertManagedSessionPath() existed it
// did that with no check of any kind, so whatever a caller called a "session
// directory" became a place to deposit auth. That is not hypothetical: a test
// that passed the repository root as sessionDir wrote a live codex auth.json
// into a public repo's working tree.
//
// These cases run in a subprocess under a throwaway HOME, because the boundary
// is defined against the REAL sessions root and the assertion resolves it at
// call time.

function inThrowawayHome(body, { seedSession = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-containment-"));
  const sessionId = "dialog-contain-0000";
  const sessionDir = path.join(home, ".dualog", "sessions", sessionId);
  if (seedSession) fs.mkdirSync(sessionDir, { recursive: true });

  const script = `
    const home = ${JSON.stringify(home)};
    const sessionDir = ${JSON.stringify(sessionDir)};
    const repoRoot = ${JSON.stringify(REPO_ROOT)};
    const m = await import(${JSON.stringify(path.join(REPO_ROOT, "src/platform.mjs"))});
    const fs = (await import("node:fs")).default;
    const path = (await import("node:path")).default;
    const out = [];
    const attempt = (label, fn) => {
      try { out.push({ label, ok: true, value: fn() }); }
      catch (err) { out.push({ label, ok: false, error: err.message }); }
    };
    ${body}
    console.log(JSON.stringify(out));
  `;
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home, USERPROFILE: home, HOMEDRIVE: "", HOMEPATH: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { home, sessionDir, results: JSON.parse(stdout.trim()) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("a session directory outside the managed roots is refused before anything is created", () => {
  const { results } = inThrowawayHome(`
    attempt("repo-as-session", () =>
      m.assertManagedSessionPath(repoRoot, path.join(repoRoot, "codex-home")));
    attempt("tmp-as-session", () =>
      m.assertManagedSessionPath("/tmp/not-a-session", "/tmp/not-a-session/codex-home"));
    attempt("nested-too-deep", () =>
      m.assertManagedSessionPath(path.join(home, ".dualog/sessions/a/b"), path.join(home, ".dualog/sessions/a/b/c")));
  `);

  for (const r of results) {
    assert.equal(r.ok, false, `${r.label} must be refused`);
    assert.match(r.error, /must be a direct child of/, r.label);
  }
});

test("the repo-as-session deposit that actually happened is refused by name", () => {
  // The concrete regression: this is the exact call shape that put a live
  // auth.json into the working tree.
  //
  // The probe name is unique rather than the real `codex-home`, because that
  // directory can legitimately be present from an earlier run and its existence
  // would then "prove" a failure this call did not cause. What is being asserted
  // is that THIS call created nothing, so it has to test a path only this call
  // could have made.
  const probe = path.join(REPO_ROOT, `codex-home-containment-probe-${process.pid}`);
  assert.equal(fs.existsSync(probe), false, "precondition: the probe path is absent");

  const { results } = inThrowawayHome(`
    attempt("deposit", () =>
      m.assertManagedSessionPath(repoRoot, ${JSON.stringify(probe)}));
  `);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /refusing to use/);
  assert.equal(
    fs.existsSync(probe),
    false,
    "and the refusal must come before anything is created in the repository"
  );
});

test("a valid session accepts its own children and refuses a sibling's", () => {
  const { results } = inThrowawayHome(`
    attempt("own-child", () =>
      m.assertManagedSessionPath(sessionDir, path.join(sessionDir, "codex-home")));
    attempt("own-nested-child", () =>
      m.assertManagedSessionPath(sessionDir, path.join(sessionDir, "turns", "1", "scratch")));
    attempt("sibling-escape", () =>
      m.assertManagedSessionPath(sessionDir, path.join(sessionDir, "..", "dialog-other-0000", "codex-home")));
    attempt("session-itself", () =>
      m.assertManagedSessionPath(sessionDir, sessionDir));
    attempt("prefix-sibling", () =>
      m.assertManagedSessionPath(sessionDir, sessionDir + "-evil"));
  `);
  const byLabel = Object.fromEntries(results.map((r) => [r.label, r]));

  assert.equal(byLabel["own-child"].ok, true, "a direct child is the normal case");
  assert.equal(byLabel["own-nested-child"].ok, true, "as is a deeper path inside the session");

  // `{{sessionDir}}/../other-session` is why checking only "inside a managed
  // root" is not enough: the sibling IS inside the root.
  assert.equal(byLabel["sibling-escape"].ok, false, "a sibling session must be refused");
  assert.match(byLabel["sibling-escape"].error, /not inside the session directory/);

  assert.equal(byLabel["session-itself"].ok, false, "the session dir is not a scratch target");

  // The reason this is path.relative and not startsWith: "/x/sess-evil"
  // startsWith "/x/sess".
  assert.equal(byLabel["prefix-sibling"].ok, false, "a name-prefix sibling must be refused");
});

test("a symlinked component is refused even though it is lexically inside", () => {
  // Lexical containment answers "does this SPELL a child", not "does it RESOLVE
  // to one". A planted link is beneath the session by name and writes to the
  // user's real config by effect.
  const { results } = inThrowawayHome(`
    const outside = path.join(home, "real-config");
    fs.mkdirSync(outside, { recursive: true });
    // Directory junctions exercise the same lstat/isSymbolicLink boundary on
    // Windows without depending on Developer Mode or SeCreateSymbolicLinkPrivilege.
    fs.symlinkSync(
      outside,
      path.join(sessionDir, "codex-home"),
      process.platform === "win32" ? "junction" : "dir"
    );
    attempt("linked-dir", () =>
      m.assertManagedSessionPath(sessionDir, path.join(sessionDir, "codex-home")));
    attempt("through-linked-dir", () =>
      m.assertManagedSessionPath(sessionDir, path.join(sessionDir, "codex-home", "auth.json")));
  `);

  for (const r of results) {
    assert.equal(r.ok, false, `${r.label} must be refused`);
    assert.match(r.error, /symbolic link/, r.label);
  }
});

test("a seed name must be one filename, because it is joined onto the real config dir too", () => {
  // copyIfMissing/copyIfExists join these onto the user's actual config
  // directory as the SOURCE, so a traversing name reads outside it and writes
  // outside the destination in the same step.
  for (const bad of ["../auth.json", "a/b", "..", ".", "/etc/passwd", "sub/../auth.json"]) {
    assert.throws(
      () => assertSeedFileName(bad),
      /single filename|non-empty string/,
      `${bad} must be refused`
    );
  }
  for (const good of ["auth.json", "version.json", "config.toml", ".credentials"]) {
    assert.equal(assertSeedFileName(good), good, `${good} must be accepted`);
  }
});

test("the containment helper is what the isolation path actually calls", () => {
  // A boundary that exists but is not wired in is worse than none, because the
  // tests above would keep passing while the product wrote wherever it liked.
  const src = fs.readFileSync(path.join(REPO_ROOT, "src/adapters/env.mjs"), "utf-8");
  const isolationCall = src.indexOf("assertManagedSessionPath");
  const firstMkdir = src.indexOf("fs.mkdirSync");
  assert.ok(isolationCall !== -1, "env.mjs must call the containment assertion");
  assert.ok(
    isolationCall < firstMkdir,
    "and must call it BEFORE the first mkdirSync, not after the directory exists"
  );
  assert.match(src, /assertSeedFileName/, "seed names must be validated in the same place");
});

// --- containment holes found by adversarial review ---------------------------
//
// Both of these existed while this file already claimed the isolation path was
// contained. They are here because "I audited every write" turned out to mean
// "I audited every write I thought of".

test("a relocation cannot be smuggled through a settings map, and every declared one is contained", () => {
  // Three defects, one demonstration.
  //
  // 1. The overlay was built as `{ [isolation.env]: targetDir, ...extra }`, so
  //    an extraEnv key EQUAL to the isolation variable overwrote the value that
  //    had just been proven inside the session -- the containment result was
  //    discarded by the very next statement.
  // 2. Path detection was inferred from the rendered string, and a bare
  //    relative name like `pwned-config` has no separator and is not absolute,
  //    so it was classified a scalar and never checked. dualog then created it
  //    relative to its own cwd, i.e. inside the user's project.
  // 3. The fix for (2) exempted four literal scalars, which left `XDG_DATA_HOME`
  //    set to `1` or `true` uncontained -- a relative path the partner resolves
  //    against its own cwd. That residual was documented as unclosable without
  //    this split, and the `dirs-*` cases below are where it closes: a declared
  //    relocation is contained at EVERY value, with no exempt forms at all.
  //
  // Runs under a throwaway HOME because the boundary resolves the sessions root
  // from os.homedir() at call time.
  const { results } = inThrowawayHome(`
    const env = await import(${JSON.stringify(path.join(REPO_ROOT, "src/adapters/env.mjs"))});
    const base = {
      id: "probe",
      configIsolation: {
        env: "PROBE_HOME",
        dir: "{{sessionDir}}/probe-home",
        copyIfMissing: [],
        copyIfExists: [],
        dirs: {},
        extraEnv: {},
      },
    };
    const ctx = { sessionDir, home };
    const withIsolation = (patch) => ({
      ...base,
      configIsolation: { ...base.configIsolation, ...patch },
    });
    const withExtra = (extraEnv) => withIsolation({ extraEnv });
    const withDirs = (dirs) => withIsolation({ dirs });

    attempt("collision", () => env.prepareConfigIsolation(withExtra({ PROBE_HOME: "elsewhere" }), ctx));
    // Case-folded: environment names are case-insensitive on Windows, so this is
    // the SAME variable and would replace the value proven inside the lease. The
    // schema rejects it too, but a manifest also reaches the runtime through the
    // registry merge, so the boundary that actually holds is this one.
    attempt("collision-cased", () => env.prepareConfigIsolation(withExtra({ probe_home: "elsewhere" }), ctx));
    attempt("collision-cased-dirs", () => env.prepareConfigIsolation(withDirs({ Probe_Home: "x" }), ctx));
    attempt("collision-dirs", () => env.prepareConfigIsolation(withDirs({ PROBE_HOME: "elsewhere" }), ctx));

    // A location-named variable is refused by a settings map at ANY value.
    attempt("settings-path-name", () => env.prepareConfigIsolation(withExtra({ OTHER_DIR: "pwned-config" }), ctx));
    attempt("settings-xdg", () => env.prepareConfigIsolation(withExtra({ XDG_DATA_HOME: "1" }), ctx));
    attempt("settings-home-suffix", () => env.prepareConfigIsolation(withExtra({ PROBE_OTHER_HOME: "." }), ctx));

    // A declared relocation is contained at EVERY value -- no exempt forms.
    attempt("dirs-bare-relative", () => env.prepareConfigIsolation(withDirs({ OTHER_DIR: "pwned-config" }), ctx));
    attempt("dirs-dot", () => env.prepareConfigIsolation(withDirs({ OTHER_DIR: "." }), ctx));
    attempt("dirs-digits", () => env.prepareConfigIsolation(withDirs({ OTHER_DIR: "123" }), ctx));
    attempt("dirs-one", () => env.prepareConfigIsolation(withDirs({ OTHER_DIR: "1" }), ctx));
    attempt("dirs-true", () => env.prepareConfigIsolation(withDirs({ OTHER_DIR: "true" }), ctx));
    attempt("dirs-escape", () => env.prepareConfigIsolation(withDirs({ OTHER_DIR: "{{sessionDir}}/../escape" }), ctx));
    attempt("dirs-contained", () => env.prepareConfigIsolation(withDirs({ OTHER_DIR: "{{sessionDir}}/probe-data" }), ctx));

    attempt("scalar-still-works", () => env.prepareConfigIsolation(withExtra({ PROBE_SWITCH: "1" }), ctx));
    attempt("scalar-word", () => env.prepareConfigIsolation(withExtra({ PROBE_MODE: "auto" }), ctx));

    // The adapter-level maps, which had no containment check on ANY path before
    // the split: staticEnv is merged into the launch environment independently
    // of configIsolation.
    attempt("static-env-path-name", () => env.staticEnv({ id: "probe", env: { OTHER_DIR: "/etc" } }, ctx));
    attempt("static-dirs-escape", () => env.staticEnv({ id: "probe", env: {}, dirs: { OTHER_DIR: "/etc" } }, ctx));
    attempt("static-dirs-contained", () =>
      env.staticEnv({ id: "probe", env: {}, dirs: { OTHER_DIR: "{{sessionDir}}/probe-static" } }, ctx));
    attempt("static-env-scalar", () => env.staticEnv({ id: "probe", env: { PROBE_MODE: "auto" } }, ctx));
  `);
  const byLabel = Object.fromEntries(results.map((r) => [r.label, r]));
  const refused = (label, pattern) => {
    assert.equal(byLabel[label].ok, false, `${label} must be refused`);
    assert.match(byLabel[label].error, pattern, label);
  };

  refused("collision", /may not redefine PROBE_HOME/);
  refused("collision-cased", /may not redefine PROBE_HOME/);
  refused("collision-cased-dirs", /may not redefine PROBE_HOME/);
  refused("collision-dirs", /may not redefine PROBE_HOME/);

  for (const label of ["settings-path-name", "settings-xdg", "settings-home-suffix"]) {
    refused(label, /names a filesystem location/);
  }

  const contained = /not inside the session directory|must be a direct child/;
  for (const label of [
    "dirs-bare-relative",
    "dirs-dot",
    "dirs-digits",
    "dirs-one",
    "dirs-true",
    "dirs-escape",
  ]) {
    refused(label, contained);
  }

  // The counterweight: a legitimate relocation and real scalar switches must
  // still pass, or "contain everything" has quietly broken every adapter.
  assert.equal(byLabel["dirs-contained"].ok, true, byLabel["dirs-contained"].error);
  assert.match(byLabel["dirs-contained"].value.OTHER_DIR, /probe-data$/);
  assert.match(byLabel["dirs-contained"].value.PROBE_HOME, /probe-home$/);

  assert.equal(byLabel["scalar-still-works"].ok, true, "a scalar switch is not a path");
  assert.equal(byLabel["scalar-still-works"].value.PROBE_SWITCH, "1");
  assert.equal(byLabel["scalar-word"].ok, true, "goose's GOOSE_MODE=auto shape must survive");
  assert.equal(byLabel["scalar-word"].value.PROBE_MODE, "auto");

  refused("static-env-path-name", /names a filesystem location/);
  refused("static-dirs-escape", contained);
  assert.equal(byLabel["static-dirs-contained"].ok, true, byLabel["static-dirs-contained"].error);
  assert.match(byLabel["static-dirs-contained"].value.OTHER_DIR, /probe-static$/);
  assert.equal(byLabel["static-env-scalar"].ok, true, byLabel["static-env-scalar"].error);
  assert.equal(byLabel["static-env-scalar"].value.PROBE_MODE, "auto");
});

test("a turn writes nothing until its session directory has been proven managed", async () => {
  // The prompt is the FIRST write of a turn, and it happened ~60 lines before
  // anything reached the containment assert. So an unmanaged sessionDir was
  // refused -- correctly -- only after `turns/<id>/prompt.md`, containing the
  // full prompt text, had already been written into it.
  const { runPartnerCommand } = await import("../src/partner-invocation.mjs");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-not-a-session-"));

  try {
    await assert.rejects(
      () =>
        runPartnerCommand({
          partnerAgent: "codex",
          partnerCommand: "true",
          prompt: "SECRET-PROMPT-TEXT-THAT-MUST-NOT-BE-WRITTEN",
          projectPath: REPO_ROOT,
          sessionDir: outside,
          responseInstruction: "none",
          log: () => {},
        }),
      /refusing to use|must be a direct child/,
      "an unmanaged session directory must be refused"
    );

    assert.equal(
      fs.existsSync(path.join(outside, "turns")),
      false,
      "and refused BEFORE the turn directory is created"
    );
    assert.deepEqual(fs.readdirSync(outside), [], "nothing at all may be written there");
  } finally {
    fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a session directory that is itself a symlink is refused", () => {
  // assertNoSymlinkComponents() walks DOWNWARD from the session directory, so
  // the session directory itself was never inspected. A link planted there is
  // lexically a direct child of the managed root and carries a valid session
  // id, so it passed every check -- and mkdirSync then created the partner home
  // inside whatever it pointed at.
  const { results } = inThrowawayHome(`
    const victim = path.join(home, "victim-repo");
    fs.mkdirSync(victim, { recursive: true });
    const linked = path.join(home, ".dualog/sessions/dialog-1785600000077-000000ff");
    fs.symlinkSync(
      victim,
      linked,
      process.platform === "win32" ? "junction" : "dir"
    );
    attempt("linked-session", () =>
      m.assertManagedSessionPath(linked, path.join(linked, "codex-home")));
    attempt("victim-untouched", () => fs.readdirSync(victim));
  `);
  const byLabel = Object.fromEntries(results.map((r) => [r.label, r]));

  assert.equal(byLabel["linked-session"].ok, false, "a symlinked session dir must be refused");
  assert.match(byLabel["linked-session"].error, /session directory itself/);
  assert.deepEqual(byLabel["victim-untouched"].value, [], "and nothing may be created in its target");
});

test("a session path that is a plain file, not a directory, is refused", () => {
  const { results } = inThrowawayHome(`
    const asFile = path.join(home, ".dualog/sessions/dialog-1785600000078-000000fe");
    fs.writeFileSync(asFile, "not a directory");
    attempt("file-session", () =>
      m.assertManagedSessionPath(asFile, path.join(asFile, "codex-home")));
  `);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /not a directory/);
});
