# fast

kind: let

source:
```prose
let fast = exec "make test-fast 2>&1 | tail -10"
```

exit_code: 0
stderr: (empty)

---

  ✓ G49: no session listed
  ✓ G50: SHARED_SESSIONS=1 enables
  ✓ G51: trace filter includes matching
  ✓ G51: trace filter excludes other

═══════════════════════════════════
  Results: 72 passed, 0 failed
═══════════════════════════════════

All tests passed! ✓
