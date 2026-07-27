#!/bin/bash
# test_provider_allowlist.sh — keep the child-process provider env allowlist correct.
#
# Two invariants (no LLM calls):
#   1. The CLI adapter delegates directly to the canonical runtime core.
#   2. Every real provider credential Pi reads is in the canonical allowlist,
#      so a child can authenticate to the same provider as its parent.
#
# Run: bash tests/test_provider_allowlist.sh

set -euo pipefail
exec </dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_CONFIG="$PROJECT_DIR/extensions/ypi/internal/child-config.ts"
CLI_ADAPTER="$PROJECT_DIR/extensions/ypi/cli.ts"
PI_MONO="$PROJECT_DIR/pi-mono"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1: $2"; }

echo ""
echo "=== Provider env allowlist ==="

# ── Extract the native allowlist (the PROVIDER_ENV_ALLOWLIST Set) ──────────────
NATIVE_KEYS="$(awk '/PROVIDER_ENV_ALLOWLIST = new Set\(\[/{f=1;next} /\]\);/{f=0} f' "$RUNTIME_CONFIG" \
    | grep -oE '"[A-Z][A-Z0-9_]*"' | tr -d '"' | sort -u)"

NATIVE_COUNT="$(printf '%s\n' "$NATIVE_KEYS" | grep -c . || true)"
if [ "$NATIVE_COUNT" -ge 40 ]; then
    pass "P1: canonical allowlist is populated ($NATIVE_COUNT provider keys)"
else
    fail "P1: canonical allowlist is populated" "only $NATIVE_COUNT keys"
fi

if grep -q 'runRecursiveChild' "$CLI_ADAPTER"; then
    pass "P2: CLI delegates child execution to the canonical core"
else
    fail "P2: CLI delegates child execution to the canonical core" "missing runRecursiveChild dependency"
fi

# ── Completeness vs pinned pi-mono (skips if submodule absent) ─────────────────
# Source of truth is env-api-keys.ts: getEnvApiKey() reads some names directly
# through process.env.KEY and maps others through envMap string values. We extract
# those exact names directly (not by suffix regex), so credentials like
# COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, and HF_TOKEN — which end in
# neither _API_KEY nor _OAUTH_TOKEN — are still enforced.
ENV_KEY_SRC="$PI_MONO/packages/ai/src/env-api-keys.ts"
if [ -f "$ENV_KEY_SRC" ]; then
    REAL_KEYS="$(node - "$ENV_KEY_SRC" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
const keys = new Set();
for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
    keys.add(match[1]);
}
for (const match of source.matchAll(/:\s*"([A-Z][A-Z0-9_]+)"/g)) {
    keys.add(match[1]);
}
console.log([...keys].sort().join("\n"));
NODE
)"
    REAL_COUNT="$(printf '%s\n' "$REAL_KEYS" | grep -c . || true)"
    MISSING=""
    for key in $REAL_KEYS; do
        if ! printf '%s\n' "$NATIVE_KEYS" | grep -qx "$key"; then
            MISSING="$MISSING $key"
        fi
    done
    if [ "$REAL_COUNT" -lt 20 ]; then
        fail "C1: extracted provider credentials from env-api-keys.ts" "parsed only $REAL_COUNT — extraction likely broke"
    elif [ -z "$MISSING" ]; then
        pass "C1: allowlist covers every env-api-keys.ts provider credential ($REAL_COUNT names)"
    else
        fail "C1: allowlist covers every env-api-keys.ts provider credential" "not allowlisted:$MISSING"
    fi
else
    echo "  - C1 skipped (pi-mono env-api-keys.ts not present)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
