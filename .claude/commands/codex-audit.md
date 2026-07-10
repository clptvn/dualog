---
description: Have Codex audit files or directories for bugs, architecture issues, and correctness
argument-hint: <file or directory paths> [optional: focus area] [optional: rounds:N] [optional: effort:low|medium|high|xhigh|max|ultra] [optional: model:gpt-5.6|gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna|gpt-5.5|gpt-5.4|gpt-5.3-codex|gpt-5.4-mini|gpt-5.3-codex-spark]
allowed-tools: mcp__codex-dialog__start_dialog, mcp__codex-dialog__check_messages, mcp__codex-dialog__send_message, mcp__codex-dialog__get_full_history, mcp__codex-dialog__check_partner_alive, mcp__codex-dialog__end_dialog, mcp__codex-dialog__list_sessions, Bash, Read, Glob, Grep, Edit, Write, AskUserQuestion, LSP, Monitor
---

# /codex-audit - Comprehensive Code Audit via Codex Dialog MCP Server

Uses the `codex-dialog` MCP server to have Codex CLI perform a deep audit of existing code — not changes, but the code as it stands. Reviews architecture, correctness, methodology, potential bugs, unwanted behavior, and more.

## How It Works

1. You read the target files and call `start_dialog` with a structured audit prompt
2. You send the code contents to Codex via `send_message`
3. You arm a `Monitor` on the session's `conversation.jsonl` that fires one notification when Codex responds, then call `check_messages` to read it
4. You investigate findings, discuss, and fix issues
5. Discussion continues until Codex is satisfied or you escalate to the user

---

## TASK

Audit code: $ARGUMENTS

---

## PHASE 0: DETECT CONTEXT AND GATHER FILES

### Step 0.1: Determine Project Root

```bash
PROJECT_DIR="$(git rev-parse --show-toplevel)"
echo "Project: $PROJECT_DIR"
```

### Step 0.2: Parse Arguments

Parse $ARGUMENTS to determine:
- **targets**: file paths, directory paths, or glob patterns to audit. Can be multiple, space-separated.
- **focus**: after stripping any `rounds:*`, `effort:*`, and `model:*` tokens, if the last argument(s) look like a focus area rather than a path (e.g. "security", "error handling", "concurrency"), treat it as the review focus.
- **max_rounds**: if any argument is `rounds:N` (integer), parse and pass it to `start_dialog` as `max_rounds`. Otherwise OMIT the parameter — the server will default to 5. **Never invent or adjust this value on your own.** The 5-round default is tuned to make Codex deliver complete feedback each round instead of drip-feeding. Only override when the user explicitly provided `rounds:N`.
- **reasoning_effort**: if any argument matches `effort:<level>` where level is one of `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, parse it and pass as `reasoning_effort`. `max` is valid only with an explicitly selected GPT-5.6 family model; `ultra` is valid only with GPT-5.6 Sol or Terra. Otherwise DO NOT pass it — let the server default to `high`.
- **model**: if any argument matches `model:<name>` where name is one of `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, parse it and pass as `model`. `gpt-5.6` is the alias for `gpt-5.6-sol`. These are the ONLY valid model IDs — do not guess or abbreviate (e.g. `gpt-5.3` is NOT valid, use `gpt-5.3-codex`). Otherwise DO NOT pass it — let Codex use its default.

If `effort:max` is paired with no explicit model or with a non-GPT-5.6 model, stop and explain that `max` requires `model:gpt-5.6`, `model:gpt-5.6-sol`, `model:gpt-5.6-terra`, or `model:gpt-5.6-luna`.
If `effort:ultra` is paired with no explicit model or with any model other than GPT-5.6 Sol or Terra, stop and explain that `ultra` requires `model:gpt-5.6`, `model:gpt-5.6-sol`, or `model:gpt-5.6-terra`.

Examples:
- `src/` — audit all source files in src/
- `src/auth.ts src/session.ts` — audit specific files
- `src/api/ security` — audit src/api/ with security focus
- `**/*.py` — audit all Python files

If $ARGUMENTS is empty, use **AskUserQuestion** to ask what files to audit.

### Step 0.3: Collect File Contents

Read all target files. For directories, use Glob to discover files, filtering out:
- `node_modules/`, `dist/`, `build/`, `.git/`, `__pycache__/`, `venv/`
- Binary files, images, lock files
- Files over 500 lines (note them as "skipped — too large, review separately")

Build a manifest of files to send. If the total content exceeds ~40,000 characters, prioritize:
1. Files the user explicitly named
2. Entry points and main modules
3. Files with the most logic (not config/boilerplate)

Note any files that were skipped so Codex knows what it hasn't seen.

---

## PHASE 1: START THE AUDIT DIALOG

Call `start_dialog` with:
- `project_path`: the git project root
- `max_rounds`: only if the user provided `rounds:N`. Otherwise OMIT this parameter.
- `reasoning_effort`: only if the user provided `effort:<level>`. Otherwise omit the parameter entirely and let the server default to `high`.
- `model`: only if the user provided `model:<id>`. Otherwise omit the parameter entirely and let Codex use its default.
- `problem_description`: A brief summary like: "Comprehensive code audit of [target files]. Codex will review for bugs, architecture issues, correctness, and potential problems."

Save the returned `session_id`. Note the `max_rounds` and `hard_cap` values returned — you'll track budget via the `budget` field in subsequent tool responses.

### Step 1.1: Send the Audit Prompt

Use `send_message` to send the code and audit instructions. The message should follow this structure:

```
## Code Audit Request

### Your Audit Stance

ADVERSARIAL AUDIT MODE: Your default assumption is that there are bugs, design flaws, or subtle correctness issues hiding in this code. You are not here to confirm it works — you are here to find what doesn't, what could break, and what was missed. Only accept something as correct once you have actively tried to break it and failed.

For every function, module, and interaction, ask yourself:
- "What input would make this fail?"
- "What state would make this behave unexpectedly?"
- "What was the author probably not thinking about?"
- "What happens under load, concurrency, or partial failure?"
- "What implicit assumptions does this code make that aren't enforced?"
- "If I were trying to cause this system to misbehave, how would I do it?"

You have full access to the project codebase. Read any file you need to understand context, dependencies, and how these files interact with the rest of the system.

### How to Frame Your Findings

Present findings as interesting observations and open questions, not urgent demands. Use language like "I noticed...", "Worth investigating whether...", "This is an interesting case — what happens when...". Frame each finding as a collaborative puzzle to solve together. Be direct and specific, but avoid language that implies urgency or disappointment. If you genuinely find the code to be solid after thorough investigation, say so clearly and explain what you checked — forced criticism is worse than honest approval.

### Deliver Complete Findings Each Round

This audit has a round budget (the runner will show you the current round / soft cap / hard cap in each prompt). Deliver EVERY finding you have in each message — do not hold items back for "next round." Drip-feeding burns the budget and risks the conversation ending before you raise important issues. Rounds exist for verifying fixes and genuine new follow-ups, not for releasing findings you already had.

Apply a severity bar: a finding only earns a slot if a reasonable senior engineer would change a decision based on it. Skip stylistic and naming-level nitpicks unless they impact correctness or understanding — if they're truly worth mentioning at all, group them into one short "Nits" section at the end. If nothing serious survives investigation, say so plainly.

### What to Audit

Examine this code comprehensively for:

**Correctness & Logic**
- Logic errors, off-by-one errors, incorrect conditions
- Unhandled edge cases (null, empty, boundary values, overflow)
- Race conditions, deadlocks, ordering dependencies
- Incorrect error propagation or swallowed errors

**Architecture & Design**
- Coupling between modules that shouldn't know about each other
- Abstraction leaks, broken encapsulation
- Violation of the module's own contract or API promises
- Missing or misleading abstractions
- State management issues (shared mutable state, stale references)

**Robustness & Error Handling**
- Failure modes that aren't handled or are handled incorrectly
- Resource leaks (file handles, connections, memory, event listeners)
- Missing cleanup in error paths
- Partial failure scenarios (what if step 3 of 5 fails?)

**Security**
- Input validation gaps (injection, traversal, overflow)
- Authentication/authorization bypasses
- Information leakage in errors or logs
- Unsafe deserialization or eval-like patterns

**Methodology & Practices**
- Code that's correct now but fragile to future changes
- Implicit ordering dependencies that aren't documented or enforced
- Magic numbers, undocumented assumptions
- Test coverage gaps for critical paths

[USER FOCUS AREA IF SPECIFIED]

### Files to Audit

[FILE CONTENTS HERE — each file prefixed with === path/to/file.ext ===]

[LIST OF SKIPPED FILES IF ANY]

### Response Format

For each finding, categorize as (do not inflate categories — definitions matter):
- **[CRITICAL]** — bugs, security issues, data loss risk
- **[ARCHITECTURE]** — design problems, coupling, broken abstractions
- **[CORRECTNESS]** — logic errors, edge cases, race conditions
- **[ROBUSTNESS]** — error handling, resource management, failure modes
- **[SECURITY]** — vulnerabilities, input validation, auth issues
- **[SUGGESTION]** — concrete improvement with demonstrable benefit; not a stylistic preference
- **[QUESTION]** — genuinely needs investigation or clarification; used sparingly
- **[PRAISE]** — optional; call out a pattern genuinely worth keeping, one or two lines. Only when honest
- **[NIT]** — cosmetic/stylistic only. Group into one short trailing "Nits" section or omit

For each finding, include:
1. The specific file and location
2. What you found
3. Why it matters (what could go wrong)
4. What you checked to verify this is a real issue

At the end, give an overall assessment of the code's health.
```

---

## PHASE 2: WAIT FOR INITIAL AUDIT (Monitor)

Instead of sleep-polling `check_messages`, arm a **Monitor** that fires one notification the moment Codex writes its audit. The conversation is appended to `~/.claude/dialogs/<session_id>/conversation.jsonl`, so a tailed grep on that file is the wake-up signal.

**Monitor command** (replace `<SESSION_ID>` with the actual session id):

```bash
tail -F -n 0 "$HOME/.claude/dialogs/<SESSION_ID>/conversation.jsonl" 2>/dev/null | \
  grep -m 1 --line-buffered -E '"from":"(codex|system)"'
```

`grep -m 1` exits after the first match, so the Monitor produces exactly one notification per wait and then stops cleanly.

**Monitor parameters:**
- `description`: `codex audit response in <SESSION_ID>`
- `timeout_ms`: `900000` (15 min — audits can run long)
- `persistent`: `false`

When the notification arrives, call `check_messages` with the latest `since_id` (or `get_full_history`) to read the structured content — the notification itself just confirms a new message landed.

**If the Monitor hits its timeout with no event**, call `check_partner_alive`. Inspect `partner_terminal.activity` and `partner_terminal.capture.tail_text` to see Codex's compact live tmux status. If it shows useful progress, continue waiting; restart only if the runner died, `last_error` shows a real failure, or the pane shows an idle/stuck state that you decide cannot recover.

Read the audit carefully once it arrives.

---

## PHASE 3: AUDIT DISCUSSION LOOP

Loop until Codex is satisfied (no remaining serious findings), the hard cap is hit, or the remaining disagreements need the user. Watch the `budget` field in each `check_messages` / `send_message` / `check_partner_alive` response.

### Step 3.1: Investigate Findings

**Treat each finding as useful signal.** Codex's job is to be adversarial — many findings will reveal real issues, some will be false positives. Both outcomes are valuable.

For each finding Codex raised:
1. **Read the actual code** at the location mentioned. Use LSP for go-to-definition, find-references, type information to trace the full picture.
2. **Understand before reacting.** Make sure you understand what Codex is actually claiming before deciding whether it's valid.
3. Determine if the finding is VALID, PARTIALLY VALID, or INVALID.
4. If VALID: fix the issue in the code, then describe what you fixed and why the fix is correct.
5. If INVALID: explain why with specific evidence — file paths, line numbers, the actual logic that handles the case.

**Resolve testable claims now.** If a finding can be proven with a local command, grep, SQL query, migration check, CLI command, or filesystem inspection, run it before responding. Do not say you will verify it later unless you include a specific, valid reason it cannot be resolved now.

For each disputed or unresolved finding, include either:
- `Evidence`: the file, command, query, or result you checked
- `Cannot resolve now because`: the specific, valid reason it cannot be resolved now

**If a fix attempt fails:**
- A failed fix is useful information, not a failure on your part.
- Before trying again, analyze *why* it failed. What assumption was wrong?
- After 2 failed attempts at the same fix, stop and re-examine from scratch.
- Never write code whose primary purpose is making a problem go away rather than solving the underlying issue.

### Step 3.2: Send Your Response

Use `send_message` to send ONE consolidated response per round covering everything:
- What you fixed and how (with enough detail for Codex to verify)
- What you disagree with and why (with code evidence)
- What you found surprising or insightful
- Any follow-up areas you'd like Codex to look at based on what you've learned

**Consolidate, don't split.** Don't send a fix in one message and your disagreement in the next — both cost a round. Bundle everything into a single message so Codex has the full picture.

**You have full permission to disagree with Codex.** Honest technical disagreement backed by evidence is more valuable than agreeing to move forward.

**If the previous Codex message hinted at drip-feeding** (e.g. "I'll look at X next round," thin coverage for the scope), add: *"Please include any remaining findings in your next message — we have a limited round budget and I want to make sure I hear everything."*

### Step 3.3: Wait for Follow-up (Monitor)

Arm the same one-shot **Monitor** described in Phase 2 to wait for Codex's next message — `grep -m 1` ensures it fires exactly once per round. When the notification arrives, call `check_messages` with the latest `since_id` to read the content.

Codex will:
- Verify fixes look correct
- Accept or push back on disagreements
- Raise follow-up issues if fixes introduced new concerns
- Give a final assessment when satisfied

### Step 3.4: Check Completion

If Codex indicates the audit is complete (no more findings, or remaining issues acknowledged), go to Phase 4.

Otherwise, continue the loop.

**If there's persistent disagreement (2+ rounds on the same issue):** Ask the user to decide using AskUserQuestion.

---

## PHASE 4: COMPLETION

Report results:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CODEX CODE AUDIT  COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Files Audited: [count] ([list])
 Discussion Rounds: [count]
 Findings: [X critical, Y architecture, Z correctness, ...]
 Fixes Applied: [count]
 Session: [session_id]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Call `end_dialog` to clean up the session.

---

## TROUBLESHOOTING

- **Codex not responding:** Use `check_partner_alive` to check runner status and inspect `partner_terminal.activity` plus `partner_terminal.capture.tail_text` from Codex's tmux pane.
- **Runner died:** Start a new dialog with `start_dialog`.
- **Too many files:** Break the audit into multiple sessions by directory or module.
- **Want full context:** Use `get_full_history` for the complete conversation.

---

## KEY PRINCIPLES

1. **Use the MCP tools** — all communication goes through the codex-dialog server
2. **Use Monitor to wait, not sleep loops** — `tail -F | grep -m 1` on `conversation.jsonl` fires one notification per codex response. Don't burn context re-calling `check_messages` on a timer.
3. **Respect the round budget** — default 5 soft / 10 hard. Watch `budget` in server responses. Consolidate into single messages; push back on drip-feeding. Never change `max_rounds` unless the user explicitly asked.
4. **Fix in code, explain in message** — make actual fixes, then tell Codex what you did
5. **Evidence-based** — back up agreements AND disagreements with actual code
6. **User is arbiter** — when you and Codex can't agree, ask the user
7. **Honest over agreeable** — if Codex is wrong, say so with evidence. If Codex is right, fix it properly
8. **Depth over breadth** — a thorough audit of fewer files beats a shallow scan of everything
