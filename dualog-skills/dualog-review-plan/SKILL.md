---
name: dualog-review-plan
description: Use when the user wants Claude Code to adversarially review an implementation plan from within Codex.
---

# Claude Review Plan

Use this skill when the user wants Claude Code to review an implementation plan through the `dualog` MCP server.

## Parse the user's invocation

Interpret the invocation text as:

- one optional plan path
- `rounds:N`
- `effort:<level>`
- `model:<name>`: optional partner model override
- `timeout:<minutes>` or `timeout:<minutes>m`: optional wait hint for long partner turns, in minutes

Do not assert from memory which models exist or which effort levels they accept. Which efforts are valid depends on the specific MODEL, not on the agent — one model accepts `max` but not `xhigh` while its sibling accepts both — and that table changes whenever a vendor ships. If the user names a model and you need to check it, call `mcp__dualog__list_models` for the partner agent first and use what it returns; it also reports whether that list is a live catalog or a hand-maintained fallback.

Pass the user's model and effort through as given. The server validates the pair and returns an error naming the model, exactly what it accepts, and where that came from. Surface that error verbatim rather than pre-judging the combination yourself.

If a plan path is not provided, auto-detect from:

- `.codex-reviews/*/plan-v*.md`
- `plan*.md`
- `PLAN.md`
- `.claude/plan*.md`

If multiple candidates exist, ask the user which one to review.
If none exist, ask the user for the path.

Verify the plan file exists, is readable, and is non-empty before starting the dialog.

## Start the dialog

Determine the git root and call `mcp__dualog__start_dialog` with:

- `project_path`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `max_rounds` only if explicitly requested
- `reasoning_effort` only if explicitly requested; otherwise omit it so the server default of `high` is used
- `model` only if explicitly requested
- `partner_timeout_ms` if `timeout:*` was explicitly requested, or `1800000` if `effort:max` was explicitly requested without a timeout override
- `subject_path`: the resolved plan file path
- `subject_kind`: `"plan"`
- `problem_description`: a short summary such as `Implementation plan review for <path>. Claude Code will adversarially review feasibility, ordering, and completeness.`

Save the returned `session_id`.

## Kick off the review

Send the first message with `mcp__dualog__send_message`. Use this structure:

```text
## Plan Review Request

ADVERSARIAL REVIEW MODE: Your default assumption is that this plan has gaps, incorrect assumptions, or hidden dependencies. You are not here to confirm the plan is good — you are here to find what is wrong with it. Read the actual codebase to verify claims. Do not trust the plan's description of current behavior without checking.

Deliver complete feedback in each round. Do not hold findings back for later rounds.

Review dimensions:
- Feasibility
- Completeness
- Correctness
- Risk
- Alternatives
- Ordering

Categorize findings as:
- [CRITICAL]
- [SUGGESTION]
- [QUESTION]
- [PRAISE]
- [NIT]

At the end, set one machine-readable verdict on its own line:
- `REVIEW_VERDICT: APPROVE`
- `REVIEW_VERDICT: NEEDS_DISCUSSION`
- `REVIEW_VERDICT: CHANGES_REQUESTED`

The server will include a `Current Plan Snapshot` section by rereading the plan file from `subject_path` before every Claude turn. Treat that snapshot as the authoritative current plan.
```

## Wait for Claude

Preferred wait strategy:

1. Call `mcp__dualog__wait_for_partner_response` with `session_id` and `since_id` set to the latest message you sent. If `partner_timeout_ms` was set, pass `timeout_ms: partner_timeout_ms - 60000`.
2. If the wait tool is not exposed in the current session, fall back to waiting on the session file with a shell tail.
3. If neither wait tool nor shell tail is available, poll `mcp__dualog__check_messages` every 5 seconds.

If `wait_result` is `timeout_processing` or `timeout_idle`:

1. Call `mcp__dualog__check_partner_alive`
2. Inspect `partner_terminal.activity` and `partner_terminal.capture.tail_text` to see Claude's compact live tmux status
3. If the runner died or `last_error` is populated, report that and stop
4. If the runner and tmux session are alive and the pane shows useful progress, continue waiting
5. If the pane shows an idle prompt, repeated unchanged output, a stuck prompt, or malformed sidecar state, end the session or ask the user before restarting

## Discussion loop

For each Claude finding:

1. Read the relevant code and the relevant part of the plan.
2. Decide whether you agree, partially agree, or disagree.
3. If the finding is valid, edit the plan file and explain what changed.
4. If invalid, rebut it with concrete evidence from the codebase or the plan text.
5. Send one consolidated response per round.

If Claude hints at drip-feeding, explicitly ask for all remaining concerns in the next reply.

If the same disagreement persists across 2+ rounds, summarize both positions and ask the user to decide.

## Completion

When `review_status.approved` is true in `check_messages`, or the hard cap is reached:

1. Summarize the outcome, path, rounds used, and session id
2. Call `mcp__dualog__end_dialog`

Do not call it approved unless the MCP `review_status.approved` field is true.
