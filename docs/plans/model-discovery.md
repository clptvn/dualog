# Plan: per-model effort enforcement + runtime model discovery

## Context

Two defects, found while answering "what models and efforts does each agent support?":

1. **`models` is decoration.** It is read in exactly one place (`describeAdapter`) to
   generate a tool description. Nothing validates against it.
2. **Efforts are flat per adapter, but validity is per MODEL.** Six of seven adapters
   ship wrong effort metadata.

The per-model matrix was never missing — it lived as *prose* in the skill files, enforced
by whichever model happened to read it. That is the same duplication the adapter refactor
set out to remove, and it does not survive N agents.

All findings below are source- or machine-verified. Evidence lives in
`scratchpad/review/{codex-discovery-spec,grok-cursor-discovery,claude-qwen-goose-discovery,models-dev-findings}.md`.

## Decisions taken

| Decision | Choice |
| --- | --- |
| Unknown model on an enumerable adapter | **Hard error**, with `allow_unknown_model: true` escape hatch. Static-only adapters stay soft — they cannot know. |
| Effort unsupported by the chosen model | **Hard error** both directions, naming what the model does accept |
| Caching | **Per-source TTL**, honoring upstream staleness rules |

## The three tiers (do not conflate them)

| Tier | Question | Source |
| --- | --- | --- |
| Universe | what could this CLI *ever* route to | models.dev (5,935 models) |
| **Available** | what can *you* select | Codex/Grok cache, `opencode models` |
| Installed | what is physically present | Ollama `/v1/models` |

**Only the middle tier answers "what can I use."** models.dev is enrichment, never the
answer. It disagreed with the live machine on both `ultra` and `gpt-5.3-codex`; the
machine was right both times.

## Verified facts

### Codex — `$CODEX_HOME/models_cache.json`
`models.filter(m => m.visibility === "list").sort(by priority)` reproduces the `/model`
picker exactly (verified against a screenshot). Fields: `slug`,
`supported_reasoning_levels[].effort`, `default_reasoning_level`, `context_window`,
`visibility`, `supported_in_api`.

| Model | Default | Efforts |
| --- | --- | --- |
| gpt-5.6-sol | low | low, medium, high, xhigh, max, **ultra** |
| gpt-5.6-terra | medium | low, medium, high, xhigh, max, **ultra** |
| gpt-5.6-luna | medium | low, medium, high, xhigh, max |
| gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex-spark | medium (spark: high) | low, medium, high, xhigh |

`gpt-5.3-codex` **no longer exists**. `codex-auto-review` is `visibility: "hide"` — filter it.

### Claude — compiled into the binary, no cache file
No `claude models` subcommand. A `list_models` SDK control request exists but needs a
stream-json session — too heavy. **Ship a static table**, refresh on CLI upgrade.

| Model | Efforts |
| --- | --- |
| opus-5, opus-4-8, opus-4-7, sonnet-5, fable-5, mythos-5 | low, medium, high, xhigh, max |
| **opus-4-6, sonnet-4-6** | low, medium, high, **max** — no xhigh |
| opus-4-5/4-1/4-0, sonnet-4-5/4-0, haiku-4-5, claude-3-* | **none** |

**The inversion:** `opus-4-6` and `sonnet-4-6` accept `max` but not `xhigh`. Any ordered-ladder
assumption is wrong. Store sets, never ranges.

**Claude never hard-fails** — invalid combinations *silently clamp to `high`* with no warning.
So validation here is a truthfulness fix: today you believe you got xhigh and did not.

### Grok — `$GROK_HOME/models_cache.json`, TTL 300s
Carries `supports_reasoning_effort` and a per-model `reasoning_efforts` menu the source calls
"source of truth". Has an `origin` field naming the backend it was written against — **a cache
from a different endpoint is a deliberate miss**. `grok-4.5` allows only high/medium/low.
`grok models` exists but boots a full agent shell — fallback only, never the default path.
The effort flag is `Option<String>`, not a validated enum, so bad values fail *late*.

### opencode — `opencode models`, credential-filtered
One `provider/model` per line, not JSON. **Split on the FIRST `/` only** — model ids can
themselves contain slashes (`lmstudio/google/gemma-3n-e4b`, verified). `run --variant` *is*
reasoning effort.

### Cursor — nothing local
`cursor-agent models` / `--list-models` exist in current releases but not in the installed
2025.09.18 build; introducing version unknown. Account-scoped. **No effort axis** — it is baked
into the model id (`gpt-5-high`, `sonnet-4-thinking`). **No `--base-url`** (zero occurrences in
the installed bundle) — do not claim local-model support.

### qwen / goose — no cache, no listing
Neither calls `GET /v1/models` in a way we can reach, so **we call it ourselves**.
- qwen: effort is settings-only (`model.reasoningEffort`), no flag, no env var. We already
  create an isolated `QWEN_HOME`, so we can write it.
- goose: `GOOSE_THINKING_EFFORT` env var. The `--model gpt-5.4-high` suffix trick applies
  **only** to OpenAI Responses-API models; on anything else the suffix silently becomes part
  of the literal model id. Do not use it.

### OpenAI-compatible endpoints
`/v1/models` returns `data[].id` and nothing else. Ollama's `POST /api/show` returns
`capabilities: ["completion","tools","thinking"]` — **`tools` gates the sidecar protocol**;
a model without it cannot write `result.md`/`done.json` and will look like a hang.
Context length key is architecture-prefixed: read `model_info["general.architecture"]` first.

## Work

### 1. Schema — `src/adapters/schema.mjs`

`models` accepts a bare string (unchanged meaning) **or** an object:

```js
{ id, efforts: [...], defaultEffort, context, aliasOf, deprecated }
```

Add:
- `modelAliases: Record<string,string>` — `{"gpt-5.6": "gpt-5.6-sol"}`. CLI aliases are not
  catalog entries; `grok-build` is the same class.
- `effortDelivery: "argv" | "env" | "settings-file" | "none"` (default `argv`)
- `discovery` — see §2.

`superRefine` additions: a model's `defaultEffort` must appear in its own `efforts`;
`aliasOf` must resolve to a declared model; `effortDelivery: "settings-file"` requires
`configIsolation` (nowhere else to write it).

### 2. Discovery — `src/adapters/discovery.mjs` (new)

One interface, five strategies. Each returns
`{ models: [{id, efforts?, defaultEffort?, context?}], source, fetchedAt, stale, notices[] }`.

| Strategy | Used by | Cache |
| --- | --- | --- |
| `local-cache` | codex, grok | codex: none (local file, ~1ms). grok: honor upstream 300s TTL **and** `origin` mismatch |
| `cli-command` | opencode, grok (fallback) | 60s — spawns a process |
| `http-openai` | qwen, goose, any custom base URL | 60s |
| `catalog` | models.dev enrichment only | 24h |
| `static` | claude, cursor | n/a |

Config is declarative per adapter, e.g. codex:

```json
"discovery": {
  "strategy": "local-cache",
  "path": "{{configHome}}/models_cache.json",
  "collection": "models",
  "filter": { "visibility": "list" },
  "sortBy": "priority",
  "map": { "id": "slug", "efforts": "supported_reasoning_levels[].effort",
           "defaultEffort": "default_reasoning_level", "context": "context_window" }
}
```

**Failure is never fatal.** Discovery falls back to the static list with a notice. Distinguish
*unreachable* from *reachable-but-empty* — they mean opposite things.

HTTP rules (all verified): strip trailing `/`; if the base already ends in `/v1` use
`{base}/models`, else try `{base}/v1/models` then `{base}/models` — never blindly append, Ollama
404s on `/v1/v1/models`. **Check `content-type` before parsing** (Ollama's root returns
`text/plain`, a misconfigured URL returns HTML). `AbortSignal.timeout(3000)` local / `8000`
remote, one retry, cap body at 2 MB.

### 3. Enforcement — `src/adapters/negotiate.mjs`

Resolve alias → resolve model → resolve efforts. Then:

- **Unknown model, adapter enumerable** → `ERROR`, listing valid ids *and the source path*.
  Suppressed by `allow_unknown_model: true`.
- **Unknown model, static-only adapter** → `WARN` (unchanged).
- **Effort not in that model's set** → `ERROR`, naming what the model accepts. For Claude,
  add: *"Claude would silently run this at `high`."*
- **Effort requested, model supports none** → `ERROR`.
- **No effort given** → use the model's `defaultEffort` when known.
- **Ollama model lacking `tools`** → `ERROR`: cannot complete the sidecar protocol.

### 4. Effort delivery — `src/adapters/argv.mjs` + `env.mjs`

`argv` works today. Add:
- `env` — goose. Manifest `env` values already template against the turn context; make a
  templated entry **drop out when its variable is null** rather than throwing.
- `settings-file` — qwen. Write `{"model":{"reasoningEffort":"<x>"}}` into the isolated
  config dir before spawn, merging if a seeded file exists.

### 5. MCP surface — `src/dialog-server.mjs`

New tool **`list_models`**:
```
{ agent, refresh?: bool, include_metadata?: bool }
  -> { models[], source, fetched_at, stale, notices[] }
```
`check_adapter` gains `model` validation. `start_dialog` / `start_code_review` gain
`allow_unknown_model`.

### 6. Manifests — all seven

Apply the tables above. Specifically: drop `gpt-5.3-codex`; add `gpt-5.4-mini` and
`gpt-5.3-codex-spark`; encode the Claude inversion; per-model Grok efforts; flip
`reasoningEffort` to true for opencode/qwen/goose with the right `effortDelivery`; keep cursor
false and drop any implication of custom base URLs.

### 7. Skills — stop asserting model facts

The prose matrices in `.claude/commands/dualog-*.md` and `dualog-skills/*/SKILL.md` are deleted,
not updated. Replace with: *if the user names a model, call `list_models` for that agent first;
pass it through and let the server validate.* This is what removes the N×prose problem — the
skill stops being a second registry.

## Testing

- **Fixtures, not live calls.** Commit a redacted `models_cache.json` (Codex + Grok), fake
  `opencode models` stdout including a multi-slash id, and an Ollama `/v1/models` +
  `/api/show` pair. Parsers are unit-tested against these.
- **The picker test.** Assert the Codex parser reproduces the seven-model list in order and
  excludes `codex-auto-review`. That is validated against real ground truth today.
- **The inversion test.** `xhigh` + `claude-sonnet-4-6` must error while `max` succeeds.
  Cheap, and it is exactly the case a ladder assumption breaks.
- **The alias test.** `gpt-5.6` resolves to `gpt-5.6-sol` and inherits `ultra`.
- **Discovery-failure tests.** Missing file, stale Grok cache, `origin` mismatch, HTTP timeout,
  HTML response, empty `data[]` — each degrades to static with the right notice, none throw.
- Contract suite extends to: every declared `defaultEffort` is within its own `efforts`.

## Sequencing

1. Schema + manifests + static per-model tables — fixes the six wrong adapters with no new
   machinery. Ship first; it is the actual bug.
2. `negotiate()` enforcement + `allow_unknown_model`.
3. `discovery.mjs` with `local-cache` (Codex, then Grok).
4. `http-openai` + Ollama `tools` gate.
5. `cli-command` (opencode) + models.dev enrichment.
6. `list_models` tool, then the skill rewrite.

## Known limits, stated up front

- Claude's table is **static and will drift** on CLI upgrade. Its live catalog is only
  reachable via a stream-json control request we deliberately do not make.
- `cursor-agent models` output format is **unverified** — the installed build predates the
  feature. Do not write that parser until someone captures real output.
- opencode, qwen, goose, grok are **not installed here**. Parsers are fixture-tested; first
  real run is first real validation.
- Grok model ids are ultimately server-side facts; the source-level confirmations
  (`grok-build` exists, `grok-build-latest` does not, `grok-code-fast-1` retired) are strong
  but not live-verified.
