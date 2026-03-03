#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# download-lambdas.sh — Download deployed Lambda code from AWS
#
# Run this in AWS Cloud Shell (no credentials needed — already authenticated).
#
# Usage:
#   bash download-lambdas.sh
#
# Output:
#   downloaded/<FunctionName>/        ← unzipped source code
#   downloaded/<FunctionName>.zip     ← original zip
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

OUT_DIR="$HOME/downloaded-lambdas"
mkdir -p "$OUT_DIR"

FUNCTIONS=(
  "rulesGenerator"
  "FundDocumentProcessingWorkerLambda"
  "ExtractICMemoLambda"
  "FundGetByIdLambda"
  "FundDocumentUploadLambda"
  "CreateFundUpload"
  "FundDocumentProcessorLambda"
  "FundProcessingStatusLambda"
  "FundUploadCompleteLambda"
  "FundInitUploadLambda"
)

for fn_name in "${FUNCTIONS[@]}"; do
  echo "Fetching $fn_name..."

  url=$(aws lambda get-function \
    --function-name "$fn_name" \
    --query 'Code.Location' \
    --output text 2>/dev/null || echo "")

  if [[ -z "$url" || "$url" == "None" ]]; then
    echo "  SKIP — function not found or no access"
    continue
  fi

  zip_file="$OUT_DIR/${fn_name}.zip"
  extract_dir="$OUT_DIR/${fn_name}"

  # Download the ZIP
  curl -sSL "$url" -o "$zip_file"

  # Unzip so the code is readable
  rm -rf "$extract_dir"
  mkdir -p "$extract_dir"
  unzip -q "$zip_file" -d "$extract_dir"

  size=$(du -sh "$extract_dir" | cut -f1)
  echo "  -> $extract_dir  ($size)"
done

echo ""
echo "All done. Source code is in: $OUT_DIR"
echo ""
echo "To see all index.js files:"
echo "  find $OUT_DIR -name 'index.js' | sort"
