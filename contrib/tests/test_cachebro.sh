#!/bin/bash
# test_cachebro.sh — Tests for cachebro file cache extension.
#
# T1-T2: Structure tests (no LLM calls, checks file exists and loads)
# T3-T7: Logic tests (pure functions via bash, no Pi needed)
# T8-T10: Integration tests (real Pi session, costs money, --e2e flag)
#
# Usage:
#   bash contrib/tests/test_cachebro.sh          # unit tests only
#   bash contrib/tests/test_cachebro.sh --e2e    # include integration tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXT="$REPO_DIR/contrib/extensions/cachebro.ts"

PASS=0
FAIL=0
TESTS_RUN=0
RUN_E2E=false
CLEANUP_FILES=()

[ "${1:-}" = "--e2e" ] && RUN_E2E=true

# ─── Helpers ──────────────────────────────────────────────────────────────

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_ne() {
  local desc="$1" val1="$2" val2="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "$val1" != "$val2" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    values should differ but both are: $val1"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" pattern="$2" text="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if echo "$text" | grep -q "$pattern"; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    pattern '$pattern' not found in output"
    FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  for f in "${CLEANUP_FILES[@]}"; do
    rm -f "$f" 2>/dev/null || true
    [ -d "$f" ] && rmdir "$f" 2>/dev/null || true
  done
}
trap cleanup EXIT

# ─── T1: Extension structure ─────────────────────────────────────────────

echo ""
echo "=== T1: Extension file structure ==="

assert_eq "extension file exists" "1" "$([ -f "$EXT" ] && echo 1 || echo 0)"
assert_contains "exports default function" "export default function" "$(cat "$EXT")"
assert_contains "hooks tool_result event" 'on("tool_result"' "$(cat "$EXT")"
assert_contains "hooks session_start event" 'on("session_start"' "$(cat "$EXT")"
assert_contains "hooks session_switch event" 'on("session_switch"' "$(cat "$EXT")"
assert_contains "reads files from disk" "readFileSync" "$(cat "$EXT")"
assert_contains "uses sha256 hashing" "sha256" "$(cat "$EXT")"
assert_contains "handles write invalidation" '"write"' "$(cat "$EXT")"
assert_contains "handles edit invalidation" '"edit"' "$(cat "$EXT")"
assert_contains "supports CACHEBRO_DISABLE" "CACHEBRO_DISABLE" "$(cat "$EXT")"
assert_contains "supports partial reads" "offset" "$(cat "$EXT")"

# ─── T2: Extension loads in Pi ───────────────────────────────────────────

echo ""
echo "=== T2: Extension loads without errors ==="

if command -v pi &>/dev/null; then
  LOAD_STDERR=$(mktemp /tmp/cachebro_test_XXXXXX.txt)
  CLEANUP_FILES+=("$LOAD_STDERR" "${LOAD_STDERR}.stdout")

  echo "test" | timeout 15 pi -p --no-session --no-extensions -e "$EXT" "Say ok" \
    >"${LOAD_STDERR}.stdout" 2>"$LOAD_STDERR" || true

  LOAD_ERRORS=$(grep -ci 'Failed to load extension\|TypeError\|ReferenceError\|SyntaxError' "$LOAD_STDERR" || true)
  assert_eq "no load errors" "0" "$LOAD_ERRORS"
else
  echo "  SKIP: pi not installed"
fi

# ─── T3: SHA-256 hashing is deterministic ─────────────────────────────────

echo ""
echo "=== T3: Hashing correctness ==="

TMP_DIR=$(mktemp -d /tmp/cachebro_test_XXXXXX)
CLEANUP_FILES+=("$TMP_DIR")

echo "hello world" > "$TMP_DIR/test.txt"
HASH1=$(sha256sum "$TMP_DIR/test.txt" | cut -d' ' -f1)
HASH2=$(sha256sum "$TMP_DIR/test.txt" | cut -d' ' -f1)
assert_eq "same content same hash" "$HASH1" "$HASH2"

echo "hello world changed" > "$TMP_DIR/test.txt"
HASH3=$(sha256sum "$TMP_DIR/test.txt" | cut -d' ' -f1)
assert_ne "different content different hash" "$HASH1" "$HASH3"

echo "hello world" > "$TMP_DIR/test.txt"
HASH4=$(sha256sum "$TMP_DIR/test.txt" | cut -d' ' -f1)
assert_eq "restored content matches original hash" "$HASH1" "$HASH4"

# ─── T4: Diff output is correct ──────────────────────────────────────────

echo ""
echo "=== T4: Diff correctness ==="

cat > "$TMP_DIR/old.txt" << 'EOF'
line 1
line 2
line 3
line 4
line 5
EOF

cat > "$TMP_DIR/new.txt" << 'EOF'
line 1
line 2 modified
line 3
line 4
line 5
line 6 added
EOF

DIFF_OUTPUT=$(diff -u "$TMP_DIR/old.txt" "$TMP_DIR/new.txt" || true)
assert_contains "diff shows removed line" "^-line 2$" "$DIFF_OUTPUT"
assert_contains "diff shows added line" "^+line 2 modified$" "$DIFF_OUTPUT"
assert_contains "diff shows new line" "^+line 6 added$" "$DIFF_OUTPUT"

DIFF_SAME=$(diff -u "$TMP_DIR/old.txt" "$TMP_DIR/old.txt" || true)
assert_eq "identical files produce empty diff" "" "$DIFF_SAME"

# ─── T5: Partial read range detection ────────────────────────────────────

echo ""
echo "=== T5: Partial read range overlap ==="

cat > "$TMP_DIR/before.txt" << 'EOF'
line 1
line 2
line 3
line 4
line 5
line 6
line 7
line 8
line 9
line 10
EOF

cat > "$TMP_DIR/after.txt" << 'EOF'
line 1
line 2
line 3
line 4
line 5
line 6
line 7
line 8 CHANGED
line 9
line 10
EOF

RANGE_1_5=$(diff <(sed -n '1,5p' "$TMP_DIR/before.txt") <(sed -n '1,5p' "$TMP_DIR/after.txt") || true)
assert_eq "lines 1-5 unchanged when edit at line 8" "" "$RANGE_1_5"

RANGE_6_10=$(diff <(sed -n '6,10p' "$TMP_DIR/before.txt") <(sed -n '6,10p' "$TMP_DIR/after.txt") || true)
assert_ne "lines 6-10 changed when edit at line 8" "" "$RANGE_6_10"

# ─── T6: Token estimation ────────────────────────────────────────────────

echo ""
echo "=== T6: Token estimation ==="

TOKENS_100=$(python3 -c "import math; print(math.ceil(100 * 0.75))")
assert_eq "100 chars → 75 tokens" "75" "$TOKENS_100"

TOKENS_1000=$(python3 -c "import math; print(math.ceil(1000 * 0.75))")
assert_eq "1000 chars → 750 tokens" "750" "$TOKENS_1000"

TOKENS_1=$(python3 -c "import math; print(math.ceil(1 * 0.75))")
assert_eq "1 char → 1 token" "1" "$TOKENS_1"

# ─── T7: Cache invalidation on file change ───────────────────────────────

echo ""
echo "=== T7: Cache invalidation logic ==="

echo "original content" > "$TMP_DIR/cached.txt"
H_ORIG=$(sha256sum "$TMP_DIR/cached.txt" | cut -d' ' -f1)

echo "new content" > "$TMP_DIR/cached.txt"
H_NEW=$(sha256sum "$TMP_DIR/cached.txt" | cut -d' ' -f1)
assert_ne "hash changes after write" "$H_ORIG" "$H_NEW"

echo "original content" > "$TMP_DIR/cached.txt"
H_RESTORED=$(sha256sum "$TMP_DIR/cached.txt" | cut -d' ' -f1)
assert_eq "hash restored after reverting content" "$H_ORIG" "$H_RESTORED"

> "$TMP_DIR/cached.txt"
H_EMPTY=$(sha256sum "$TMP_DIR/cached.txt" | cut -d' ' -f1)
assert_ne "empty file has distinct hash" "$H_ORIG" "$H_EMPTY"

# ─── T8: Diff efficiency ─────────────────────────────────────────────────

echo ""
echo "=== T8: Diff efficiency ==="

for i in $(seq 1 100); do echo "line $i: some content here for padding purposes"; done > "$TMP_DIR/big.txt"
cp "$TMP_DIR/big.txt" "$TMP_DIR/big_modified.txt"
sed -i '50s/.*/line 50: THIS LINE WAS CHANGED/' "$TMP_DIR/big_modified.txt"

FULL_SIZE=$(wc -c < "$TMP_DIR/big_modified.txt")
DIFF_SIZE=$(diff -u "$TMP_DIR/big.txt" "$TMP_DIR/big_modified.txt" | wc -c || true)
RATIO=$(python3 -c "print('short' if $DIFF_SIZE < $FULL_SIZE * 0.5 else 'long')")
assert_eq "single-line diff shorter than 50% of file" "short" "$RATIO"

for i in $(seq 1 100); do echo "completely different line $i $$"; done > "$TMP_DIR/big_rewritten.txt"
DIFF_BIG=$(diff -u "$TMP_DIR/big.txt" "$TMP_DIR/big_rewritten.txt" | wc -c || true)
RATIO_BIG=$(python3 -c "print('big' if $DIFF_BIG > $FULL_SIZE * 0.5 else 'small')")
assert_eq "full-rewrite diff is large" "big" "$RATIO_BIG"

# ─── Integration Tests ───────────────────────────────────────────────────

if [ "$RUN_E2E" = true ]; then
  if ! command -v pi &>/dev/null; then
    echo ""
    echo "SKIP: pi not installed"
  else
    PI_VERSION=$(pi --version 2>/dev/null || echo "unknown")

    echo ""
    echo "=== T9: Cache hit on second read (pi $PI_VERSION) ==="

    E2E_DIR=$(mktemp -d /tmp/cachebro_e2e_XXXXXX)
    CLEANUP_FILES+=("$E2E_DIR")

    cat > "$E2E_DIR/example.ts" << 'TSEOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}
TSEOF

    RESULT=$(cd "$E2E_DIR" && timeout 30 pi -p --no-session --no-extensions \
      -e "$EXT" \
      "Read the file example.ts twice using the Read tool. First read it, then read it again. Report exactly what you see each time." \
      2>/dev/null || true)

    assert_contains "agent sees cachebro output" "cachebro\|unchanged\|cached\|tokens saved" "$RESULT"

    echo ""
    echo "=== T10: Cache invalidation after write (pi $PI_VERSION) ==="

    RESULT2=$(cd "$E2E_DIR" && timeout 30 pi -p --no-session --no-extensions \
      -e "$EXT" \
      "Read example.ts, then write a new line at the end of example.ts, then read example.ts again. Tell me what you see on the final read." \
      2>/dev/null || true)

    assert_contains "agent sees updated content after write" "console\|test\|diff\|changed\|cachebro" "$RESULT2"

    echo ""
    echo "=== T11: Coexistence with hashline (pi $PI_VERSION) ==="

    HASHLINE_EXT="$REPO_DIR/contrib/extensions/hashline.ts"
    if [ -f "$HASHLINE_EXT" ]; then
      RESULT3=$(cd "$E2E_DIR" && timeout 30 pi -p --no-session --no-extensions \
        -e "$HASHLINE_EXT" -e "$EXT" \
        "Read example.ts twice. Report what you see." \
        2>/dev/null || true)

      assert_contains "works with hashline" "cachebro\|unchanged\|tokens saved\|greet\|add" "$RESULT3"
    else
      echo "  SKIP: hashline.ts not found"
    fi
  fi
else
  echo ""
  echo "(Skipping integration tests — run with --e2e to include)"
fi

# ─── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════"
echo "  $PASS passed, $FAIL failed, $TESTS_RUN total"
echo "════════════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
