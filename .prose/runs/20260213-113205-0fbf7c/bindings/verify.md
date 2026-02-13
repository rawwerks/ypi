# verify

kind: let

source:
```prose
let verify = exec "make test-fast 2>&1 | tail -15"
```

exit_code: 0
stderr: (empty)

---

  ✓ G47: RLM_JSON=0 works

=== rlm_sessions ===
  ✓ G48: lists sessions by default
  ✓ G49: SHARED_SESSIONS=0 disables
  ✓ G49: no session listed
  ✓ G50: SHARED_SESSIONS=1 enables
  ✓ G51: trace filter includes matching
  ✓ G51: trace filter excludes other

═══════════════════════════════════
  Results: 72 passed, 0 failed
═══════════════════════════════════

All tests passed! ✓
