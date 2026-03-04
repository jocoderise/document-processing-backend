#!/usr/bin/env bash
# Adds x-amz-meta-fund-name metadata to the IC Memo PDF
# Usage: ./add-icmemo-metadata.sh "Fund Name"

PDF_FILE="/Users/josephvarghese/mine/Coderize/SampleJSONForRUlesEngine/AltFundFlowSampleIcMemo.pdf"
FUND_NAME="$1"

exiftool -overwrite_original \
  -XMP-dc:Subject="x-amz-meta-fund-name=${FUND_NAME}" \
  "$PDF_FILE"
