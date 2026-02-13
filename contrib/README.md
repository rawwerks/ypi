# contrib/

Community and optional extensions. **Nothing here is required to use ypi.**

ypi is a recursive Pi launcher — it doesn't bundle or manage Pi extensions.
Pi's own auto-discovery (`~/.pi/agent/extensions/`) handles extension loading
for both interactive sessions and rlm_query children.

## Extensions

These are Pi extensions we find useful alongside ypi. Install any you like
by symlinking into your Pi extensions directory:

```bash
ln -s "$(pwd)/contrib/extensions/hashline.ts" ~/.pi/agent/extensions/hashline.ts
```

### dirpack.ts

Runs `dirpack pack` on session start and injects a compact repo index into
the system prompt. Gives the agent an instant map of the entire codebase —
file structure, function signatures, key types — without reading every file.

Requires [dirpack](https://github.com/rawwerks/dirpack) on PATH.

```bash
ln -s "$(pwd)/contrib/extensions/dirpack.ts" ~/.pi/agent/extensions/dirpack.ts
```

### colgrep.ts

Adds semantic code search via [colgrep](https://github.com/lightonai/next-plaid/tree/main/colgrep).
Pre-warms the ColBERT index on session start and injects usage instructions
into the system prompt so the agent uses `colgrep` as its primary search tool
instead of grep.

Requires `colgrep` on PATH.

```bash
ln -s "$(pwd)/contrib/extensions/colgrep.ts" ~/.pi/agent/extensions/colgrep.ts
```

### hashline.ts

Line-addressed editing with content hashes. Overrides Pi's `read` and `edit`
tools so every line is tagged `LINE:HASH|CONTENT`. Edits reference hashes
instead of requiring exact text match, catching stale-file errors before
they corrupt anything.

Ported from [oh-my-pi](https://github.com/can1357/oh-my-pi) by can1357.

```bash
ln -s "$(pwd)/contrib/extensions/hashline.ts" ~/.pi/agent/extensions/hashline.ts
```

### treemap.ts

Appends a repository tree overview to the system prompt so the agent always
has a map of the codebase. Uses `eza --tree` if available, falls back to `find`.

Some people "prime" their agents by pasting `eza --tree` output at the start
of a session. This extension automates that — the tree is generated once per
session and appended to every turn's system prompt.

```bash
ln -s "$(pwd)/contrib/extensions/treemap.ts" ~/.pi/agent/extensions/treemap.ts
```

Configuration:
| Env var | Default | Description |
|---|---|---|
| `TREEMAP_DEPTH` | `3` | Tree depth |
| `TREEMAP_CMD` | auto-detect | Custom command (overrides eza/find) |
| `TREEMAP_DISABLE` | `0` | Set to `1` to disable |

## Uninstalling

Remove the symlink from `~/.pi/agent/extensions/`:

```bash
rm ~/.pi/agent/extensions/<extension>.ts
```
