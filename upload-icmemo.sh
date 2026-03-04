#!/usr/bin/env bash
# Usage: ./upload-icmemo.sh <s3-bucket-name> <fund-name>
# Example: ./upload-icmemo.sh doc-processing-uploads-123456789 "Alt Fund Flow"

BUCKET="$1"
FUND_NAME="$2"
PDF_FILE="/Users/josephvarghese/mine/Coderize/SampleJSONForRUlesEngine/AltFundFlowSampleIcMemo.pdf"
FILE_NAME=$(basename "$PDF_FILE")

aws s3 cp "$PDF_FILE" "s3://${BUCKET}/uploads/ICMemo/${FILE_NAME}" \
  --content-type "application/pdf" \
  --metadata "fund-name=${FUND_NAME}"
