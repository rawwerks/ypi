# push

kind: let

source:
```prose
let push = exec """
cd /home/raw/Documents/GitHub/ypi
jj bookmark set master 2>&1
jj git push 2>&1
"""
```

exit_code: 0
stderr: (empty)

---

Move forward bookmark master from 9d4da4cd1b74 to 5b159aa10140
