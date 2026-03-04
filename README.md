# Document Processing Backend

AWS serverless backend for fund document ingestion, async OCR, and AI-powered data extraction.
Built on Lambda, SQS, SNS, S3, DynamoDB, Textract, and Bedrock (Amazon Nova Pro).

---

## Architecture Overview

### Primary Flow — Unified Async Textract Pipeline

All document types (ICMemo, IMA, PPM, LPA, SideLetter, FundStructure, SubDoc) go through a single
shared async pipeline. Every upload triggers Textract, and every Textract completion triggers Bedrock.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    UNIFIED ASYNC DOCUMENT PROCESSING PIPELINE                   │
└─────────────────────────────────────────────────────────────────────────────────┘

 ① PDF Upload
 ┌──────────────────────┐
 │   Upload Bucket      │   s3://...-uploads-.../uploads/<DocType>/<file>.pdf
 │   (S3 Put event)     │   S3 metadata:  x-amz-meta-fund-name = "Acme Fund I"
 └──────────┬───────────┘                x-amz-meta-fund-id  = "INT#<uuid>"  (non-ICMemo)
            │
            ▼
 ② Route by Document Type
 ┌──────────────────────────────────────────────┐
 │         S3UploadTriggerLambda                │
 │                                              │
 │  ICMemo  → create new DDB record             │
 │            (INT#<uuid>, status=CREATED)      │
 │                                              │
 │  All other types → update existing DDB       │
 │            record (status=RECEIVED)          │
 │                                              │
 │  ALL types → enqueue to TextractStarterQueue │
 │    payload: { fundId, documentType,          │
 │               bucket, key, fileName }        │
 └──────────────────────┬───────────────────────┘
                        │
                        ▼
 ③ Start Async OCR Job
 ┌──────────────────────────────────────────────┐
 │         TextractStarterLambda                │
 │                                              │
 │  StartDocumentTextDetection:                 │
 │    DocumentLocation: S3 URI                  │
 │    NotificationChannel: TextractSNSRole      │
 │                         TextractCompletionTopic │
 │    JobTag: "<uuid>:<documentType>"           │
 │                                              │
 │  DDB → status=TEXTRACT_PROCESSING            │
 │         + textractJobId stored               │
 └──────────────────────┬───────────────────────┘
                        │
                        │  (minutes later, async)
                        ▼
 ④ Textract Completion Notification
 ┌──────────────────────────────────────────────┐
 │      TextractCompletionTopic (SNS)           │
 │                                              │
 │  Published by Textract when job finishes     │
 │  Payload: { JobId, Status, JobTag,           │
 │             DocumentLocation }               │
 └──────────────────────┬───────────────────────┘
                        │
                        ▼
 ⑤ Queue Completion Event
 ┌──────────────────────────────────────────────┐
 │         TextractResultsQueue (SQS)           │
 │                                              │
 │  Subscribed to TextractCompletionTopic       │
 │  Visibility timeout: 960s                    │
 │  DLQ: TextractResultsDLQ                     │
 └──────────────────────┬───────────────────────┘
                        │
                        ▼
 ⑥ Extract Text + Run AI
 ┌──────────────────────────────────────────────┐
 │      TextractResultsWorkerLambda             │
 │                                              │
 │  Parse SNS→SQS envelope (double JSON.parse)  │
 │  Parse JobTag → fundId (INT#<uuid>)          │
 │                → documentType               │
 │                                              │
 │  GetDocumentTextDetection (paginated)        │
 │    → collect all LINE blocks → join text     │
 │                                              │
 │  Route prompt + schema by documentType:      │
 │   ┌──────────┬───────────────────────────┐   │
 │   │ icmemo   │ icmemo-v1.txt             │   │
 │   │          │ ICMemoEngineJSONSchema.txt │   │
 │   ├──────────┼───────────────────────────┤   │
 │   │ all      │ rules-engine-v1.txt       │   │
 │   │ others   │ RulesEngineJSONSchema.txt │   │
 │   └──────────┴───────────────────────────┘   │
 │                                              │
 │  Bedrock ConverseCommand (Nova Pro)          │
 │    → structured JSON extraction              │
 └──────────────────────┬───────────────────────┘
                        │
            ┌───────────┴────────────┐
            ▼                        ▼
 ⑦ Write Result              ⑧ Update Status
 ┌──────────────────┐   ┌───────────────────────┐
 │  Documents Bucket│   │      DynamoDB         │
 │  (S3)            │   │                       │
 │                  │   │  status = SUCCEEDED   │
 │  <fundId>/       │   │  resultPath = s3://…  │
 │  <docType>/      │   │                       │
 │  <file>.<ts>.    │   │  on error:            │
 │  <docType>.json  │   │  status = FAILED      │
 └──────────────────┘   │  errorReason set      │
                        └───────────────────────┘
                                    │
                                    ▼
                        ⑨ Notify Downstream
                        ┌───────────────────────┐
                        │    SuccessQueue (SQS)  │
                        │                        │
                        │  { fundId,             │
                        │    documentType,       │
                        │    status: SUCCEEDED,  │
                        │    outputFiles: [...] }│
                        └───────────────────────┘
```

### Secondary Flows — API-based

```
 IC Memo API Flow (internal tooling / direct upload)
 ─────────────────────────────────────────────────────
 POST /funds              → CreateFundUploadLambda  → INT#<uuid> DDB record + presigned PUT URL
 [client uploads PDF]
 POST /funds/{id}/extract → ICMemoExtractionLambda  → Textract (sync) + Bedrock → DDB EXTRACTED

 External API Flow (third-party integration)
 ─────────────────────────────────────────────────────
 POST /funds/register     → ExternalFundCreateLambda → EXT#<id> DDB record + presigned PUT URL
 [third party uploads PDF]
 POST /funds/{id}/extract → ICMemoExtractionLambda  → Textract (sync) + Bedrock → DDB EXTRACTED

 Rules Engine API Flow (multi-document analysis)
 ─────────────────────────────────────────────────────
 POST /funds/{id}/init    → FundInitUploadLambda     → DDB record + presigned S3 POST URL
 POST /funds/{id}/upload  → FundDocumentUploadLambda → PDFs → DocumentsBucket
 POST /funds/{id}/complete→ FundUploadCompleteLambda → ProcessingQueue (SQS)
 [SQS trigger]            → FundDocumentProcessorLambda → Bedrock → S3 + DDB SUCCEEDED

 Read APIs
 ─────────────────────────────────────────────────────
 GET /funds               → FundProcessingStatusLambda → list / filter by status
 GET /funds/{id}          → FundGetByIdLambda          → single fund record
```

---

## DynamoDB Status Lifecycle

### S3 Trigger Flow (all document types — primary pipeline)

```
  ① CREATED              ← S3UploadTriggerLambda creates new INT#uuid record (ICMemo only)
    or
  ① RECEIVED             ← S3UploadTriggerLambda updates existing fund record (all other types)
        │
        ▼
  ② TEXTRACT_PROCESSING  ← TextractStarterLambda: async Textract job started, textractJobId stored
        │
        ├──▶ ③ SUCCEEDED  ← TextractResultsWorkerLambda: Bedrock complete, resultPath stored
        │
        └──▶ ③ FAILED     ← Textract job failed OR Bedrock/S3 error, errorReason stored
```

### IC Memo API / External API Flow

```
  UPLOADING  ← CreateFundUploadLambda or ExternalFundCreateLambda
      │
      ▼
  PROCESSING ← ICMemoExtractionLambda starts
      │
      ├──▶ EXTRACTED  (resultBucket + resultKey set)
      └──▶ FAILED     (errorReason set)
```

### Rules Engine API Flow

```
  INITIATED → [client uploads] → POST /funds/{id}/complete
           → UPLOADED → [SQS ProcessingQueue] → FundDocumentProcessorLambda
           → SUCCEEDED  (resultPath set)
           → FAILED     (errorMessage set)
```

---

## S3 Buckets

### Lambda Code Bucket (`LambdaCodeBucket`)
Created once by `bootstrap.yaml`. Holds Lambda ZIPs and read-only AI assets.

```
<bootstrap-stack>-platform-<accountId>/
├── lambdas/                              ← Lambda deployment ZIPs (written by deploy.sh)
│   └── <fnName>.zip
└── assets/                               ← Read-only schemas + prompts (written by deploy.sh)
    ├── ICMemoEngineJSONSchema.txt         ← IC Memo JSON schema
    ├── RulesEngineJSONSchema.txt          ← IMA / Rules Engine schema
    └── prompt/
        ├── icmemo-v1.txt                  ← IC Memo Bedrock prompt
        └── rules-engine-v1.txt            ← Rules Engine Bedrock prompt
```

### Upload Bucket
All PDFs are uploaded here. S3 Put events automatically invoke `S3UploadTriggerLambda`.

```
<stack>-uploads-<accountId>/
└── uploads/<DocumentType>/<filename>.pdf
    e.g.  uploads/ICMemo/memo.pdf
          uploads/IMA/agreement.pdf
          uploads/PPM/prospectus.pdf
          uploads/SideLetter/sl-2024.pdf
```

**S3 upload metadata required:**

| Metadata key | Required for | Value |
|---|---|---|
| `x-amz-meta-fund-name` | All types | Human-readable fund name |
| `x-amz-meta-fund-id` | All types **except** ICMemo | `fundId` of the existing fund to update |

Supported document types: `icmemo`, `ima`, `ppm`, `lpa`, `sideletter`, `fundstructure`, `subdoc`

### Documents Bucket
Holds extraction results (AI output) and API-flow PDFs.

```
<stack>-documents-<accountId>/
├── INT#<uuid>/
│   ├── icmemo/<file>.<ts>.icmemo.json    ← IC Memo AI extraction output
│   ├── ima/<file>.<ts>.ima.json          ← IMA AI extraction output
│   ├── ppm/<file>.<ts>.ppm.json          ← PPM AI extraction output
│   ├── lpa/<file>.<ts>.lpa.json          ← LPA AI extraction output
│   ├── sideletter/<file>.<ts>.sideletter.json
│   ├── fundstructure/<file>.<ts>.fundstructure.json
│   └── subdoc/<file>.<ts>.subdoc.json
└── EXT#<id>/
    └── icmemo/<file>.<ts>.icmemo.json    ← External fund AI output
```

---

## Fund ID Prefixes

| Prefix | Created by | Example |
|--------|------------|---------|
| `INT#<uuid>` | S3UploadTriggerLambda (ICMemo) or CreateFundUploadLambda | `INT#a3f2-…` |
| `EXT#<id>` | ExternalFundCreateLambda (third-party provided) | `EXT#partner-fund-42` |

---

## Lambda Reference

| # | Lambda Name | Trigger | Purpose |
|---|-------------|---------|---------|
| 1 | `s3-upload-trigger` | S3 Put (upload bucket) | Routes all doc types to TextractStarterQueue; creates new DDB record for ICMemo, updates existing for all others |
| 2 | `textract-starter` | SQS TextractStarterQueue | Starts async Textract job (`StartDocumentTextDetection`); updates DDB to TEXTRACT_PROCESSING |
| 3 | `textract-results-worker` | SQS TextractResultsQueue (via SNS) | Fetches Textract results (paginated), calls Bedrock by doc type, writes JSON to S3, updates DDB to SUCCEEDED |
| 4 | `create-fund-upload` | POST /funds | Internal IC Memo init — generates INT# fundId, returns presigned URL |
| 5 | `ic-memo-extraction` | POST /funds/{id}/extract | Synchronous Textract + Bedrock extraction (API flow) |
| 6 | `external-fund-create` | POST /funds/register | External API — accepts third-party fundId (EXT#), returns presigned URL |
| 7 | `fund-init-upload` | POST /funds/{id}/init | Rules Engine init — presigned POST URL |
| 8 | `fund-document-upload` | POST /funds/{id}/upload | Rules Engine — base64 PDF upload |
| 9 | `fund-upload-complete` | POST /funds/{id}/complete | Rules Engine — enqueue to ProcessingQueue |
| 10 | `fund-document-processor` | SQS ProcessingQueue | Rules Engine — Bedrock extraction (sync Textract + Bedrock) |
| 11 | `fund-processing-status` | GET /funds | List funds with optional status filter |
| 12 | `fund-get-by-id` | GET /funds/{id} | Single fund lookup |

> **Deprecated (kept in stack, no longer triggered):**
> `fund-document-processing-worker` (was ICMemo SQS worker) and `ICMemoProcessingQueue` / `ProcessingQueue`
> are no longer written to by `s3-upload-trigger`. They remain in CloudFormation as no-ops.

---

## SQS / SNS Queue Reference

| Queue / Topic | Type | Producer | Consumer | Purpose |
|---|---|---|---|---|
| `TextractStarterQueue` | SQS | S3UploadTriggerLambda | TextractStarterLambda | Triggers async Textract job per upload |
| `TextractStarterDLQ` | SQS | (overflow from above) | Manual review | Dead-letter queue for failed starter records |
| `TextractCompletionTopic` | SNS | AWS Textract | TextractResultsQueue | Textract publishes job completion here |
| `TextractResultsQueue` | SQS | TextractCompletionTopic (SNS) | TextractResultsWorkerLambda | Delivers Textract completion events to results worker |
| `TextractResultsDLQ` | SQS | (overflow from above) | Manual review | Dead-letter queue for failed result records |
| `SuccessQueue` | SQS | TextractResultsWorkerLambda | Downstream consumers | Signals successful extraction per document |

---

## CloudFormation Stacks

| Template | Purpose |
|----------|---------|
| `bootstrap.yaml` | Creates the Lambda code bucket (lambdas/ + assets/). Deploy **once per account**. |
| `cloudformation.yaml` | All application resources: 12 Lambdas, S3 buckets, SQS queues, SNS topic, DynamoDB table, API Gateway, IAM roles. |

---

## Deploying

### Prerequisites

| Tool | Notes |
|------|-------|
| Node.js 22.x + npm | https://nodejs.org |
| AWS CLI v2 | Configured with Admin or PowerUser credentials |
| zip | Pre-installed on macOS/Linux |

### Step 1 — Enable Bedrock Model Access

AWS Console → **Amazon Bedrock** → **Model access** → enable **Amazon Nova Pro** (`amazon.nova-pro-v1:0`).
Wait for *Access granted*.

### Step 2 — Run deploy.sh

```bash
REGION=us-east-1 ./deploy.sh
```

This script does everything in order:

1. Deploys `bootstrap.yaml` — creates the Lambda code bucket
2. Runs `build.sh` — builds all Lambda ZIPs into `dist/`
3. Syncs `dist/` → `s3://<lambda-code-bucket>/lambdas/`
4. Deploys `cloudformation.yaml` — all infrastructure
5. Uploads `assets/` → `s3://<lambda-code-bucket>/assets/`

### Step 3 — Upload a document

```bash
# ICMemo (creates a new fund record)
aws s3 cp memo.pdf \
  s3://<upload-bucket>/uploads/ICMemo/memo.pdf \
  --metadata "fund-name=Acme Capital Fund I"

# IMA / PPM / LPA / etc. (updates an existing fund record)
aws s3 cp agreement.pdf \
  s3://<upload-bucket>/uploads/IMA/agreement.pdf \
  --metadata "fund-name=Acme Capital Fund I,fund-id=INT#<uuid>"
```

Pipeline runs automatically — check DynamoDB for status progression:
`CREATED → TEXTRACT_PROCESSING → SUCCEEDED`

---

## Day-2 Operations

### Update prompts or schemas only

```bash
REGION=us-east-1 ./deploy.sh --assets-only
```

### Redeploy CloudFormation only

```bash
REGION=us-east-1 ./deploy.sh --stack-only
```

### Hotpatch a single Lambda

```bash
FN=textractStarterLambda   # folder name under functions/funds/

./build.sh $FN

aws lambda update-function-code \
  --function-name highcloud-ai-infra-textract-starter \
  --zip-file fileb://dist/$FN.zip
```

---

## Tearing Down

```bash
REGION="us-east-1"
STACK_NAME="highcloud-ai-infra"
BOOTSTRAP_STACK="highcloud-ai-infra-bootstrap"

PLATFORM_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$BOOTSTRAP_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='LambdaCodeBucketName'].OutputValue" \
  --output text --region "$REGION")

# Empty S3 buckets first (CloudFormation cannot delete non-empty buckets)
aws s3 rm "s3://$PLATFORM_BUCKET" --recursive

aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"

aws cloudformation delete-stack --stack-name "$BOOTSTRAP_STACK" --region "$REGION"
```
