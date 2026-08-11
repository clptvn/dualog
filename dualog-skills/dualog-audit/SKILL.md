---
name: dualog-audit
description: Use when the user wants Claude Code to perform a comprehensive audit of files or directories from within Codex.
---

# Claude Audit

Use this skill when the user wants Claude Code to audit existing code through the `dualog` MCP server.

## Parse the user's invocation

Interpret the invocation text as:

- one or more file paths, directory paths, or globs
- optional free-text focus area
- `rounds:N`
- `effort:<level>`
- `model:<name>`: optional partner model override
- `timeout:<minutes>` or `timeout:<minutes>m`: optional wait hint for long partner turns, in minutes

Do not assert from memory which models exist or which effort levels they accept. Which efforts are valid depends on the specific MODEL, not on the agent — one model accepts `max` but not `xhigh` while its sibling accepts both — and that table changes whenever a vendor ships. If the user names a model and you need to check it, call `mcp__dualog__list_models` for the partner agent first and use what it returns; it also reports whether that list is a live catalog or a hand-maintained fallback.

Pass the user's model and effort through as given. The server validates the pair and returns an error naming the model, exactly what it accepts, and where that came from. Surface that error verbatim rather than pre-judging the combination yourself.

If no targets are provided, ask the user what files to audit.

## Gather the audit corpus

Determine the git root first.

Read the target files. For directories or globs, collect relevant source files and skip obvious noise:

- `node_modules/`
- `dist/`
- `build/`
- `.git/`
- lockfiles
- binaries

If the total content gets too large, prioritize:

1. Explicitly named files
2. Entry points and core logic
3. Files most likely to contain risk

Keep track of anything skipped and tell Claude what was omitted.

## Start the dialog

Call `mcp__dualog__start_dialog` with:

- `project_path`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `max_rounds` only if explicitly requested
- `reasoning_effort` only if explicitly requested; otherwise omit it so the model's own default is used (the server falls back to `high` only for models that declare no default of their own)
- `model` only if explicitly requested
- `partner_timeout_ms` if `timeout:*` was explicitly requested, or `1800000` if `effort:max` was explicitly requested without a timeout override
- `problem_description`: a short summary such as `Comprehensive code audit of <targets>. Claude Code will audit for bugs, architecture issues, robustness, and security.`

Save the returned `session_id`.

**Verify what the server actually used.** The start response echoes `requested_model` / `requested_reasoning_effort` (what you passed) alongside `model` / `reasoning_effort` (what resolved). Compare the **requested** fields against your own call: if something you specified comes back as `null` there, that parameter never arrived and the session is running on settings you did not choose. End it and retry.

Do **not** treat a difference between requested and resolved as a failure. That difference is normal and usually correct -- an adapter may translate an effort it names differently (goose maps a requested `xhigh` onto its own `max`), and omitting an effort deliberately resolves to the model's own default. Those cases are reported in the response's `notices` array as `effort_alias_applied` or `default_effort_applied`, and are working as intended.

Read the three effort fields as three different questions. `requested_reasoning_effort` is what you asked for -- use it to check transport. `reasoning_effort` is the flag actually passed to the CLI, which is `null` when we deliberately pass none. **`effective_reasoning_effort` is what the turn will really run at**, including the model's own default when no flag is sent. For `gpt-5.6-sol` with effort omitted the response is `requested_reasoning_effort: null`, `reasoning_effort: null`, `effective_reasoning_effort: "low"` -- so read `effective_reasoning_effort`, not `reasoning_effort`, to know the runtime behavior.

Ending is possible at this point specifically because the partner has not spoken yet: a session with no partner turns has no findings to abandon, so `end_dialog` is permitted. Once the partner has replied, the usual approval/round-budget gating applies.

The server cannot catch a dropped parameter for you. A parameter the caller deliberately omitted and one lost in transit are identical on the wire, so the echoed values are the only place the difference is visible.

## Kick off the audit

Send the first message with `mcp__dualog__send_message`. Use this structure:

```text
## Code Audit Request

ADVERSARIAL AUDIT MODE: Your default assumption is that there are bugs, design flaws, or subtle correctness issues hiding in this code. You are not here to confirm it works — you are here to find what does not, what could break, and what was missed.

Read any additional project files you need for context. Deliver complete findings in each round. Do not hold findings back for later rounds.

Audit dimensions:
- Correctness and logic
- Architecture and design
- Robustness and error handling
- Security
- Fragility and methodology

Categorize findings as:
- [CRITICAL]
- [ARCHITECTURE]
- [CORRECTNESS]
- [ROBUSTNESS]
- [SECURITY]
- [SUGGESTION]
- [QUESTION]
- [PRAISE]
- [NIT]

[OPTIONAL USER FOCUS AREA]

### Files to Audit
[FILE CONTENTS OR SUMMARIES]

[SKIPPED FILES]
```

## Wait for Claude

Preferred wait strategy:

1. Call `mcp__dualog__wait_for_partner_response` with `session_id` and `since_id` set to the latest message you sent. If `partner_timeout_ms` was set, pass `timeout_ms: partner_timeout_ms - 60000`.
2. If the wait tool is not exposed in the current session, fall back to waiting on the session file with a shell tail.
3. If neither wait tool nor shell tail is available, poll `mcp__dualog__check_messages` every 5 seconds.

If `wait_result` is `timeout_processing` or `timeout_idle`:

1. Call `mcp__dualog__check_partner_alive`
2. Inspect `partner_terminal.activity` and `partner_terminal.capture.tail_text` to see Claude's compact live tmux status
3. If the runner died or `last_error` is populated, stop and report it honestly
4. If the runner and tmux session are alive and the pane shows useful progress, continue waiting
5. If the pane shows a blocked interactive prompt, use `mcp__dualog__send_key` only when the exact visible choice is already authorized by the user's request and does not broaden permissions; set `submit: true` for a numbered choice, then call `check_partner_alive` again to verify it advanced
6. If the answer is ambiguous, consequential, or would persist permission beyond this session, ask the user. For repeated unchanged output, an unexplained idle prompt, or malformed sidecar state, end the session or ask before restarting

## Discussion loop

For each Claude finding:

1. Read the actual code in context.
2. Decide whether it is valid, partially valid, or invalid.
3. Fix valid issues before replying.
4. Rebut invalid issues with code evidence.
5. Send one consolidated response per round.

If Claude drip-feeds, explicitly request the full remaining set of findings.

If the same disagreement persists across 2+ rounds, summarize both positions and ask the user to decide.

## Completion

When Claude indicates the audit is complete, or the hard cap is reached:

1. Summarize the audit outcome, files covered, rounds used, and session id
2. Call `mcp__dualog__end_dialog`

Do not claim Claude approved the code unless that is what the conversation actually established.
