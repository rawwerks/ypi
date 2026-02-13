# Changelog

All notable changes to ypi are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

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
