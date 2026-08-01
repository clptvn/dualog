export const DEFAULT_REASONING_EFFORT = "high";

/**
 * How much of a review diff is embedded in the partner's prompt.
 *
 * The partner is told to read the changed files from the project directory for
 * anything past this, so a large diff is not lost -- but the host has to be told
 * that the embedded copy is partial, which is why this lives here rather than
 * privately in review-runner.mjs. A host that believes the partner saw the whole
 * diff will misread a review that only covered the head of it.
 */
export const MAX_REVIEW_DIFF_CHARS = 50000;

// Retained only for the legacy hand-written buildInvocation() that the golden
// argv snapshots compare against. NOT a validation source: which efforts a given
// MODEL accepts is a per-model fact the adapter manifests carry, and treating
// these two lists as the answer is what rejected Goose's `off` and Grok's
// `minimal` while letting Claude's `xhigh` through for models that refuse it.
export const CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
export const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const ALL_REASONING_EFFORTS = [
  ...new Set([...CODEX_REASONING_EFFORTS, ...CLAUDE_REASONING_EFFORTS]),
];

/**
 * Pass a caller's effort through untouched, preserving an omission AS an
 * omission.
 *
 * This deliberately does not substitute a default. Defaulting here happens
 * before the model is known, which converts "the caller said nothing" into "the
 * caller demanded high" -- and an invented demand can be rejected. claude-haiku-4-5
 * declares `efforts: []`, so pre-defaulting made it impossible to start: the
 * invented `high` was refused and no explicit value would have worked either.
 *
 * resolveContext() applies the operator default instead, after resolving the
 * model, and only when that model accepts it. An omission that cannot be
 * defaulted simply sends no flag, which is what makes the CLI apply the model's
 * own default -- reported back as `defaultEffort`.
 */
export function requestedReasoningEffortForAdapter(reasoningEffort) {
  return reasoningEffort || null;
}
