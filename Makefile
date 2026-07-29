.PHONY: test test-unit test-guardrails test-timeout-range test-native test-runtime-contract test-eval-contracts test-concurrency test-child-process test-transcripts test-session-tools test-private-path-ownership test-implementer-registry-generation test-workspace-retirement-generation test-workspace-policy test-parallel-workspace test-implementer-recovery test-workspace-crash test-workspace-concurrent-crash test-write-scope test-publication-policy test-config-surface typecheck-runtime build-runtime-cli check-runtime-cli test-provider-allowlist test-extensions test-e2e test-recursion-e2e test-extensions-e2e eval-depth-ablation eval-runtime-parity test-fast doctor test-doctor pre-push-checks check-upstream install-hooks land ci-status ci-last-failure clean

# Fast tests — no LLM calls, uses mock pi
test-unit:
	@echo "Running unit tests..."
	@bash tests/test_unit.sh

# Guardrail tests — no LLM calls, tests new features
test-guardrails:
	@echo "Running guardrail tests..."
	@bash tests/test_guardrails.sh

test-timeout-range:
	@echo "Running timeout range tests..."
	@bun tests/timeout_range_harness.ts

test-native:
	@echo "Running native extension tool tests..."
	@bash tests/test_native_tool.sh

# Shared native/CLI runtime contract — no LLM calls.
test-runtime-contract:
	@echo "Running recursion runtime contract tests..."
	@bash tests/test_runtime_contract.sh

test-eval-contracts:
	@echo "Running evaluation contract tests..."
	@bash tests/test_eval_contracts.sh

test-concurrency:
	@echo "Running recursive concurrency tests..."
	@bun tests/concurrency_harness.ts

test-child-process:
	@echo "Running child process terminality tests..."
	@bun tests/child_process_harness.ts

test-transcripts:
	@echo "Running required transcript proof tests..."
	@bun tests/transcript_harness.ts
	@bun tests/n88_n90_harness.ts

test-session-tools:
	@echo "Running session presentation tool tests..."
	@bash tests/test_session_tools.sh

test-private-path-ownership:
	@echo "Running private path ownership tests..."
	@bun tests/private_path_ownership_harness.ts
	@bun tests/private_path_lifecycle_harness.ts
	@bun tests/n84_telemetry_append_harness.ts
	@bun tests/n91_telemetry_init_harness.ts

test-implementer-registry-generation:
	@echo "Running implementer registry generation tests..."
	@bun tests/implementer_registry_generation_harness.ts

test-workspace-retirement-generation:
	@echo "Running workspace retirement generation tests..."
	@bun tests/workspace_retirement_generation_harness.ts

test-workspace-policy:
	@echo "Running recursive workspace policy tests..."
	@bun tests/workspace_policy_harness.ts
	@bun tests/worktree_inventory_harness.ts
	@bun tests/workspace_container_replacement_harness.ts
	@REPLACE_TARGET=checkout bun tests/workspace_container_replacement_harness.ts
	@REPLACE_TARGET=registration bun tests/workspace_container_replacement_harness.ts
	@REPLACE_TARGET=setup-registration bun tests/workspace_container_replacement_harness.ts
	@bun tests/workspace_git_buffer_harness.ts

test-parallel-workspace:
	@echo "Running parallel implementer workspace tests..."
	@bun tests/parallel_workspace_harness.ts
	@bun tests/root_batch_policy_harness.ts
	@bun tests/implementer_launch_gate_harness.ts

test-implementer-recovery:
	@echo "Running implementer recovery module and CLI tests..."
	@bun tests/implementer_recovery_harness.ts
	@bun tests/worktree_index_ownership_harness.ts
	@bun tests/recovery_exact_worktree_harness.ts

test-workspace-crash:
	@echo "Running workspace worktree/ref crash matrix..."
	@bun tests/workspace_crash_matrix.ts

test-workspace-concurrent-crash:
	@echo "Running concurrent implementer crash matrix..."
	@bun tests/workspace_concurrent_crash_matrix.ts

test-write-scope:
	@echo "Running implementer write-scope tests..."
	@bun tests/write_scope_harness.ts
	@bun tests/implementer_confinement_harness.ts
	@bun tests/n89_audit_identity_harness.ts

test-publication-policy:
	@echo "Running publication authority tests..."
	@bash tests/test_publication_policy.sh

test-config-surface:
	@echo "Running runtime configuration surface tests..."
	@bash tests/test_config_surface.sh

typecheck-runtime:
	@bunx --bun tsc -p tsconfig.runtime.json

build-runtime-cli:
	@scripts/build-runtime-cli

check-runtime-cli:
	@scripts/build-runtime-cli --check

# Provider env allowlist — no LLM calls, enforces native/shell parity + pi-mono coverage
test-provider-allowlist:
	@echo "Running provider allowlist tests..."
	@bash tests/test_provider_allowlist.sh

# Host pi runtime health (no LLM) — catches a wrong/stale pi before it "seems broken"
doctor:
	@scripts/doctor

test-doctor:
	@echo "Running doctor tests..."
	@bash tests/test_doctor.sh

# All fast tests (no LLM calls)
test-fast: typecheck-runtime check-runtime-cli test-unit test-guardrails test-timeout-range test-native test-runtime-contract test-eval-contracts test-concurrency test-child-process test-transcripts test-session-tools test-private-path-ownership test-implementer-registry-generation test-workspace-retirement-generation test-workspace-policy test-parallel-workspace test-implementer-recovery test-workspace-crash test-workspace-concurrent-crash test-write-scope test-publication-policy test-config-surface test-provider-allowlist test-doctor

# Extension compatibility — requires real pi installed
test-extensions:
	@echo "Running extension tests..."
	@bash tests/test_extensions.sh

# Extension E2E tests — REAL LLM calls, tests extension API compatibility
test-extensions-e2e:
	@echo "Running extension e2e tests (real LLM calls)..."
	@bash tests/test_extensions_e2e.sh

# E2E tests — REAL LLM calls, costs money
test-e2e:
	@echo "Running e2e tests (real LLM calls)..."
	@bash tests/test_e2e.sh

# Focused live proof that a root ypi session can invoke rlm_query recursively.
test-recursion-e2e:
	@echo "Running recursion e2e test (real LLM calls)..."
	@RLM_PROVIDER="$${RLM_PROVIDER:-openrouter}" RLM_MODEL="$${RLM_MODEL:-openai/gpt-5.5:xhigh}" bash tests/test_e2e.sh E9

# Manual paid evaluations. Run independent conditions concurrently rather than
# adding these long-running model calls to the default test target.
eval-depth-ablation:
	@test -n "$(DEPTH)" || { echo "usage: make eval-depth-ablation DEPTH=3" >&2; exit 2; }
	@bash tests/eval/depth-ablation/run-condition.sh "$(DEPTH)"

eval-runtime-parity:
	@test -n "$(LANE)" || { echo "usage: make eval-runtime-parity LANE=canonical-cli" >&2; exit 2; }
	@bash tests/eval/runtime-parity/run-lane.sh "$(LANE)"

# All tests
test: test-fast test-extensions test-e2e

# Shared local/CI gate
pre-push-checks:
	@scripts/pre-push-checks


# Check compatibility with latest upstream Pi
check-upstream:
	@scripts/check-upstream

# Install repo hooks (.githooks/*)
install-hooks:
	@scripts/install-hooks

# Validate and push the current feature branch to the owner-verified origin.
land:
	@scripts/land

# CI helper: show recent runs (usage: make ci-status [N])
ci-status:
	@scripts/ci-status $(or $(N),10)

# CI helper: dump latest failed run log (or pass RUN=<id>)
ci-last-failure:
	@scripts/ci-last-failure $(RUN)



# Clean up temp files
clean:
	rm -f /tmp/rlm_ctx_d*
	rm -f /tmp/rlm_test_*
	rm -f /tmp/rlm_e2e_*
