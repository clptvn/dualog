---
description: Have a partner agent review an implementation plan via the dualog MCP server
argument-hint: [optional: path/to/plan.md] [optional: rounds:N] [optional: effort:<level>] [optional: model:<id>] [optional: partner:<agent-id>]
allowed-tools: mcp__dualog__start_dialog, mcp__dualog__check_messages, mcp__dualog__send_message, mcp__dualog__get_full_history, mcp__dualog__check_partner_alive, mcp__dualog__end_dialog, mcp__dualog__list_sessions, mcp__dualog__list_models, mcp__dualog__check_adapter, Bash, Read, Glob, Grep, Edit, Write, AskUserQuestion, LSP, Monitor
---

# /dualog-review-plan - Plan Review via Codex Dialog MCP Server

Uses the `dualog` MCP server to have the partner agent review an implementation plan interactively.

## How It Works

1. You read the plan file and call `start_dialog` with a structured review prompt
2. Codex reviews the plan and responds with findings
3. You arm a `Monitor` on the session's `conversation.jsonl` that fires one notification when Codex responds, then call `check_messages` to read it
4. You investigate findings in the codebase, respond via `send_message`
5. Discussion continues until Codex approves or you escalate to the user

---

## TASK

Review plan: $ARGUMENTS

---

## PHASE 0: DETECT CONTEXT

### Step 0.1: Find the Plan File

Parse $ARGUMENTS:
- Any argument of the form `rounds:N` (integer) → parse as `max_rounds`.
- Any argument of the form `effort:<level>` → parse as `reasoning_effort` and pass it through unchanged. Otherwise DO NOT pass it — let the server apply its default of `high`.
- Any argument of the form `model:<name>` → parse as `model` and pass it through unchanged. Otherwise DO NOT pass it — let the partner use its default.
- Remaining non-`rounds:*`/non-`effort:*`/non-`model:*` argument (if any) → treat as the plan path.

Do not assert from memory which models exist or which effort levels they accept. Which efforts are valid depends on the specific MODEL, not on the agent, and that table changes whenever a vendor ships. If the user names a model and you need to check it, call `list_models` for the partner agent first and use what it returns — it also reports whether that list is a live catalog or a hand-maintained fallback.

Pass the user's model and effort through as given. The server validates the pair and, if it is wrong, returns an error naming the model, exactly what that model accepts, and where that came from. Surface that error verbatim rather than pre-judging the combination yourself.

**If a plan path is provided**, use it directly.

**If no plan path is provided**, auto-detect:
```bash
PROJECT_DIR="$(git rev-parse --show-toplevel)"
echo "Project: $PROJECT_DIR"
git branch --show-current
```

Search for plan files in the project:
```bash
ls -t "$PROJECT_DIR"/.codex-reviews/*/plan-v*.md 2>/dev/null | head -5
ls -t "$PROJECT_DIR"/plan*.md "$PROJECT_DIR"/PLAN.md "$PROJECT_DIR"/.claude/plan*.md 2>/dev/null | head -5
```

If no plan found, use **AskUserQuestion** to ask the user for the path.

### Step 0.2: Verify the Plan

Verify the plan file exists, is readable, and is non-empty. The dialog server will reread this file before every Codex turn and inject the current contents as the authoritative plan snapshot.

---

## PHASE 1: START THE REVIEW DIALOG

Call `start_dialog` with:
- `project_path`: the git project root
- `max_rounds`: only if the user provided `rounds:N`. Otherwise OMIT this parameter and let the server default to 5. **Never invent or change this value on your own** — the 5-round default is tuned to force Codex to deliver complete feedback each round rather than drip-feed it.
- `reasoning_effort`: only if the user provided `effort:<level>`. Otherwise omit the parameter entirely and let the server default to `high`.
- `model`: only if the user provided `model:<id>`. Otherwise omit the parameter entirely and let Codex use its default.
- `subject_path`: the resolved plan file path
- `subject_kind`: `"plan"`
- `problem_description`: a structured prompt — see below

The `problem_description` must include the adversarial review instructions. Do not rely on this field as the canonical plan copy — `subject_path` makes the server inject the current plan file each round:

```
## Plan Review Request

### Your Review Stance

ADVERSARIAL REVIEW MODE: Your default assumption is that this plan has gaps, incorrect assumptions, or will fail in ways the author hasn't anticipated. You are not here to confirm the plan is good — you are here to find what's wrong with it. Only accept a part of the plan as sound once you have actively tried to poke holes in it and failed.

For every step in the plan, ask yourself:
- "What happens if this assumption is wrong?"
- "What dependency is being taken for granted here?"
- "What's the failure mode the author probably hasn't considered?"
- "Is there a simpler way to achieve this that was overlooked?"
- "Does the codebase actually support what this plan assumes?"

Read the actual codebase to verify claims. Do not take the plan's description of the current state at face value — check it.

### Deliver Complete Feedback Each Round

This review has a round budget (the runner will show you the current round / soft cap / hard cap in each prompt). Deliver EVERY finding you have in each message — do not hold items back for "next round." Drip-feeding across rounds burns the budget and risks the conversation ending before you raise important points. Rounds exist for verifying the author's responses and for genuine new follow-ups, not for releasing findings you already had.

Apply a severity bar: a finding only earns a slot if a reasonable senior engineer would change a decision based on it. If nothing serious survives investigation, say so plainly — forced criticism is worse than honest approval.

### How to Frame Your Feedback

Present findings as interesting observations and open questions, not urgent demands. Use language like "I noticed...", "Worth investigating whether...", "This is an interesting case — what happens when...", "I checked the codebase and found that actually...". 

Frame each finding as a collaborative puzzle to solve together, not a failure on the author's part. Be direct and specific about what you found, but avoid language that implies the author was careless or should have caught this. The goal is to produce the best possible plan, and that happens when the discussion feels like two engineers thinking through a problem together.

If you genuinely find the plan to be solid after thorough investigation, say so clearly and explain what you checked — forced criticism is worse than honest approval.

### Review Dimensions

Examine the plan for:
- **Feasibility** — can this actually be built as described? Does the codebase support it?
- **Completeness** — are there missing steps, edge cases, or dependencies?
- **Correctness** — are the technical assumptions sound? Verify against actual code.
- **Risk** — what could go wrong? What's underestimated?
- **Alternatives** — are there simpler or better approaches the plan missed?
- **Ordering** — are the steps in the right order? Are there hidden dependencies between steps?

You have access to the full project codebase at the project_path. Read relevant files to verify assumptions made in the plan.

### Current Plan Source

The server will include a `Current Plan Snapshot` section in each Codex prompt by rereading the plan file from `subject_path`. Treat that snapshot as the authoritative current plan. It supersedes older plan text or summaries in the conversation.

### Response Format

For each significant finding, categorize as (do not inflate categories — definitions matter):
- **[CRITICAL]** — plan is flawed or will fail as stated
- **[SUGGESTION]** — concrete improvement with demonstrable benefit; not a stylistic or preference-level tweak
- **[QUESTION]** — genuinely needs clarification before you can conclude; used sparingly
- **[PRAISE]** — optional; call out a decision genuinely worth keeping, one or two lines. Only when honest — forced praise is worthless
- **[NIT]** — cosmetic/presentational plan wording. Group into one short trailing section or omit entirely

At the end, set the machine-readable verdict on its own line:
- `REVIEW_VERDICT: APPROVE` — plan is solid, proceed with implementation
- `REVIEW_VERDICT: NEEDS_DISCUSSION` — some issues need resolution first
- `REVIEW_VERDICT: CHANGES_REQUESTED` — significant problems must be addressed
```

Save the returned `session_id`.

**Verify what the server actually used.** The start response echoes `requested_model` / `requested_reasoning_effort` (what you passed) alongside `model` / `reasoning_effort` (what resolved). Compare the **requested** fields against your own call: if something you specified comes back as `null` there, that parameter never arrived and the session is running on settings you did not choose. End it and retry.

Do **not** treat a difference between requested and resolved as a failure. That difference is normal and usually correct -- an adapter may translate an effort it names differently (goose maps a requested `xhigh` onto its own `max`), and omitting an effort deliberately resolves to the model's own default. Those cases are reported in the response's `notices` array as `effort_alias_applied` or `default_effort_applied`, and are working as intended.

Read the three effort fields as three different questions. `requested_reasoning_effort` is what you asked for -- use it to check transport. `reasoning_effort` is the flag actually passed to the CLI, which is `null` when we deliberately pass none. **`effective_reasoning_effort` is what the turn will really run at**, including the model's own default when no flag is sent. For `gpt-5.6-sol` with effort omitted the response is `requested_reasoning_effort: null`, `reasoning_effort: null`, `effective_reasoning_effort: "low"` -- so read `effective_reasoning_effort`, not `reasoning_effort`, to know the runtime behavior.

Ending is possible at this point specifically because the partner has not spoken yet: a session with no partner turns has no findings to abandon, so `end_dialog` is permitted. Once the partner has replied, the usual approval/round-budget gating applies.

The server cannot catch a dropped parameter for you. A parameter the caller deliberately omitted and one lost in transit are identical on the wire, so the echoed values are the only place the difference is visible.

Then use `send_message` to ask Codex to review the current plan snapshot as your first message to kick off the dialog.

---

## PHASE 2: WAIT FOR INITIAL REVIEW (Monitor)

Instead of sleep-polling `check_messages`, arm a **Monitor** that fires one notification the moment Codex writes its review. Messages are appended as JSON lines to `<dialog_dir>/conversation.jsonl`, where `<dialog_dir>` is the **`dialog_dir` returned by the start call**, so a tailed grep is the wake-up signal.

**Monitor command** (replace `<SESSION_ID>` with the actual session id):

```bash
tail -F -n 0 "<dialog_dir>/conversation.jsonl" 2>/dev/null | \
  grep -m 1 --line-buffered -E '"from":"(codex|system)"'
```

Use the literal `dialog_dir` value from the start response. Sessions moved from `~/.claude/dialogs` to `~/.dualog/sessions`; a hardcoded root tails a path that will never be created for a new session, so the Monitor sits until its full timeout instead of firing.

`grep -m 1` exits after the first match, so the Monitor produces exactly one notification per wait and then stops cleanly.

**Monitor parameters:**
- `description`: `codex plan review response in <SESSION_ID>`
- `timeout_ms`: `600000` (10 min — plan reviews are usually faster than audits)
- `persistent`: `false`

When the notification arrives, call `check_messages` with `since_id: 0` (or `get_full_history`) to read the structured content — the notification itself just confirms a new message landed.

**If the Monitor hits its timeout with no event**, call `check_partner_alive`. Inspect `partner_terminal.activity` and `partner_terminal.capture.tail_text` to see Codex's compact live tmux status. If it shows useful progress, continue waiting; restart only if the runner died, `last_error` shows a real failure, or the pane shows an idle/stuck state that you decide cannot recover.

Read the review carefully once it arrives.

---

## PHASE 3: DISCUSSION LOOP

Loop until `review_status.approved` is true, the hard cap is hit, or the remaining disagreements need the user. The `budget` and `review_status` fields in each `check_messages` / `send_message` response show where you stand.

### Step 3.1: Investigate Findings

**Treat each finding as useful signal.** Codex's job is to be adversarial — many findings will reveal real gaps, some will be based on misunderstandings. Both outcomes are valuable.

For each finding Codex raised:
1. **Read the actual codebase** at locations mentioned — use LSP for go-to-definition, find-references, etc.
2. **Understand before reacting.** Before deciding whether a finding is valid, make sure you understand what Codex is actually claiming. Re-read the finding. Re-read the relevant code. Check surrounding context.
3. Determine: AGREE / PARTIALLY AGREE / DISAGREE
4. Provide evidence from actual code (file paths, line numbers, snippets)

**Resolve testable claims now.** If a finding can be proven with a local command, grep, SQL query, migration check, CLI command, or filesystem inspection, run it before responding. Do not say you will verify it later unless you include a specific, valid reason it cannot be resolved now.

For each disputed or unresolved finding, include either:
- `Evidence`: the file, command, query, or result you checked
- `Cannot resolve now because`: the specific, valid reason it cannot be resolved now

**If you're struggling with a finding:**
- That's useful information — it may mean the finding has identified genuine complexity in the plan.
- Before responding, write a brief analysis of what makes this hard. What are the competing constraints?
- After 2 attempts to resolve the same finding, step back. Re-read the plan section in question and the finding side by side. The resolution may require rethinking the plan's approach, not just tweaking it.
- Never dismiss a finding just because it's hard to address. If Codex found a real problem, the plan needs to account for it even if the answer isn't obvious.

### Step 3.2: Respond and Update Plan

Use `send_message` to send ONE consolidated response per round covering every finding:
- Your verdict on each finding, with code evidence
- If you agree: describe how the plan should change and make the edit
- If you disagree: explain why with references to actual code

**Consolidate, don't split.** Don't send agreement in one message and disagreement in the next — both cost a round. Bundle everything into a single message so Codex has the full picture.

**You have full permission to disagree with Codex.** If a finding doesn't hold up after investigation, say so directly and explain why. Honest technical disagreement, backed by evidence, is more valuable than agreeing just to move forward.

**If the previous Codex message hinted at drip-feeding** (e.g. "I'll look at X next round," thin coverage for a dense plan), add: *"Please include any remaining concerns in your next message — we have a limited round budget and I want to make sure I hear everything."*

If findings warrant plan changes, update the plan file and mention what changed in your response.

### Step 3.3: Wait for Follow-up (Monitor)

Arm the same one-shot **Monitor** described in Phase 2 to wait for Codex's next message — `grep -m 1` ensures it fires exactly once per round. When the notification arrives, call `check_messages` with the latest `since_id` to read the content.

Codex will:
- Accept or push back on your responses
- Raise follow-up concerns
- Set `review_status.approved` when satisfied

### Step 3.4: Check Verdict

After every `check_messages` call, inspect `review_status`. If `review_status.approved` is true, the review is complete — go to Phase 4. Treat the structured field as authoritative rather than re-prompting for a prose-only approval token.

Otherwise, continue the loop.

**If there's persistent disagreement (2+ rounds on the same issue):** Ask the user to decide using AskUserQuestion. Frame it neutrally: present both positions with the evidence each side has, and let the user make the call. This is a normal and healthy outcome — it means the review process is working.

---

## PHASE 4: COMPLETION

Report results:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CODEX PLAN REVIEW  COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Plan: [plan file path]
 Verdict: [APPROVED / IN PROGRESS / MAX ROUNDS]
 Discussion Rounds: [count]
 Plan Updated: [yes/no]
 Session: [session_id]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Call `end_dialog` to clean up the session.

---

## TROUBLESHOOTING

- **Codex not responding:** Use `check_partner_alive` to check the runner and inspect `partner_terminal.activity` plus `partner_terminal.capture.tail_text` from Codex's tmux pane.
- **Runner died:** Start a new dialog with `start_dialog`.
- **Want full context:** Use `get_full_history` for the complete conversation.
- **Multiple sessions:** Use `list_sessions` to see all active/completed sessions.

---

## KEY PRINCIPLES

1. **Use the MCP tools** — all communication goes through the dualog server
2. **Use Monitor to wait, not sleep loops** — `tail -F | grep -m 1` on `conversation.jsonl` fires one notification per codex response. Don't burn context re-calling `check_messages` on a timer.
3. **Respect the round budget** — default 5 soft / 10 hard. Watch `budget` in server responses. Consolidate into single messages; push back on drip-feeding. Never change `max_rounds` unless the user explicitly asked.
4. **Evidence-based** — verify every finding against actual code before agreeing or disagreeing
5. **Update the plan** — if findings are valid, actually fix the plan file
6. **User is arbiter** — when you and Codex can't agree, ask the user
7. **Honest over agreeable** — if Codex is wrong, say so with evidence. If Codex is right, update the plan properly. Never make a superficial plan edit just to resolve a finding.
