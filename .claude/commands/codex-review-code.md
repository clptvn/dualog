---
description: Have Codex review your code changes via the codex-dialog MCP server
argument-hint: [optional: diff_target (uncommitted|staged|branch|commit:<sha>)] [optional: review focus] [optional: rounds:N] [optional: effort:low|medium|high|xhigh] [optional: model:gpt-5.5|gpt-5.4|gpt-5.3-codex|gpt-5.4-mini|gpt-5.3-codex-spark]
allowed-tools: mcp__codex-dialog__start_code_review, mcp__codex-dialog__check_messages, mcp__codex-dialog__send_message, mcp__codex-dialog__get_review_summary, mcp__codex-dialog__get_full_history, mcp__codex-dialog__check_partner_alive, mcp__codex-dialog__end_dialog, mcp__codex-dialog__list_sessions, Bash, Read, Glob, Grep, Edit, Write, AskUserQuestion, LSP, Monitor
---

# /codex-review-code - Code Review via Codex Dialog MCP Server

Uses the `codex-dialog` MCP server to have Codex CLI review your code changes interactively.

## How It Works

1. You call `start_code_review` which generates a diff and spawns a background Codex runner
2. Codex **automatically generates an initial review** from the diff (no first message needed)
3. You arm a `Monitor` on the session's `conversation.jsonl` that fires one notification when Codex responds, then call `check_messages` to read it
4. You respond to findings with `send_message`, discussing or fixing issues
5. Codex re-reviews and responds until the MCP `review_status.approved` field is true or you end the session

---

## TASK

Review code: $ARGUMENTS

---

## PHASE 0: DETECT CONTEXT

Determine the project path:
```bash
PROJECT_DIR="$(git rev-parse --show-toplevel)"
echo "Project: $PROJECT_DIR"
git branch --show-current
```

Parse $ARGUMENTS to determine:
- **diff_target**: first arg if it matches `uncommitted`, `staged`, `branch`, or `commit:<sha>`. Default: `uncommitted`
- **review_focus**: remaining text after diff_target (excluding any `rounds:N`, `effort:*`, or `model:*` tokens), if any (e.g. "security", "performance", "correctness")
- **max_rounds**: if any argument matches `rounds:N` (integer), parse it and pass as `max_rounds`. Otherwise DO NOT pass `max_rounds` — let the server use its tuned default of 5. **Never invent or adjust this value on your own.** The default exists for a reason: it forces Codex to deliver complete feedback each round instead of drip-feeding. Only override when the user explicitly provided `rounds:N` in the command.
- **reasoning_effort**: if any argument matches `effort:<level>` where level is one of `low`, `medium`, `high`, `xhigh`, parse it and pass as `reasoning_effort`. Otherwise DO NOT pass it — let the server default to `high`. Only override when the user explicitly provided `effort:<level>` in the command.
- **model**: if any argument matches `model:<name>` where name is one of `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, parse it and pass as `model`. These are the ONLY valid model IDs — do not guess or abbreviate (e.g. `gpt-5.3` is NOT valid, use `gpt-5.3-codex`). Otherwise DO NOT pass it — let Codex use its default model.

If $ARGUMENTS is empty, use `uncommitted` as the diff target with no specific focus.

---

## PHASE 1: START THE REVIEW

Call `start_code_review` with:
- `project_path`: the git project root
- `diff_target`: parsed from arguments (default: `uncommitted`)
- `max_rounds`: only if the user provided `rounds:N`. Otherwise omit the parameter entirely and let the server default to 5.
- `reasoning_effort`: only if the user provided `effort:<level>`. Otherwise omit the parameter entirely and let the server default to `high`.
- `model`: only if the user provided `model:<id>`. Otherwise omit the parameter entirely and let Codex use its default.
- `review_focus`: Always prepend the adversarial review stance to whatever focus the user specified. The `review_focus` string should begin with the following, then append the user's focus (if any):

```
ADVERSARIAL REVIEW MODE: Your default assumption is that something is wrong, missing, or subtly broken in this code. You are not looking to confirm it works — you are looking to find what doesn't. Only accept something as correct once you have actively tried to break it and failed. For every function, ask: "What input would make this fail? What state would make this behave unexpectedly? What was the author probably not thinking about?" Check edge cases, error paths, concurrency, resource cleanup, and implicit assumptions. If you cannot find a flaw, explain what you checked and why you believe it holds — do not simply say it looks fine.

FEEDBACK FRAMING: When you report findings, frame them as interesting observations and open questions, not urgent demands. Use language like "I noticed...", "Worth investigating whether...", "This is an interesting case — what happens when...". Present each finding as a collaborative puzzle to solve together, not a failure to be fixed under pressure. Be direct and specific about what you found, but avoid language that implies urgency, disappointment, or that the author should have caught this. The goal is to produce the most thorough and accurate review possible, and that works best when the discussion feels like two engineers working through a problem together rather than an interrogation. If you genuinely find nothing wrong after thorough investigation, say so clearly — forced criticism is worse than honest approval.
```

- `branch` / `base_branch`: only if diff_target is `branch`

Save the returned `session_id` — you need it for all subsequent calls. Note the returned `max_rounds` and `hard_cap` values — you'll want to keep an eye on the budget as the review progresses.

The response will confirm the review started and point you at arming a Monitor on the session's `conversation.jsonl` to wait for Codex's initial review.

### Round Budget (Important)

The server enforces a **soft round budget** (default: 5 rounds). Codex is prompted to deliver COMPLETE feedback in each message — no drip-feeding across rounds. A hard cap of `soft + 5` rounds stops the session entirely if the conversation overruns.

You'll see the current budget in every `check_messages`, `send_message`, and `check_partner_alive` response under the `budget` key: `{ max_rounds, hard_cap, rounds_used, rounds_remaining, hard_rounds_remaining, past_soft_cap }`.

Use the budget as a cue, not a stopwatch:
- If Codex's first review looks thin or says things like "more to follow" / "I'll get to X next round," push back explicitly: *"Please include all remaining findings in this message — the session has a round budget, and holding findings back risks running out before they're raised."*
- If you're approaching `rounds_remaining = 1`, consolidate your own response too: bundle all fixes and all disagreements into a single message so Codex has the material for a final comprehensive round.
- Going past the soft cap is OK when a genuine issue needs more back-and-forth. Going past for pedantic follow-ups is not.

---

## PHASE 2: WAIT FOR INITIAL REVIEW (Monitor)

Codex is generating the initial review in the background. Instead of sleep-polling `check_messages`, arm a **Monitor** that fires one notification the moment Codex writes its first message. Each message is appended as a JSON line to `~/.claude/dialogs/<session_id>/conversation.jsonl`, so a tailed grep is the wake-up signal.

**Monitor command** (replace `<SESSION_ID>` with the actual session id):

```bash
tail -F -n 0 "$HOME/.claude/dialogs/<SESSION_ID>/conversation.jsonl" 2>/dev/null | \
  grep -m 1 --line-buffered -E '"from":"(codex|system)"'
```

`grep -m 1` exits after the first match, so the Monitor produces exactly one notification per wait and then stops cleanly.

**Monitor parameters:**
- `description`: `codex review response in <SESSION_ID>`
- `timeout_ms`: `900000` (15 min — large diffs can run long)
- `persistent`: `false`

When the notification arrives, call `check_messages` with `since_id: 0` (or `get_full_history`) to read the structured content — the notification itself just confirms a new message landed.

**If the Monitor hits its timeout with no event**, call `check_partner_alive`. Inspect `partner_terminal.activity` and `partner_terminal.capture.tail_text` to see Codex's compact live tmux status. If it shows useful progress, continue waiting; restart only if the runner died, `last_error` shows a real failure, or the pane shows an idle/stuck state that you decide cannot recover.

Once you receive the initial review, read it carefully. The review uses a severity-ordered taxonomy:
- **[CRITICAL]** — bugs, security issues, data loss risk (must address)
- **[CORRECTNESS]** / **[ARCHITECTURE]** / **[SECURITY]** / **[ROBUSTNESS]** — substantive issues (address)
- **[SUGGESTION]** — concrete improvements with demonstrable benefit (discuss or fix)
- **[QUESTION]** — needs clarification (answer)
- **[PRAISE]** — optional callouts of patterns worth keeping (acknowledge briefly)
- **[NIT]** — cosmetic/stylistic (address only if trivial; often fine to skip)

**If the review feels thin for the size of the diff** — or if Codex wrote things like "I'll cover X next round," "more findings to follow," etc. — that's a drip-feed signal. Respond by asking Codex to deliver the full set *now*, not next round.

---

## PHASE 3: REVIEW DISCUSSION LOOP

Loop until `review_status.approved` is true, the hard cap is hit, or the remaining disagreements need the user. Check the `budget` and `review_status` fields in each `check_messages` / `send_message` response to know where you stand.

### Step 3.1: Investigate and Respond to Findings

**Treat each finding as useful signal.** Codex's job is to be adversarial — many findings will be real issues worth fixing, some will be false positives that you can refute with evidence. Both outcomes are valuable.

For each finding Codex raised:
1. **Read the actual code** at the location mentioned. Use LSP for go-to-definition and find-references to trace the full picture.
2. **Understand before reacting.** Before deciding whether a finding is valid, make sure you understand what Codex is actually claiming. Re-read the finding. Re-read the code. Check the surrounding context.
3. Determine if the finding is VALID, PARTIALLY VALID, or INVALID.
4. If VALID: fix the issue in the code, then describe what you fixed and why the fix is correct.
5. If INVALID: explain why with specific evidence from the code. Reference file paths, line numbers, and the actual logic that handles the case Codex raised.

**Resolve testable claims now.** If a finding can be proven with a local command, grep, SQL query, migration check, CLI command, or filesystem inspection, run it before responding. Do not say you will verify it later unless you include a specific, valid reason it cannot be resolved now.

For each disputed or unresolved finding, include either:
- `Evidence`: the file, command, query, or result you checked
- `Cannot resolve now because`: the specific, valid reason it cannot be resolved now

**If a fix attempt fails:**
- A failed fix is useful information about the problem, not a failure on your part.
- Before trying again, write a brief analysis of *why* it failed. What assumption was wrong?
- After 2 failed attempts at the same fix, stop and re-examine the finding from scratch. The issue may be different from what you initially thought, or the finding itself may be based on a misunderstanding.
- Never write code whose primary purpose is making a problem go away rather than solving the underlying issue. A correct solution that takes longer is always preferred over a fast patch.

### Step 3.2: Send Your Response

Use `send_message` to send ONE consolidated response covering everything you did this round. Include:
- What you fixed and how (with enough detail that Codex can verify)
- What you disagree with and why (with code evidence — file paths, line numbers, logic traces)
- Answers to any questions
- If a finding revealed something you hadn't considered, say so briefly — it helps Codex calibrate

**Consolidate, don't split.** Don't send a fix in one message and your disagreement in the next — both cost a round. Bundle everything into a single message so Codex has the full picture for its follow-up.

**You have full permission to disagree with Codex.** If a finding doesn't hold up after investigation, say so directly and explain why. Honest technical disagreement, backed by evidence, is more valuable than agreeing just to move forward.

**If the previous Codex message hinted at drip-feeding** (e.g. "I'll look at X next round," thin coverage for a large diff), add an explicit line: *"Please include any remaining findings in your next message — we have a limited round budget and I want to make sure I hear everything."*

### Step 3.3: Wait for Codex Follow-up (Monitor)

Arm the same one-shot **Monitor** described in Phase 2 to wait for Codex's next message — `grep -m 1` ensures it fires exactly once per round. When the notification arrives, call `check_messages` with the latest `since_id` to read the content.

Codex will:
- Verify your fixes look correct
- Accept or push back on disagreements
- Set `review_status.approved` once all significant issues are resolved

### Step 3.4: Check Review Status

After every `check_messages` call, inspect `review_status`. If `review_status.approved` is true, the review is complete — go to Phase 4. Do not start another round just because the prose approval wording differs; the structured field is authoritative.

Otherwise, continue the loop with the next round.

**If there's persistent disagreement (2+ rounds on the same issue):** Ask the user to decide using AskUserQuestion. Frame it neutrally: present both positions with the evidence each side has, and let the user make the call. This is a normal and healthy outcome — it means the review process is working.

---

## PHASE 4: COMPLETION

Call `get_review_summary` to get the final state, then report the verdict from `review_status`:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CODEX CODE REVIEW  COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Verdict: [APPROVED / IN PROGRESS / MAX ROUNDS]
 Review Rounds: [count]
 Findings: [X critical, Y suggestions, Z questions]
 Session: [session_id]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Call `end_dialog` to clean up the session.

---

## TROUBLESHOOTING

- **Codex not responding:** Use `check_partner_alive` to check the runner and inspect `partner_terminal.activity` plus `partner_terminal.capture.tail_text` from Codex's tmux pane. Check `last_error` in the response.
- **Runner died:** Start a new review with `start_code_review`.
- **Want to see everything:** Use `get_full_history` to get the complete conversation and diff metadata.
- **Multiple reviews:** Use `list_sessions` to see all active/completed sessions.

---

## KEY PRINCIPLES

1. **Use the MCP tools** — all communication goes through the codex-dialog server
2. **Use Monitor to wait, not sleep loops** — `tail -F | grep -m 1` on `conversation.jsonl` fires one notification per codex response. Don't burn context re-calling `check_messages` on a timer.
3. **Respect the round budget** — default 5 soft / 10 hard. Watch `budget` in server responses. Consolidate into single messages; push back on drip-feeding. Never change `max_rounds` unless the user explicitly asked.
4. **Fix in code, explain in message** — make actual fixes, then tell Codex what you did
5. **Evidence-based** — back up agreements AND disagreements with actual code
6. **User is arbiter** — when you and Codex can't agree, ask the user
7. **Honest over agreeable** — if Codex is wrong, say so with evidence. If Codex is right, fix it properly. Never patch something superficially just to resolve a finding.
