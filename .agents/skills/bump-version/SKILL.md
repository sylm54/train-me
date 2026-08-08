---
name: bump-version
description: How to cut a new release of train-me. Use whenever the user asks to bump, ship, cut, or release a version, prepare a release, or push a new tag so CI runs — even if they don't say "bump version" explicitly. Handles updating the version across all synced files, tagging, and pushing the tag to trigger the release workflow.
---

# Bump Version

Cut a new release of train-me by bumping the version, tagging the commit, and pushing the tag. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds Windows (MSI) and Android packages and creates a **draft** GitHub release named `train-me v<version>`.

## The four version locations

The version lives in **four** files that must always be in sync. Missing one is the common failure mode, so don't hand-edit them — use the script in the next section:

1. `package.json` — the CI workflow reads the version **only** from here (`jq -r '.version' package.json`).
2. `src-tauri/tauri.conf.json` — must match `package.json`; Tauri validates it matches the Cargo crate.
3. `src-tauri/Cargo.toml` — the Rust crate version, under `[package]`.
4. `src-tauri/Cargo.lock` — **only** the `train-me` crate entry. The lockfile has thousands of unrelated `version` lines for dependencies; changing any of those breaks the build.

Do **not** touch `package-lock.json`. Its root `"version"` is unrelated (currently stale at `0.3.0`) and is not part of releases.

## Release flow

### 1. Decide the new version

Versions are [semver](https://semver.org) `MAJOR.MINOR.PATCH`. Look at the current version and recent tags (`git tag --sort=-v:refname | head`) to pick the right bump:

- **patch** (`0.8.2` → `0.8.3`): bug fixes, small tweaks.
- **minor** (`0.8.2` → `0.9.0`): new features, backward-compatible.
- **major** (`0.8.2` → `1.0.0`): breaking changes. (train-me is pre-1.0, so minor bumps are the common "new release" cadence.)

If the user didn't specify, ask which level they want rather than guessing — a wrong bump can't be cleanly undone once the tag is pushed.

### 2. Update the four files with the helper script

From the repo root, run:

```bash
.agents/skills/bump-version/scripts/bump-version.sh <new-version>
```

For example:

```bash
.agents/skills/bump-version/scripts/bump-version.sh 0.8.3
```

The script:

- Validates the version string.
- Edits all four files with targeted replacements (Cargo.lock is patched only at the `train-me` crate entry — see the script comments for why this matters).
- Refuses to run if the version is unchanged or not in `MAJOR.MINOR.PATCH` form.
- Prints a verification block showing the new version in each file — **read it**. All four must show the new version.

If for any reason the script can't be run (e.g. Windows without bash), the four edits it makes are documented inline in `scripts/bump-version.sh` — replicate them precisely rather than improvising.

### 3. Sanity check the diff

```bash
git diff
```

Confirm exactly four one-line changes, all to the same new version, and nothing else (no reformatting, no dependency versions, no `package-lock.json`).

### 4. Commit, tag, and push

The project's convention is a `Bump version to v<version>` commit message.

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Bump version to v<version>"
git tag "v<version>"
git push origin master "v<version>"
```

**The push is the release trigger — confirm with the user before running it** unless they've already said to release. Pushing the tag kicks off the build workflow, which creates a draft GitHub release with binary assets.

### 5. Verify the release

After pushing, give CI a moment and check the workflow run:

```bash
gh run watch
```

Or open the Actions tab: `https://github.com/sylm54/train-me/actions`. The release appears as a **draft** at `https://github.com/sylm54/train-me/releases` — it still needs to be published (or discarded) by hand once the builds finish. A published release is outward-facing and hard to undo, so surface that step to the user rather than auto-publishing.

## Notes & gotchas

- **Already-pushed tag:** the CI `meta` job gracefully skips if a tag for the current `package.json` version already exists. So re-pushing the same tag is a no-op for releases, but still errors locally — check `git tag` first if you're unsure.
- **The tag must start with `v`** (`v0.8.3`, not `0.8.3`) or the workflow won't trigger.
- **The repo's default branch is `master`.** Push the version commit and the tag to `origin master` together (`git push origin master "v<version>"`) so CI checks out a commit that has the tag.
- **Reset saved chats:** there's an existing `feat(settings): reset saved chats on app data reset` setting; it's unrelated to versioning and shouldn't be touched during a bump.
