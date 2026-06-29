# Changelog

All notable changes to ypi are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Changed
- Bare `ypi` now explicitly preserves Pi-native root model selection: root provider/model/thinking come from Pi settings (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`), `/model`, or CLI flags, while children inherit the active root route by default. Recursive child routing can now be lowered by depth with `RLM_CHILD_MODELS`, `RLM_CHILD_PROVIDERS`, and `RLM_CHILD_THINKING_LEVELS` without narrowing the root default, toolset, timeout, or call-limit behavior.

## [0.6.1] - 2026-06-22

### Changed
- **npm keywords aligned with the pi package gallery.** The gallery at `pi.dev/packages` discovers packages by the `pi-package` keyword (already present on both); this adds `pi-coding-agent` to both packages and `pi-extension` to `ypi` to match the convention used by featured pi packages and improve in-ecosystem search ranking.
- `pi-recursive` `repository.url` normalized to `git+https://…` (was emitting an npm publish warning).

### Verified
- Real `pi install npm:pi-recursive` from the registry, in an isolated `PI_CODING_AGENT_DIR`: installs, writes `settings.json`, and registers the native `rlm_query` tool (`__YPI_NATIVE_TOOL_REGISTERED__`).

## [0.6.0] - 2026-06-22

### Added
- **`pi-recursive` package**: the pure Pi extension (the `pi.extensions` surface, no `bin`) is now published as its own companion package — `pi install npm:pi-recursive`. `ypi` remains the CLI wrapper. Both are built from one canonical source: `pi-recursive` is staged from the root `extensions/` + `SYSTEM_PROMPT.md` by `scripts/build-pi-recursive` (an explicit build step, not an npm lifecycle hook), and `tests/test_pi_recursive_pack.sh` proves the packed extension installs and registers the native tool.
- **Extension-first architecture**: `extensions/recursive.ts` is now the canonical Pi extension; the `ypi` launcher and shell `rlm_query` are convenience layers around it. Split into modules under `extensions/ypi/` (`runtime`, `env`, `guardrails`, `prompt`, `status`, `native-tool`).
- **Native `rlm_query` Pi tool**: recursion works from a bare `pi -e ./extensions/recursive.ts` (or npm extension install) with no `ypi` launcher, shell helper, or jj. Verified against Pi 0.79.4.
- **`pure-extension/` proof + parity harness** (`test.sh`, `compare.sh`, `DIFFERENCES.md`) and a native-tool unit harness (`tests/test_native_tool.sh`).
- **Self-validating provider env allowlist** (`tests/test_provider_allowlist.sh`): enforces native/shell parity and completeness, deriving the required credential set from pi-mono's `getApiKeyEnvVars()` (suffix-agnostic) so the allowlist cannot silently drift or go blind to names like `COPILOT_GITHUB_TOKEN` / `HF_TOKEN`.
- **`.gitleaks.toml`**: extends the default ruleset with a narrow allowlist for Cloudflare provider env-var *names* (identifiers, not secrets).
- Packed-consumer smoke (`tests/test_consumer_pack.sh`) asserts the tarball ships `rlm_cleanup` and installs it as an executable.

### Changed
- **Shell helper is opt-in** via `YPI_SHELL_HELPER=1` (set by the `ypi` wrapper). A bare `pi -e` / npm extension install defaults to the native tool only — no shell helper on `PATH`, no shell source folded into the prompt.
- Provider env allowlist extended to cover additional Pi 0.79.4 credentials (Google Cloud, Ollama, Portkey, MiniMax CN, AWS container/web-identity, Azure API version, Cloudflare gateway routing).
- `package.json`: `typebox` moved to runtime `dependencies`; `rlm_cleanup` added to `bin` and `files`.

### Fixed
- **`RLM_MAX_CALLS` off-by-one**: `RLM_MAX_CALLS=N` now permits exactly N calls (was N−1) in both the native tool and shell `rlm_query`.
- **Trace-ID path traversal**: `RLM_TRACE_ID` is sanitized before use in session/temp filenames and async job IDs.
- **Stale timeout budget**: `RLM_START_TIME` is anchored when each depth-0 recursion tree begins instead of frozen at extension load, so a long-running root Pi no longer falsely times out.
- **Async `--notify`**: peer-inbox lines are JSON-encoded with `python3` (valid even with quotes/newlines in child output); async temp files honor `${TMPDIR:-/tmp}` instead of hardcoded `/tmp`.
- **`check-upstream --dry-run`**: now runs the test suite even when the pinned version is already known-good (previously skipped tests via an early exit).
- **Provider credential forwarding**: recursive children now inherit `COPILOT_GITHUB_TOKEN` (github-copilot) and `HF_TOKEN` (huggingface), which were dropped by the child-env allowlist — env-var-only-authed parents could not authenticate their children for those providers.
- **Recursion depth config fails closed**: a non-integer `RLM_DEPTH`/`RLM_MAX_DEPTH` now errors instead of silently bypassing the depth limiter (native and shell).
- Collapsed a dead `--no-extensions` if/else branch in the shell `rlm_query` (both arms were identical).

## [0.5.1] - 2026-03-23

### Fixed
- **macOS mktemp compatibility**: BSD `mktemp` does not allow characters after the `XXXXXX` template suffix — moved `XXXXXX` to end of all templates and use `${TMPDIR:-/tmp}` for portable temp directory resolution
- **Bash 3.2 unbound variable crash**: empty array expansion under `set -u` fails on macOS default bash — build argv incrementally with length checks in `ypi` launcher

## [0.5.0] - 2026-02-15

### Added
- **Notify-done extension** (`contrib/extensions/notify-done.ts`): background task completion notifications via sentinel files — injects messages into conversation when tasks finish, no polling needed
- **LSP extension** (`contrib/extensions/lsp/`): Language Server Protocol integration for code intelligence (diagnostics, references, definitions, rename, hover, symbols)
- **Persist-system-prompt extension** (`contrib/extensions/persist-system-prompt.ts`): saves effective system prompt to session files for debugging and reproducibility
- **Auto-title extension** (`contrib/extensions/auto-title.ts`): automatic session title generation
- **Cachebro extension** (`contrib/extensions/cachebro.ts`): intelligent file caching with diff-aware invalidation and token estimation
- **Context window awareness**: SYSTEM_PROMPT.md now teaches agents about finite context budgets and how to manage them
- Tests for notify-done and persist-system-prompt extensions

### Changed
- **AGENTS.md**: added sentinel/notify-done workflow pattern, background task instructions
- **SYSTEM_PROMPT.md**: context window awareness guidance
- **contrib/README.md**: updated with new extensions documentation

### Fixed
- Notify-done extension: block broadcast sentinels, use `steer` for busy agents, `display: true` for visibility

## [0.4.0] - 2026-02-13

### Added
- **`rlm_sessions` command**: inspect, read, and search session logs from sibling and parent agents in the recursive tree (`rlm_sessions --trace`, `rlm_sessions read <file>`, `rlm_sessions grep <pattern>`)
- **Symbolic prompt access** (`RLM_PROMPT_FILE`): agents can grep/sed the original prompt as a file instead of copying tokens from context memory
- **Contrib extensions**: `colgrep.ts` (semantic code search via ColBERT), `dirpack.ts` (repository index), `treemap.ts` (visual tree maps) — opt-in extensions in `contrib/extensions/`
- **Encryption workflow**: `scripts/encrypt-prose` and `scripts/decrypt-prose` for sops/age encryption of private execution state before pushing
- **`.sops.yaml`**: age encryption rules for `.prose/runs/`, `.prose/agents/`, `experiments/`, `private/`
- **`.githooks/pre-commit`**: safety net blocking unencrypted private files on direct git push
- **OpenProse programs**: `release.prose`, `land.prose`, `incorporate-insight.prose`, `recursive-development.prose`, `self-experiment.prose`, `check-upstream.prose`
- **Experiment infrastructure**: `experiments/` directory with pipe-vs-filename, session-sharing, and tree-awareness experiments with results
- E2E tests: expanded coverage (+90 lines), gemini-flash as default e2e model
- Guardrail tests: `rlm_sessions` tests (G48-G51), session sharing toggle
- Unit tests: `RLM_PROMPT_FILE` tests (T14d)

### Changed
- **SYSTEM_PROMPT.md**: added symbolic access principle (SECTION 2), refined depth awareness guidance
- **AGENTS.md**: expanded with experiment workflow (tmux rules), self-experimentation, session history reading, OpenProse program references
- **README.md**: updated feature list and project description
- Removed hardcoded provider/model defaults from `rlm_query` — inherits from environment only

### Fixed
- Kill orphan `rlm_parse_json` processes after timeout in E2E tests
- Contrib extension GitHub links (dirpack, colgrep) now point to correct URLs

## [0.3.0] - 2026-02-13

### Added
- **ypi status extension** (`extensions/ypi.ts`): shows `ypi ∞ depth 0/3` in footer status bar and sets terminal title to "ypi" — visual indicator that this is recursive Pi, not vanilla
- **CI workflows**: GitHub Actions for push/PR testing and upstream Pi compatibility checks every 6 hours
- **`scripts/check-upstream`**: local script to test ypi against latest Pi version — no GitHub required
- **`tests/test_extensions.sh`**: verifies `.ts` extensions load cleanly with installed Pi
- **`.pi-version`**: tracks last known-good Pi version for compatibility monitoring
- `make test-extensions` and `make check-upstream` targets

### Changed
- Removed hardcoded hashline extension from `ypi` launcher — user's own Pi extensions (installed at `~/.pi/agent/extensions/`) are discovered automatically by Pi
- Removed `RLM_HASHLINE` environment variable (no longer needed)

## [0.2.1] - 2026-02-13

### Fixed
- Skip bundled `hashline.ts` extension when the global install (`~/.pi/agent/extensions/hashline.ts`) exists, fixing "Tool read/edit conflicts" error

## [0.2.0] - 2026-02-12

### Added
- **Cost tracking**: children default to `--mode json`, parsed by `rlm_parse_json` for structured cost/token data
- **Budget enforcement**: `RLM_BUDGET=0.50` caps dollar spend for entire recursive tree
- **`rlm_cost` command**: agent can query cumulative spend at any time (`rlm_cost` or `rlm_cost --json`)
- **`rlm_parse_json`**: streams text to stdout, captures cost via fd 3 to shared cost file
- System prompt updated with cost awareness (SECTION 4 teaches `rlm_cost`)
- `rlm_query` source embedded in system prompt (SECTION 6) so agents understand their own infrastructure

### Changed
- **Uniform children**: removed separate leaf path — all depths get full tools, extensions, sessions, jj workspaces
- **Extensions on by default** at all depths (`RLM_EXTENSIONS=1`)
- **`RLM_CHILD_EXTENSIONS`**: per-instance extension override for depth > 0
- Recursion limited by removing `rlm_query` from PATH at max depth (not `--no-tools`)
- `RLM_JSON=0` opt-out for plain text mode (disables cost tracking)

### Removed
- Separate leaf code path (`--no-tools`, `--no-extensions`, `--no-session` at max depth)
- sops/age/gitleaks references from README and install.sh (internal only)

## [0.1.0] - 2026-02-12

Initial release.

### Added
- `ypi` launcher — starts Pi as a recursive coding agent
- `rlm_query` — bash recursive sub-call function (analog of Python RLM's `llm_query()`)
- `SYSTEM_PROMPT.md` — teaches the LLM to use recursion + bash for divide-and-conquer
- Guardrails: timeout (`RLM_TIMEOUT`), call limits (`RLM_MAX_CALLS`), depth limits (`RLM_MAX_DEPTH`)
- Model routing: `RLM_CHILD_MODEL` / `RLM_CHILD_PROVIDER` for cheaper sub-calls
- jj workspace isolation for recursive children (`RLM_JJ`)
- Session forking and trace logging (`PI_TRACE_FILE`, `RLM_TRACE_ID`)
- Pi extensions support (`RLM_EXTENSIONS`, `RLM_CHILD_EXTENSIONS`)
- `install.sh` for curl-pipe-bash installation
- npm package with `ypi` and `rlm_query` as global CLI commands
