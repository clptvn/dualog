# dualog

An MCP server that lets one AI coding agent hold a real, multi-round conversation
with a **different** AI coding agent running in its own CLI — for code review,
plan review, spec review, and audits.

Two agents, one dialog. Neither is the tool of the other; they argue.

```
Claude Code  ──►  dualog  ──►  Codex / Grok / opencode / Qwen / Cursor / …
     ▲                              │
     └──────────  findings  ◄────────┘
```

The partner is not called through an API. It is the **real CLI**, running in a
detached tmux session or headlessly, with its own auth, its own tools, and its
own opinions.

## Supported agents

Run `list_adapters` to see which are installed on your machine.

| Agent | id | Engine | Notes |
| --- | --- | --- | --- |
| Claude Code | `claude` | tmux or headless | Renders inline, no alt screen — the best TUI target |
| Codex | `codex` | tmux or headless | `--oss --local-provider ollama` drives local models with no extra setup |
| Grok Build | `grok` | tmux or headless | Positional prompt seeds the TUI, so no keystroke injection |
| opencode | `opencode` | headless | Best route to local/OSS models via an OpenAI-compatible base URL |
| Qwen Code | `qwen` | headless | Full `OPENAI_BASE_URL` support (Ollama, LM Studio, vLLM, OpenRouter) |
| Cursor Agent | `cursor` | headless | |
| Goose | `goose` | headless | |

Anything else is a JSON file away — see **[docs/adding-an-agent.md](docs/adding-an-agent.md)**,
which includes ready-made recipes for aider, crush, copilot, droid, amp,
openhands, continue, and cline.

Gemini is deliberately **not** shipped: Google stopped serving Gemini CLI
requests for the free tier, AI Pro, AI Ultra, and individual Code Assist on
2026-06-18, and its `isHeadlessMode()` checks `CI=true` unconditionally, which
makes the TUI unreachable in most agent harnesses. `qwen` is the actively
maintained fork and covers the same ground.

## Install

```bash
git clone https://github.com/clptvn/dualog.git
cd dualog
npm run setup            # or: --claude | --codex | --both
```

Requires Node ≥ 18, `tmux` for tmux-engine partners, and whichever agent CLIs
you actually want to use. macOS, Linux, Windows, and WSL are supported.

On native Windows, dualog automatically runs interactive sessions through tmux
in the default WSL distribution, converting project, session, and isolated
config paths to their WSL locations. It first checks that both tmux and the
selected partner CLI are available in that distribution. If an adapter supports
headless mode and its WSL CLI is unavailable, dualog falls back to headless
instead. Set `DUALOG_WSL_DISTRO` to select a different distribution or
`DUALOG_WSL_BINARY` to use a non-default WSL launcher. An explicit
`DUALOG_TMUX_BINARY` continues to run tmux directly rather than through WSL.

Upgrading from `claude-codex-dialog`? The installer migrates you: it removes the
old `codex-dialog` MCP registration, rewrites hook matchers, and deletes the old
slash commands. The tool namespace moves from `mcp__codex-dialog__*` to
`mcp__dualog__*`, so this is a clean break rather than a dual-registration.
Existing sessions under `~/.claude/dialogs` stay readable.

## Use

```
/dualog-review-code                       review uncommitted changes
/dualog-review-code staged security       narrow the diff and the focus
/dualog-review-plan path/to/plan.md
/dualog-review-spec docs/specs/foo.md
/dualog-audit src/
```

Add `partner:<agent-id>` to any of them to choose who reviews.

## Tools

`start_dialog`, `start_code_review`, `send_message`, `check_messages`,
`wait_for_partner_response`, `get_full_history`, `get_review_summary`,
`check_partner_alive`, `end_dialog`, `list_sessions`, and:

- **`list_adapters`** — every agent this server can drive, its capabilities, and
  whether its binary is actually installed
- **`check_adapter`** — preflight one agent against the options you intend to
  use, before starting a session

## How a turn works

1. The full prompt is written to `turns/<id>/prompt.md`.
2. The partner CLI is launched — in tmux, or headlessly.
3. It is handed a short bootstrap that points at the prompt file and states the
   completion protocol.
4. It does the work, writes `result.md`, then `done.json`.
5. The runner reads the sidecars and appends the reply to `conversation.jsonl`.

The indirection through files is deliberate: terminal output is wrapped,
truncated, interleaved with tool chatter, and in most CLIs impossible to
delimit. `done.json` also proves the partner actually had working write
access — a capability several CLIs revoke silently in headless mode.

Turns are never killed by a wall-clock timeout. The host inspects the pane with
`check_partner_alive` and calls `end_dialog` when a partner is genuinely stuck.

## Adding an agent

A manifest, dropped in a directory. No source changes:

```json
{
  "id": "mycli",
  "displayName": "My CLI",
  "binary": { "default": "mycli" },
  "engines": { "default": "headless", "allowed": ["headless"] },
  "capabilities": { "modelFlag": true, "reasoningEffort": false,
                    "toolProfiles": "none", "addDir": false,
                    "writesFiles": true, "tuiDrivable": "no" },
  "mcp": { "strategy": "none" },
  "promptDelivery": { "headless": "argv" },
  "argv": { "headless": [
    { "args": ["run", "--yes"] },
    { "when": { "set": "model" }, "args": ["--model", "{{model}}"] },
    { "args": ["{{initialPrompt}}"] }
  ] },
  "completion": { "sidecar": "always", "stdoutTrustworthy": false }
}
```

Save to `~/.config/dualog/adapters/mycli.json`. Manifests merge by `id`, so you
can also patch a shipped adapter — point it at a wrapper script, add env vars,
retune markers — without forking.

Validation is strict and every error names the file it came from. The contract
suite in `npm test` runs over every registered adapter automatically.

## Recursion guard

Every spawned partner gets `DUALOG_ROLE=partner` and an incremented
`DUALOG_DEPTH`. A nested copy of this server sees the sentinel and serves an
empty tool list instead of recursing.

This is unconditional and does not depend on per-CLI cooperation, which matters:
several agent CLIs have no reliable "disable MCP" switch, and some read MCP
config from `homedir()` regardless of their config-dir override. Env inherits
transitively, so it also covers partner-spawns-partner.

## Configuration

`start_dialog` and `start_code_review` accept `partner_agent`, `partner_command`,
`model`, `reasoning_effort`, `max_rounds`, `tool_profile`, `subject_path`.

Model strings are forwarded verbatim; unknown values pass through with a warning
rather than being rejected, because vendors ship new ids continuously. Reasoning
effort **is** validated against the chosen agent — an unsupported effort flag can
stop a CLI from starting — and a dropped option is reported back to the caller
rather than silently ignored.

Environment: `DUALOG_TMUX_SOCKET`, `DUALOG_TMUX_BINARY`, `DUALOG_IDLE_SHUTDOWN_MS`,
`DUALOG_STRATEGY`, `DUALOG_ADAPTER_PATH`, `DUALOG_MAX_DEPTH`. The former
`CODEX_DIALOG_*` names still work as aliases.

Sessions live in `~/.dualog/sessions/`.

## Round budget

Soft default 5 rounds, hard cap soft + 5. Every response carries
`{max_rounds, hard_cap, rounds_used, rounds_remaining, hard_rounds_remaining,
past_soft_cap}`. Partners are told to deliver complete feedback each round
rather than drip-feeding findings across rounds.

## Testing

```bash
npm test                 # contract suite, argv snapshots, marker equivalence, engines
npm run smoke:wait-tool  # boots the real MCP server over stdio
```

Most supported CLIs are not installed on any given machine and have no free
tier, so everything except the vendor's own behavior is made testable:
schema validation, golden argv snapshots, fake CLI binaries driven through the
real engines, and marker matching replayed against recorded pane transcripts
with a cross-contamination guard (one agent's idle markers must never match
another's busy screen).

## License

MIT
