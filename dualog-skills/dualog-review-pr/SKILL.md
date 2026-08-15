---
name: dualog-review-pr
description: Use when the user wants a multi-specialist PR review — the pr-review-toolkit panel — run by a partner agent, either against a GitHub pull request or against local branch/uncommitted changes.
---

# PR Review Panel

Use this skill when the user wants a partner agent to run a **multi-specialist**
review through the `dualog` MCP server.

This is not `dualog-review-code` with a different name. That skill runs one
general reviewer over the whole change in a single pass. This one runs several
narrow specialists — general code quality, test coverage, error handling,
comment accuracy, type design, and optionally simplification — each in its own
partner turn with only its own rubric loaded, then consolidates them into one
prioritized report. It surfaces a different class of problem for that reason: no
single pass is trying to hold six concerns at once.

Reach for `dualog-review-code` when the user wants a fast general read, and this
skill when they want thoroughness or say "PR review".

## Parse the user's invocation

- `pr:<number|url>`: review an actual pull request via `gh`. This reviews what is
  on the PR, not what is in the working tree, and needs an authenticated `gh`.
- `diff_target`: used only when no `pr` is given. `branch` (default),
  `uncommitted`, `staged`, or `commit:<sha>`. The default is `branch` because a
  PR review is branch-shaped; for work that is not committed yet, pass
  `uncommitted` explicitly.
- `aspects:a,b,c`: pin the panel. Valid: `code`, `tests`, `errors`, `comments`,
  `types`, `simplify`. Omit to let the server select from the diff.
- `rounds:N`: soft budget for the conversation AFTER the panel reports.
- `effort:<level>`, `model:<name>`: partner overrides.
- `timeout:<minutes>`: per-pass wait hint.
- Remaining free text: `review_focus`.

`simplify` is opt-in and never auto-selected. It proposes rewrites rather than
reporting defects, so running it by default would fold refactor suggestions into
a correctness review. Pass it explicitly, ideally only after the review passes.

Model and effort rules: do not assert from memory which models exist or which
efforts they accept. Which efforts are valid depends on the specific MODEL, not
the agent, and the table changes whenever a vendor ships. Call
`mcp__dualog__list_models` if you need to check. Pass the user's values through
as given and surface any server error verbatim rather than pre-judging the pair.

If `effort:max` is given with no `timeout:*`, set `partner_timeout_ms:
1800000`. Note this hint is **per pass**, and a panel runs several passes back to
back, so total wall-clock is roughly the hint times the number of aspects.

## Start the panel

Determine the git root first and use it as `project_path`.

Call `mcp__dualog__start_pr_review` with:

- `project_path`
- `pr` **or** `diff_target` (+ `branch` / `base_branch` for branch mode)
- `aspects` only if the user pinned them
- `review_focus`
- `host_agent: "codex"`, `partner_agent: "claude"`
- `follow_up_rounds` only if the user provided `rounds:N`
- `reasoning_effort` / `model` only if the user provided valid ones
- `partner_timeout_ms` if `timeout:*` or `effort:max` applies

Prepend this framing to `review_focus`:

```text
ADVERSARIAL REVIEW MODE: Your default assumption is that something is wrong, missing, or subtly broken in this code. You are not looking to confirm it works — you are looking to find what does not. Only accept something as correct once you have actively tried to break it and failed. Check edge cases, error paths, concurrency, resource cleanup, and implicit assumptions. If you cannot find a flaw, explain what you checked and why you believe it holds — do not simply say it looks fine.

FEEDBACK FRAMING: Present findings as direct technical observations and open questions, not urgent demands. If you genuinely find nothing wrong after thorough investigation, say so clearly.
```

Save the returned `session_id`.

**Read the response, do not just store it.**

- `aspects` — which specialists will run, one partner turn each
- `skipped_aspects` — which will NOT run, and why
- `total_passes` — specialists plus one consolidation pass
- `max_rounds` includes the panel, because every pass appends a partner message;
  `follow_up_rounds` is the conversation budget after the panel

Report the skipped list to the user. An aspect nobody ran is not an aspect that
came back clean, and that distinction is invisible in the final report unless you
carry it forward.

**Verify what the server actually used.** The response echoes `requested_model` /
`requested_reasoning_effort` (what you passed) alongside `model` /
`reasoning_effort` (what resolved). If something you specified comes back `null`
in a *requested* field, that parameter never arrived — end the session and retry.
A difference between requested and resolved is normal and usually correct: an
adapter may translate an effort it names differently, and an omitted effort
resolves to the model's own default. Those appear in `notices` as
`effort_alias_applied` or `default_effort_applied`. Read
`effective_reasoning_effort` to know what the turn will really run at.

If `pr.state` is not `OPEN`, or `pr.is_draft` is true, tell the user before
proceeding.

## Wait out the panel

Each pass appends its report as it lands, so **the first partner message is not
the finished review**. Expect `total_passes` partner messages before the
conversation phase.

1. Call `mcp__dualog__wait_for_partner_response` with `since_id` set to the last
   id you have seen, and repeat until the panel is complete. Do not stop at the
   first wake.
2. Call `mcp__dualog__get_pr_review_report` to see where the panel stands. Use
   this rather than `check_messages`: it is the only view that separates
   `aspects_reported`, `aspects_pending`, and `aspects_failed`.
3. The panel is finished when `panel_complete` is true and
   `consolidated_report` is populated.

A pass in `aspects_failed` means that aspect was **not reviewed**. Say so; do not
let it read as clean.

If a wait returns `timeout_processing` or `timeout_idle`, call
`mcp__dualog__check_partner_alive` and inspect `partner_terminal.activity` and
`capture.tail_text`. If the runner died or `last_error` is populated, stop and
report it honestly. If the pane is blocked on an interactive prompt, use
`mcp__dualog__send_key` only when the visible choice is already authorized by the
user's request and does not broaden or persist permissions; verify it advanced
afterwards. Ask the user when the choice is ambiguous or consequential.

## Discussion loop

Work the consolidated report in its own order: Critical, then Important, then
Suggestions.

For each finding:

1. Read the actual code at the cited location.
2. Decide valid, partially valid, or invalid.
3. If valid, fix it in code before replying.
4. If invalid, push back with file-level evidence.
5. Send one consolidated reply per round with `mcp__dualog__send_message`.

Where two specialists disagree — a simplification proposed for code another pass
called correct — treat that as signal about genuinely unclear code and raise it
rather than silently picking a side.

If the same disagreement persists across two or more rounds, summarize both
positions and ask the user to arbitrate.

## Completion

When `review_status.approved` is true, or the hard cap is reached:

1. Call `mcp__dualog__get_pr_review_report`
2. Report the verdict, the aspects that ran, **the aspects that did not run and
   why**, the findings by severity, and the session id
3. Call `mcp__dualog__end_dialog`

Do not claim approval unless `review_status.approved` is true. Do not describe
the review as comprehensive if any aspect was skipped or failed — name what was
left uncovered.
