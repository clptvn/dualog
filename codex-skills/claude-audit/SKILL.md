---
name: claude-audit
description: Use when the user wants Claude Code to perform a comprehensive audit of files or directories from within Codex.
---

# Claude Audit

Use this skill when the user wants Claude Code to audit existing code through the `codex-dialog` MCP server.

## Parse the user's invocation

Interpret the invocation text as:

- one or more file paths, directory paths, or globs
- optional free-text focus area
- `rounds:N`
- `effort:<level>`
- `model:<name>`: optional Claude model override. Accepted examples include `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-8[1m]`, `claude-opus-4-7[1m]`, `claude-opus-4-6[1m]`, and `claude-sonnet-4-6`. Claude Fable 5 has 1M context by default; do not add a `[1m]` suffix.
- `timeout:<minutes>` or `timeout:<minutes>m`: optional wait hint for long partner turns, in minutes

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

Call `mcp__codex-dialog__start_dialog` with:

- `project_path`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `max_rounds` only if explicitly requested
- `reasoning_effort` only if explicitly requested; otherwise omit it so the server default of `high` is used
- `model` only if explicitly requested
- `partner_timeout_ms` if `timeout:*` was explicitly requested, or `1800000` if `effort:max` was explicitly requested without a timeout override
- `problem_description`: a short summary such as `Comprehensive code audit of <targets>. Claude Code will audit for bugs, architecture issues, robustness, and security.`

Save the returned `session_id`.

## Kick off the audit

Send the first message with `mcp__codex-dialog__send_message`. Use this structure:

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

1. Call `mcp__codex-dialog__wait_for_partner_response` with `session_id` and `since_id` set to the latest message you sent. If `partner_timeout_ms` was set, pass `timeout_ms: partner_timeout_ms - 60000`.
2. If the wait tool is not exposed in the current session, fall back to waiting on the session file with a shell tail.
3. If neither wait tool nor shell tail is available, poll `mcp__codex-dialog__check_messages` every 5 seconds.

If `wait_result` is `timeout_processing` or `timeout_idle`:

1. Call `mcp__codex-dialog__check_partner_alive`
2. Inspect `partner_terminal.activity` and `partner_terminal.capture.tail_text` to see Claude's compact live tmux status
3. If the runner died or `last_error` is populated, stop and report it honestly
4. If the runner and tmux session are alive and the pane shows useful progress, continue waiting
5. If the pane shows an idle prompt, repeated unchanged output, a stuck prompt, or malformed sidecar state, end the session or ask the user before restarting

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
2. Call `mcp__codex-dialog__end_dialog`

Do not claim Claude approved the code unless that is what the conversation actually established.
