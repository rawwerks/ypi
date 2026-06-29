# ypi

[![npm](https://img.shields.io/npm/v/ypi?style=flat-square)](https://www.npmjs.com/package/ypi)

**ypi** — a recursive coding agent built on [Pi](https://github.com/earendil-works/pi).

Named after the [Y combinator](https://en.wikipedia.org/wiki/Fixed-point_combinator#Y_combinator) from lambda calculus — the fixed-point combinator that enables recursion. `ypi` is Pi that can call itself. (`rpi` already has another connotation.)

Inspired by [Recursive Language Models](https://github.com/alexzhang13/rlm) (RLM), which showed that an LLM with a code REPL and a `llm_query()` function can recursively decompose problems, analyze massive contexts, and write code — all through self-delegation.

## The Idea

Pi already has an extension system and a bash REPL. ypi's core is a Pi extension that registers one native tool — `rlm_query` — and teaches Pi to use it recursively. The `ypi` launcher and shell-compatible `rlm_query` command are convenience layers around that extension. [jj](https://martinvonz.github.io/jj/) workspace isolation is used when available, but it is not required for the minimal path.

```
┌──────────────────────────────────────────┐
│  ypi (depth 0)                           │
│  Tools: native rlm_query, bash           │
│  Workspace: default                      │
│                                          │
│  > grep -n "bug" src/*.py                │
│  > sed -n '50,80p' src/app.py \          │
│      | rlm_query "Fix this bug"          │
│            │                             │
│            ▼                             │
│    ┌────────────────────────────┐        │
│    │  ypi (depth 1)            │        │
│    │  Workspace: jj if present │        │
│    │  Edits files safely       │        │
│    │  Returns: patch on stdout │        │
│    └────────────────────────────┘        │
│                                          │
│  > jj squash --from <child-change>       │
│  # absorb the fix into our working copy  │
└──────────────────────────────────────────┘
```

---

## Using ypi

### Install

```bash
# bun (global)
bun install -g ypi

# or npm (global)
npm install -g ypi

# or run without installing
bunx ypi "What does this repo do?"

# or curl
curl -fsSL https://raw.githubusercontent.com/rawwerks/ypi/master/install.sh | bash

# or manual
git clone https://github.com/rawwerks/ypi.git && cd ypi
git submodule update --init --depth 1
export PATH="$PWD:$PATH"
```

### Run

```bash
# Interactive
ypi

# One-shot
ypi "Refactor the error handling in this repo"

# Different model
ypi --provider anthropic --model claude-sonnet-4-5-20250929 "What does this codebase do?"
```

### Use As A Pi Extension

The minimal path is the `pi-recursive` package — a pure Pi extension. It gives Pi
the native recursive `rlm_query` tool without the `ypi` launcher, shell helper, or
jj requirement:

```bash
# Try for one run
pi -e npm:pi-recursive "Use rlm_query to ask a child what 2 + 2 is."

# Install globally for normal pi sessions
pi install npm:pi-recursive
pi

# Install project-locally into .pi/settings.json
pi install -l npm:pi-recursive
```

The npm package has a Pi manifest that exposes only
`./extensions/recursive.ts`. The `ypi` binary remains available for users who
want the wrapper defaults and shell-compatible helper commands.

### How It Works
**Three pieces** (same architecture as Python RLM):
| Piece | Python RLM | ypi |
|---|---|---|
| System prompt | `RLM_SYSTEM_PROMPT` | `SYSTEM_PROMPT.md` |
| Context / REPL | Python `context` variable | `$CONTEXT` file + bash |
| Sub-call function | `llm_query("prompt")` | native Pi tool `rlm_query`; optional shell command `rlm_query "prompt"` |
**Recursion:** the `extensions/recursive.ts` extension registers a native `rlm_query` tool that spawns a child Pi process with the same extension and tools. The child can call `rlm_query` too:

```
Depth 0 (root)    -> full Pi with native rlm_query + bash
  Depth 1 (child) -> full Pi with native rlm_query + bash
    Depth 2 (leaf) -> full Pi with bash, but no rlm_query (max depth)
```

**File isolation with jj:** When jj is available and `RLM_JJ` is not `0`, recursive children use [jj workspaces](https://martinvonz.github.io/jj/latest/working-copy/) for isolation. Without jj, the minimal extension still works, but children default to read-only tools in the current checkout. Set `RLM_UNSAFE_NO_JJ_WRITE=1` only when you intentionally want writable no-jj child agents.

### Why It Works

The design has three properties that compound:

1. **Self-similarity** — Every depth runs the same prompt, same tools, same agent. No specialized "scout" or "planner" roles. The intelligence is in *decomposition*, not specialization. The system prompt teaches one pattern — size-first → search → chunk → delegate → combine — and it works at every scale.

2. **Self-hosting** — The extension is the canonical recursion machinery. When the shell helper is enabled (the `ypi` wrapper, or any load with `YPI_SHELL_HELPER=1`), the prompt also includes its source for inspection and modification. A bare `pi -e` / npm extension install uses the native tool only and does not require that shell file.

3. **Bounded recursion** — Five concentric guardrails (depth limit, PATH scrubbing, call count, budget, timeout) guarantee termination. The system prompt also installs *cognitive* pressure: deeper agents are told to be more conservative, preferring direct action over spawning more children.

4. **Symbolic access** — Anything the agent needs to manipulate precisely is a file, not just tokens in context. `$CONTEXT` holds the data, `$RLM_PROMPT_FILE` holds the original prompt, and hashline provides line-addressed edits. Agents `grep`/`sed`/`cat` instead of copying tokens from memory.

### Model Configuration

Root model selection is owned by Pi, not ypi. Configure the default root model in Pi's native settings (`~/.pi/agent/settings.json` globally, or project `.pi/settings.json`):

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.5",
  "defaultThinkingLevel": "xhigh"
}
```

Bare `ypi` passes no provider/model by default, so Pi applies those settings (or `/model`, `--provider`, `--model`, and `--thinking`). ypi then captures the active root provider/model/thinking and forwards that route to recursive children unless child routing variables override it.

For depth-based cost control, use child routing:

```bash
RLM_CHILD_MODELS='gpt-5.5,gpt-5.5' \
RLM_CHILD_THINKING_LEVELS='high,medium' \
ypi
```

This means root uses Pi's configured default, depth-1 children use high thinking, and depth-2 children use medium thinking.

### Guardrails

| Feature | Env var | What it does |
|---------|---------|-------------|
| Budget | `RLM_BUDGET=0.50` | Max dollar spend for entire recursive tree; native extension mode requires JSON output so child cost can be measured |
| Timeout | `RLM_TIMEOUT=60` | Wall-clock limit for entire recursive tree |
| Call limit | `RLM_MAX_CALLS=20` | Max total `rlm_query` invocations |
| Model routing | `RLM_CHILD_MODEL=haiku` or `RLM_CHILD_MODELS=big:high,small:medium` | Use one child model for every sub-call, or a comma-separated depth route for depth 1, 2, ... |
| Depth limit | `RLM_MAX_DEPTH=3` | How deep recursion can go |
| jj disable | `RLM_JJ=0` | Skip workspace isolation; child agents are read-only unless `RLM_UNSAFE_NO_JJ_WRITE=1` |
| Plain text | `RLM_JSON=0` | Disable JSON mode (no cost tracking) |
| Tracing | `PI_TRACE_FILE=$HOME/scratch/trace.log` | Log all calls with timing + cost |

The agent can check spend at any time:

```bash
rlm_cost          # "$0.042381"
rlm_cost --json   # {"cost": 0.042381, "tokens": 12450, "calls": 3}
```

### Pi Compatibility

ypi is a thin layer on top of Pi. We strive not to break or duplicate what Pi already does:

| Pi feature | ypi behavior | Tests |
|---|---|---|
| **Session history** | Uses Pi's native session manager when a parent session exists. Child sessions go in the same dir with trace-encoded filenames. `RLM_SHARED_SESSIONS=0` uses `--no-session` and clears child session env. No separate session store. | G24–G30 |
| **Extensions** | Child processes disable ambient extension discovery and explicitly reload the ypi extension. `RLM_EXTENSIONS=0` disables recursion extension loading; `RLM_CHILD_EXTENSIONS=0` disables it for child depths. | G34–G38, N8 |
| **Native recursion** | The canonical `extensions/recursive.ts` extension registers a native Pi `rlm_query` tool. Minimal mode works with only Pi plus extension files: no `ypi` launcher, no shell helper, no jj. | extension smoke, pure-extension E2E |
| **System prompt** | The extension injects `SYSTEM_PROMPT.md` when present and falls back to a minimal built-in prompt when it is not. If the shell `rlm_query` file exists, its source is appended as optional compatibility context. Standalone shell `rlm_query` falls back to Pi's `--system-prompt`. | T8–T9, parity E2E |
| **`-p` mode** | All child Pi calls run non-interactive (`-p`). ypi never fakes a terminal. | T3–T4 |
| **`--session` flag** | Used when session sharing is enabled and Pi has a session dir; `--no-session` otherwise. Never both. | G24, G28 |
| **Provider/model** | Bare `ypi` defers root provider/model/thinking to Pi (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `/model`, or CLI flags). The extension captures Pi's active root route into `RLM_PROVIDER`/`RLM_MODEL`/`RLM_THINKING_LEVEL` so children inherit it unless `RLM_CHILD_*` or depth lists override child routing. | T14, T14c–T14g, G6b, N7b |

If Pi changes how sessions or extensions work, our guardrail tests should catch it.

### Troubleshooting

If `ypi` or recursion **seems broken**, run `make doctor` first. The most common
cause is the wrong host `pi`: either the old `@mariozechner/pi-coding-agent`
shadowing the current `@earendil-works/pi-coding-agent`, or a version older than
`.pi-version`. `make doctor` reports the exact mismatch and the one-line fix
(`bun add -g @earendil-works/pi-coding-agent@<pinned>`). It honors `YPI_PI_BIN`,
so it checks the same binary recursion actually spawns.

### Package Boundary

There are two published packages, built from one canonical source:

| Package | Audience | Entry point | Includes |
|---|---|---|---|
| **`pi-recursive`** | Pi users who want recursion inside plain `pi` | `pi install npm:pi-recursive` or `pi -e npm:pi-recursive` | The native `rlm_query` tool, prompt injection, depth/status/env handling. No `bin`; host `pi` is a peer dependency. |
| **`ypi`** | Users who want a preconfigured recursive CLI | `npm install -g ypi` / `bun install -g ypi` | The same extension plus launcher defaults, the shell-compatible `rlm_query` (pipes/async), cost/session helpers. Bundles `pi` so the CLI runs without a separate global install. |

Both ship the same `extensions/` source. `pi-recursive` is the extension-only
publish view, staged from the repo root by `scripts/build-pi-recursive`; `ypi`
ships the extension plus its launcher and shell helpers. The shell helper is
opt-in (`YPI_SHELL_HELPER=1`, set by the `ypi` wrapper), so installing
`pi-recursive` gives you the native tool only.

---

## Contributing

### Project Structure

```
ypi/
├── ypi                    # Thin launcher: sets env, loads extensions/recursive.ts
├── rlm_query              # Optional shell-compatible recursive sub-call command
├── extensions/
│   ├── recursive.ts       # Canonical ypi Pi extension
│   ├── ypi/               # Native tool, env, prompt, status modules
│   └── ypi.ts             # Compatibility alias for recursive.ts
├── SYSTEM_PROMPT.md       # Teaches the LLM to be recursive + edit code
├── AGENTS.md              # Meta-instructions for the agent (read by ypi itself)
├── Makefile               # test targets
├── tests/
│   ├── test_unit.sh       # Mock pi, test bash logic (no LLM, fast)
│   ├── test_guardrails.sh # Test guardrails (no LLM, fast)
│   └── test_e2e.sh        # Real LLM calls (slow, costs ~$0.05)
├── pi-mono/               # Git submodule: upstream Pi coding agent
└── README.md
```

### Version Control

This repo strongly prefers **[jj](https://martinvonz.github.io/jj/)** for version control. Git remains the remote-facing substrate.

```bash
jj status                    # What's changed
jj describe -m "message"     # Describe current change
jj new                       # Start a new change
jj bookmark set master       # Point master at current change
jj git push                  # Push to GitHub
```

Prefer jj for local changes, especially recursive agent work. Use the repo's safe push/land helpers for remote-facing operations.

### Testing

```bash
make test-fast         # unit + guardrails
make test-extensions   # latest Pi + extension compatibility, including minimal mode
make pre-push-checks   # shared local/CI gate (recommended before push)
make test-e2e          # real LLM calls, costs money
make test-recursion-e2e # focused live proof that ypi invokes rlm_query
make test-extension-recursion-e2e # direct pi -e native tool recursion proof
make test-parity-e2e   # wrapper vs direct-extension parity proof
make test              # all of the above
```

Install hooks once per clone to run checks automatically on git push:
```bash
make install-hooks
```

Release/update helper:
```bash
make release-preflight   # same checks + upstream dry-run in one command
make land                # deterministic-ish landing helper
```

**Before any change to `rlm_query`:** run `make test-fast`. After: run it again. `rlm_query` is a live dependency of the agent's own execution — breaking it breaks the agent.

CI helper commands:
```bash
make ci-status N=15      # recent workflow runs
make ci-last-failure     # dump latest failing workflow log
```


### History

ypi went through five approaches before landing on the current design:

1. **Tool-use REPL** (exp 010/012) — Pi's `completeWithTools()`, ReAct loop. 77.6% on LongMemEval.
2. **Python bridge** — HTTP server between Pi and Python RLM. Too complex.
3. **Pi extension** — Custom provider with search tools. Not true recursion.
4. **Bash RLM** (`rlm_query` + `SYSTEM_PROMPT.md`) — True recursion via bash.
5. **Pi-native extension RLM** — `extensions/recursive.ts` registers native recursion; `ypi` and shell `rlm_query` are compatibility/ergonomics layers. **Current approach.**

The key insight: Pi's extension API can expose recursion as a first-class tool, while Pi's bash tool remains the REPL for command-line composition. No bridge needed.

---

## See Also

- [Pi coding agent](https://github.com/earendil-works/pi) — the underlying agent
- [Recursive Language Models](https://github.com/alexzhang13/rlm) — the library that inspired this
- [rlm-cli](https://github.com/rawwerks/rlm-cli) — Python RLM CLI (budget, timeout, model routing)
