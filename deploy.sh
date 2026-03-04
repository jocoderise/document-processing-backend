#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Full deployment: bootstrap → build → upload → stack → assets
#
# Usage:
#   ./deploy.sh                          # deploy everything (first time or update)
#   ./deploy.sh --assets-only            # re-upload prompts/schemas only
#   ./deploy.sh --stack-only             # redeploy CloudFormation only (code already uploaded)
#
# Optional env vars (or edit the defaults below):
#   REGION          — AWS region to deploy into (default: us-east-1)
#   STACK_NAME      — CloudFormation stack name (default: doc-processing)
#   BOOTSTRAP_STACK — bootstrap stack name      (default: doc-processing-bootstrap)
#
# The upload bucket (for PDF intake) is created automatically by cloudformation.yaml.
# No UPLOAD_BUCKET env var is needed — the bucket name is printed at the end.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration (override via env or edit here) ────────────────────────────
REGION="${REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-doc-processing}"
BOOTSTRAP_STACK="${BOOTSTRAP_STACK:-doc-processing-bootstrap}"
ENVIRONMENT="${ENVIRONMENT:-dev}"

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Argument parsing ──────────────────────────────────────────────────────────
MODE="all"
for arg in "$@"; do
  case $arg in
    --assets-only) MODE="assets" ;;
    --stack-only)  MODE="stack"  ;;
  esac
done

# Warn if the RulesEngineJSONSchema.txt is still a placeholder
if grep -q "PLACEHOLDER" "$ROOT_DIR/assets/RulesEngineJSONSchema.txt" 2>/dev/null; then
  echo ""
  echo "WARNING: assets/RulesEngineJSONSchema.txt is still a placeholder."
  echo "  Copy the real schema from the source account first:"
  echo "  aws s3 cp s3://highcloud-rulesgen/RulesEngineJSONSchema.txt assets/RulesEngineJSONSchema.txt"
  echo ""
  read -rp "Continue anyway? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || exit 1
fi

# ── Step 1: Bootstrap stack (creates Lambda code bucket) ─────────────────────
if [[ "$MODE" == "all" ]]; then
  echo ""
  echo "▶ Deploying bootstrap stack ($BOOTSTRAP_STACK)..."
  aws cloudformation deploy \
    --stack-name "$BOOTSTRAP_STACK" \
    --template-file "$ROOT_DIR/bootstrap.yaml" \
    --parameter-overrides Environment="$ENVIRONMENT" \
    --region "$REGION" \
    --no-fail-on-empty-changeset
fi

# ── Resolve Lambda code bucket name from bootstrap stack ─────────────────────
LAMBDA_CODE_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$BOOTSTRAP_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='LambdaCodeBucketName'].OutputValue" \
  --output text \
  --region "$REGION")

echo "   Lambda code bucket: $LAMBDA_CODE_BUCKET"

# ── Step 2: Build Lambda ZIPs ─────────────────────────────────────────────────
if [[ "$MODE" == "all" ]]; then
  echo ""
  echo "▶ Building Lambda ZIPs..."
  "$ROOT_DIR/build.sh"
fi

# ── Step 3: Upload Lambda ZIPs to lambdas/ prefix ────────────────────────────
if [[ "$MODE" == "all" ]]; then
  echo ""
  echo "▶ Uploading Lambda ZIPs to s3://$LAMBDA_CODE_BUCKET/lambdas/..."
  aws s3 sync "$ROOT_DIR/dist/" "s3://$LAMBDA_CODE_BUCKET/lambdas/" --region "$REGION"
fi

# ── Step 4: Deploy main CloudFormation stack ──────────────────────────────────
if [[ "$MODE" == "all" || "$MODE" == "stack" ]]; then
  echo ""
  echo "▶ Deploying main stack ($STACK_NAME)..."
  aws cloudformation deploy \
    --stack-name "$STACK_NAME" \
    --template-file "$ROOT_DIR/cloudformation.yaml" \
    --capabilities CAPABILITY_NAMED_IAM \
    --region "$REGION" \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
      LambdaCodeBucket="$LAMBDA_CODE_BUCKET" \
      Environment="$ENVIRONMENT"
fi

# ── Step 5: Upload schemas and prompts to assets/ prefix ──────────────────────
echo ""
echo "▶ Uploading assets to s3://$LAMBDA_CODE_BUCKET/assets/..."

# Schemas — at assets/ root (used by Lambda env vars ICSchemaKey, IMASchemaKey)
aws s3 cp "$ROOT_DIR/assets/ICMemoEngineJSONSchema.txt" \
  "s3://$LAMBDA_CODE_BUCKET/assets/ICMemoEngineJSONSchema.txt" --region "$REGION"

aws s3 cp "$ROOT_DIR/assets/RulesEngineJSONSchema.txt" \
  "s3://$LAMBDA_CODE_BUCKET/assets/RulesEngineJSONSchema.txt" --region "$REGION"

# Prompts — under assets/prompt/ (used by Lambda env vars ICPromptKey, ProcessorPromptKey)
aws s3 cp "$ROOT_DIR/assets/prompt/icmemo-v1.txt" \
  "s3://$LAMBDA_CODE_BUCKET/assets/prompt/icmemo-v1.txt" --region "$REGION"

aws s3 cp "$ROOT_DIR/assets/prompt/rules-engine-v1.txt" \
  "s3://$LAMBDA_CODE_BUCKET/assets/prompt/rules-engine-v1.txt" --region "$REGION"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✓ Deployment complete."
echo ""

API=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text \
  --region "$REGION")

UPLOAD_BUCKET_OUT=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='UploadBucketName'].OutputValue" \
  --output text \
  --region "$REGION")

DOCS_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='DocumentsBucketName'].OutputValue" \
  --output text \
  --region "$REGION")

TABLE=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='FundsTableName'].OutputValue" \
  --output text \
  --region "$REGION")

IC_QUEUE=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ICMemoProcessingQueueUrl'].OutputValue" \
  --output text \
  --region "$REGION")

echo "  API endpoint:         $API"
echo "  Lambda code bucket:   $LAMBDA_CODE_BUCKET  (lambdas/ + assets/)"
echo "  Upload bucket:        $UPLOAD_BUCKET_OUT   (PDF intake — upload here)"
echo "  Documents bucket:     $DOCS_BUCKET         (extraction results)"
echo "  DynamoDB table:       $TABLE"
echo "  IC Memo SQS queue:    $IC_QUEUE"
echo ""
echo "▶ Upload PDFs to the upload bucket using this key pattern:"
echo "  <prefix>/<DocumentType>/<filename>.pdf"
echo ""
echo "  Supported document types: ICMemo, IMA, PPM, LPA, SideLetter, FundStructure, SubDoc"
echo "  Required S3 metadata:"
echo "    x-amz-meta-fund-name = <fund name>         (all document types)"
echo "    x-amz-meta-fund-id   = <existing fundId>   (all types EXCEPT ICMemo)"
echo ""
