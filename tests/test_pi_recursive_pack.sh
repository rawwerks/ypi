#!/bin/bash
# test_pi_recursive_pack.sh — packed-consumer smoke for the pure-extension `pi-recursive` package.
#
# Builds the pi-recursive publish view from canonical source, packs it, asserts the tarball
# surface (extension TS + SYSTEM_PROMPT.md, no bin/shell/tests/private), and loads the packed
# extension via a real `pi -e` to confirm it registers the native rlm_query tool.
#
# Run: bash tests/test_pi_recursive_pack.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$PROJECT_DIR/pi-recursive"

if ! command -v bun >/dev/null 2>&1; then
	echo "SKIP: bun not installed"
	exit 0
fi

SCRATCH_ROOT="${HOME}/scratch/pi-recursive-pack"
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
	if echo "$haystack" | grep -qF -- "$needle"; then pass "$label"; else fail "$label" "expected '$needle'"; fi
}
assert_not_contains() {
	local label="$1" needle="$2" haystack="$3"
	if echo "$haystack" | grep -qF -- "$needle"; then fail "$label" "unexpected '$needle'"; else pass "$label"; fi
}

echo ""
echo "=== pi-recursive Packed Consumer Smoke ==="
echo "artifacts=$TEST_TMP"

# Stage the publish view from canonical root source (explicit build, no lifecycle hook).
bash "$PROJECT_DIR/scripts/build-pi-recursive"

# package.json shape: pure extension — no bin, has pi.extensions, host pi is a peer dep.
PKG_JSON="$PKG_DIR/package.json"
HAS_BIN="$(node -e "console.log('bin' in require('$PKG_JSON'))")"
HAS_PI_EXT="$(node -e "const p=require('$PKG_JSON');console.log((p.pi?.extensions||[]).join(','))")"
HAS_PI_SKILL="$(node -e "const p=require('$PKG_JSON');console.log((p.pi?.skills||[]).join(','))")"
HAS_PEER="$(node -e "const p=require('$PKG_JSON');console.log(p.peerDependencies?.['@earendil-works/pi-coding-agent']||'')")"
HAS_TYPEBOX="$(node -e "const p=require('$PKG_JSON');console.log(p.peerDependencies?.typebox||'')")"
[ "$HAS_BIN" = "false" ] && pass "manifest has no bin (pure extension)" || fail "manifest has no bin" "bin present"
assert_contains "manifest exposes canonical extension" "./extensions/recursive.ts" "$HAS_PI_EXT"
assert_contains "manifest exposes bounded delegation skill" "./skills" "$HAS_PI_SKILL"
[ "$HAS_PEER" = "*" ] && pass "manifest declares host Pi as an unrestricted peer" || fail "manifest declares host Pi as an unrestricted peer" "value=$HAS_PEER"
[ "$HAS_TYPEBOX" = "*" ] && pass "manifest declares host typebox as an unrestricted peer" || fail "manifest declares host typebox as an unrestricted peer" "value=$HAS_TYPEBOX"

# Pack and inspect the tarball surface.
PACK_OUTPUT="$(cd "$PKG_DIR" && bun pm pack --destination "$TEST_TMP" --ignore-scripts --quiet)"
TARBALL="$(printf '%s\n' "$PACK_OUTPUT" | awk 'NF { last=$0 } END { print last }')"
[[ "$TARBALL" = /* ]] || TARBALL="$PKG_DIR/$TARBALL"
[ -f "$TARBALL" ] && pass "npm tarball created" || { fail "npm tarball created" "no tarball: $TARBALL"; echo -e "$ERRORS"; exit 1; }

TARBALL_LIST="$(tar -tzf "$TARBALL")"
assert_contains "tarball ships canonical extension" "package/extensions/recursive.ts" "$TARBALL_LIST"
assert_contains "tarball ships native adapter" "package/extensions/ypi/native-tool.ts" "$TARBALL_LIST"
assert_contains "tarball ships canonical runtime core" "package/extensions/ypi/runtime-core.ts" "$TARBALL_LIST"
assert_contains "tarball ships internal child-process owner" "package/extensions/ypi/internal/child-process.ts" "$TARBALL_LIST"
assert_contains "tarball ships internal child-output owner" "package/extensions/ypi/internal/child-output.ts" "$TARBALL_LIST"
assert_contains "tarball ships implementer write-scope owner" "package/extensions/ypi/internal/write-scope.ts" "$TARBALL_LIST"
assert_contains "tarball ships system prompt" "package/SYSTEM_PROMPT.md" "$TARBALL_LIST"
assert_contains "tarball ships bounded delegation skill" "package/skills/bounded-recursive-delegation/SKILL.md" "$TARBALL_LIST"
assert_not_contains "tarball excludes the wrapper launcher" "package/ypi" "$TARBALL_LIST"
assert_not_contains "tarball excludes the shell rlm_query" "package/rlm_query" "$TARBALL_LIST"
assert_not_contains "tarball excludes tests" "package/tests/" "$TARBALL_LIST"
assert_not_contains "tarball excludes private files" "package/private/" "$TARBALL_LIST"

# Real load: install into an isolated consumer and load via `pi -e`; it must register the tool.
if command -v pi >/dev/null 2>&1; then
	CONSUMER="$TEST_TMP/consumer"
	mkdir -p "$CONSUMER"
	printf '{"name":"c","version":"1.0.0","private":true}\n' > "$CONSUMER/package.json"
	(cd "$CONSUMER" && bun add "$TARBALL" --no-save >/dev/null 2>&1)
	EXT="$CONSUMER/node_modules/pi-recursive/extensions/recursive.ts"
	if [ -f "$EXT" ]; then
		FAKE_PI="$TEST_TMP/fake-pi"
		cat > "$FAKE_PI" <<'FAKEPI'
#!/usr/bin/env bash
printf '%s\n' PACKED_NATIVE_EXEC_OK
FAKEPI
		chmod +x "$FAKE_PI"
			if bun "$PROJECT_DIR/tests/installed_extension_harness.ts" "$EXT" "$FAKE_PI" >"$TEST_TMP/execute.out" 2>"$TEST_TMP/execute.err" \
				&& grep -q 'INSTALLED_EXTENSION_EXECUTION=PASS' "$TEST_TMP/execute.out"; then
				pass "installed pi-recursive native tool executes through canonical runtime"
			else
				fail "installed pi-recursive native tool executes through canonical runtime" "$(tail -4 "$TEST_TMP/execute.err")"
			fi

			ERRF="$TEST_TMP/load.err"
		set +e
		YPI_EXTENSION_DEBUG=1 RLM_MAX_DEPTH=2 timeout 30 pi --no-extensions -e "$EXT" --list-models test >"$TEST_TMP/load.out" 2>"$ERRF"
		LOAD_RC=$?
		set -e
		if [ "$LOAD_RC" -eq 0 ] \
			&& grep -q '__YPI_EXTENSION_LOADED__' "$ERRF" \
			&& grep -q '__YPI_NATIVE_TOOL_REGISTERED__' "$ERRF"; then
			pass "installed pi-recursive exits cleanly, loads, and registers native rlm_query"
		else
			fail "installed pi-recursive exits cleanly, loads, and registers native rlm_query" "rc=$LOAD_RC $(tail -3 "$ERRF")"
		fi
	else
		fail "installed package exposes the extension" "missing $EXT"
	fi
else
	echo "  - load check skipped (pi not installed)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then echo -e "Failures:$ERRORS"; exit 1; fi
echo "All pi-recursive pack tests passed! ✓"
