#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build.sh — Build and zip Lambda functions for deployment
#
# Usage:
#   ./build.sh                  # build all functions
#   ./build.sh createFundUpload # build a single function by name
#
# Output: dist/<fnName>.zip
#   e.g.  dist/createFundUpload.zip
#
# Run deploy.sh to build and upload everything to AWS.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_DIR="$ROOT_DIR/shared"
DIST_DIR="$ROOT_DIR/dist"
FILTER="${1:-}"   # optional: ./build.sh createFundUpload

mkdir -p "$DIST_DIR"

for fn_dir in "$ROOT_DIR"/functions/*/*/; do
  fn_name=$(basename "$fn_dir")
  category=$(basename "$(dirname "$fn_dir")")

  # If a filter was provided, skip everything that doesn't match
  if [[ -n "$FILTER" && "$fn_name" != "$FILTER" ]]; then
    continue
  fi

  echo "Building $category/$fn_name..."

  cp -r "$SHARED_DIR" "$fn_dir/shared"
  (cd "$fn_dir" && npm install --omit=dev --silent)

  # AWS SDK v3 and Node.js built-ins are provided by the Lambda runtime — exclude from ZIP
  rm -rf "$fn_dir/node_modules/@aws-sdk"
  rm -rf "$fn_dir/node_modules/@smithy"

  (cd "$fn_dir" && zip -r "$DIST_DIR/$fn_name.zip" . \
    --exclude "*.git*" \
    --exclude ".env*" \
    --exclude "*.DS_Store")

  rm -rf "$fn_dir/shared"

  echo "  → dist/$fn_name.zip"
done

echo ""
echo "Done. ZIPs in dist/"
