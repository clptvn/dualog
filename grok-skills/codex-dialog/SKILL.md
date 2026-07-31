---
name: codex-dialog
description: Decide whether to consult the codex-dialog MCP server from Grok Build for an independent second opinion, and route to /codex-review-code, /codex-review-plan, /codex-review-spec, /codex-audit, or a raw dialog. Use when the user asks to consult Codex/Claude/Grok as a partner, wants a diff/plan/spec red-teamed, or needs an outside model on contested design. Skip ordinary self-review, lookups, mechanical edits, known root causes, and quick/simple asks. Partner turns spawn a real CLI in detached tmux and block on wait_for_partner_response.
user-invocable: true
---

# Routing to codex-dialog (Grok Build host)

You are the **host**. Default partner is **Codex** (`partner_agent: "codex"`). Partners can also be Claude or Grok when requested.

Tool names on Grok are **`codex-dialog__*`** (not Claude’s `mcp__codex-dialog__*`). Call them via MCP (`search_tool` / `use_tool`) or the exposed tool surface.

Always pass **`host_agent: "grok"`** on `start_dialog` / `start_code_review`.

## Pre-flight

Each round spawns a full model in tmux. `wait_for_partner_response` defaults to ~10 minutes; partner-turn hint ~15 minutes. Soft budget 5 rounds, hard cap `max_rounds + 5`.

1. **Explicit request** — user ran `/codex-review-*`, `/codex-audit`, or asked to consult a partner → route.
2. **Otherwise** require all three or **ABORT**:
   - Independent judgment is the deliverable (high blast radius / contested).
   - You already did the work (read the code first).
   - User left room (not “quick/just/simple”).

## Routing

| Subject | Route |
|---|---|
| Changes just made (uncommitted/staged/branch/commit) | `/codex-review-code` |
| Existing code as it stands | `/codex-audit` |
| WHAT/WHY (spec, PRD) | `/codex-review-spec` |
| HOW (plan, migration) | `/codex-review-plan` |
| Open question, no artifact | raw dialog |

Prefer a slash command when one fits.

## Raw dialog

```
codex-dialog__start_dialog(
  problem_description, project_path,
  host_agent: "grok", partner_agent: "codex"   # or claude / grok if requested
) → session_id
codex-dialog__send_message(session_id, <actual prompt>) → message_id   ← REQUIRED
codex-dialog__wait_for_partner_response(session_id, since_id: message_id)
  → inspect new_messages, budget, review_status
  → read_file every cited path, then send_message again (or end_dialog)
codex-dialog__end_dialog(session_id)
```

Never sleep-poll. Never use Claude Monitor.

| wait_result | Action |
|---|---|
| `message` | Continue |
| `timeout_processing` | Wait again |
| `timeout_idle` | `check_partner_alive`, then decide |
| `runner_exited` / `hard_cap` / `ended` | Close out |
| `error` | Inspect `last_error`; may still be alive |
| `cancelled` | Only this wait aborted; re-check state |

Pass **`project_path` explicitly** (server cwd may be wrong).

## Partner write safety

- **Codex** partner: `tool_profile: "read"` uses read-only sandbox; `implementation` allows writes.
- **Claude** partner: read profile disallows edit tools but keeps Bash.
- **Grok** partner: read profile disallows edit/image tools; isolated `GROK_HOME` with empty MCP.

## Anti-patterns

- Consulting a partner for something `read_file` answers
- Accepting findings without verifying file:line
- Raising `max_rounds` to “win”
- Sleep-polling instead of `wait_for_partner_response`
- Abandoning live sessions without `end_dialog`
