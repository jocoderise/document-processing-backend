import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "crypto";

const region = process.env.AWS_REGION;

const s3     = new S3Client({ region });
const dynamo = new DynamoDBClient({ region });
const sqs    = new SQSClient({ region });

const TABLE                    = process.env.DDB_TABLE;
const TEXTRACT_STARTER_QUEUE_URL = process.env.TEXTRACT_STARTER_QUEUE_URL;

// ── Document type registry ─────────────────────────────────────────────────
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
 */
const readS3Metadata = async (bucket, key, requestId) => {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const meta = head.Metadata || {};

    const fundName = (meta["fund-name"] || meta["fundname"] || meta["fund_name"] || "").trim();
    const fundId   = (meta["fund-id"]   || meta["fundid"]   || meta["fund_id"]   || "").trim();

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
 * Enqueue a document to TextractStarterQueue with a unified payload.
 * All document types use the same payload shape.
 */
const enqueueForTextract = async ({ fundId, documentType, bucket, key, fileName, fundName, requestId }) => {
  await sqs.send(new SendMessageCommand({
    QueueUrl: TEXTRACT_STARTER_QUEUE_URL,
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
    stage: "ENQUEUED_FOR_TEXTRACT",
    queue: "TextractStarterQueue"
  }));
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
      console.warn(JSON.stringify({ level: "WARN", requestId, fundId, stage: "ICMEMO_DDB_COLLISION_SKIP" }));
      return;
    }
    throw err;
  }

  await enqueueForTextract({ fundId, documentType, bucket, key, fileName, fundName, requestId });
};

/**
 * All other document types (IMA, PPM, LPA, SideLetter, FundStructure, SubDoc):
 * Update existing fund record to RECEIVED, then enqueue for Textract processing.
 * Requires x-amz-meta-fund-id metadata.
 */
const handleExistingFund = async ({ bucket, key, fileName, fundName, fundId, documentType, requestId }) => {
  const now = new Date().toISOString();

  console.log(JSON.stringify({
    level: "INFO", requestId,
    fundId, documentType, bucket, key, fileName,
    stage: "UPDATING_FUND_RECORD_TO_RECEIVED"
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

  await enqueueForTextract({ fundId, documentType, bucket, key, fileName, fundName, requestId });
};

/**
 * S3UploadTriggerLambda
 *
 * Triggered by S3 Put events on the upload bucket.
 * Routes ALL document types to TextractStarterQueue for unified async processing.
 *
 * S3 key convention:
 *   <prefix>/<DocumentType>/<filename>.pdf
 *
 * S3 metadata expected:
 *   x-amz-meta-fund-name = <fund name>            (all document types)
 *   x-amz-meta-fund-id   = <existing fundId>      (all types EXCEPT ICMemo)
 *
 * Routing:
 *   icmemo   → create INT#<uuid> fund record → TextractStarterQueue
 *   all else → update existing fund record   → TextractStarterQueue
 */
export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  console.log(JSON.stringify({
    level: "INFO", requestId,
    stage: "S3_TRIGGER_START",
    recordCount: event.Records?.length || 0
  }));

  for (const record of (event.Records || [])) {

    const bucket = record.s3?.bucket?.name;
    const rawKey = record.s3?.object?.key;
    const key    = rawKey ? decodeURIComponent(rawKey.replace(/\+/g, " ")) : "";

    if (!bucket || !key) {
      console.warn(JSON.stringify({ level: "WARN", requestId, stage: "MISSING_S3_INFO" }));
      continue;
    }

    const fileName = key.split("/").pop() || key;
    if (!fileName.toLowerCase().endsWith(".pdf")) {
      console.log(JSON.stringify({ level: "INFO", requestId, stage: "SKIPPED_NON_PDF", key }));
      continue;
    }

    const documentType = extractDocumentType(key);
    if (!documentType) {
      console.warn(JSON.stringify({
        level: "WARN", requestId,
        stage: "UNKNOWN_DOCUMENT_TYPE",
        key, knownTypes: [...KNOWN_DOC_TYPES].join(", ")
      }));
      continue;
    }

    const { fundName, fundId: metaFundId } = await readS3Metadata(bucket, key, requestId);

    try {
      if (documentType === "icmemo") {
        await handleICMemo({ bucket, key, fileName, fundName, documentType, requestId });
      } else {
        if (!metaFundId) {
          console.error(JSON.stringify({
            level: "ERROR", requestId,
            stage: "MISSING_FUND_ID_IN_METADATA",
            documentType, bucket, key,
            message: `${documentType} document requires x-amz-meta-fund-id metadata`
          }));
          continue;
        }
        await handleExistingFund({ bucket, key, fileName, fundName, fundId: metaFundId, documentType, requestId });
      }
    } catch (err) {
      console.error(JSON.stringify({
        level: "ERROR", requestId,
        stage: "RECORD_PROCESSING_FAILED",
        documentType, bucket, key,
        error: err.message,
        stack: err.stack
      }));
    }
  }

  console.log(JSON.stringify({ level: "INFO", requestId, stage: "S3_TRIGGER_COMPLETE" }));
};
