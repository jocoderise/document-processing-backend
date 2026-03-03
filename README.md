# Document Processing Backend

AWS serverless backend for fund document ingestion, OCR, and AI-powered extraction.
Built on Lambda, SQS, S3, DynamoDB, Textract, and Bedrock (Amazon Nova).

---

## Architecture Overview

### Processing Flows

```
S3 Trigger Flow — ICMemo  (primary — new fund)
  [PDF uploaded to <upload-bucket>/<prefix>/ICMemo/<file>.pdf]
  S3 Put event              → S3UploadTriggerLambda       → new DDB record (INT#<uuid>, CREATED)
                                                          → ICMemoProcessingQueue
  SQS (ICMemoProcessingQueue) → FundDocumentProcessingWorkerLambda
                              → Textract OCR → Bedrock (icmemo-v1.txt + ICMemoEngineJSONSchema.txt)
                              → result JSON → DocumentsBucket → DDB (EXTRACTED)

S3 Trigger Flow — IMA  (existing fund)
  [PDF uploaded to <upload-bucket>/<prefix>/IMA/<file>.pdf]
  Metadata: x-amz-meta-fund-id = <existing fundId>
  S3 Put event              → S3UploadTriggerLambda       → update existing DDB record (RECEIVED)
                                                          → ProcessingQueue
  SQS (ProcessingQueue)     → FundDocumentProcessorLambda
                              → Bedrock s3Location (rules-engine-v1.txt + RulesEngineJSONSchema.txt)
                              → result JSON → DocumentsBucket → DDB (SUCCEEDED)

S3 Trigger Flow — PPM / LPA / SideLetter / FundStructure / SubDoc  (existing fund, no AI yet)
  [PDF uploaded to <upload-bucket>/<prefix>/<DocType>/<file>.pdf]
  Metadata: x-amz-meta-fund-id = <existing fundId>
  S3 Put event              → S3UploadTriggerLambda       → update existing DDB record (RECEIVED)
                                                            (no queue — AI processing TBD)

IC Memo API Flow  (secondary — future / internal tooling)
  POST /funds               → CreateFundUploadLambda      → DDB record (INT#<uuid>) + presigned PUT URL
  [client uploads PDF to DocumentsBucket]
  POST /funds/{id}/extract  → ICMemoExtractionLambda      → Textract → Bedrock → DDB

External API Flow  (secondary — future third-party integration)
  POST /funds/register      → ExternalFundCreateLambda    → DDB record (EXT#<fundId>) + presigned PUT URL
  [third party uploads PDF to DocumentsBucket]
  POST /funds/{id}/extract  → ICMemoExtractionLambda      → Textract → Bedrock → DDB

Rules Engine API Flow  (secondary — future multi-document analysis)
  POST /funds/{id}/init     → FundInitUploadLambda        → DDB record + presigned S3 POST URL
  POST /funds/{id}/upload   → FundDocumentUploadLambda    → PDFs → DocumentsBucket
  POST /funds/{id}/complete → FundUploadCompleteLambda    → SQS (ProcessingQueue)
  SQS trigger               → FundDocumentProcessorLambda → Bedrock → S3 + SQS (SuccessQueue)

Read APIs
  GET /funds                → FundProcessingStatusLambda  → list / filter by status
  GET /funds/{id}           → FundGetByIdLambda           → single fund record
```

### Three S3 Buckets

**Platform bucket** — created once by `bootstrap.yaml`, shared across redeployments.
Holds Lambda ZIPs and read-only assets. Lambdas never write here at runtime.

```
<bootstrap-stack>-platform-<accountId>/
├── lambdas/                             ← Lambda deployment ZIPs (written by deploy.sh)
│   └── funds/<name>/<name>.zip
└── assets/                              ← Read-only schemas + prompts (written by deploy.sh)
    ├── ICMemoEngineJSONSchema.txt        ← IC Memo JSON schema   (env: ICSchemaKey)
    ├── RulesEngineJSONSchema.txt         ← IMA / Rules Engine schema (env: IMASchemaKey)
    └── prompt/
        ├── icmemo-v1.txt                 ← IC Memo system prompt (env: ICPromptKey)
        └── rules-engine-v1.txt           ← IMA system prompt     (env: ProcessorPromptKey)
```

Source files live in `assets/` (schemas) and `assets/prompt/` (prompts) in the repo.
Canonical originals are in `SchemasAndPrompts/`.

**Upload bucket** — created by `cloudformation.yaml`. This is where all PDFs are uploaded.
S3 Put events here automatically invoke `S3UploadTriggerLambda` (wired in CloudFormation — no manual setup needed).

```
<stack>-uploads-<accountId>/
└── <prefix>/<DocumentType>/<filename>.pdf   ← upload PDFs here
    e.g. uploads/ICMemo/memo.pdf
         uploads/IMA/agreement.pdf
         uploads/SideLetter/sl-2024.pdf
```

PDFs remain in the upload bucket. Lambdas read them from here during processing.

**Documents bucket** — created by `cloudformation.yaml`. Holds extraction results and API-flow PDFs.
Env var `DOC_BUCKET` in all Lambdas points here.

```
<stack>-documents-<accountId>/
├── INT#<uuid>/
│   ├── <fileName>.pdf                ← IC Memo PDFs uploaded via presigned URL (internal)
│   └── icmemo/<file>.<ts>.json       ← IC Memo extraction output
├── EXT#<externalId>/
│   ├── <fileName>.pdf                ← IC Memo PDFs for externally-identified funds
│   └── icmemo/<file>.<ts>.json       ← IC Memo extraction output
└── <fundId>/
    ├── files/                        ← Input PDFs (Rules Engine flow)
    ├── results/rules-engine.json     ← Rules Engine Bedrock output
    └── archive/<ts>/                 ← Previous uploads
```

### S3 Key Convention for the Upload Bucket

The S3UploadTriggerLambda derives the document type from the folder name in the object key:

```
<prefix>/<documentType>/<filename>.pdf

Examples:
  uploads/ICMemo/document.pdf        → documentType = icmemo  (new fund)
  uploads/IMA/agreement.pdf          → documentType = ima      (existing fund)
  uploads/SideLetter/sl-2024.pdf     → documentType = sideletter (existing fund)
```

**S3 metadata required when uploading:**

| Metadata key | Required for | Description |
|---|---|---|
| `x-amz-meta-fund-name` | All document types | Human-readable fund name |
| `x-amz-meta-fund-id` | All types **except** ICMemo | fundId of the existing fund to update |

Supported document types: `icmemo`, `ima`, `sideletter`, `lpa`, `ppm`, `subdoc`, `fundstructure`

### Fund ID Prefixes

| Prefix | Source | Created by |
|--------|--------|------------|
| `INT#<uuid>` | Internally generated | CreateFundUploadLambda, S3UploadTriggerLambda |
| `EXT#<id>` | Provided by third party | ExternalFundCreateLambda |

### CloudFormation Stacks

| Template | Purpose |
|----------|---------|
| `bootstrap.yaml` | Creates the platform bucket (lambdas/ + assets/). Deploy **once**. |
| `cloudformation.yaml` | All application resources: 11 Lambdas, DocumentsBucket, SQS queues, DynamoDB, API Gateway, IAM. |

---

## Deploying to a New Account

### Prerequisites

| Tool | Notes |
|------|-------|
| Node.js 22.x + npm | https://nodejs.org |
| AWS CLI v2 | Configured with Admin or PowerUser credentials for the target account |
| zip | Pre-installed on macOS/Linux |

### Step 1 — Enable Bedrock Model Access

In the **target account**: AWS Console → **Amazon Bedrock** → **Model access** → enable **Amazon Nova Pro** (`amazon.nova-pro-v1:0`). Wait for *Access granted*.

### Step 2 — Run deploy.sh

```bash
REGION=us-east-1 ./deploy.sh
```

The script does everything in order:

1. Deploys `bootstrap.yaml` — creates the platform bucket (Lambda ZIPs + assets)
2. Runs `build.sh` — builds all 11 Lambda ZIPs into `dist/`
3. Syncs `dist/` → `s3://<platform-bucket>/lambdas/`
4. Deploys `cloudformation.yaml` — all infrastructure, including the upload bucket with S3 event notification pre-configured
5. Uploads `assets/` → `s3://<platform-bucket>/assets/`

At the end it prints the API endpoint, upload bucket name, documents bucket name, DynamoDB table, and IC Memo queue URL.

### Step 3 — Upload documents

The S3 event notification is wired automatically in CloudFormation — no manual setup needed.

Upload PDFs to the upload bucket using the folder convention:

```
<prefix>/<DocumentType>/<filename>.pdf
```

Set S3 metadata when uploading:

| Metadata | Required for | Value |
|---|---|---|
| `x-amz-meta-fund-name` | All document types | Human-readable fund name |
| `x-amz-meta-fund-id` | All types **except** ICMemo | fundId of the existing fund |

Example (AWS CLI):

```bash
aws s3 cp memo.pdf \
  s3://<upload-bucket>/uploads/ICMemo/memo.pdf \
  --metadata "fund-name=Acme Capital Fund I"

aws s3 cp agreement.pdf \
  s3://<upload-bucket>/uploads/IMA/agreement.pdf \
  --metadata "fund-name=Acme Capital Fund I,fund-id=INT#<uuid>"
```

---

## Day-2 Operations

### Update prompts or schemas

Edit files under `assets/`, then push them without a full redeploy:

```bash
REGION=us-east-1 ./deploy.sh --assets-only
```

### Redeploy CloudFormation only (code already uploaded)

```bash
REGION=us-east-1 ./deploy.sh --stack-only
```

### Hotpatch a single Lambda

Rebuild one function, upload it, and update the Lambda — no full stack redeploy needed.

```bash
STACK_NAME="doc-processing"
BOOTSTRAP_STACK="doc-processing-bootstrap"
REGION="us-east-1"
FN="s3-upload-trigger"   # camelCase folder name under functions/funds/

./build.sh $FN

PLATFORM_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$BOOTSTRAP_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='LambdaCodeBucketName'].OutputValue" \
  --output text --region "$REGION")

aws s3 cp "dist/funds/$FN/$FN.zip" \
  "s3://$PLATFORM_BUCKET/lambdas/funds/$FN/$FN.zip" \
  --region "$REGION"

aws lambda update-function-code \
  --function-name "${STACK_NAME}-${FN}" \
  --s3-bucket "$PLATFORM_BUCKET" \
  --s3-key "lambdas/funds/$FN/$FN.zip" \
  --region "$REGION"
```

---

## Tearing Down

```bash
REGION="us-east-1"
STACK_NAME="doc-processing"
BOOTSTRAP_STACK="doc-processing-bootstrap"

PLATFORM_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$BOOTSTRAP_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='LambdaCodeBucketName'].OutputValue" \
  --output text --region "$REGION")

# Empty the bucket first (CloudFormation cannot delete non-empty buckets)
aws s3 rm "s3://$PLATFORM_BUCKET" --recursive

aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"

aws cloudformation delete-stack --stack-name "$BOOTSTRAP_STACK" --region "$REGION"
```

---

## DynamoDB Status Lifecycle

### S3 Trigger Flow (ICMemo — new fund)

```
CREATED       ← S3UploadTriggerLambda creates new INT#uuid record
  → PROCESSING  ← FundDocumentProcessingWorkerLambda starts
  → EXTRACTED   (resultBucket + resultKey set)
  → FAILED      (errorReason set)
```

### S3 Trigger Flow (IMA / other docs — existing fund)

```
RECEIVED      ← S3UploadTriggerLambda updates existing record

IMA continues →
  → SUCCEEDED  (resultPath set) ← FundDocumentProcessorLambda completes
  → FAILED     (errorMessage set)

PPM / LPA / SideLetter / FundStructure / SubDoc → stays at RECEIVED (no AI processing yet)
```

### IC Memo API Flow / External API Flow

```
UPLOADING     ← CreateFundUploadLambda or ExternalFundCreateLambda
[PDF uploaded, POST /funds/{id}/extract called]
  → PROCESSING → EXTRACTED  (resultBucket + resultKey set)
  → PROCESSING → FAILED     (errorReason set)
```

### Rules Engine API Flow

```
INITIATED → [client uploads files] → POST /funds/{id}/complete
          → UPLOADED → (SQS ProcessingQueue) → FundDocumentProcessorLambda
          → SUCCEEDED  (resultPath attribute set)
          → FAILED     (errorMessage attribute set)
```

---

## Lambda Reference

| # | Name | Trigger | Purpose |
|---|------|---------|---------|
| 1 | `create-fund-upload` | POST /funds | Internal IC Memo init — generates INT# fundId, returns presigned URL |
| 2 | `fund-init-upload` | POST /funds/{id}/init | Rules Engine init — presigned POST URL |
| 3 | `fund-document-upload` | POST /funds/{id}/upload | Rules Engine — base64 PDF upload |
| 4 | `fund-upload-complete` | POST /funds/{id}/complete | Rules Engine — enqueue to ProcessingQueue |
| 5 | `fund-document-processor` | SQS ProcessingQueue | Rules Engine — Bedrock extraction |
| 6 | `fund-processing-status` | GET /funds | List funds with optional status filter |
| 7 | `fund-get-by-id` | GET /funds/{id} | Single fund lookup |
| 8 | `ic-memo-extraction` | POST /funds/{id}/extract | Synchronous Textract + Bedrock extraction |
| 9 | `fund-document-processing-worker` | SQS ICMemoProcessingQueue | ICMemo only — Textract + Bedrock (icmemo-v1.txt + ICMemoEngineJSONSchema.txt) + AJV, idempotent |
| 10 | `s3-upload-trigger` | S3 Put (upload bucket) | Routes by doc type: ICMemo → new fund + ICMemoProcessingQueue; IMA → update fund + ProcessingQueue; others → update fund only |
| 11 | `external-fund-create` | POST /funds/register | External API — accepts third-party fundId (EXT#), returns presigned URL |
