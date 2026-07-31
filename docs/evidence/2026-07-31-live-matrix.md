# Live / automated evidence — 2026-07-31

## Automated
| ID | Result | Notes |
|----|--------|-------|
| A1 npm test | **PASS** 16/16 | includes partner invocation + group targets + session limit |
| A2 smoke:wait-tool | **PASS** | includes grok host metadata, host=partner reject, group start |
| A3 grok host metadata | **PASS** | via smoke |
| A4 argv/env isolation | **PASS** | claude empty MCP, codex CODEX_HOME, grok GROK_HOME |
| A5 active limit | **PASS** | unit |
| B4 host=partner | **PASS** | smoke rejects grok→grok |

## Live pairwise
| ID | Host | Partner | Result | Session | Notes |
|----|------|---------|--------|---------|-------|
| B1 | grok | codex | **BLOCKED** | dialog-1785527840393-b721875d | Codex usage limit UI (credits); not a code path failure after sandbox fix |
| B2 | grok | **claude** | **PASS** | dialog-1785528477204-29b45e00 | reply `PONG` in 12s; `claude-empty-mcp.json` present |
| B3 | claude | grok | not run | — | deferred (time); architecture same as B2 with swapped roles |
| B5 | grok | claude review | not run | — | deferred; dialog path proven |

## Live group
| ID | Scenario | Result | Session |
|----|----------|--------|---------|
| G1 | group_dialog facilitator=grok partners=[claude] fan_out | **PASS** | group-1785528582615-3d37fc03 |
| G2 three-way + codex | blocked | — | needs Codex credits |

## Fixes found only by live test
1. `--sandbox read-only` causes Codex CLI to exit immediately in tmux → reverted to `workspace-write` for Codex partners.
2. Codex usage-limit UI hangs partner → rate-limit switch handler + document fail-fast.

## Claude as partner
**Proven live from Grok host (B2).** Historical machine also has many codex→claude successes.
