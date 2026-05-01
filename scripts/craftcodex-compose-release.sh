#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
BRANCH_PREFIX="${BRANCH_PREFIX:-craftcodex/upstream}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RELEASE_BRANCH="${RELEASE_BRANCH:-${BRANCH_PREFIX}-${STAMP}}"
UPDATE_FEED_URL="${CRAFTCODEX_UPDATE_FEED_URL:-${CRAFT_UPDATE_FEED_URL:-https://github.com/ildunari/craft-agents-oss/releases/download/craftcodex-latest}}"
UPLOAD="${UPLOAD:-0}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: must run inside a git checkout" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  cat >&2 <<EOF
error: working tree is dirty.

Commit or stash your local CraftCodex changes before composing an upstream release.
This script intentionally starts from a clean tree so conflicts are visible and the
published app can be traced back to exact git commits.
EOF
  exit 1
fi

echo "Fetching ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}..."
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

echo "Creating release branch ${RELEASE_BRANCH}..."
git switch -c "$RELEASE_BRANCH"

echo "Merging ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} into ${RELEASE_BRANCH}..."
if ! git merge --no-edit "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"; then
  cat >&2 <<EOF

Merge conflict while composing CraftCodex release.
Resolve conflicts, keep the CraftCodex/agent patches, then run:
  CRAFTCODEX_UPDATE_FEED_URL="${UPDATE_FEED_URL}" bun run typecheck:electron
  CRAFTCODEX_UPDATE_FEED_URL="${UPDATE_FEED_URL}" bun run electron:dist:dev:mac

After a good build, upload with:
  S3_VERSIONS_BUCKET_NAME=... S3_VERSIONS_BUCKET_ENDPOINT=... \\
  S3_VERSIONS_BUCKET_ACCESS_KEY_ID=... S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY=... \\
  bun scripts/upload.ts --electron --script
EOF
  exit 1
fi

echo "Using CraftCodex update feed: ${UPDATE_FEED_URL}"
export CRAFTCODEX_UPDATE_FEED_URL="${UPDATE_FEED_URL}"

echo "Running focused updater tests..."
bun test \
  apps/electron/src/main/__tests__/auto-update-config.test.ts \
  apps/electron/src/shared/__tests__/ipc-channels.test.ts

echo "Running Electron typecheck..."
bun run typecheck:electron

echo "Building CraftCodex macOS artifacts..."
bun run electron:dist:dev:mac

if [ "$UPLOAD" = "1" ]; then
  echo "Uploading CraftCodex artifacts..."
  bun scripts/upload.ts --electron --script
else
  cat <<EOF

Build complete. Upload skipped because UPLOAD=1 was not set.

DMG:
  ${ROOT_DIR}/apps/electron/release/CraftCodex-arm64.dmg

To publish this composed build to the CraftCodex update feed, run:
  S3_VERSIONS_BUCKET_NAME=... S3_VERSIONS_BUCKET_ENDPOINT=... \\
  S3_VERSIONS_BUCKET_ACCESS_KEY_ID=... S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY=... \\
  bun scripts/upload.ts --electron --script
EOF
fi
