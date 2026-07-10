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
export const ALL_REASONING_EFFORTS = [
  ...new Set([...CODEX_REASONING_EFFORTS, ...CLAUDE_REASONING_EFFORTS]),
];

export function normalizeReasoningEffortForAgent(reasoningEffort, partnerAgent) {
  const value = reasoningEffort || DEFAULT_REASONING_EFFORT;
  const allowed =
    partnerAgent === "claude"
      ? CLAUDE_REASONING_EFFORTS
      : CODEX_REASONING_EFFORTS;

  if (!allowed.includes(value)) {
    throw new Error(
      `${partnerAgent || "Partner"} reasoning_effort must be one of: ${allowed.join(", ")}`
    );
  }

  return value;
}
