---
name: dualog-review-code
description: Use when the user wants Claude Code to review code changes from within Codex, including uncommitted, staged, branch, or commit-based diffs.
---

# Claude Review Code

Use this skill when the user wants Claude Code to review code changes through the `dualog` MCP server.

## Parse the user's invocation

Interpret the user's invocation text as:

- `diff_target`: `uncommitted` (default), `staged`, `branch`, or `commit:<sha>`
- `review_focus`: any remaining free text after stripping control tokens
- `rounds:N`: optional soft round budget override
- `effort:<level>`: optional partner effort override
- `model:<name>`: optional partner model override
- `timeout:<minutes>` or `timeout:<minutes>m`: optional wait hint for long partner turns, in minutes.

If no diff target is provided, use `uncommitted`.

Model and effort rules:

Do not assert from memory which models exist or which effort levels they accept. Which efforts are valid depends on the specific MODEL, not on the agent — one model accepts `max` but not `xhigh` while its sibling accepts both — and that table changes whenever a vendor ships. If the user names a model and you need to check it, call `mcp__dualog__list_models` for the partner agent first and use what it returns; it also reports whether that list is a live catalog or a hand-maintained fallback.

Pass the user's model and effort through as given. The server validates the pair and returns an error naming the model, exactly what it accepts, and where that came from. Surface that error verbatim rather than pre-judging the combination yourself.

If `effort:max` is provided and no `timeout:*` override is provided, set `partner_timeout_ms: 1800000` so wait calls use a 30 minute hint instead of the default 15.
If `timeout:*` is provided, convert minutes to milliseconds and pass `partner_timeout_ms`. This is a wait hint only; the server does not kill interactive tmux partner turns when a wait expires.

## Start the review

Determine the git root first. Use that as `project_path`.

Call `mcp__dualog__start_code_review` with:

- `project_path`
- `diff_target`
- `review_focus`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `max_rounds` only if the user explicitly provided `rounds:N`
- `reasoning_effort` only if the user explicitly provided a valid `effort:<level>` for the selected model; otherwise omit it so the model's own default is used (the server falls back to `high` only for models that declare no default of their own)
- `model` only if the user explicitly provided a valid `model:<name>`
- `partner_timeout_ms` if the user explicitly provided `timeout:*`, or if `effort:max` was provided and no timeout override was provided

Always prepend this adversarial framing to `review_focus`:

```text
ADVERSARIAL REVIEW MODE: Your default assumption is that something is wrong, missing, or subtly broken in this code. You are not looking to confirm it works — you are looking to find what does not. Only accept something as correct once you have actively tried to break it and failed. For every function, ask: "What input would make this fail? What state would make this behave unexpectedly? What was the author probably not thinking about?" Check edge cases, error paths, concurrency, resource cleanup, and implicit assumptions. If you cannot find a flaw, explain what you checked and why you believe it holds — do not simply say it looks fine.

FEEDBACK FRAMING: Present findings as direct technical observations and open questions, not urgent demands. If you genuinely find nothing wrong after thorough investigation, say so clearly.
```

Save the returned `session_id`.

**Verify what the server actually used.** The start response echoes `requested_model` / `requested_reasoning_effort` (what you passed) alongside `model` / `reasoning_effort` (what resolved). Compare the **requested** fields against your own call: if something you specified comes back as `null` there, that parameter never arrived and the session is running on settings you did not choose. End it and retry.

Do **not** treat a difference between requested and resolved as a failure. That difference is normal and usually correct -- an adapter may translate an effort it names differently (goose maps a requested `xhigh` onto its own `max`), and omitting an effort deliberately resolves to the model's own default. Those cases are reported in the response's `notices` array as `effort_alias_applied` or `default_effort_applied`, and are working as intended.

Read the three effort fields as three different questions. `requested_reasoning_effort` is what you asked for -- use it to check transport. `reasoning_effort` is the flag actually passed to the CLI, which is `null` when we deliberately pass none. **`effective_reasoning_effort` is what the turn will really run at**, including the model's own default when no flag is sent. For `gpt-5.6-sol` with effort omitted the response is `requested_reasoning_effort: null`, `reasoning_effort: null`, `effective_reasoning_effort: "low"` -- so read `effective_reasoning_effort`, not `reasoning_effort`, to know the runtime behavior.

Ending is possible at this point specifically because the partner has not spoken yet: a session with no partner turns has no findings to abandon, so `end_dialog` is permitted. Once the partner has replied, the usual approval/round-budget gating applies.

The server cannot catch a dropped parameter for you. A parameter the caller deliberately omitted and one lost in transit are identical on the wire, so the echoed values are the only place the difference is visible.

## Wait for Claude's review

Claude generates the initial review automatically.

Preferred wait strategy:

1. Call `mcp__dualog__wait_for_partner_response` with `session_id` and `since_id: 0`. If `partner_timeout_ms` was set, pass `timeout_ms: partner_timeout_ms - 60000`.
2. If the wait tool is not exposed in the current session, fall back to tailing the session's `conversation.jsonl` until a partner message lands.
3. If neither wait tool nor shell tail is available, poll `mcp__dualog__check_messages` every 5 seconds.

After every later `send_message`, call `mcp__dualog__wait_for_partner_response` with `since_id` set to the returned `message_id`. If `partner_timeout_ms` was set, pass `timeout_ms: partner_timeout_ms - 60000`.

If `wait_result` is `timeout_processing` or `timeout_idle`:

1. Call `mcp__dualog__check_partner_alive`
2. Inspect `partner_terminal.activity` and `partner_terminal.capture.tail_text` to see Claude's compact live tmux status
3. If the runner died or `last_error` is populated, stop and report the error honestly
4. If the runner and tmux session are alive and the pane shows useful progress, continue waiting
5. If the pane shows an idle prompt, repeated unchanged output, a stuck prompt, or malformed sidecar state, end the session or ask the user before restarting

## Discussion loop

For each Claude finding:

1. Read the actual code Claude referenced.
2. Decide whether the finding is valid, partially valid, or invalid.
3. If valid, fix the issue in code before replying.
4. If invalid, push back with file-level evidence.
5. Send one consolidated reply with `mcp__dualog__send_message`.

Keep the discussion efficient:

- Bundle all fixes, disagreements, and answers into one message per round.
- If Claude appears to be drip-feeding findings, explicitly ask for the full remaining set in the next message.
- If the same disagreement persists across 2+ rounds, summarize both positions and ask the user to arbitrate.

## Completion

When `review_status.approved` is true in `check_messages` / `get_review_summary`, or the hard cap is reached:

1. Call `mcp__dualog__get_review_summary`
2. Report the verdict from `review_status`, rounds used, and session id
3. Call `mcp__dualog__end_dialog`

Do not claim approval unless the MCP `review_status.approved` field is true.
