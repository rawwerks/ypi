# installed

kind: let

source:
```prose
let installed = exec "pi --version 2>/dev/null || echo not-installed"
```

exit_code: 0
stderr: (empty)

---

0.52.12
