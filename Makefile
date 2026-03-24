.PHONY: test test-unit test-guardrails test-extensions test-e2e test-fast pre-push-checks check-upstream install-hooks release-preflight land ci-status ci-last-failure clean

# Fast tests — no LLM calls, uses mock pi
test-unit:
	@echo "Running unit tests..."
	@bash tests/test_unit.sh

# Guardrail tests — no LLM calls, tests new features
test-guardrails:
	@echo "Running guardrail tests..."
	@bash tests/test_guardrails.sh

# All fast tests (unit + guardrails)
test-fast: test-unit test-guardrails

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

# One-command release preflight (hooks + tests + upstream dry-run)
release-preflight:
	@scripts/release-preflight

# Deterministic-ish land helper (preflight + encrypt-check + push + CI status + optional agent audit)
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
