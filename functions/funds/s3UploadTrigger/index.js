import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "crypto";

const region = process.env.AWS_REGION;

const s3     = new S3Client({ region });
const dynamo = new DynamoDBClient({ region });
const sqs    = new SQSClient({ region });

const TABLE               = process.env.DDB_TABLE;
const IC_MEMO_QUEUE_URL   = process.env.IC_MEMO_QUEUE_URL;   // → FundDocumentProcessingWorkerLambda
const PROCESSING_QUEUE_URL = process.env.PROCESSING_QUEUE_URL; // → FundDocumentProcessorLambda (IMA)
const ASSETS_BUCKET       = process.env.ASSETS_BUCKET;       // platform bucket (for schema S3 URIs)
const DOC_BUCKET          = process.env.DOC_BUCKET;          // documents bucket (for result output paths)
const IMA_SCHEMA_KEY      = process.env.IMA_SCHEMA_KEY;      // e.g. "assets/RulesEngineJSONSchema.txt"

// ── Document type registry ─────────────────────────────────────────────────
// Add entries here as new document types are onboarded.
// Matched case-insensitively against folder segments in the S3 key path.
const KNOWN_DOC_TYPES = new Set([
  "icmemo",
  "ima",
  "sideletter",
  "lpa",
  "ppm",
  "subdoc",
  "fundstructure"
]);

/**
 * Extract document type from S3 key path.
 * Convention: the folder containing the PDF names the document type.
 *   uploads/ICMemo/document.pdf   → "icmemo"
 *   uploads/IMA/report.pdf        → "ima"
 */
const extractDocumentType = (key) => {
  for (const segment of key.split("/")) {
    const lower = segment.trim().toLowerCase();
    if (KNOWN_DOC_TYPES.has(lower)) return lower;
  }
  return null;
};

/**
 * Read fund metadata from S3 object (HeadObject).
 * Returns { fundName, fundId } — either may be empty string if not found.
 * S3 lowercases all user metadata keys.
 */
const readS3Metadata = async (bucket, key, requestId) => {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const meta = head.Metadata || {};

    const fundName = (
      meta["fund-name"]  ||
      meta["fundname"]   ||
      meta["fund_name"]  ||
      ""
    ).trim();

    const fundId = (
      meta["fund-id"]  ||
      meta["fundid"]   ||
      meta["fund_id"]  ||
      ""
    ).trim();

    return { fundName, fundId };
  } catch (err) {
    console.warn(JSON.stringify({
      level: "WARN", requestId,
      stage: "HEAD_OBJECT_WARN",
      bucket, key, error: err.message
    }));
    return { fundName: "", fundId: "" };
  }
};

/**
 * ICMemo: create a brand-new fund record (INT#<uuid>, status=CREATED).
 * ICMemo signals a new fund — we generate the fundId internally.
 */
const handleICMemo = async ({ bucket, key, fileName, fundName, documentType, requestId }) => {
  const fundId = `INT#${randomUUID()}`;
  const now    = new Date().toISOString();

  console.log(JSON.stringify({
    level: "INFO", requestId,
    fundId, documentType, bucket, key, fileName,
    fundName: fundName || "(not in metadata)",
    stage: "ICMEMO_CREATING_FUND_RECORD"
  }));

  try {
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        fundId:       { S: fundId },
        fundName:     { S: fundName },
        status:       { S: "CREATED" },
        documentType: { S: documentType },
        bucket:       { S: bucket },
        objectKey:    { S: key },
        fileName:     { S: fileName },
        source:       { S: "S3_TRIGGER" },
        createdAt:    { S: now },
        updatedAt:    { S: now }
      },
      ConditionExpression: "attribute_not_exists(fundId)"
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // Extremely unlikely with a fresh UUID — skip defensively
      console.warn(JSON.stringify({ level: "WARN", requestId, fundId, stage: "ICMEMO_DDB_COLLISION_SKIP" }));
      return;
    }
    throw err;
  }

  // Enqueue for IC Memo processing (Textract + Bedrock)
  await sqs.send(new SendMessageCommand({
    QueueUrl: IC_MEMO_QUEUE_URL,
    MessageBody: JSON.stringify({
      fundId,
      documentType,
      bucket,
      key,
      fileName,
      ...(fundName && { fundName })
    })
  }));

  console.log(JSON.stringify({
    level: "INFO", requestId, fundId, documentType,
    stage: "ICMEMO_ENQUEUED",
    queue: "ICMemoProcessingQueue"
  }));
};

/**
 * IMA: update existing fund record (status=RECEIVED), enqueue for IMA processing.
 * Constructs the SQS payload expected by FundDocumentProcessorLambda:
 *   { fundId, inputFiles, schemaPath, outputPath }
 */
const handleIMA = async ({ bucket, key, fileName, fundName, fundId, documentType, requestId }) => {
  const now = new Date().toISOString();

  console.log(JSON.stringify({
    level: "INFO", requestId,
    fundId, documentType, bucket, key, fileName,
    stage: "IMA_UPDATING_FUND_RECORD"
  }));

  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { fundId: { S: fundId } },
    UpdateExpression:
      "SET #s = :received, updatedAt = :u, documentType = :dt, objectKey = :k, fileName = :f",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":received": { S: "RECEIVED" },
      ":u":        { S: now },
      ":dt":       { S: documentType },
      ":k":        { S: key },
      ":f":        { S: fileName }
    }
  }));

  // Build SQS payload for FundDocumentProcessorLambda (Rules Engine)
  const schemaPath = `s3://${ASSETS_BUCKET}/${IMA_SCHEMA_KEY}`;
  const outputPath = `s3://${DOC_BUCKET}/${fundId}/results/`;

  await sqs.send(new SendMessageCommand({
    QueueUrl: PROCESSING_QUEUE_URL,
    MessageBody: JSON.stringify({
      fundId,
      inputFiles: [`s3://${bucket}/${key}`],
      schemaPath,
      outputPath
    })
  }));

  console.log(JSON.stringify({
    level: "INFO", requestId, fundId, documentType,
    stage: "IMA_ENQUEUED",
    queue: "ProcessingQueue",
    schemaPath,
    outputPath
  }));
};

/**
 * Other document types (PPM, LPA, SideLetter, FundStructure, SubDoc):
 * Update existing fund record to RECEIVED. No AI processing yet.
 */
const handleOtherDocument = async ({ key, fileName, fundName, fundId, documentType, requestId }) => {
  const now = new Date().toISOString();

  console.log(JSON.stringify({
    level: "INFO", requestId,
    fundId, documentType, key, fileName,
    stage: "OTHER_DOC_UPDATING_FUND_RECORD"
  }));

  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { fundId: { S: fundId } },
    UpdateExpression:
      "SET #s = :received, updatedAt = :u, documentType = :dt, objectKey = :k, fileName = :f",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":received": { S: "RECEIVED" },
      ":u":        { S: now },
      ":dt":       { S: documentType },
      ":k":        { S: key },
      ":f":        { S: fileName }
    }
  }));

  console.log(JSON.stringify({
    level: "INFO", requestId, fundId, documentType,
    stage: "OTHER_DOC_RECEIVED_NO_QUEUE",
    note: "AI processing for this document type is not yet implemented"
  }));
};

/**
 * S3UploadTriggerLambda
 *
 * Triggered by S3 Put events on the external upload bucket (e.g. altfundflow).
 * Routes each PDF to the correct processing path based on the document type
 * encoded in the S3 key folder structure.
 *
 * S3 key convention:
 *   <prefix>/<DocumentType>/<filename>.pdf
 *
 * S3 metadata expected:
 *   x-amz-meta-fund-name = <fund name>            (all document types)
 *   x-amz-meta-fund-id   = <existing fundId>      (all document types EXCEPT ICMemo)
 *
 * Routing:
 *   icmemo       → create INT#<uuid> record → ICMemoProcessingQueue
 *   ima          → update existing record   → ProcessingQueue (FundDocumentProcessorLambda)
 *   ppm / lpa /
 *   sideletter /
 *   fundstructure/
 *   subdoc       → update existing record   → no queue (processing TBD)
 *
 * Post-deploy setup required on the external bucket:
 *   aws s3api put-bucket-notification-configuration \
 *     --bucket <upload-bucket> \
 *     --notification-configuration '{
 *       "LambdaFunctionConfigurations": [{
 *         "LambdaFunctionArn": "<S3UploadTriggerLambdaArn>",
 *         "Events": ["s3:ObjectCreated:*"]
 *       }]
 *     }'
 */
export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    stage: "S3_TRIGGER_START",
    recordCount: event.Records?.length || 0
  }));

  for (const record of (event.Records || [])) {

    // ── Extract bucket + key ─────────────────────────────────────────────────
    const bucket = record.s3?.bucket?.name;
    const rawKey = record.s3?.object?.key;

    // S3 encodes spaces as '+' and other chars as '%xx' in event payloads
    const key = rawKey ? decodeURIComponent(rawKey.replace(/\+/g, " ")) : "";

    if (!bucket || !key) {
      console.warn(JSON.stringify({
        level: "WARN", requestId,
        stage: "MISSING_S3_INFO",
        record: JSON.stringify(record)
      }));
      continue;
    }

    // ── Only process PDFs ────────────────────────────────────────────────────
    const fileName = key.split("/").pop() || key;
    if (!fileName.toLowerCase().endsWith(".pdf")) {
      console.log(JSON.stringify({ level: "INFO", requestId, stage: "SKIPPED_NON_PDF", bucket, key }));
      continue;
    }

    // ── Determine document type from folder name ─────────────────────────────
    const documentType = extractDocumentType(key);
    if (!documentType) {
      console.warn(JSON.stringify({
        level: "WARN", requestId,
        stage: "UNKNOWN_DOCUMENT_TYPE",
        bucket, key,
        knownTypes: [...KNOWN_DOC_TYPES].join(", ")
      }));
      continue;
    }

    // ── Read S3 metadata ─────────────────────────────────────────────────────
    const { fundName, fundId: metaFundId } = await readS3Metadata(bucket, key, requestId);

    // ── Route by document type ───────────────────────────────────────────────
    try {
      if (documentType === "icmemo") {
        // New fund — fundId generated internally
        await handleICMemo({ bucket, key, fileName, fundName, documentType, requestId });

      } else if (documentType === "ima") {
        // Existing fund — fundId must be in metadata
        if (!metaFundId) {
          console.error(JSON.stringify({
            level: "ERROR", requestId,
            stage: "MISSING_FUND_ID_IN_METADATA",
            documentType, bucket, key,
            message: "IMA document requires x-amz-meta-fund-id metadata"
          }));
          continue;
        }
        await handleIMA({ bucket, key, fileName, fundName, fundId: metaFundId, documentType, requestId });

      } else {
        // PPM, LPA, SideLetter, FundStructure, SubDoc — existing fund, no queue
        if (!metaFundId) {
          console.error(JSON.stringify({
            level: "ERROR", requestId,
            stage: "MISSING_FUND_ID_IN_METADATA",
            documentType, bucket, key,
            message: `${documentType} document requires x-amz-meta-fund-id metadata`
          }));
          continue;
        }
        await handleOtherDocument({ key, fileName, fundName, fundId: metaFundId, documentType, requestId });
      }

    } catch (err) {
      console.error(JSON.stringify({
        level: "ERROR", requestId,
        stage: "RECORD_PROCESSING_FAILED",
        documentType, bucket, key,
        error: err.message,
        stack: err.stack
      }));
      // Log and continue — do not let one failed record block others in the batch
    }
  }

  console.log(JSON.stringify({ level: "INFO", requestId, stage: "S3_TRIGGER_COMPLETE" }));
};
