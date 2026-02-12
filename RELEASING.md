# Releasing ypi

## Version Strategy

We use [semver](https://semver.org/):
- **patch** (0.1.0 → 0.1.1): bug fixes, docs
- **minor** (0.1.x → 0.2.0): new features, new env vars, new guardrails
- **major** (0.x → 1.0): breaking changes to CLI args, env vars, or rlm_query interface

## How to Release

### 1. Make sure tests pass
```bash
make test-fast
```

### 2. Update version in package.json
Edit `package.json` and set the new version. Don't use `npm version` — it
calls git directly which conflicts with jj.

### 3. Update CHANGELOG.md
Add an entry under the new version. Follow the format already in the file.

### 4. Commit and tag
```bash
jj describe -m "release: v0.2.0"
jj bookmark set master
jj bookmark set v0.2.0
jj git push --bookmark master --bookmark v0.2.0
```

### 5. Publish to npm
```bash
npm publish
```

### 6. Create GitHub Release
Go to https://github.com/rawwerks/ypi/releases/new, select the tag, paste
the changelog entry as release notes.

### 7. Start next change
```bash
jj new
```

## Notes

- **jj bookmarks as tags**: We use `jj bookmark set vX.Y.Z` for release tags.
  These push to GitHub as branches, which is fine — GitHub Releases can
  reference them. True git tags (`jj git push --tag`) are not yet stable in jj.
- **No auto-changelog tooling**: The jj log is the source of truth. We manually
  curate CHANGELOG.md to keep it human-readable.
- **npm login**: Publishing requires `npm login` as `rawwerks`.
