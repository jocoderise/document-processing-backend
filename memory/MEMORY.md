# Document Processing Backend — Session Memory

## Architecture
- Two CloudFormation stacks: `bootstrap.yaml` (platform bucket) → `cloudformation.yaml` (everything else including DocumentsBucket)
- **Platform bucket** (bootstrap.yaml, `ASSETS_BUCKET` env var): `lambdas/` + `assets/` only — Lambdas read-only at runtime
- **Documents bucket** (cloudformation.yaml, `DOC_BUCKET` env var): all runtime document data (PDFs, results, archives)

## S3 Bucket Layout — TWO BUCKETS

Platform bucket (`ASSETS_BUCKET` in Lambdas, created by bootstrap.yaml):
```
<platform-bucket>/
  lambdas/funds/<name>/<name>.zip   ← Lambda ZIPs (deploy.sh syncs dist/ here)
  assets/
    ICMemoEngineJSONSchema.txt      ← ICMemo schema  (ICSchemaKey param default)
    RulesEngineJSONSchema.txt       ← IMA/Rules Engine schema (IMASchemaKey param default)
    prompt/
      icmemo-v1.txt                 ← ICMemo extraction prompt (ICPromptKey param default)
      rules-engine-v1.txt           ← IMA rules engine prompt (ProcessorPromptKey param default)
```
Lambdas ONLY READ from this bucket at runtime (GetObject on assets/ prefix).
Source files in repo: `assets/` (schemas) and `assets/prompt/` (prompts); canonical originals in `SchemasAndPrompts/`.

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
- **IC Memo API** (internal): POST /funds → CreateFundUpload → presigned PUT → POST /funds/{id}/extract → Textract → Bedrock → DDB
- **External API**: POST /funds/register → ExternalFundCreate → DDB (EXT#id, status=UPLOADING) → presigned PUT → POST /funds/{id}/extract
- **Rules Engine API**: POST /funds/{id}/init → FundInitUpload → presigned POST → POST /funds/{id}/complete → FundUploadComplete → SQS (ProcessingQueue) → FundDocumentProcessorLambda → Bedrock → S3 + SuccessQueue

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
10. S3UploadTriggerLambda — S3 Put event bridge (altfundflow → DDB record → ICMemoProcessingQueue)
11. ExternalFundCreateLambda — POST /funds/register — EXT# prefix for third-party fundIds

## Key Files
- `bootstrap.yaml` — creates platform S3 bucket with CORS + lifecycle
- `cloudformation.yaml` — all Lambdas, SQS, DDB, API Gateway, IAM
- `deploy.sh` — full deploy: bootstrap → build → sync dist/ to lambdas/ → stack → sync assets/
- `build.sh` — builds all 9 Lambda ZIPs into dist/
- `assets/` — prompts and schemas committed to repo, uploaded to assets/ prefix by deploy.sh
- `functions/funds/` — source code for all Lambda functions

## Completed Work
- Fixed critical bug: `UpdateItemCommand` → `GetItemCommand` in FundDocumentProcessingWorkerLambda
- Added Lambda 9 (FundDocumentProcessingWorkerLambda + ICMemoProcessingQueue) to cloudformation.yaml
- Created bootstrap.yaml, deploy.sh
- Seeded assets/RulesEngineJSONSchema.txt from source account
- Consolidated two S3 buckets into one platform bucket (lambdas/ + assets/)
- Fixed hardcoded `RulesEngineJSONSchema.txt` → `assets/RulesEngineJSONSchema.txt` in 3 Lambda files
- Added Lambda 10: S3UploadTriggerLambda (functions/funds/s3UploadTrigger/) — S3 Put → DDB + SQS bridge
- Added Lambda 11: ExternalFundCreateLambda (functions/funds/externalFundCreate/) — POST /funds/register
- Updated cloudformation.yaml: IAM (SQSSend for ICMemoProcessingQueue), new log groups, new Lambdas, API routes, S3 Lambda permission, outputs
- Post-deploy step: configure S3 notification on altfundflow bucket pointing to S3UploadTriggerLambda ARN
- Split single platform bucket into TWO buckets: platform bucket (ASSETS_BUCKET) for lambdas+assets, DocumentsBucket (DOC_BUCKET) for runtime document data
- Updated 4 Lambda source files to use ASSETS_BUCKET for prompt/schema reads, DOC_BUCKET for PDFs/results
- Updated cloudformation.yaml: added DocumentsBucket resource, split IAM (S3DocumentsObjects + S3AssetsRead), added ASSETS_BUCKET env var to 4 Lambdas, added DocumentsBucketName output
- Expanded S3UploadTriggerLambda: routes ALL doc types (icmemo/ima/ppm/lpa/sideletter/fundstructure/subdoc); ICMemo creates new fund, IMA updates existing + sends to ProcessingQueue, others update only
- Renamed asset files to canonical names: ICMemoEngineJSONSchema.txt, RulesEngineJSONSchema.txt, prompt/icmemo-v1.txt, prompt/rules-engine-v1.txt; updated cloudformation param defaults and deploy.sh
- FundDocumentProcessingWorkerLambda: ICMemo only — throws for any other doc type reaching the queue
- Added IMASchemaKey cloudformation parameter (default: assets/RulesEngineJSONSchema.txt)

## Deploy Command
```bash
REGION=us-east-1 ./deploy.sh
```
