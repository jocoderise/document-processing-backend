#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build.sh — Build and zip Lambda functions for deployment
#
# Usage:
#   ./build.sh                  # build all functions
#   ./build.sh createFundUpload # build a single function by name
#
# Output: dist/<category>/<fnName>/<fnName>.zip
#   e.g.  dist/funds/createFundUpload/createFundUpload.zip
#
# The dist/ path mirrors the S3 key structure expected by cloudformation.yaml.
# Upload after building:
#   aws s3 sync dist/ s3://<LambdaCodeBucket>/<LambdaCodeKeyPrefix>/
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

  out_dir="$DIST_DIR/$category/$fn_name"
  mkdir -p "$out_dir"

  (cd "$fn_dir" && zip -r "$out_dir/$fn_name.zip" . \
    --exclude "*.git*" \
    --exclude ".env*" \
    --exclude "*.DS_Store")

  rm -rf "$fn_dir/shared"

  echo "  → dist/$category/$fn_name/$fn_name.zip"
done

echo ""
echo "Done. ZIPs in dist/"
echo ""
echo "To upload to S3 (set your bucket and prefix first):"
echo "  aws s3 sync dist/ s3://<LambdaCodeBucket>/<LambdaCodeKeyPrefix>/"
