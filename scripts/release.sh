#!/usr/bin/env bash
#
# Cut a release. Usage:
#
#   npm run release X.Y.Z [NEXT_DEV_BASE]
#
# X.Y.Z          the version to release (must equal main's current X.Y.Z-develop base)
# NEXT_DEV_BASE  optional base to open next (defaults to next minor, e.g. 0.4.0 -> 0.5.0)
#
# It guards, then in one shot:
#   1. promotes CHANGELOG "## [Unreleased]" -> "## [X.Y.Z] - <date>"
#   2. sets package.json to the bare X.Y.Z and commits the release commit
#   3. tags vX.Y.Z on that commit
#   4. opens the next "-develop" cycle (package.json + fresh Unreleased) and commits
#   5. pushes main + the tag (after an explicit confirmation) -> triggers the Release workflow
#
# The tag points at a commit whose package.json reads exactly X.Y.Z, so the
# published bundle and the git history agree on the version. CI verifies the
# match and publishes the promoted CHANGELOG section as the release notes.

set -euo pipefail

die() {
  echo "release: $*" >&2
  exit 1
}

semver_re='^[0-9]+\.[0-9]+\.[0-9]+$'

VERSION="${1:-}"
[ -n "$VERSION" ] || die "missing version. Usage: npm run release X.Y.Z [NEXT_DEV_BASE]"
[[ "$VERSION" =~ $semver_re ]] || die "version '$VERSION' is not X.Y.Z"

# Default next dev base: bump the minor, reset patch.
if [ -n "${2:-}" ]; then
  NEXT_BASE="$2"
  [[ "$NEXT_BASE" =~ $semver_re ]] || die "next dev base '$NEXT_BASE' is not X.Y.Z"
else
  IFS='.' read -r MA MI _PA <<<"$VERSION"
  NEXT_BASE="${MA}.$((MI + 1)).0"
fi
NEXT_DEV="${NEXT_BASE}-develop"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Guards ----------------------------------------------------------------

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "must be on 'main' (currently on '$BRANCH')"

[ -z "$(git status --porcelain)" ] || die "working tree is not clean — commit or stash first"

git fetch --quiet origin main || die "could not fetch origin/main"
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse '@{u}')"
[ "$LOCAL" = "$REMOTE" ] || die "local main is not in sync with origin/main — pull/push first"

PKG_BASE="$(node -p 'require("./package.json").version.split("-")[0]')"
[ "$PKG_BASE" = "$VERSION" ] || die "package.json base is $PKG_BASE, expected $VERSION — bump main to ${VERSION}-develop first (or release $PKG_BASE)"

git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && die "tag v$VERSION already exists"

[ -f CHANGELOG.md ] || die "CHANGELOG.md not found"
# The Unreleased section must carry content — an empty changelog ships empty notes.
UNRELEASED_BODY="$(awk '
  /^## \[Unreleased\]/ {grab=1; next}
  /^## / && grab {exit}
  grab {print}
' CHANGELOG.md | grep -v '^[[:space:]]*$' || true)"
[ -n "$UNRELEASED_BODY" ] || die "CHANGELOG '## [Unreleased]' is empty — write the release notes there first"

# --- Plan ------------------------------------------------------------------

DATE="$(date +%Y-%m-%d)"
echo "Release plan:"
echo "  version       : $VERSION  (tag v$VERSION)"
echo "  release date  : $DATE"
echo "  next cycle    : $NEXT_DEV"
echo
echo "Unreleased notes that will become the v$VERSION release notes:"
echo "$UNRELEASED_BODY" | sed 's/^/  | /'
echo
read -r -p "Proceed (commits, tag, and PUSH to origin)? [y/N] " ANSWER
case "$ANSWER" in
  y | Y | yes | YES) ;;
  *) die "aborted" ;;
esac

# --- 1. Promote CHANGELOG Unreleased -> this version -----------------------

node - "$VERSION" "$DATE" <<'NODE'
const fs = require("fs");
const [version, date] = process.argv.slice(2);
const file = "CHANGELOG.md";
let text = fs.readFileSync(file, "utf8");

if (text.includes(`## [${version}]`)) {
  console.error(`release: CHANGELOG already has a [${version}] section`);
  process.exit(1);
}

// Replace the Unreleased heading with a fresh empty Unreleased + the new version.
text = text.replace(
  /^## \[Unreleased\][^\n]*\n/m,
  `## [Unreleased]\n\n## [${version}] - ${date}\n`,
);

// Refresh the link reference block at the bottom, if present.
const repo = "https://github.com/juherr/kill-the-news";
const unreleasedLink = `[Unreleased]: ${repo}/compare/v${version}...HEAD`;
if (/^\[Unreleased\]:/m.test(text)) {
  text = text.replace(
    /^\[Unreleased\]:.*$/m,
    `${unreleasedLink}\n[${version}]: ${repo}/compare/PREV...v${version}`,
  );
  // Best-effort: point the new version diff at the previous tagged version.
  const prev = [...text.matchAll(/^\[(\d+\.\d+\.\d+)\]:/gm)]
    .map((m) => m[1])
    .find((v) => v !== version);
  if (prev) {
    text = text.replace("compare/PREV...", `compare/v${prev}...`);
  } else {
    text = text.replace(`/compare/PREV...v${version}`, `/releases/tag/v${version}`);
  }
}

fs.writeFileSync(file, text);
console.log(`Updated CHANGELOG.md for ${version}`);
NODE

# --- 2. Release commit (bare version) + 3. tag -----------------------------

npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): $VERSION" >/dev/null
git tag "v$VERSION"
echo "Committed release v$VERSION and tagged it."

# --- 4. Open the next develop cycle ----------------------------------------

npm version "$NEXT_DEV" --no-git-tag-version >/dev/null
git add package.json package-lock.json
git commit -m "chore: open $NEXT_BASE develop cycle" >/dev/null
echo "Opened next cycle: $NEXT_DEV."

# --- 5. Push ----------------------------------------------------------------

git push origin main "v$VERSION"
echo
echo "Pushed main + v$VERSION. The Release workflow will publish the GitHub Release."
