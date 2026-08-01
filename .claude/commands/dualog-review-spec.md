---
description: Have a partner agent review a feature/product spec via the dualog MCP server
argument-hint: [optional: path/to/spec.md] [optional: rounds:N] [optional: effort:<level>] [optional: model:<id>] [optional: partner:<agent-id>]
allowed-tools: mcp__dualog__start_dialog, mcp__dualog__check_messages, mcp__dualog__send_message, mcp__dualog__get_full_history, mcp__dualog__check_partner_alive, mcp__dualog__end_dialog, mcp__dualog__list_sessions, mcp__dualog__list_models, mcp__dualog__check_adapter, Bash, Read, Glob, Grep, Edit, Write, AskUserQuestion, LSP, Monitor
---

# /dualog-review-spec - Feature Spec Review via Codex Dialog MCP Server

Uses the `dualog` MCP server to have the partner agent review a product/feature specification interactively. Targets specs (the WHAT/WHY) — the kind of document produced by the `product-manager` skill — rather than implementation plans (the HOW, use `/dualog-review-plan`) or code (the RESULT, use `/dualog-review-code`).

## How It Works

1. You read the spec file and call `start_dialog` with a structured spec-review prompt
2. Codex reviews the spec adversarially and responds with findings
3. You arm a `Monitor` on the session's `conversation.jsonl` that fires one notification when Codex responds, then call `check_messages` to read it
4. You investigate findings in the spec + codebase, respond via `send_message`
5. Discussion continues until Codex approves or you escalate to the user

---

## TASK

Review spec: $ARGUMENTS

---

## PHASE 0: DETECT CONTEXT

### Step 0.1: Find the Spec File

Parse $ARGUMENTS:
- Any argument of the form `rounds:N` (integer) → parse as `max_rounds`.
- Any argument of the form `effort:<level>` → parse as `reasoning_effort` and pass it through unchanged. Otherwise DO NOT pass it — let the server apply its default of `high`.
- Any argument of the form `model:<name>` → parse as `model` and pass it through unchanged. Otherwise DO NOT pass it — let the partner use its default.
- Remaining non-`rounds:*`/non-`effort:*`/non-`model:*` argument (if any) → treat as the spec path.

Do not assert from memory which models exist or which effort levels they accept. Which efforts are valid depends on the specific MODEL, not on the agent, and that table changes whenever a vendor ships. If the user names a model and you need to check it, call `list_models` for the partner agent first and use what it returns — it also reports whether that list is a live catalog or a hand-maintained fallback.

Pass the user's model and effort through as given. The server validates the pair and, if it is wrong, returns an error naming the model, exactly what that model accepts, and where that came from. Surface that error verbatim rather than pre-judging the combination yourself.

**If a spec path is provided**, use it directly — skip auto-detection entirely, even if other spec files exist. This is the preferred path when you (Claude) just produced the spec yourself and already know where it is (e.g. after running the `product-manager` skill in the same session). Pass the path you wrote; don't re-discover it.

**If no spec path is provided**, auto-detect:
```bash
PROJECT_DIR="$(git rev-parse --show-toplevel)"
echo "Project: $PROJECT_DIR"
git branch --show-current
```

Search for spec files in the project, in priority order (canonical locations first, fallbacks last):
```bash
ls -t "$PROJECT_DIR"/docs/specs/*.md 2>/dev/null | head -5
ls -t "$PROJECT_DIR"/.claude/specs/*.md 2>/dev/null | head -5
ls -t "$PROJECT_DIR"/specs/*.md 2>/dev/null | head -5
ls -t "$PROJECT_DIR"/spec*.md "$PROJECT_DIR"/SPEC.md 2>/dev/null | head -5
```

If multiple candidates surface, use **AskUserQuestion** to disambiguate — never silently pick. If no spec found, use **AskUserQuestion** to ask the user for the path.

### Step 0.2: Verify the Spec

Verify the spec file exists, is readable, is non-empty, and is markdown. The dialog server will reread this file before every Codex turn and inject the current contents as the authoritative spec snapshot.

**Guard against unusable spec files.** Before proceeding to Phase 1:
- If the file does not exist or the read returns empty content → abort with a clear message and do **not** call `start_dialog`. Starting a dialog with an empty spec wastes a session.
- If the file extension is not `.md` or `.markdown` → abort with a clear message naming the extension you got. The review prompt assumes markdown; feeding in binaries or other formats produces garbage output. If the user insists the file really is markdown with a non-standard extension, they can rename it and re-run.

In both abort cases, report the problem and the path you tried, and stop. Do not ask further clarifying questions — the user's next action will be obvious from the error.

---

## PHASE 1: START THE REVIEW DIALOG

Call `start_dialog` with:
- `project_path`: the git project root
- `max_rounds`: only if the user provided `rounds:N`. Otherwise OMIT this parameter and let the server default to 5. **Never invent or change this value on your own** — the 5-round default is tuned to force Codex to deliver complete feedback each round rather than drip-feed it.
- `reasoning_effort`: only if the user provided `effort:<level>`. Otherwise omit the parameter entirely and let the server default to `high`.
- `model`: only if the user provided `model:<id>`. Otherwise omit the parameter entirely and let Codex use its default.
- `subject_path`: the resolved spec file path
- `subject_kind`: `"spec"`
- `problem_description`: a structured prompt — see below

The `problem_description` must include the adversarial review instructions. Do not rely on this field as the canonical spec copy — `subject_path` makes the server inject the current spec file each round:

```
## Spec Review Request

### Your Review Stance

ADVERSARIAL SPEC REVIEW MODE: Your default assumption is that this spec has gaps, ambiguous requirements, untestable acceptance criteria, or flows that fall apart at the edges. You are not here to confirm the spec is good — you are here to find what's missing, unclear, or inconsistent. A coding agent will implement directly from this document; anything ambiguous becomes an arbitrary decision downstream. Assume every ambiguity will be resolved in the wrong direction.

For every section of the spec, ask yourself:
- "Could two engineers read this and build meaningfully different things?"
- "What happens on the error path this spec doesn't mention?"
- "Is this acceptance criterion something I could write a test for, or is it an opinion?"
- "Does the claimed integration point actually exist in the codebase?"
- "What user need is being asserted without evidence?"
- "What's in v1 that should be in v2 — is the scope cut honest?"
- "Does the described flow actually serve the user stories, or are some stories unserved?"

Read the actual codebase to verify claims about existing structure, integration points, or supposed extension seams. Do not take the spec's description of the current state at face value — check it.

### Deliver Complete Feedback Each Round

This review has a round budget (the runner will show you the current round / soft cap / hard cap in each prompt). Deliver EVERY finding you have in each message — do not hold items back for "next round." Drip-feeding across rounds burns the budget and risks the conversation ending before you raise important points. Rounds exist for verifying the author's responses and for genuine new follow-ups, not for releasing findings you already had.

Apply a severity bar: a finding only earns a slot if a reasonable senior engineer or PM would change a decision based on it. If nothing serious survives investigation, say so plainly — forced criticism is worse than honest approval.

### How to Frame Your Feedback

Present findings as interesting observations and open questions, not urgent demands. Use language like "I noticed...", "Worth investigating whether...", "This is an interesting case — what happens when...", "I checked the codebase and found that actually...".

Frame each finding as a collaborative puzzle to solve together, not a failure on the author's part. Be direct and specific about what you found, but avoid language that implies the author was careless or should have caught this. The goal is to produce the best possible spec, and that happens when the discussion feels like two people thinking through a problem together.

If you genuinely find the spec to be solid after thorough investigation, say so clearly and explain what you checked — forced criticism is worse than honest approval.

### Review Dimensions

Examine the spec for:
- **Completeness** — are all user flows covered? Are error, empty, and loading states specified? Are there missing requirements, data-model fields, or acceptance criteria?
- **Clarity / Ambiguity** — is every requirement unambiguous? Could two readers diverge on what "done" means?
- **Testability** — are acceptance criteria framed as statements a test could verify? Or are they opinions ("should feel snappy," "works well") dressed up as criteria?
- **Scope hygiene** — is v1 honestly bounded? Any feature creep smuggled in as "while we're at it"? Any v1 item that should have been cut to v2?
- **Data-model coherence** — do entities, fields, and relationships hang together? Any implied-but-unstated foreign keys, ordering constraints, or uniqueness requirements?
- **UX soundness** — does the described flow actually solve the stated user problem? Any steps that feel tacked on or any obvious happy-path holes?
- **Feasibility sanity check** — does the codebase actually support the claimed integration points, extension seams, or existing patterns the spec references? (This is a sanity check, not a deep technical feasibility review — that's `/dualog-review-plan`'s job.)
- **Alignment** — does the feature as described match the stated user stories? Are any user stories unserved by the described flow? Does the summary match the details?

You have access to the full project codebase at the project_path. Read relevant files to verify assumptions the spec makes about existing code or product structure.

### Current Spec Source

The server will include a `Current Spec Snapshot` section in each Codex prompt by rereading the spec file from `subject_path`. Treat that snapshot as the authoritative current spec. It supersedes older spec text or summaries in the conversation.

### Response Format

For each significant finding, categorize as (do not inflate categories — definitions matter):
- **[GAP]** — missing requirement, flow, state, or acceptance criterion that v1 clearly needs
- **[AMBIGUITY]** — requirement that two competent readers would interpret differently
- **[SCOPE]** — v1/v2 boundary issue; feature creep, or v1 item that should be cut
- **[FEASIBILITY]** — spec assumes something about the codebase that isn't true (caught at spec time, not plan time)
- **[UX]** — user flow or state-design problem; step ordering, missing state, dead-end path
- **[TESTABILITY]** — acceptance criterion that isn't testable as written (opinion dressed as criterion)
- **[SUGGESTION]** — concrete improvement with demonstrable benefit; not a stylistic or preference-level tweak
- **[QUESTION]** — genuinely needs clarification before you can conclude; used sparingly
- **[PRAISE]** — optional; call out a design decision genuinely worth keeping, one or two lines. Only when honest — forced praise is worthless
- **[NIT]** — cosmetic/wording/presentational. Group into one short trailing section or omit entirely

At the end, set the machine-readable verdict on its own line:
- `REVIEW_VERDICT: APPROVE` — spec is solid, ready for planning/implementation
- `REVIEW_VERDICT: NEEDS_DISCUSSION` — some issues need resolution first
- `REVIEW_VERDICT: CHANGES_REQUESTED` — significant problems must be addressed
```

Save the returned `session_id`.

Then use `send_message` to ask Codex to review the current spec snapshot as your first message to kick off the dialog.

---

## PHASE 2: WAIT FOR INITIAL REVIEW (Monitor)

Instead of sleep-polling `check_messages`, arm a **Monitor** that fires one notification the moment Codex writes its review. Messages are appended as JSON lines to `~/.claude/dialogs/<session_id>/conversation.jsonl`, so a tailed grep is the wake-up signal.

**Monitor command** (replace `<SESSION_ID>` with the actual session id):

```bash
tail -F -n 0 "$HOME/.claude/dialogs/<SESSION_ID>/conversation.jsonl" 2>/dev/null | \
  grep -m 1 --line-buffered -E '"from":"(codex|system)"'
```

`grep -m 1` exits after the first match, so the Monitor produces exactly one notification per wait and then stops cleanly.

**Monitor parameters:**
- `description`: `codex spec review response in <SESSION_ID>`
- `timeout_ms`: `600000` (10 min — spec reviews are usually faster than audits)
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
1. **Read the actual spec and codebase** at locations mentioned — use LSP for go-to-definition, find-references, etc. when the finding touches claimed integration points.
2. **Understand before reacting.** Before deciding whether a finding is valid, make sure you understand what Codex is actually claiming. Re-read the finding. Re-read the relevant spec section and code. Check surrounding context.
3. Determine: AGREE / PARTIALLY AGREE / DISAGREE
4. Provide evidence from the spec text, the codebase, or user-story logic (file paths, line numbers, snippets)

**Resolve testable claims now.** If a finding can be proven with a local command, grep, SQL query, migration check, CLI command, or filesystem inspection, run it before responding. Do not say you will verify it later unless you include a specific, valid reason it cannot be resolved now.

For each disputed or unresolved finding, include either:
- `Evidence`: the file, command, query, or result you checked
- `Cannot resolve now because`: the specific, valid reason it cannot be resolved now

**If you're struggling with a finding:**
- That's useful information — it may mean the finding has identified genuine ambiguity or tension in the spec.
- Before responding, write a brief analysis of what makes this hard. What are the competing constraints?
- After 2 attempts to resolve the same finding, step back. Re-read the spec section in question and the finding side by side. The resolution may require rethinking the spec's approach, not just tweaking a sentence.
- Never dismiss a finding just because it's hard to address. If Codex found a real gap or ambiguity, the spec needs to account for it even if the answer isn't obvious.

### Step 3.2: Respond and Update Spec

Use `send_message` to send ONE consolidated response per round covering every finding:
- Your verdict on each finding, with evidence from the spec and/or codebase
- If you agree: describe how the spec should change and make the edit
- If you disagree: explain why with references to the spec text or actual code

**Consolidate, don't split.** Don't send agreement in one message and disagreement in the next — both cost a round. Bundle everything into a single message so Codex has the full picture.

**You have full permission to disagree with Codex.** If a finding doesn't hold up after investigation, say so directly and explain why. Honest technical disagreement, backed by evidence, is more valuable than agreeing just to move forward.

**If the previous Codex message hinted at drip-feeding** (e.g. "I'll look at X next round," thin coverage for a dense spec), add: *"Please include any remaining concerns in your next message — we have a limited round budget and I want to make sure I hear everything."*

If findings warrant spec changes, update the spec file and mention what changed in your response.

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
 CODEX SPEC REVIEW  COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Spec: [spec file path]
 Verdict: [APPROVED / IN PROGRESS / MAX ROUNDS]
 Discussion Rounds: [count]
 Spec Updated: [yes/no]
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
4. **Evidence-based** — verify every finding against actual spec text and/or codebase before agreeing or disagreeing
5. **Update the spec** — if findings are valid, actually fix the spec file
6. **Prefer the passed path** — if you (Claude) just wrote the spec in this session, pass the path as an argument rather than relying on auto-detection
7. **User is arbiter** — when you and Codex can't agree, ask the user
8. **Honest over agreeable** — if Codex is wrong, say so with evidence. If Codex is right, update the spec properly. Never make a superficial spec edit just to resolve a finding.
