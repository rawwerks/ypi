#!/usr/bin/env bash
set -euo pipefail

# This suite runs inside the pre-push hook, where git exports GIT_DIR (and
# friends). Inherited values override `git -C` discovery and would point the
# fixture repositories at the real parent checkout.
for _v in $(env | grep -o '^GIT_[A-Z_]*' || true); do unset "$_v"; done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATE="$ROOT/scripts/validate-push-owner"
RELEASE="$ROOT/scripts/assert-release-authorized"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s: %s\n' "$1" "$2"; }
expect_pass() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label" "unexpected rejection"; fi; }
expect_fail() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$label" "unexpected authorization"; else pass "$label"; fi; }

echo ""
echo "=== Delivery and release authority ==="
expect_pass "owned HTTPS remote allowed" "$VALIDATE" https://github.com/ruslanvasylev/ypi.git
expect_pass "owned SSH remote allowed" "$VALIDATE" git@github.com:ruslanvasylev/ypi.git
expect_pass "owned ssh URL allowed" "$VALIDATE" ssh://git@github.com/ruslanvasylev/ypi.git
expect_fail "non-owned upstream denied" "$VALIDATE" https://github.com/otherowner/ypi.git
expect_fail "lookalike owner denied" "$VALIDATE" https://github.com/ruslanvasylev-evil/ypi.git
expect_fail "embedded owner text denied" "$VALIDATE" https://github.com/other/ruslanvasylev-ypi.git
expect_fail "unparseable remote denied" "$VALIDATE" not-a-remote
expect_fail "arbitrary host with owned-looking path denied" "$VALIDATE" https://attacker.invalid/ruslanvasylev/ypi.git
expect_fail "dot-segment owner escape denied" "$VALIDATE" https://github.com/ruslanvasylev/../otherowner/ypi.git
expect_fail "ambiguous SCP-like URL denied" "$VALIDATE" evil.invalid:ignored@github.com:ruslanvasylev/ypi.git
expect_fail "percent-encoded path denied" "$VALIDATE" https://github.com/ruslanvasylev%2Frawwerks/ypi.git
expect_fail "local filesystem remote denied outside tests" "$VALIDATE" "$ROOT/.git"
expect_pass "local filesystem fixture allowed only by test marker" env YPI_ALLOW_LOCAL_REMOTE_FOR_TESTS=1 "$VALIDATE" "$ROOT/.git"
expect_fail "environment cannot authorize a non-owned remote" env YPI_EXPLICIT_NON_OWNED_REMOTE=github.com/otherowner/ypi "$VALIDATE" https://github.com/otherowner/ypi.git

expect_fail "release denied without explicit user request" "$RELEASE"
expect_pass "release helper accepts explicit user request marker" env YPI_EXPLICIT_RELEASE_REQUEST=1 "$RELEASE"

HOOK="$ROOT/.githooks/pre-push"
if printf 'refs/heads/feature abc refs/heads/feature def\n' | YPI_SKIP_PUSH_CHECKS=1 "$HOOK" origin https://github.com/ruslanvasylev/ypi.git >/dev/null 2>&1; then
  pass "quality-check skip cannot disable owned-remote policy"
else
  fail "owned feature push passes hook policy" "hook rejected"
fi
if printf 'refs/heads/feature abc refs/heads/feature def\n' | YPI_SKIP_PUSH_CHECKS=1 "$HOOK" upstream https://github.com/rawwerks/ypi.git >/dev/null 2>&1; then
  fail "quality-check skip cannot bypass non-owned denial" "hook authorized upstream"
else
  pass "quality-check skip cannot bypass non-owned denial"
fi
if printf 'refs/tags/v1.0.0 abc refs/tags/v1.0.0 def\n' | YPI_SKIP_PUSH_CHECKS=1 "$HOOK" origin https://github.com/ruslanvasylev/ypi.git >/dev/null 2>&1; then
  fail "release ref requires explicit request" "tag was authorized"
else
  pass "release ref requires explicit request"
fi
if printf 'refs/tags/v1.0.0 abc refs/tags/v1.0.0 def\n' | YPI_SKIP_PUSH_CHECKS=1 YPI_EXPLICIT_RELEASE_REQUEST=1 "$HOOK" origin https://github.com/ruslanvasylev/ypi.git >/dev/null 2>&1; then
  pass "explicit release request authorizes owned release ref"
else
  fail "explicit release request authorizes owned release ref" "hook rejected"
fi

MULTI_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/ypi_multi_push.XXXXXX")"
MULTI_TMP="$MULTI_PARENT/repo"
git clone -q --no-checkout "$ROOT" "$MULTI_TMP"
mkdir -p "$MULTI_TMP/scripts"
ln -s "$VALIDATE" "$MULTI_TMP/scripts/validate-push-owner"
ln -s "$RELEASE" "$MULTI_TMP/scripts/assert-release-authorized"
git -C "$MULTI_TMP" remote set-url origin https://github.com/ruslanvasylev/ypi.git
git -C "$MULTI_TMP" remote set-url --add --push origin https://github.com/ruslanvasylev/ypi.git
git -C "$MULTI_TMP" remote set-url --add --push origin https://github.com/otherowner/ypi.git
if (cd "$MULTI_TMP" && printf 'refs/heads/feature abc refs/heads/feature def\n' | YPI_SKIP_PUSH_CHECKS=1 "$HOOK" origin https://github.com/ruslanvasylev/ypi.git >/dev/null 2>&1); then
  fail "every configured push URL is owner-validated" "second non-owned pushurl was authorized"
else
  pass "every configured push URL is owner-validated"
fi
rm -rf "$MULTI_PARENT"

if grep -q 'Never release, publish, tag, or ask whether to release' "$ROOT/SYSTEM_PROMPT.md"; then pass "system prompt carries release prohibition"; else fail "system prompt carries release prohibition" "missing rule"; fi
if grep -q 'validate-push-owner' "$ROOT/scripts/land" && grep -q -- '--no-follow-tags' "$ROOT/scripts/land" && grep -q 'HEAD:refs/heads/' "$ROOT/scripts/land" && ! grep -q 'to publish to npm' "$ROOT/scripts/land"; then pass "landing validates all origin targets and pushes only one branch"; else fail "landing publication boundary" "unsafe landing text"; fi
if grep -q 'git diff --quiet' "$ROOT/scripts/land" && grep -q 'HEAD_BEFORE' "$ROOT/scripts/land"; then pass "landing binds validation to a clean unchanged commit"; else fail "landing exact-state gate" "missing clean/HEAD checks"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
