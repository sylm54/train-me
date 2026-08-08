#!/usr/bin/env bash
#
# bump-version.sh <new-version>
#
# Updates the version in the FOUR places that must stay in sync for a release:
#   1. package.json                      (CI reads the version from here)
#   2. src-tauri/tauri.conf.json         (must match package.json)
#   3. src-tauri/Cargo.toml              (Rust crate version)
#   4. src-tauri/Cargo.lock              (only the `train-me` crate entry —
#                                         the lockfile has thousands of
#                                         `version` lines for dependencies)
#
# It edits files only. It does NOT commit, tag, or push — the SKILL.md walks
# those git steps so each one (especially the release-triggering push) is
# intentional and verifiable.
#
# Run from anywhere; it resolves the repo root from its own location.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <new-version>   (e.g. 0.8.3)" >&2
  exit 1
fi

NEW="$1"

# Validate MAJOR.MINOR.PATCH, optional -prerelease. Keeps stray junk out.
if ! printf '%s' "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "Error: '$NEW' is not a valid version (expected MAJOR.MINOR.PATCH)." >&2
  exit 1
fi

# Script lives at <root>/.agents/skills/bump-version/scripts/bump-version.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"

# Relative paths read better in the verification output and git hints.
pkg="package.json"
tauri="src-tauri/tauri.conf.json"
cargo="src-tauri/Cargo.toml"
lock="src-tauri/Cargo.lock"

for f in "$pkg" "$tauri" "$cargo" "$lock"; do
  if [ ! -f "$f" ]; then
    echo "Error: expected file not found: $f" >&2
    exit 1
  fi
done

OLD=$(grep -E '^  "version":' "$pkg" | head -1 | sed -E 's/.*"version": "([^"]*)".*/\1/')

if [ -z "$OLD" ]; then
  echo "Error: could not read current version from $pkg" >&2
  exit 1
fi

if [ "$OLD" = "$NEW" ]; then
  echo "Already at $NEW — nothing to do." >&2
  exit 1
fi

# 1 & 2. JSON files — replace the top-level (2-space-indent) "version" line.
#    A targeted sed keeps the diff to one line per file; jq would reformat.
sed -i -e "s|^  \"version\": \"[^\"]*\"|  \"version\": \"$NEW\"|" "$pkg"
sed -i -e "s|^  \"version\": \"[^\"]*\"|  \"version\": \"$NEW\"|" "$tauri"

# 3. Cargo.toml — the [package] version is the first `version = "..."` line.
sed -i -e "0,/^version = \"[^\"]*\"/s//version = \"$NEW\"/" "$cargo"

# 4. Cargo.lock — update ONLY the version that follows `name = "train-me"`.
awk -v new="$NEW" '
  /^name = "train-me"$/ { hit = 1 }
  hit && /^version = ".*"$/ { sub(/version = ".*"/, "version = \"" new "\""); hit = 0 }
  { print }
' "$lock" > "$lock.tmp" && mv "$lock.tmp" "$lock"

echo "Bumped version $OLD -> $NEW"
echo
echo "Verify:"
grep -nE '^  "version":' "$pkg"               | sed 's|^|  package.json:              |'
grep -nE '^  "version":' "$tauri"             | sed 's|^|  src-tauri/tauri.conf.json: |'
grep -nE '^version =' "$cargo" | head -1       | sed 's|^|  src-tauri/Cargo.toml:       |'
grep -A1 '^name = "train-me"$' "$lock" | grep '^version' | sed 's|^|  src-tauri/Cargo.lock:         |'
echo
echo "Next (SKILL.md walks these — confirm before pushing the tag):"
echo "  git add $pkg $tauri $cargo $lock"
echo "  git commit -m \"Bump version to v$NEW\""
echo "  git tag \"v$NEW\""
echo "  git push origin master \"v$NEW\""
