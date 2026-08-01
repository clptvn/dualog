// The sidecar completion protocol, shared by both engines.
//
// The partner is asked to write its final message to result.md and then a
// done.json describing the outcome. That indirection exists because terminal
// output is not a reliable channel: it is wrapped, truncated, interleaved with
// tool chatter, and in most CLIs impossible to delimit.
//
// In headless mode a terminal stream event can be more reliable than the
// sidecar -- but done.json keeps earning its place even there, because it is
// proof the partner actually had working write access. Several CLIs silently
// deny write tools unless an auto-approve flag is passed, and the failure looks
// identical to success right up until nothing appears.

import fs from "fs";
import path from "path";

/** Marks the point in the bootstrap where the protocol begins. */
export const SUBMISSION_MARKER = "Completion protocol is mandatory:";

/**
 * Size ceilings for the two partner-written sidecars.
 *
 * These files are the primary completion channel and their contents are chosen
 * by the partner, so their size is untrusted input. Bounding the headless output
 * streams was not enough on its own: a malformed or malicious partner can reach
 * the same exhaustion through result.md, which is read in one allocation and
 * then appended to a conversation log that is re-read in full on every poll.
 *
 * done.json is a fixed handful of fields; a megabyte is already absurd for it.
 * A result is prose -- 2 MiB is far past any real final message while still
 * leaving room for a partner that inlines a large diff.
 *
 * The result limit deliberately matches MAX_MESSAGE_BYTES: every accepted result
 * becomes a conversation entry, so a looser ceiling here would simply move the
 * unbounded growth one step downstream into a log that is re-read on every poll.
 */
export const MAX_DONE_BYTES = 1024 * 1024;
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

export function buildBootstrapPrompt({
  promptPath,
  resultPath,
  donePath,
  projectPath,
  responseInstruction,
}) {
  return `Read the prompt file at:
${promptPath}

Follow the prompt exactly for the project at:
${projectPath}

${responseInstruction || "Produce the requested response."}

${SUBMISSION_MARKER}
1. Do all investigation or implementation work requested by the prompt.
2. Write ONLY the final message that should be sent back to the host agent to:
${resultPath}
3. Then write this JSON object to:
${donePath}

{"status":"ok","result_path":"${jsonEscape(resultPath)}","summary":"completed","error":null}

If you cannot complete the work, still write a useful final message to the result file, then write done.json with "status":"error" and a concise non-empty "error" string.

Use shell/Bash commands for these sidecar writes if file-write tools are unavailable in this session.

Do not stop after printing to the terminal. The host will not receive your response until both sidecar files exist.

Before you finish, confirm you have done both writes, in this order:
1. ${resultPath}
2. ${donePath}
Write the result file first. If only one write succeeds, the result is the one worth having.`;
}

/**
 * Read a completed turn, if it is complete.
 *
 * Returns null while the turn is still in flight, including for transient
 * filesystem errors: a partially-written sidecar is normal and must not be
 * mistaken for a failure.
 */
export function readCompletion({ turnDir, resultPath, donePath }) {
  let doneStat;
  try {
    doneStat = fs.statSync(donePath);
  } catch (err) {
    if (isTransientFsError(err)) return null;
    throw err;
  }

  // Both sidecars are written by the PARTNER, which makes their size an input
  // this process does not control. done.json is a fixed handful of fields, so
  // anything past this is not one -- and because the completion loop re-reads it
  // on every poll, an unbounded file is re-parsed at its full size several times
  // a second for the life of the turn.
  if (doneStat.size > MAX_DONE_BYTES) {
    throw new Error(
      `Completion sidecar ${donePath} is ${doneStat.size} bytes, past the ${MAX_DONE_BYTES}-byte limit; refusing to parse it`
    );
  }

  let done;
  try {
    done = JSON.parse(fs.readFileSync(donePath, "utf-8"));
  } catch {
    return null; // Caught mid-write; try again on the next poll.
  }

  const status = done?.status === "error" ? "error" : "ok";
  const selectedResultPath =
    typeof done?.result_path === "string" && done.result_path.trim()
      ? done.result_path
      : resultPath;
  const resolvedResultPath = assertPathInside(turnDir, selectedResultPath);

  let resultExists = false;
  let resultSize = 0;
  try {
    const resultStat = fs.statSync(resolvedResultPath);
    resultExists = resultStat.isFile();
    resultSize = resultStat.size;
  } catch (err) {
    if (!isTransientFsError(err)) throw err;
  }

  // The result is read in one allocation and then appended to conversation.jsonl,
  // which readConversation() re-reads in full on every poll. An unbounded result
  // therefore costs memory twice over and keeps costing it for the rest of the
  // session, so the limit is enforced before the read rather than after.
  if (resultExists && resultSize > MAX_RESULT_BYTES) {
    throw new Error(
      `Partner result ${resolvedResultPath} is ${resultSize} bytes, past the ${MAX_RESULT_BYTES}-byte limit. ` +
        `A turn's final message is prose; something has gone wrong upstream of this file.`
    );
  }
  if (!resultExists) {
    if (status === "error") {
      return {
        status,
        result: "",
        error:
          typeof done?.error === "string"
            ? done.error
            : "Partner reported an error before writing a result file",
      };
    }
    return null;
  }

  let result;
  try {
    result = fs.readFileSync(assertRealPathInside(turnDir, resolvedResultPath), "utf-8");
  } catch (err) {
    if (isTransientFsError(err)) return null;
    throw err;
  }

  return {
    status,
    result,
    error: typeof done?.error === "string" ? done.error : null,
  };
}

/**
 * The partner names its own result path in done.json, so it must be confined to
 * the turn directory. Checked twice: once on the declared path, and once on the
 * resolved real path, so a symlink cannot escape.
 */
export function assertPathInside(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(root, targetPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Completion result path is outside the turn directory: ${targetPath}`);
  }
  return resolved;
}

export function assertRealPathInside(rootDir, targetPath) {
  const root = fs.realpathSync(rootDir);
  const resolved = fs.realpathSync(targetPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Completion result path resolves outside the turn directory: ${targetPath}`
    );
  }
  return resolved;
}

export function isTransientFsError(err) {
  return ["ENOENT", "ENOTDIR", "EAGAIN", "EBUSY"].includes(err?.code);
}

function jsonEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
