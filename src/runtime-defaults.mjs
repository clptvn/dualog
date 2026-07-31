export const DEFAULT_REASONING_EFFORT = "high";

export const CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
export const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Grok Build --reasoning-effort values (mirrors common CLI efforts). */
export const GROK_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const ALL_REASONING_EFFORTS = [
  ...new Set([
    ...CODEX_REASONING_EFFORTS,
    ...CLAUDE_REASONING_EFFORTS,
    ...GROK_REASONING_EFFORTS,
  ]),
];

export function normalizeReasoningEffortForAgent(reasoningEffort, partnerAgent) {
  const value = reasoningEffort || DEFAULT_REASONING_EFFORT;
  let allowed = CODEX_REASONING_EFFORTS;
  if (partnerAgent === "claude") allowed = CLAUDE_REASONING_EFFORTS;
  else if (partnerAgent === "grok") allowed = GROK_REASONING_EFFORTS;

  if (!allowed.includes(value)) {
    throw new Error(
      `${partnerAgent || "Partner"} reasoning_effort must be one of: ${allowed.join(", ")}`
    );
  }

  return value;
}
