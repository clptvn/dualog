---
name: dualog-ui-implementer
description: Use when the user wants Codex to partner with Claude on frontend/UI implementation while Codex owns backend, data, API, and integration work. Starts an editable dualog session with Claude as the frontend implementation partner, then coordinates the frontend/backend handoff until the feature is integrated.
---

# Claude UI Implementer

Use this skill when a user asks to build or modify a feature that has meaningful UI/frontend work and wants Claude to implement that UI through the `dualog` MCP server.

Codex remains the host, integrator, and final verifier. Claude owns frontend/UI implementation.

## Preconditions

Before starting, confirm the `dualog` MCP tools are available. If `mcp__dualog__start_dialog` is not exposed in the current session, report that exact blocker and stop; do not pretend the collaboration is running.

## Parse the user's request

Interpret the invocation text as the feature request plus optional controls:

- `rounds:N`: optional soft round budget override
- `model:<name>`: optional partner model override
- `effort:<level>`: optional partner effort override
- `timeout:<minutes>` or `timeout:<minutes>m`: optional wait hint for long partner turns, in minutes

Do not assert from memory which models exist or which effort levels they accept. Which efforts are valid depends on the specific MODEL, not on the agent — one model accepts `max` but not `xhigh` while its sibling accepts both — and that table changes whenever a vendor ships. If the user names a model and you need to check it, call `mcp__dualog__list_models` for the partner agent first and use what it returns; it also reports whether that list is a live catalog or a hand-maintained fallback.

Pass the user's model and effort through as given. The server validates the pair and returns an error naming the model, exactly what it accepts, and where that came from. Surface that error verbatim rather than pre-judging the combination yourself.

Defaults for this skill:

- `model`: `claude-opus-4-7[1m]`
- `reasoning_effort`: `high`
- `tool_profile`: `implementation`

Only override the default model or effort if the user explicitly provided `model:*` or `effort:*`. The default model above is this skill's preference, not a claim that it is the only one available — if the server rejects it, call `mcp__dualog__list_models` and pick the closest equivalent rather than guessing.
Pass `partner_timeout_ms` only if the user explicitly provided `timeout:*`, or use `1800000` if the user explicitly provided `effort:max` without a timeout override. This is a wait hint only; the server does not kill interactive tmux partner turns when a wait expires.

## Split the work

Determine the git root first and use it as `project_path`.

Inspect enough of the codebase to identify:

- frontend routes/components/styles/client state Claude should own
- backend/API/data/domain/test work Codex should own
- shared types, API contracts, schemas, or fixtures that require coordination
- validation commands likely needed for this repo

Create a concise ownership contract:

- **Claude owns:** frontend/UI files and client-side behavior.
- **Codex owns:** backend services, server actions/API routes, database/schema work, auth/security, tests, and final integration.
- **Shared boundary:** types, API response shapes, form contracts, and routing conventions. Claude may read and use these, but should ask before changing backend-owned files.

Do not send Claude a vague assignment. Give it concrete files or search targets when possible.

## Start Claude

Call `mcp__dualog__start_dialog` with:

- `project_path`
- `host_agent: "codex"`
- `partner_agent: "claude"`
- `model: "claude-opus-4-7[1m]"` unless overridden
- `reasoning_effort: "high"` unless overridden
- `tool_profile: "implementation"`
- `max_rounds` only if the user provided `rounds:N`
- `partner_timeout_ms` if selected during invocation parsing
- `problem_description`: `Frontend implementation collaboration for: <short feature summary>. Claude owns UI/frontend implementation; Codex owns backend/API/data/integration and final verification.`

Save the returned `session_id`.

## First message to Claude

Send one `mcp__dualog__send_message` with this structure:

```text
## UI Implementation Request

You are Claude working as the frontend/UI implementation partner. You may edit files, but keep edits scoped to the frontend/UI ownership described below.

### User Feature Request
[raw or summarized user request]

### Ownership
Claude owns:
- [frontend routes/components/styles/client state]

Codex owns:
- [backend/API/data/domain/test/integration work]

Shared boundary:
- [types/contracts/routes/props/API shapes that both sides must preserve]

### Frontend Task
[specific UI work Claude should implement]

### Existing Conventions To Follow
[design system, component library, routing/state patterns, relevant files]

### Constraints
- Implement the UI for real; do not leave TODOs, stubs, mock-only behavior, or placeholder wiring.
- Use existing project conventions and components.
- Do not rewrite backend, database, auth, billing, or infrastructure code.
- If you need a backend/API/type change, describe the requested contract instead of making broad backend edits.
- Keep the changed file set focused.
- After editing, summarize what changed, list changed files, and call out any integration needs or blockers.

### Expected Response
- Changed files
- Implementation summary
- Backend/API contract needed from Codex, if any
- Validation attempted and results
```

## Work in parallel

After sending the first message, immediately work on the Codex-owned backend/API/data/test side. Avoid editing the frontend files assigned to Claude while Claude is running.

Prefer the MCP wait tool instead of repeated polling:

1. Call `mcp__dualog__wait_for_partner_response` with `session_id` and `since_id` set to the latest message you sent. If `partner_timeout_ms` was set, pass `timeout_ms: partner_timeout_ms - 60000`.
2. If the wait tool is not exposed in the current session, fall back to waiting on the session file with a shell tail.
3. If neither wait tool nor shell tail is available, poll `mcp__dualog__check_messages` every 5 seconds.

If `wait_result` is `timeout_processing` or `timeout_idle`:

1. Call `mcp__dualog__check_partner_alive`.
2. Inspect `partner_terminal.activity` and `partner_terminal.capture.tail_text` to see Claude's compact live tmux status.
3. If the runner died or `last_error` is populated, report it honestly.
4. If the runner and tmux session are alive and the pane shows useful progress, continue waiting.
5. If the pane shows an idle prompt, repeated unchanged output, a stuck prompt, or malformed sidecar state, end the session or ask the user before restarting. Do not proceed as if Claude completed the UI work.

## Integration loop

For each Claude response:

1. Read the files Claude changed before making any assumptions.
2. Check whether Claude stayed inside the frontend ownership boundary.
3. Integrate backend/API/type contract changes on the Codex side.
4. Resolve merge or wiring issues directly.
5. Run the relevant validation commands for the repo.
6. If validation exposes UI/frontend issues, send one consolidated message to Claude with the error output, file paths, and expected fix.

Keep each follow-up consolidated. One message should include all backend contract updates, validation failures, and UX concerns for that round.

If Claude touched backend-owned files unnecessarily, inspect the diff and either keep narrow valid integration edits or revert only edits you can verify came from this Claude session. Never revert unrelated user changes.

## Completion

Finish only when:

- Claude's frontend work is present in the working tree
- Codex has connected backend/API/data pieces as needed
- shared contracts are consistent
- validation has run or you can state exactly why it could not run
- no important unresolved Claude blockers remain

Before ending:

1. Call `mcp__dualog__get_full_history` if you need the full collaboration record.
2. Call `mcp__dualog__end_dialog`.
3. Report the session id, Claude-changed files, Codex-changed files, and validation results.
