#!/usr/bin/env bash
# test_consumer_pack.sh - packed npm consumer smoke tests.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PINNED_PI="$(tr -d '[:space:]' < "$PROJECT_DIR/.pi-version")"

if ! command -v bun >/dev/null 2>&1; then
	echo "SKIP: bun not installed"
	exit 0
fi

SCRATCH_ROOT="${HOME}/scratch/ypi-consumer-pack"
mkdir -p "$SCRATCH_ROOT"
TEST_TMP="$(mktemp -d "$SCRATCH_ROOT/run.XXXXXX")"
trap 'rm -rf "$TEST_TMP"' EXIT

PASS=0
FAIL=0
ERRORS=""

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  ✗ $1: $2"; echo "  ✗ $1: $2"; }
assert_contains() {
	local label="$1" needle="$2" haystack="$3"
	if echo "$haystack" | grep -qF -- "$needle"; then pass "$label"; else fail "$label" "expected '$needle' in '$haystack'"; fi
}
assert_not_contains() {
	local label="$1" needle="$2" haystack="$3"
	if echo "$haystack" | grep -qF -- "$needle"; then fail "$label" "unexpected '$needle' in '$haystack'"; else pass "$label"; fi
}

echo ""
echo "=== Packed Consumer Smoke ==="
echo "artifacts=$TEST_TMP"

PACK_OUTPUT="$(cd "$PROJECT_DIR" && bun pm pack --destination "$TEST_TMP" --ignore-scripts --quiet)"
PACK_OUTPUT="$(printf '%s\n' "$PACK_OUTPUT" | awk 'NF { last=$0 } END { print last }')"
if [[ "$PACK_OUTPUT" = /* ]]; then
	TGZ="$PACK_OUTPUT"
else
	TGZ="$TEST_TMP/$PACK_OUTPUT"
fi
if [ -f "$TGZ" ]; then
	pass "npm tarball created"
else
	fail "npm tarball created" "missing $TGZ"
fi

TARBALL_LIST="$(tar -tzf "$TGZ")"
assert_contains "tarball contains package manifest" "package/package.json" "$TARBALL_LIST"
assert_contains "tarball contains canonical extension" "package/extensions/recursive.ts" "$TARBALL_LIST"
assert_contains "tarball contains native adapter" "package/extensions/ypi/native-tool.ts" "$TARBALL_LIST"
assert_contains "tarball contains canonical runtime core" "package/extensions/ypi/runtime-core.ts" "$TARBALL_LIST"
assert_contains "tarball contains internal child-process owner" "package/extensions/ypi/internal/child-process.ts" "$TARBALL_LIST"
assert_contains "tarball contains internal child-output owner" "package/extensions/ypi/internal/child-output.ts" "$TARBALL_LIST"
assert_contains "tarball contains workspace-policy owner" "package/extensions/ypi/internal/workspace-policy.ts" "$TARBALL_LIST"
assert_contains "tarball contains implementer write-scope owner" "package/extensions/ypi/internal/write-scope.ts" "$TARBALL_LIST"
assert_contains "tarball contains bounded delegation skill" "package/skills/bounded-recursive-delegation/SKILL.md" "$TARBALL_LIST"
assert_contains "tarball contains internal CLI-input owner" "package/extensions/ypi/internal/cli-input.ts" "$TARBALL_LIST"
assert_contains "tarball contains thin CLI adapter" "package/extensions/ypi/cli.ts" "$TARBALL_LIST"
assert_contains "tarball contains generated Node CLI projection" "package/dist/rlm_query.mjs" "$TARBALL_LIST"
assert_contains "tarball contains cleanup helper" "package/rlm_cleanup" "$TARBALL_LIST"
assert_contains "tarball contains installed doctor" "package/scripts/doctor" "$TARBALL_LIST"
assert_contains "tarball contains Pi compatibility pin" "package/.pi-version" "$TARBALL_LIST"
assert_not_contains "tarball excludes private files" "package/private/" "$TARBALL_LIST"

mkdir -p "$TEST_TMP/install" "$TEST_TMP/home" "$TEST_TMP/cache"
INSTALL_LOG="$TEST_TMP/install.log"
if env \
	HOME="$TEST_TMP/home" \
	BUN_INSTALL="$TEST_TMP/install" \
	XDG_CACHE_HOME="$TEST_TMP/cache" \
	PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" \
	bun install -g "$TGZ" --ignore-scripts >"$INSTALL_LOG" 2>&1; then
	pass "isolated global install succeeds"
else
	fail "isolated global install succeeds" "$(tail -20 "$INSTALL_LOG")"
fi

YPI_BIN="$TEST_TMP/install/bin/ypi"
if [ -x "$YPI_BIN" ]; then
	pass "isolated global install exposes ypi"
else
	fail "isolated global install exposes ypi" "missing executable $YPI_BIN"
fi

if [ -x "$TEST_TMP/install/bin/rlm_cleanup" ]; then
	pass "isolated global install exposes rlm_cleanup"
else
	fail "isolated global install exposes rlm_cleanup" "missing executable $TEST_TMP/install/bin/rlm_cleanup"
fi

DOCTOR_BIN="$TEST_TMP/install/bin/ypi-doctor"
if [ -x "$DOCTOR_BIN" ]; then
	pass "isolated global install exposes ypi-doctor"
else
	fail "isolated global install exposes ypi-doctor" "missing executable $DOCTOR_BIN"
fi

RLM_BIN="$TEST_TMP/install/bin/rlm_query"
if [ -x "$RLM_BIN" ]; then
	pass "isolated global install exposes rlm_query"
else
	fail "isolated global install exposes rlm_query" "missing executable $RLM_BIN"
fi

mkdir -p "$TEST_TMP/mock-bin"
cat > "$TEST_TMP/mock-bin/pi" <<'MOCK_PI'
#!/usr/bin/env bash
[ -f "${RLM_SYSTEM_PROMPT:-}" ] || { echo "missing packaged system prompt" >&2; exit 90; }
[ -f "${YPI_EXTENSION_ROOT:-}/extensions/ypi/runtime-core.ts" ] || { echo "missing packaged runtime root" >&2; exit 91; }
[ -f "${YPI_EXTENSION_PATH:-}" ] || { echo "missing packaged extension path" >&2; exit 92; }
printf '%s\n' PACKED_CHILD_OK
MOCK_PI
chmod +x "$TEST_TMP/mock-bin/pi"
set +e
PACKED_RLM_OUTPUT="$(env -u RLM_BUDGET -u RLM_COST_FILE -u RLM_TIMEOUT -u RLM_START_TIME \
	HOME="$TEST_TMP/home" \
	PATH="$TEST_TMP/mock-bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
	YPI_PI_BIN="$TEST_TMP/mock-bin/pi" \
	RLM_DEPTH=0 RLM_MAX_DEPTH=2 RLM_CALL_COUNT=0 RLM_MAX_CALLS=8 \
	RLM_CALL_COUNTER_FILE="$TEST_TMP/packed-canonical.counter" RLM_TRACE_ID=packed-canonical \
		RLM_JSON=0 RLM_SHARED_SESSIONS=0 \
		"$RLM_BIN" "Packed runtime smoke" 2>&1)"
PACKED_RLM_RC=$?
set -e
if [ "$PACKED_RLM_RC" -eq 0 ]; then pass "installed canonical CLI exits cleanly"; else fail "installed canonical CLI exits cleanly" "rc=$PACKED_RLM_RC $PACKED_RLM_OUTPUT"; fi
assert_contains "installed rlm_query executes canonical runtime" "PACKED_CHILD_OK" "$PACKED_RLM_OUTPUT"

RUN_LOG="$TEST_TMP/ypi-version.log"
NODE_BIN="$(dirname "$(command -v node)")"
if env -u YPI_PI_BIN \
	HOME="$TEST_TMP/home" \
	BUN_INSTALL="$TEST_TMP/install" \
	XDG_CACHE_HOME="$TEST_TMP/cache" \
	PATH="$TEST_TMP/install/bin:$NODE_BIN:/usr/bin:/bin" \
	"$YPI_BIN" --version >"$RUN_LOG" 2>&1; then
	pass "global ypi resolves package-local pi without system pi on PATH"
else
	fail "global ypi resolves package-local pi without system pi on PATH" "$(cat "$RUN_LOG")"
fi
assert_contains "global ypi executes its exact package-local Pi dependency" "$PINNED_PI" "$(cat "$RUN_LOG")"

STALE_LOG="$TEST_TMP/ypi-stale-path.log"
if env -u YPI_PI_BIN \
	HOME="$TEST_TMP/home" BUN_INSTALL="$TEST_TMP/install" XDG_CACHE_HOME="$TEST_TMP/cache" \
	PATH="$TEST_TMP/mock-bin:$TEST_TMP/install/bin:$NODE_BIN:/usr/bin:/bin" \
	"$YPI_BIN" --version >"$STALE_LOG" 2>&1; then
	pass "global ypi ignores an incompatible PATH Pi when package-local Pi exists"
else
	fail "global ypi ignores an incompatible PATH Pi when package-local Pi exists" "$(cat "$STALE_LOG")"
fi
assert_contains "PATH shadow probe still uses package-local Pi" "$PINNED_PI" "$(cat "$STALE_LOG")"
assert_not_contains "PATH shadow probe does not execute stale Pi" "PACKED_CHILD_OK" "$(cat "$STALE_LOG")"

DOCTOR_LOG="$TEST_TMP/installed-doctor.log"
if env -u YPI_PI_BIN HOME="$TEST_TMP/home" \
	PATH="$TEST_TMP/mock-bin:$TEST_TMP/install/bin:$NODE_BIN:/usr/bin:/bin" \
	"$DOCTOR_BIN" >"$DOCTOR_LOG" 2>&1; then
	pass "installed ypi-doctor validates package-local Pi despite PATH shadow"
else
	fail "installed ypi-doctor validates package-local Pi despite PATH shadow" "$(cat "$DOCTOR_LOG")"
fi
assert_contains "installed doctor reads packaged Pi pin" "satisfies pinned $PINNED_PI" "$(cat "$DOCTOR_LOG")"

RLM_RESOLVE_LOG="$TEST_TMP/rlm-local-pi-resolution.log"
set +e
env -u YPI_PI_BIN HOME="$TEST_TMP/home" \
	PATH="$TEST_TMP/mock-bin:$TEST_TMP/install/bin:$NODE_BIN:/usr/bin:/bin" \
	RLM_DEPTH=0 RLM_MAX_DEPTH=0 bash -x "$RLM_BIN" "resolution probe" >"$RLM_RESOLVE_LOG" 2>&1
set -e
assert_contains "installed rlm_query resolves package-local Pi before PATH" "node_modules/.bin/pi" "$(cat "$RLM_RESOLVE_LOG")"
assert_not_contains "installed rlm_query does not select stale PATH Pi" "YPI_PI_BIN=$TEST_TMP/mock-bin/pi" "$(cat "$RLM_RESOLVE_LOG")"

tar -xzf "$TGZ" -C "$TEST_TMP"
UNPACKED="$TEST_TMP/package"
if [ -f "$UNPACKED/extensions/recursive.ts" ] && [ -f "$UNPACKED/package.json" ]; then
	pass "tarball unpacks as Pi package root"
else
	fail "tarball unpacks as Pi package root" "missing package files"
fi

DIRECT_BUNDLE_OUTPUT="$(env -u YPI_EXTENSION_ROOT -u YPI_EXTENSION_PATH -u RLM_SYSTEM_PROMPT \
	-u RLM_BUDGET -u RLM_COST_FILE -u RLM_TIMEOUT -u RLM_START_TIME \
	YPI_PI_BIN="$TEST_TMP/mock-bin/pi" CONTEXT="$TEST_TMP/ctx.txt" \
	RLM_DEPTH=0 RLM_MAX_DEPTH=2 RLM_CALL_COUNT=0 RLM_MAX_CALLS=8 \
	RLM_CALL_COUNTER_FILE="$TEST_TMP/direct-bundle.counter" RLM_TRACE_ID=direct-bundle \
		RLM_JSON=0 RLM_SHARED_SESSIONS=0 \
	node "$UNPACKED/dist/rlm_query.mjs" "Direct bundle root smoke" 2>&1 || true)"
assert_contains "direct generated bundle resolves its packaged root" "PACKED_CHILD_OK" "$DIRECT_BUNDLE_OUTPUT"
assert_not_contains "direct generated bundle avoids source-relative root failure" "missing packaged" "$DIRECT_BUNDLE_OUTPUT"

echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
	echo -e "\nFailures:$ERRORS"
	exit 1
fi
