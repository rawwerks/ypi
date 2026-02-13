.PHONY: test test-unit test-guardrails test-extensions test-e2e test-fast check-upstream clean

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

# E2E tests — REAL LLM calls, costs money
test-e2e:
	@echo "Running e2e tests (real LLM calls)..."
	@bash tests/test_e2e.sh

# All tests
test: test-fast test-extensions test-e2e

# Check compatibility with latest upstream Pi
check-upstream:
	@scripts/check-upstream

# Clean up temp files
clean:
	rm -f /tmp/rlm_ctx_d*
	rm -f /tmp/rlm_test_*
	rm -f /tmp/rlm_e2e_*
