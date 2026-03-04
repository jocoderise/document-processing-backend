# Document Processing Backend — Session Memory

## Architecture
- Two CloudFormation stacks: `bootstrap.yaml` (Lambda code bucket) → `cloudformation.yaml` (everything else including UploadBucket + DocumentsBucket)
- **Lambda code bucket** (`LambdaCodeBucket` CF param, bootstrap.yaml): `lambdas/` + `assets/` only — Lambdas read-only at runtime
- **Upload bucket** (cloudformation.yaml, `UPLOAD_BUCKET` env var): PDF intake — S3 Put events auto-trigger S3UploadTriggerLambda
- **Documents bucket** (cloudformation.yaml, `DOC_BUCKET` env var): all runtime document data (PDFs, results, archives)

## S3 Bucket Layout — THREE BUCKETS

Lambda code bucket (`LambdaCodeBucket` CF param, created by bootstrap.yaml):
```
<bootstrap-stack>-platform-<accountId>/
  lambdas/<fnName>.zip          ← Lambda ZIPs (deploy.sh syncs dist/ here — flat, no subdirs)
  assets/
    ICMemoEngineJSONSchema.txt  ← ICMemo schema  (ICSchemaKey param default)
    RulesEngineJSONSchema.txt   ← IMA/Rules Engine schema (IMASchemaKey param default)
    prompt/
      icmemo-v1.txt             ← ICMemo extraction prompt (ICPromptKey param default)
      rules-engine-v1.txt       ← IMA rules engine prompt (ProcessorPromptKey param default)
```
Lambdas ONLY READ from this bucket at runtime (GetObject on assets/ prefix).
Source files in repo: `assets/` (schemas) and `assets/prompt/` (prompts); canonical originals in `SchemasAndPrompts/`.

Upload bucket (`<stack>-uploads-<accountId>`, created by cloudformation.yaml):
```
<prefix>/<DocumentType>/<filename>.pdf   ← upload PDFs here (no fund slug in path)
```
Fund identification comes from S3 object metadata only (not the path).

Documents bucket (`DOC_BUCKET` in Lambdas, created by cloudformation.yaml):
```
<documents-bucket>/
  INT#<uuid>/<file>.pdf             ← IC Memo PDFs via presigned URL (S3 trigger flow)
  EXT#<id>/<file>.pdf               ← IC Memo PDFs via external API
  <fundId>/files/                   ← Input PDFs (Rules Engine flow)
  <fundId>/results/                 ← Bedrock output JSON
  <fundId>/archive/                 ← Previous upload archive (auto-expires 90d)
```

## S3 Trigger — Document Routing (S3UploadTriggerLambda)
S3 key convention: `<prefix>/<DocumentType>/<filename>.pdf` (no fund slug — fund info is in S3 metadata only)
S3 metadata: `x-amz-meta-fund-name` (all docs), `x-amz-meta-fund-id` (non-ICMemo docs)

| Doc Type | DDB Action | Queue |
|---|---|---|
| icmemo | Create INT#uuid record (status=CREATED) | ICMemoProcessingQueue → FundDocumentProcessingWorkerLambda |
| ima | Update existing record (status=RECEIVED) | ProcessingQueue → FundDocumentProcessorLambda |
| ppm, lpa, sideletter, fundstructure, subdoc | Update existing record (status=RECEIVED) | none (AI processing TBD) |

## Processing Flows
- **S3 Trigger / ICMemo**: S3 Put (upload bucket) → S3UploadTrigger → new INT#uuid DDB record → ICMemoProcessingQueue → FundDocumentProcessingWorkerLambda (Textract+Bedrock+AJV, schema: ICMemoEngineJSONSchema.txt, prompt: icmemo-v1.txt)
- **S3 Trigger / IMA**: S3 Put (upload bucket) → S3UploadTrigger → update existing DDB record → ProcessingQueue → FundDocumentProcessorLambda (Bedrock s3Location, schema: RulesEngineJSONSchema.txt, prompt: rules-engine-v1.txt)
- **IC Memo API** (secondary/future): POST /funds → CreateFundUpload → presigned PUT → POST /funds/{id}/extract → Textract → Bedrock → DDB
- **External API** (secondary/future): POST /funds/register → ExternalFundCreate → DDB (EXT#id, status=UPLOADING) → presigned PUT → POST /funds/{id}/extract
- **Rules Engine API** (secondary/future): POST /funds/{id}/init → FundInitUpload → presigned POST → POST /funds/{id}/complete → FundUploadComplete → SQS (ProcessingQueue) → FundDocumentProcessorLambda → Bedrock → S3 + SuccessQueue

## Lambda Functions (11 total)
1. CreateFundUploadLambda — POST /funds — generates INT#<uuid>, returns presigned PUT URL
2. FundInitUploadLambda — POST /funds/{id}/init
3. FundDocumentUploadLambda — POST /funds/{id}/upload
4. FundUploadCompleteLambda — POST /funds/{id}/complete
5. FundDocumentProcessorLambda — SQS consumer (ProcessingQueue), Bedrock rules engine
6. FundProcessingStatusLambda — GET /funds
7. FundGetByIdLambda — GET /funds/{id}
8. ICMemoExtractionLambda — POST /funds/{id}/extract, Textract + Bedrock (synchronous)
9. FundDocumentProcessingWorkerLambda — SQS consumer (ICMemoProcessingQueue), Textract + Bedrock + AJV, idempotent
10. S3UploadTriggerLambda — S3 Put (upload bucket) → routes by doc type → DDB + SQS
11. ExternalFundCreateLambda — POST /funds/register — EXT# prefix for third-party fundIds

## Key Files
- `bootstrap.yaml` — creates Lambda code bucket (lambdas/ + assets/)
- `cloudformation.yaml` — all Lambdas, SQS, DDB, API Gateway, IAM, UploadBucket, DocumentsBucket
- `deploy.sh` — full deploy: bootstrap → build.sh → sync dist/ to lambdas/ → stack → sync assets/
- `build.sh` — builds all 11 Lambda ZIPs into dist/ (flat: dist/<fnName>.zip); excludes @aws-sdk + @smithy (provided by Lambda runtime)
- `assets/` — prompts and schemas committed to repo, uploaded to assets/ prefix by deploy.sh
- `functions/funds/` — source code for all Lambda functions

## Deploy Command
```bash
REGION=us-east-1 ./deploy.sh
```
