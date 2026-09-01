---
description: Have a partner agent run a multi-specialist PR review (pr-review-toolkit panel) via the dualog MCP server
argument-hint: [optional: pr:<number|url>] [optional: diff_target (branch|uncommitted|staged|commit:<sha>)] [optional: aspects:code,tests,errors,comments,types,simplify] [optional: review focus] [optional: rounds:N] [optional: effort:<level>] [optional: model:<id>] [optional: partner:<agent-id>]
allowed-tools: mcp__dualog__start_pr_review, mcp__dualog__get_pr_review_report, mcp__dualog__check_messages, mcp__dualog__wait_for_partner_response, mcp__dualog__send_message, mcp__dualog__get_full_history, mcp__dualog__check_partner_alive, mcp__dualog__send_key, mcp__dualog__end_dialog, mcp__dualog__list_sessions, mcp__dualog__list_models, mcp__dualog__list_adapters, mcp__dualog__check_adapter, Bash, Read, Glob, Grep, Edit, Write, AskUserQuestion, LSP, Monitor
---

# /dualog-review-pr - Multi-Specialist PR Review

Runs the `pr-review-toolkit` panel through the `dualog` MCP server: the partner
agent reviews the same change once per **aspect**, each pass carrying a single
specialist's rubric, and then consolidates every pass into one prioritized
report.

This is not `/dualog-review-code` with more words. That command runs one general
reviewer in one pass. This one runs several narrow reviewers and merges them,
which finds a different class of problem — the test gap, the swallowed error,
the comment that no longer matches the code — because no single pass is trying
to hold all six concerns at once.

Any connected agent can be the panel. Codex can panel-review for Claude, Claude
for Grok, and so on.

---

## TASK

Review PR: $ARGUMENTS

---

## PHASE 0: PARSE AND DETECT

```bash
PROJECT_DIR="$(git rev-parse --show-toplevel)"
git branch --show-current
```

Parse $ARGUMENTS:

- **pr**: `pr:<number>` or a GitHub PR URL. Passing this fetches the change with
  `gh`, so it reviews what is actually on the PR rather than what is in your
  working tree. Requires an authenticated `gh`.
- **diff_target**: used only when no `pr` is given. `branch` (default),
  `uncommitted`, `staged`, or `commit:<sha>`. The default is `branch` because a
  PR review is branch-shaped; if the work is not committed yet, pass
  `uncommitted` explicitly.
- **aspects**: `aspects:a,b,c` to pin the panel. Omit it and the server selects
  from the diff.
- **review_focus**: remaining free text after the control tokens.
- **follow_up_rounds**: from `rounds:N`. Omit unless the user asked.
- **reasoning_effort** / **model**: from `effort:<level>` / `model:<id>`. Omit
  unless the user asked.
- **partner_agent**: from `partner:<agent-id>`; default `codex`. Call
  `list_adapters` if you need to know what is installed.

Do not assert from memory which models exist or which efforts they accept —
that depends on the specific model and changes whenever a vendor ships. Call
`list_models` if you need to check, pass the user's values through as given, and
surface any server error verbatim rather than pre-judging the combination.

---

## PHASE 1: START THE PANEL

Call `start_pr_review` with `project_path` and whatever the user specified.

**Read the response before you wait on it.** It tells you:

- `aspects` — the specialists that will run, one partner turn each
- `skipped_aspects` — every aspect that will NOT run, with the reason
- `total_passes` — specialists plus one consolidation pass
- `max_rounds` / `follow_up_rounds` — the panel is counted in `max_rounds`,
  because every pass appends a partner message; `follow_up_rounds` is the
  conversation budget after the panel reports

The skipped list is the half that is easy to miss and most worth reading. An
aspect nobody ran is not an aspect that came back clean. If the user cares about
a skipped aspect, restart with an explicit `aspects:` list rather than reading
its silence as approval.

**Verify what the server used.** `requested_model` / `requested_reasoning_effort`
echo what you passed; `model` / `reasoning_effort` are what resolved. If
something you specified comes back `null` in a *requested* field, it never
arrived — end the session and retry. A difference between requested and resolved
is normal (an alias translation, or a deliberately omitted effort resolving to
the model's default) and is explained in `notices`. Read
`effective_reasoning_effort` to know what the turn actually runs at.

Note `pr.state` and `pr.is_draft` if present, and mention a closed, merged, or
draft PR to the user rather than reviewing it silently.

---

## PHASE 2: WAIT OUT THE PANEL

Each pass appends its report as it finishes, so **the first partner message is
not the finished review**. Expect `total_passes` partner messages before the
conversation phase begins.

Arm a Monitor on the session's `conversation.jsonl` — use the literal
`review_dir` from the start response:

```bash
tail -F -n 0 "<review_dir>/conversation.jsonl" 2>/dev/null | \
  grep --line-buffered -E '"from":"(<partner_agent>|system)"'
```

Note there is **no `-m 1`** here, unlike `/dualog-review-code`: the panel
produces several messages in a row, and a one-shot grep would fire on pass 1 and
then go quiet while five more passes ran unobserved.

- `description`: `PR review panel progress in <SESSION_ID>`
- `timeout_ms`: `1800000` — a panel is several full turns back to back, and the
  per-turn wait hint applies to each pass, not to the panel as a whole
- `persistent`: `false`

Call `get_pr_review_report` rather than `check_messages` to see where the panel
stands. It is the only view that separates the three states that matter:
`aspects_reported`, `aspects_pending`, and `aspects_failed`. A failed pass means
that aspect was **not reviewed** — say so in your summary rather than letting it
read as clean.

If the Monitor times out with no event, call `check_partner_alive` and inspect
`partner_terminal.activity` and `capture.tail_text`. If the pane is blocked on an
interactive prompt, use `send_key` only when the visible choice is already
authorized by the user's request and does not broaden or persist permissions.

The panel is done when `panel_complete` is true and `consolidated_report` is
populated.

---

## PHASE 3: ACT ON THE CONSOLIDATED REPORT

The consolidated report is ordered Critical → Important → Suggestions, with a
Coverage section and a recommended action plan. Work it in that order.

For each finding:

1. **Read the actual code** at the cited location. Use LSP to trace callers and
   definitions before you judge it.
2. Decide VALID / PARTIALLY VALID / INVALID.
3. If VALID, fix it, then say what you changed and why the fix is correct.
4. If INVALID, refute it with specific evidence — file, line, the logic that
   already handles the case. Honest disagreement backed by code is more useful
   than agreeing to move on.

**Resolve testable claims now.** If a finding can be settled with a command, a
grep, or a test run, run it before responding.

Cross-check the panel against itself. Where two specialists disagree — the
simplifier proposing a rewrite of code the error specialist called correct —
that disagreement is signal about a genuinely unclear piece of code. Raise it
rather than silently picking one.

Send ONE consolidated `send_message` per round covering every fix, every
disagreement, and every answer. Splitting them across messages costs a round
each.

---

## PHASE 4: COMPLETION

Call `get_pr_review_report` for the final state and report:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 PR REVIEW PANEL  COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 Verdict:   [APPROVED / CHANGES REQUESTED / NEEDS DISCUSSION]
 Panel:     [aspects that reported]
 Not run:   [skipped + failed aspects, with reasons]
 Findings:  [X critical, Y important, Z suggestions]
 Session:   [session_id]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Always state what was NOT reviewed. A panel that ran four of six aspects gave a
four-aspect answer, and a reader who is not told that will assume six.

Call `end_dialog` to clean up.

---

## KEY PRINCIPLES

1. **Several messages, one review.** Do not report pass 1 as the verdict.
2. **Skipped is not clean.** Always surface `skipped_aspects` and
   `aspects_failed`.
3. **`simplify` is opt-in.** It proposes rewrites rather than reporting defects,
   so it is excluded from auto-selection. Ask for it by name, ideally after the
   review passes.
4. **Budget covers the panel.** `max_rounds` includes every pass;
   `follow_up_rounds` is the conversation after them.
5. **Evidence both ways.** Back agreements and refutations with real code.
6. **User is arbiter** when you and the panel cannot agree after two rounds.
