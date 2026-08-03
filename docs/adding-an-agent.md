# Adding an AI CLI

An agent is a JSON manifest. No source changes, no rebuild.

Drop a file into any of these, lowest precedence first:

```
<package>/src/adapters/builtin/*.json    shipped adapters
$XDG_CONFIG_DIRS/dualog/adapters/*.json
$XDG_CONFIG_HOME/dualog/adapters/*.json  your adapters  (usually ~/.config/dualog/adapters)
~/.dualog/adapters/*.json                legacy, honored only if the XDG dir is absent
<gitRoot>/.dualog/adapters/*.json        project-local
./.dualog/adapters/*.json
$DUALOG_ADAPTER_PATH                     colon-separated, highest precedence
```

Manifests merge **by `id`**, so a file that reuses an existing id patches that
adapter rather than replacing it — useful for pointing a shipped adapter at a
wrapper script, or retuning its markers. Objects deep-merge; **arrays replace**,
so you can narrow a marker list rather than only add to it.

Check your work:

```
list_adapters          # is it registered, is the binary found
check_adapter          # preflight the options you plan to pass
npm test               # the contract suite runs over every registered adapter
```

Every validation error names the file it came from.

---

## The two engines

| | `headless` | `tmux-interactive` |
|---|---|---|
| How | run the CLI's one-shot mode, wait for exit | run the real TUI in tmux, watch the pane, paste |
| Needs | a non-interactive mode | ready/busy markers that actually match |
| Gives up | the live pane in `check_partner_alive` | nothing, but it is far more fragile |

Start with `headless`. Only add `tmux-interactive` once you have real pane
captures to write markers against — a marker set written from documentation
rather than from a recording is how you get a driver that waits forever.

An adapter that cannot be TUI-driven sets `capabilities.tuiDrivable: "no"` and
omits `tmux-interactive` from `engines.allowed`. Requesting it then fails
immediately with a clear message instead of hanging on a readiness timeout.

---

## The one thing that bites everyone

**Most CLIs deny file writes by default in headless mode.** The partner then
reports success, exits 0, and never writes the sidecar files. It looks exactly
like a hang.

Every recipe below therefore carries an auto-approve flag, and it is
load-bearing rather than cosmetic:

| CLI | flag |
|---|---|
| opencode | `--auto` — without it "ask" permissions are **auto-rejected**, not queued |
| qwen | `--approval-mode yolo` |
| copilot | `--allow-all-tools` |
| droid | `--auto medium` — default is read-only |
| grok | `--always-approve` |
| amp | `--dangerously-allow-all` — exec mode exits 1 without it |
| cline | `--auto-approve true` (already the default; `--yolo` *shrinks* the toolset) |

If a turn fails with "could not write files", that flag is the first thing to check.

---

## Minimal manifest

```json
{
  "id": "mycli",
  "displayName": "My CLI",
  "binary": { "default": "mycli", "installHint": "npm i -g mycli" },
  "engines": { "default": "headless", "allowed": ["headless"] },
  "capabilities": {
    "modelFlag": true,
    "reasoningEffort": false,
    "toolProfiles": "prompt-only",
    "addDir": false,
    "writesFiles": true,
    "tuiDrivable": "no"
  },
  "mcp": { "strategy": "none" },
  "promptDelivery": { "headless": "argv" },
  "argv": {
    "headless": [
      { "args": ["run", "--yes"] },
      { "when": { "set": "model" }, "args": ["--model", "{{model}}"] },
      { "args": ["{{initialPrompt}}"] }
    ]
  },
  "completion": { "sidecar": "always", "stdoutTrustworthy": false }
}
```

Rules are evaluated in order; `when` is `{set}`, `{notSet}`, or `{equals}`.
Values are normalized *before* argv is built — an effort your CLI does not
accept is already null — so a rule never has to re-validate.

Template variables: `home`, `projectPath`, `sessionDir`, `scratchDir`,
`sessionName`, `model`, `reasoningEffort`, `reasoningEffortJson`,
`initialPrompt`, `toolProfile`, `toolProfileAllowedTools`,
`toolProfileDisallowedTools`, `mcpConfigPath`.

### `scratchDir` for runtime state, `sessionDir` for the record

These two are not interchangeable, and picking the wrong one is the difference
between a credential copy that lives for one turn and one that lives forever.

| | lifetime | use it for |
|---|---|---|
| `{{scratchDir}}` | one turn — deleted as soon as that turn's process is proven gone | config homes, data/cache dirs, MCP config files, settings files |
| `{{sessionDir}}` | the life of the session, kept as an archive | `--add-dir` grants so the partner can write `result.md` and `done.json` |

**Anything seeded with credentials goes under `{{scratchDir}}`.** Config
isolation used to point partner homes at the session directory, which is kept so
a conversation can be reread later — so every session ever run retained a live
copy of the partner's auth. A manifest that renders `{{sessionDir}}` into a
config home is now refused at runtime rather than quietly retained.

### Directories go in `dirs`, settings go in `env`

Environment variables split into two kinds, and the manifest has to say which it
means:

| | field | rule |
|---|---|---|
| **A directory** the CLI should use | `dirs`, `configIsolation.dirs` | the rendered path must resolve inside the turn's runtime lease, or the turn is refused |
| **A setting** the CLI reads | `env`, `configIsolation.extraEnv` | passed through untouched; may not name a location |

```json
"configIsolation": {
  "env": "MYCLI_HOME", "dir": "{{scratchDir}}/mycli-home",
  "dirs":     { "XDG_DATA_HOME": "{{scratchDir}}/mycli-data" },
  "extraEnv": { "MYCLI_DISABLE_KEYRING": "1" }
}
```

Putting a directory in a settings map is refused at load: variables named like
locations (`XDG_*`, `*_HOME`, `*_DIR`, `*_PATH`, `*_ROOT`) and values that look
like paths are rejected with a message naming the entry.

This is not stylistic. The two used to share one field, so dualog had to guess
which kind each entry was by looking at the value — and `auto` (goose's real
mode setting) is the same shape as `pwned-config`. Whichever way the guess was
tuned, it either rejected a legitimate setting or created an attacker-named
directory relative to the user's own project.

---

## Recipes

These are drawn from primary-source research but **have not been run here** — no
one on this machine has these CLIs installed. Treat them as a starting point,
verify with `check_adapter`, and please contribute corrections.

### aider

Not an agent loop; it edits and stops. Two things matter: it **auto-commits to
git by default**, and `--yes-always` answers *no* to shell commands.

```json
{
  "id": "aider",
  "displayName": "Aider",
  "binary": { "default": "aider", "installHint": "pip install aider-install" },
  "engines": { "default": "headless", "allowed": ["headless"] },
  "capabilities": { "modelFlag": true, "reasoningEffort": false, "toolProfiles": "none",
                    "addDir": false, "writesFiles": true, "tuiDrivable": "no" },
  "mcp": { "strategy": "none" },
  "promptDelivery": { "headless": "argv" },
  "argv": { "headless": [
    { "args": ["--yes-always", "--no-auto-commits", "--no-dirty-commits",
               "--no-check-update", "--no-detect-urls", "--no-stream", "--no-pretty"] },
    { "when": { "set": "model" }, "args": ["--model", "{{model}}"] },
    { "args": ["--message", "{{initialPrompt}}"] }
  ] },
  "completion": { "sidecar": "always", "stdoutTrustworthy": false }
}
```

`--no-auto-commits` is not optional. Aider is also not an MCP client at all,
which makes it structurally recursion-proof.

### crush

```json
{
  "id": "crush",
  "displayName": "Crush",
  "binary": { "default": "crush" },
  "engines": { "default": "headless", "allowed": ["headless"] },
  "capabilities": { "modelFlag": true, "reasoningEffort": false, "toolProfiles": "none",
                    "addDir": false, "writesFiles": true, "tuiDrivable": "risky" },
  "mcp": { "strategy": "none" },
  "configIsolation": {
    "env": "CRUSH_GLOBAL_CONFIG", "dir": "{{scratchDir}}/crush-config",
    "dirs": { "CRUSH_GLOBAL_DATA": "{{scratchDir}}/crush-data" }
  },
  "promptDelivery": { "headless": "argv" },
  "argv": { "headless": [
    { "args": ["run", "--quiet", "--cwd", "{{projectPath}}"] },
    { "when": { "set": "model" }, "args": ["--model", "{{model}}"] },
    { "args": ["{{initialPrompt}}"] }
  ] },
  "completion": { "sidecar": "always", "stdoutTrustworthy": false }
}
```

`crush run` auto-approves internally; `crush run --yolo` **fails** (`--yolo` is a
root-level flag). Config files deep-merge and `/etc/crush/config.toml` always
loads, so isolation is partial.

### copilot

```json
{
  "id": "copilot",
  "displayName": "GitHub Copilot",
  "binary": { "default": "copilot" },
  "engines": { "default": "headless", "allowed": ["headless"] },
  "capabilities": { "modelFlag": true, "reasoningEffort": false, "toolProfiles": "none",
                    "addDir": true, "writesFiles": true, "tuiDrivable": "no" },
  "mcp": { "strategy": "none" },
  "configIsolation": { "env": "COPILOT_HOME", "dir": "{{scratchDir}}/copilot-home" },
  "promptDelivery": { "headless": "argv" },
  "argv": { "headless": [
    { "args": ["--allow-all-tools", "--no-ask-user", "--add-dir", "{{sessionDir}}"] },
    { "when": { "set": "model" }, "args": ["--model", "{{model}}"] },
    { "args": ["-p", "{{initialPrompt}}"] }
  ] },
  "completion": { "sidecar": "always", "stdoutTrustworthy": false }
}
```

Copilot has **no MCP suppression flag**, and since v1.0.49 `-p` auto-loads
workspace MCP servers in trusted directories. The env sentinel is what stops
that from recursing; `COPILOT_HOME` handles the rest.

### droid, amp, openhands, continue, cline

Same shape. The load-bearing details:

- **droid** — `droid exec --cwd <repo> --auto medium -o json "<prompt>"`.
  Default is read-only, so `--auto` is mandatory. `FACTORY_HOME_OVERRIDE` is
  SDK-verified but unconfirmed on the CLI binary.
- **amp** — `amp -x --dangerously-allow-all "<prompt>"`, with `AMP_PWD` set to
  the repo. `--model` is account-gated and hard-errors; use `-m low|medium|high|ultra`.
  Isolate with the three `XDG_*` vars, though it is partial on macOS.
- **openhands** — env-configured, not flag-configured: `LLM_MODEL`, `LLM_API_KEY`,
  `LLM_BASE_URL`, `OPENHANDS_PERSISTENCE_DIR`. There is **no `--model` flag**, so
  set `capabilities.modelFlag: false` and pass the model through `env`.
- **continue (`cn`)** — `cn -p --auto --config <session.yaml>`. `--model` is dead;
  the model comes from the config YAML. MCP is read only from the resolved
  config, so a minimal YAML means zero servers.
- **cline** — `cline --json --auto-approve true -c <repo> "<prompt>"`.
  `CLINE_MCP_SETTINGS_PATH` pointed at `{"mcpServers":{}}` suppresses MCP.

---

## Local and open-source models

Two routes, and the first needs no new adapter at all:

**Through Codex.** `codex --oss --local-provider ollama` (or `lmstudio`) drives
local models with the adapter that already ships.

**Through an OpenAI-compatible base URL.** `qwen`, `opencode`, `crush`, `goose`,
`aider`, and `openhands` all accept one. Patch the shipped adapter rather than
writing a new one:

```json
{
  "id": "qwen",
  "env": {
    "OPENAI_BASE_URL": "http://localhost:11434/v1",
    "OPENAI_API_KEY": "ollama"
  }
}
```

Save that as `~/.config/dualog/adapters/qwen-local.json` and it merges over the
shipped `qwen` manifest.

The real constraint is not routing, it is capability: the completion protocol
asks the model to finish work, write `result.md`, *then* write `done.json`.
Small models routinely do the work and forget the writes. If that happens, prefer
a model with solid tool-calling (qwen3-coder, devstral, gpt-oss), and note that
the prompt already tells the partner it may use shell redirection instead of a
write tool — weak models handle `cat > f <<'EOF'` far more reliably than a
JSON-escaped multi-line write call.
