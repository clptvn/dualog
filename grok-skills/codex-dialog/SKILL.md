---
user-invocable: true
name: codex-dialog
description: Decide whether to consult the codex-dialog MCP server from Grok Build for an independent second opinion, and route to the right entry point — /codex-review-code, /codex-review-plan, /codex-review-spec, /codex-audit, or a raw dialog. Use when the user asks you to consult Codex, wants a diff, plan, spec, or named code area red-teamed before it ships, or when a contested architecture decision needs an outside model. Skip ordinary self-review, syntax and lookups, mechanical edits, bugs with a known root cause, anything verifiable directly in under a minute, anything framed as quick or simple, and any passing mention of Codex that is not a request to run it. Consulting Codex spawns a real CLI in a detached tmux session and blocks on it. Full pre-flight gate is in the skill body.
---

# Routing to codex-dialog

A router. It owns four decisions: **whether to consult Codex at all, which door
to use, how to drive a raw dialog, and how to recover when a hook blocks you.**

It does not conduct reviews. Four slash commands do that, and they carry
argument parsing, budget tracking, and wait mechanics more precise than anything
reconstructed here. Route to them; do not reimplement them.

## Pre-flight

Each round spawns a full model in a detached tmux session and waits. The wait
tool defaults to a 10-minute poll and the partner-turn hint to 15 minutes —
size your expectations from that, not from a normal tool call. Budget is 5
rounds soft, hard cap `max_rounds + 5`.

**Step 1 — Explicit request.** If the user typed `/codex-review-*` or
`/codex-audit`, or asked you to consult Codex, skip to routing. Mentioning Codex
is not asking for it.

**Step 2 — Self-judge.** Otherwise all three must hold, or ABORT:

1. **Independent judgment is the deliverable.** Irreversible, contested, or
   high-blast-radius work qualifies. Review you would do anyway does not.
2. **You did the work first.** Codex tests *your* reasoning. If you haven't read
   the code, read it — `enforce-investigation` will block you regardless.
3. **The user left room.** "Quick", "just", "simple", "one-line" mean no.

On abort, do the work directly. If a second opinion would genuinely have helped,
name the specific command that fits.

## Routing

Route on the subject the user is asking about, not on repository state.

| Subject | Route |
|---|---|
| Changes they just made — uncommitted, staged, branch, commit | `/codex-review-code` |
| Existing code as it stands, named files or directories | `/codex-audit` |
| WHAT and WHY — product contract, feature spec, PRD | `/codex-review-spec` |
| HOW — implementation plan, sequencing, migration | `/codex-review-plan` |
| Open question with no diff and no document | raw dialog (below) |

Tie-breakers, since these overlap:

- **review-code vs audit: is the subject the change, or the code?** An audit of
  named files stays an audit even when the tree happens to be dirty.
- **spec vs plan is WHAT/WHY vs HOW.** An API proposal is a spec when the
  question is what to expose, a plan when it's how to ship it.

Prefer a command whenever one fits.

## Raw dialog

For architecture arguments and tie-breaks — questions with no artifact.

**`start_dialog` creates an empty conversation and sends nothing.** The sequence:

```
start_dialog(problem_description, project_path)   → session_id
send_message(session_id, <the actual prompt>)     → message_id   ← REQUIRED
wait_for_partner_response(session_id, since_id: message_id)
   → inspect new_messages, budget, review_status
   → Read every cited file, then send_message again  (or end_dialog)
end_dialog(session_id)
```

Skip that first `send_message` and the wait just burns its timeout — the
partner was never asked anything.

| Parameter | Notes |
|---|---|
| `problem_description` | The stable problem statement. |
| `project_path` | Optional — **falls back to the server's cwd**, which may be the wrong repo. Pass it explicitly. |
| `max_rounds` | Integer 1–50, default 5. **Do not override unless asked.** |
| `subject_path` | A document the partner re-reads every round. |
| `tool_profile` | `read` \| `implementation`. Not a write boundary — see below. |
| `host_agent` + `partner_agent` | To invert, set **both**: `host_agent: codex`, `partner_agent: claude`. |
| `reasoning_effort` | Defaults to `high`. |

State the disagreement, not the topic. "Is a queue right here?" burns a round;
"I chose a queue over a cron sweep because X — argue the other side" does not.

**Ask for the verdict in your first message.** Closure needs a structured
`REVIEW_VERDICT: APPROVE` (`VERDICT:`/`STATUS:` also parse; prose does not).

`wait_for_partner_response` returns a terminal state — branch on it rather than
retrying blindly:

| State | Meaning |
|---|---|
| `message` | Normal reply. Continue. |
| `timeout_processing` | Still working. Wait again. |
| `timeout_idle` | Nothing happening — check `check_partner_alive` before assuming failure. |
| `runner_exited` | Runner is dead. `end_dialog` is allowed without approval. |
| `error` | `last_error` is set. This is checked *before* liveness, so the runner may still be alive and closure may still be blocked — inspect, don't assume dead. |
| `hard_cap` / `ended` | Session is over. |
| `cancelled` | Only this wait call was aborted; cancellation does not end the session. Re-check state rather than assuming either way. |

## When a hook blocks you

| Block | Cause | Recovery |
|---|---|---|
| `BLOCKED: You have not investigated…` | Tagged finding with no validated file reference (degraded `__any__` marker) | Any one `Read` clears it |
| `BLOCKED: You still have N file(s)…` | Partner cited specific files | `Read` each; clearing matches on **canonical path** (symlinks resolved), one entry per exact match |
| `BLOCKED: Cannot end this session yet…` | No approval, hard cap not reached | Get `REVIEW_VERDICT: APPROVE`, or reach the cap |
| `BLOCKED: …review-status parser could not be loaded` | **Broken install** — not enforcement | Closure is impossible until the runtime is repaired. Report it and retry `end_dialog`; asking the partner for another verdict cannot help |

The first three are the tool working. Do not route around them.

Details that bite:

- Only the **`Read` tool** clears a marker. `cat`, `rg`, and shell inspection
  don't. The read must come **after** the response that armed it.
- Clearing an `__any__` marker clears it for **every** open session, not just
  yours — the hook scans all marker files.
- **Two different tag sets.** Investigation arms on `[CRITICAL]`,
  `[CORRECTNESS]`, `[ARCHITECTURE]`, `[SECURITY]`, `[ROBUSTNESS]`,
  `[SUGGESTION]`, `[QUESTION]`. Closure blocks on a different set that adds
  `[GAP]`, `[AMBIGUITY]`, `[SCOPE]`, `[FEASIBILITY]`, `[UX]`, `[TESTABILITY]`
  and drops the last two. An unresolved blocking tag can override an approval.
- **`/codex-audit` never requests a structured verdict** and doesn't read
  `review_status`, so it can hit the closure hook. Ask the partner for
  `REVIEW_VERDICT: APPROVE` before closing an audit.

## The partner can write

Codex partners always run `--sandbox workspace-write` with approvals disabled,
rooted at `project_path` plus the session directory — **including during a
review**. `tool_profile` does not change this.

For Claude partners, `read` removes `Edit`/`Write`/`MultiEdit`/`NotebookEdit`
but **keeps `Bash`** under `bypassPermissions`. It reduces accidental edits; it
is not a write-safety boundary.

Do not "fix" this by committing or stashing: `/codex-review-code` defaults to
the uncommitted diff, so stashing deletes the review target and committing
reclassifies it. If the tree holds work you can't risk, isolate with a worktree
or a disposable copy.

## Anti-patterns

- **Consulting Codex on something a `Read` answers.** A multi-minute round-trip
  to confirm what's in front of you is pure waste.
- **Accepting a finding you did not reproduce.** Verify each claim against the
  cited `file:line`. A finding you can't reproduce is not a finding.
- **Raising `max_rounds` to win.** Still disagreeing at round 5 means the
  disagreement needs the user, not another round.
- **Hand-rolling the wait.** Raw dialogs use `wait_for_partner_response`; the
  commands have their own Monitor-based wait. Never sleep-poll.
- **Abandoning a live session.** `list_sessions` finds strays, but an unapproved
  one won't close until approval, hard cap, or a dead runner — so close it
  deliberately rather than walking away.
