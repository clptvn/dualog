# claude-codex-dialog

A bidirectional MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex CLI](https://github.com/openai/codex). It runs background review/dialog runners so either tool can host the conversation while the other acts as the reviewing partner.

## Features

- **Bidirectional host support** — Claude can host Codex reviews, or Codex can host Claude reviews
- **General Dialog** — open-ended technical discussions between the two agents
- **Code Review** — the partner agent auto-generates an initial review from a git diff
- **Plan Review** — adversarial review of implementation plans before code is written
- **Spec Review** — adversarial review of product/feature specs before planning or implementation
- **Code Audit** — deep audits of existing files for bugs, architecture issues, robustness, and security
- **UI implementation partnership** — Codex can delegate frontend/UI implementation to Claude Opus 4.7 while Codex owns backend/API/data integration
- **Claude-only enforcement hooks** — optional guardrails on the Claude side; no equivalent Codex hooks are installed

## How it works

### Dialog mode
1. The host agent calls `start_dialog`
2. The server spawns a background runner for the configured partner agent
3. The host sends messages with `send_message`
4. The runner starts the real interactive partner CLI in a detached tmux session, pastes the prompt into the TUI, waits for sidecar completion files, and appends replies to `conversation.jsonl`
5. The conversation continues until ended or the hard round cap is reached

### Code review mode
1. The host agent calls `start_code_review`
2. The server generates a git diff and spawns a review runner
3. The partner agent auto-generates an initial review from the diff
4. The host reads findings via `check_messages`, investigates, fixes or rebuts, and replies with `send_message`
5. The review continues until MCP responses report `review_status.approved: true`, the hard cap is reached, or the session is ended

Session data is stored under `~/.claude/dialogs/`.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on your `PATH` if you want Claude-hosted commands or Claude as a review partner
- [Codex CLI](https://github.com/openai/codex) on your `PATH` if you want Codex-hosted skills or Codex as a review partner
- `tmux` on your `PATH` for partner sessions. The server uses detached tmux sessions and does not open terminal windows.

For the full bidirectional install, both CLIs should be available.

macOS, Linux, and WSL are supported when `tmux` is installed. Native Windows can still run the installer wrappers, but partner sessions require a tmux-capable environment such as WSL.

## Install

macOS, Linux, WSL, Git Bash, or Windows PowerShell:

```bash
git clone https://github.com/clptvn/claude-codex-dialog.git
cd claude-codex-dialog
npm run setup
```

Default install mode is `--both`, which does all of the following:

- registers the MCP server for Claude
- installs Claude slash commands:
  - `/codex-review-code`
  - `/codex-review-plan`
  - `/codex-review-spec`
  - `/codex-audit`
- installs Claude-only investigation hooks
- registers the MCP server for Codex
- installs Codex skills:
  - `/claude-review-code`
  - `/claude-review-plan`
  - `/claude-review-spec`
  - `/claude-audit`
  - `/claude-ui-implementer`

You can also install only one side:

```bash
npm run setup -- --claude
npm run setup -- --codex
npm run setup -- --both
```

POSIX shell wrappers are still available:

```bash
./install.sh --claude
./install.sh --codex
./install.sh --both
```

PowerShell wrappers are also available:

```powershell
.\install.ps1 -Claude
.\install.ps1 -Codex
.\install.ps1 -Both
```

To uninstall:

```bash
npm run uninstall
```

Or remove only one side:

```bash
./uninstall.sh --claude
./uninstall.sh --codex
./uninstall.sh --both
```

Or in PowerShell:

```powershell
.\uninstall.ps1 -Claude
.\uninstall.ps1 -Codex
.\uninstall.ps1 -Both
```

Restart the relevant CLI after installation or uninstall so it reloads MCP config and commands/skills.

## MCP Tools

### Dialog

| Tool | Description |
|------|-------------|
| `start_dialog` | Start a new dialog session with a configurable host/partner agent pair |

### Code Review

| Tool | Description |
|------|-------------|
| `start_code_review` | Start a review session where the configured partner auto-generates an initial review from a git diff |
| `get_review_summary` | Get review metadata, structured findings, and `review_status` approval state |

### Shared

| Tool | Description |
|------|-------------|
| `send_message` | Send a message from the host agent into an ongoing session |
| `check_messages` | Read new partner messages, current runner status, and parsed `review_status` |
| `wait_for_partner_response` | Long-poll until the partner replies, the session reaches a terminal condition, or this wait call times out |
| `get_full_history` | Get the complete conversation history |
| `check_partner_alive` | Check runner status, inferred partner activity, and a compact tail of the live or saved tmux pane |
| `end_dialog` | End the session and return the final conversation |
| `list_sessions` | List all dialog and review sessions |

`review_status` uses closed enum values:

- `state`: `approved`, `changes_requested`, `needs_discussion`, `in_progress`, `hard_cap_reached`
- `verdict`: `APPROVE`, `CHANGES_REQUESTED`, `NEEDS_DISCUSSION`, `IN_PROGRESS`, `HARD_CAP_REACHED`, or `null`
- `source`: `structured_verdict`, `legacy_lgtm`, `legacy_approve`, `blocking_findings`, `hard_cap`, `none`
- `close_allowed_reason`: `approved`, `hard_cap`, or `null`
- Always-present fields: `schema_version`, `state`, `approved`, `close_allowed`, `close_allowed_reason`, `verdict`, `source`, `source_message_id`, `partner_agent`, `allows_approve_verdict`, and `hard_cap_reached`

### Waiting for partner responses

Use `wait_for_partner_response` instead of repeatedly polling while the background runner is invoking the partner CLI.

- After `start_code_review`, call `wait_for_partner_response` with `since_id: 0` to wait for the initial review.
- After `send_message`, call `wait_for_partner_response` with `since_id` set to the returned `message_id`.
- The default wait timeout is 10 minutes. Explicit waits only bound the MCP wait call; they do not kill the partner. If a wait returns `timeout_processing`, call `check_partner_alive` and inspect `partner_terminal.activity` plus `partner_terminal.capture.tail_text` to decide whether it is making progress, stuck, or should be ended.
- The tool returns the same public payload as `check_messages`, plus `wait_result`, `waited_ms`, `timed_out`, and `next_since_id`.
- `wait_result` is one of `message`, `error`, `runner_exited`, `ended`, `hard_cap`, `timeout_processing`, `timeout_idle`, or `cancelled`.

## Usage

### In Claude Code

After Claude-side install:

```text
/codex-review-code
/codex-review-code staged security
/codex-review-plan path/to/plan.md
/codex-review-spec docs/specs/foo.md
/codex-audit src/
```

### In Codex

After Codex-side install:

```text
/claude-review-code
/claude-review-code staged security
/claude-review-plan path/to/plan.md
/claude-review-spec docs/specs/foo.md
/claude-audit src/
/claude-ui-implementer implement the settings billing UI
```

## Configuration

Defaults preserve the original flow:

- `host_agent` defaults to `claude`
- `partner_agent` defaults to `codex`
- `partner_command` defaults based on `partner_agent`

To invert the flow, set:

- `host_agent: "codex"`
- `partner_agent: "claude"`

Both `start_dialog` and `start_code_review` also accept:

- `partner_command`
- `model`: forwarded to the selected partner CLI. Codex examples: `gpt-5.6` (the Sol alias), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`. Claude examples: `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-8[1m]`, `claude-opus-4-7[1m]`, `claude-opus-4-6[1m]`, `claude-sonnet-4-6`. Claude Fable 5 has 1M context by default; do not add a `[1m]` suffix.
- `reasoning_effort`: defaults to `high` when omitted. Codex accepts `low`, `medium`, `high`, `xhigh`, GPT-5.6's `max` effort, and the Codex-only `ultra` mode for GPT-5.6 Sol and Terra.
- `max_rounds`
- `partner_timeout_ms`: backward-compatible wait hint for clients that choose their own `wait_for_partner_response.timeout_ms`. Defaults to `900000` (15 minutes). It no longer kills partner CLI turns.

Partner runtime details:

- Claude partners run through the real interactive `claude` CLI in tmux. The server does not use `claude -p` or the Agent SDK. Claude partner sessions use an empty strict MCP config so nested partner turns do not recursively load the host's MCP servers.
- Codex partners run through the real interactive `codex` CLI in tmux. The server does not use `codex exec` for partner turns. Codex partner turns use a per-session `CODEX_HOME` with copied auth and no user MCP config, so nested Codex does not recursively boot the host's MCP servers.
- GPT-5.6 is currently a limited preview in Codex and the API, and is not yet available in ChatGPT. Selecting a GPT-5.6 model requires a provisioned Codex workspace and a Codex CLI version whose model catalog includes it.
- tmux sessions use the dedicated `codex-dialog` tmux socket by default, isolated from the user's normal tmux server and config. Override with `CODEX_DIALOG_TMUX_SOCKET` if needed.
- Completion is delivered through per-turn sidecar files under `~/.claude/dialogs/<session_id>/turns/`.
- `check_partner_alive` includes `partner_terminal.activity`, which summarizes whether the partner appears to be thinking, reading/searching files, running a command, writing, starting, idle, or unknown. When visible, it also extracts the model label, status verb, elapsed time, and token count from the CLI status line.
- `check_partner_alive` returns only `partner_terminal.capture.tail_text` by default, capped to a few bottom pane lines to avoid filling the caller's context window. Pass `include_full_capture: true` only when you intentionally need the full bounded pane capture.
- Active partner turns are not killed by wall-clock timeout. This is intentional: the host agent should inspect the pane and call `end_dialog` when a partner is actually stuck, rather than relying on a blind timer for large reviews.
- Once a partner turn starts, pane activity classification is diagnostic only. Idle, unknown, or unchanged activity never times out or terminates the tmux session; the turn waits for explicit completion, partner-process exit, or `end_dialog`.
- Inactive runners with no active turn self-shutdown after `CODEX_DIALOG_IDLE_SHUTDOWN_MS` milliseconds, defaulting to 24 hours, so abandoned sessions do not poll forever.
- Runner shutdown and server restart do not sweep or terminate active `ccd-*` sessions. The `end_dialog` tool is the explicit cleanup path; manual emergency cleanup remains available with `tmux -L codex-dialog kill-server`.
- During long turns the runner periodically saves pane captures, so a later partner crash can report the last observed terminal tail or full saved capture path instead of only saying the tmux session disappeared.

`start_dialog` also accepts:

- `tool_profile`: `read` by default. Claude read-profile sessions disallow the known file-edit tools in addition to prompting for read-only behavior, but Bash remains available for inspection commands. Use `implementation` only when the partner should edit files, such as the `/claude-ui-implementer` Codex skill.
- `subject_path`: optional path to a reviewed document, such as a plan or spec. The dialog runner rereads this file before every partner turn and includes the current contents as authoritative context.
- `subject_kind`: optional label for `subject_path`: `plan`, `spec`, or `document`.

The server still accepts `codex_command` for backward compatibility, and also accepts `claude_command` when Claude is the configured partner.

## Round budget

Each session has a soft round budget, default `5`, with a hard cap of `soft + 5`.

Every `check_messages`, `wait_for_partner_response`, `send_message`, and `check_partner_alive` response includes:

```json
{
  "max_rounds": 5,
  "hard_cap": 10,
  "rounds_used": 2,
  "rounds_remaining": 3,
  "hard_rounds_remaining": 8,
  "past_soft_cap": false
}
```

The runners explicitly instruct the partner agent to deliver complete feedback each round instead of drip-feeding findings.

## Hooks

The investigation-enforcement hooks are installed only for Claude-hosted flows. They are intentionally not installed for Codex-hosted flows.

## License

MIT
