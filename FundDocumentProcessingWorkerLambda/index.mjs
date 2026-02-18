import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import Ajv from "ajv";

const region = process.env.AWS_REGION;

const s3 = new S3Client({ region });
const textract = new TextractClient({ region });
const bedrock = new BedrockRuntimeClient({ region });
const dynamo = new DynamoDBClient({ region });

const TABLE = process.env.DDB_TABLE;

// DOC_BUCKET is the DESTINATION bucket AND also where prompt/schema already live.
const DOC_BUCKET = process.env.DOC_BUCKET;

const PROMPT_KEY = process.env.PROMPT_KEY;      // e.g. "icmemoextractionprompt.txt"
const SCHEMA_KEY = process.env.SCHEMA_KEY;      // e.g. "schema.json"
const MODEL_ID = process.env.BEDROCK_MODEL_ID;  // e.g. "amazon.nova-pro-v1:0"

// Stream -> string helper
const streamToString = async (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

/**
 * SQS Message Contract
 *
 * {
 *   "fundId": "101",
 *   "documentType": "icmemo",
 *   "bucket": "Altfundflow",  // INPUT bucket where the PDF was uploaded
 *   "key": "uploads/abc_fund/icmemo/Alt Fund Flow Sample Ic Memo.pdf",
 *   "fileName": "Alt Fund Flow Sample Ic Memo.pdf",     // optional
 *   "fundSlug": "abc_fund",                              // optional
 *   "promptKey": "icmemoextractionprompt.txt",           // optional override (stored in DOC_BUCKET)
 *   "schemaKey": "schema.json"                           // optional override (stored in DOC_BUCKET)
 * }
 *
 * Important:
 * - INPUT PDF is always read from message.bucket/message.key
 * - PROMPT + SCHEMA are read from DOC_BUCKET (as per your requirement)
 * - OUTPUT JSON is written to DOC_BUCKET under fundId/documentType/
 */

/**
 * Process IC Memo document (Textract + Bedrock + AJV validation).
 * Returns the extracted JSON object (already schema-validated).
 */
const processICMemo = async ({
  fundId,
  documentType,
  inputBucket,
  objectKey,
  fileName,
  promptKey,
  schemaKey,
  requestId
}) => {

  const start = Date.now();

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    fundId,
    documentType,
    inputBucket,
    objectKey,
    fileName: fileName || null,
    stage: "ICMEMO_PROCESSING_START"
  }));

  // Confirm the INPUT document exists before expensive calls
  console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "S3_HEAD_INPUT_DOC" }));

  await s3.send(new HeadObjectCommand({
    Bucket: inputBucket,
    Key: objectKey
  }));

  // Load prompt + schema FROM DOC_BUCKET (destination bucket), per your requirement
  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    fundId,
    stage: "LOAD_PROMPT_SCHEMA",
    promptBucket: DOC_BUCKET,
    promptKey,
    schemaBucket: DOC_BUCKET,
    schemaKey
  }));

  const promptObj = await s3.send(new GetObjectCommand({ Bucket: DOC_BUCKET, Key: promptKey }));
  const schemaObj = await s3.send(new GetObjectCommand({ Bucket: DOC_BUCKET, Key: schemaKey }));

  const systemPrompt = await streamToString(promptObj.Body);
  const schemaJsonText = await streamToString(schemaObj.Body);

  let schema;
  try {
    schema = JSON.parse(schemaJsonText);
  } catch {
    throw new Error("Schema file in DOC_BUCKET is not valid JSON");
  }

  // Load PDF bytes FROM INPUT BUCKET
  console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "LOAD_PDF" }));

  const pdfObj = await s3.send(new GetObjectCommand({ Bucket: inputBucket, Key: objectKey }));
  const pdfBytes = Buffer.from(await pdfObj.Body.transformToByteArray());

  // Textract
  console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "TEXTRACT_START" }));

  const textractResult = await textract.send(new DetectDocumentTextCommand({
    Document: { Bytes: pdfBytes }
  }));

  const memoText = (textractResult.Blocks || [])
    .filter(b => b.BlockType === "LINE")
    .map(b => b.Text || "")
    // light noise trimming (optional, safe)
    .filter(t => t && !t.toUpperCase().includes("WATERMARK"))
    .join("\n");

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    fundId,
    stage: "TEXTRACT_DONE",
    blockCount: textractResult.Blocks?.length || 0,
    textChars: memoText.length
  }));

  // Build user prompt for Nova
  const userPrompt = `
JSON Schema (must conform exactly):
${JSON.stringify(schema)}

IC Memo text to extract from:
${memoText}

Now extract and return exactly one JSON object that conforms to the schema.
`;

  // Bedrock
  console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "NOVA_START" }));

  const converse = new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: systemPrompt }],
    messages: [
      { role: "user", content: [{ text: userPrompt }] }
    ],
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0
    }
  });

  const response = await bedrock.send(converse);

  const rawText = response.output?.message?.content?.[0]?.text || "";

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    fundId,
    stage: "NOVA_DONE",
    outputChars: rawText.length
  }));

  let extracted;
  try {
    extracted = JSON.parse(rawText);
  } catch {
    throw new Error("Model output was not valid JSON");
  }

  // AJV validate against schema
  console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "AJV_VALIDATE" }));

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const valid = validate(extracted);
  if (!valid) {
    throw new Error(`Schema validation failed: ${JSON.stringify(validate.errors || [])}`);
  }

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    fundId,
    stage: "ICMEMO_SUCCESS",
    durationMs: Date.now() - start
  }));

  return extracted;
};

/**
 * Process one SQS message (one document).
 * - Requires fund record to exist in DynamoDB (enterprise-safe recommendation).
 * - Uses switch(documentType) routing.
 * - Reads INPUT PDF from message.bucket/message.key.
 * - Reads PROMPT/SCHEMA from DOC_BUCKET.
 * - Writes OUTPUT JSON to DOC_BUCKET under fundId/documentType/.
 * - Updates DynamoDB status transitions and persists payload + result S3 location.
 */
const processOneMessage = async ({ message, requestId }) => {

  // Required environment configuration
  if (!TABLE) throw new Error("Missing env var DDB_TABLE");
  if (!DOC_BUCKET) throw new Error("Missing env var DOC_BUCKET (destination bucket for results and prompt/schema)");
  if (!PROMPT_KEY) throw new Error("Missing env var PROMPT_KEY");
  if (!SCHEMA_KEY) throw new Error("Missing env var SCHEMA_KEY");
  if (!MODEL_ID) throw new Error("Missing env var BEDROCK_MODEL_ID");

  // Required message fields
  const fundId = (typeof message.fundId === "string" && message.fundId.trim()) ? message.fundId.trim() : "";
  if (!fundId) throw new Error("Missing fundId in SQS message");

  const documentType = (typeof message.documentType === "string" && message.documentType.trim())
    ? message.documentType.trim().toLowerCase()
    : "";
  if (!documentType) throw new Error("Missing documentType in SQS message");

  // INPUT bucket is provided by SQS payload (where uploaded PDF lives)
  const inputBucket = (typeof message.bucket === "string" && message.bucket.trim()) ? message.bucket.trim() : "";
  if (!inputBucket) throw new Error("Missing bucket (input bucket) in SQS message");

  const objectKey = (typeof message.key === "string" && message.key.trim()) ? message.key.trim() : "";
  if (!objectKey) throw new Error("Missing key (objectKey) in SQS message");

  const fileName =
    (typeof message.fileName === "string" && message.fileName.trim())
      ? message.fileName.trim()
      : objectKey.split("/").slice(-1)[0];

  // Optional per-message overrides (still stored in DOC_BUCKET)
  const promptKey =
    (typeof message.promptKey === "string" && message.promptKey.trim())
      ? message.promptKey.trim()
      : PROMPT_KEY;

  const schemaKey =
    (typeof message.schemaKey === "string" && message.schemaKey.trim())
      ? message.schemaKey.trim()
      : SCHEMA_KEY;

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    fundId,
    documentType,
    inputBucket,
    objectKey,
    fileName,
    stage: "DOCUMENT_TYPE_ROUTING"
  }));

  // Switch-based routing (only icmemo implemented now)
  switch (documentType) {

    case "icmemo":
      break;

    case "ima":
    case "sideletter":
    case "lpa":
    case "ppm":
    case "subdoc":
      console.log(JSON.stringify({
        level: "INFO",
        requestId,
        fundId,
        documentType,
        stage: "NOT_IMPLEMENTED_YET"
      }));
      return;

    default:
      throw new Error(`Unsupported documentType: ${documentType}`);
  }

  // Fetch fund record (strict requirement: fund must exist)
  const fundRecord = await dynamo.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { fundId: { S: fundId } },
    UpdateExpression: `
    SET #s = :processing,
        updatedAt = :u,
        objectKey = :k,
        fileName = :f,
        documentType = :dt
    REMOVE errorReason
  `,
    ExpressionAttributeNames: {
      "#s": "status"
    },
    ExpressionAttributeValues: {
      ":processing": { S: "PROCESSING" },
      ":u": { S: new Date().toISOString() },
      ":k": { S: objectKey },
      ":f": { S: fileName },
      ":dt": { S: documentType }
    }
  }));


  const currentStatus = fundRecord.Item.status?.S || "";
  const existingObjectKey = fundRecord.Item.objectKey?.S || "";

  // Idempotency / gating behavior
  if (currentStatus === "EXTRACTED" && fundRecord.Item.payload?.S) {
    console.log(JSON.stringify({
      level: "INFO",
      requestId,
      fundId,
      stage: "IDEMPOTENT_ALREADY_EXTRACTED"
    }));
    return;
  }

  if (currentStatus === "PROCESSING") {
    console.log(JSON.stringify({
      level: "INFO",
      requestId,
      fundId,
      stage: "IDEMPOTENT_ALREADY_PROCESSING",
      existingObjectKey: existingObjectKey || null,
      incomingObjectKey: objectKey
    }));

    // If same object is being processed, treat as idempotent and exit.
    if (!existingObjectKey || existingObjectKey === objectKey) {
      return;
    }

    // If different object arrives while processing, fail hard.
    await dynamo.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { fundId: { S: fundId } },
      UpdateExpression: "SET #s = :failed, updatedAt = :u, errorReason = :e",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":failed": { S: "FAILED" },
        ":u": { S: new Date().toISOString() },
        ":e": { S: "Received a new document while processing another document" }
      }
    }));

    throw new Error("Processing already in progress for a different document");
  }

  // Move to PROCESSING with conditional gate to avoid races
  console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "STATUS_TO_PROCESSING" }));

  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { fundId: { S: fundId } },
    UpdateExpression: "SET #s = :processing, updatedAt = :u, objectKey = :k, fileName = :f, documentType = :dt REMOVE errorReason",
    ConditionExpression: "attribute_not_exists(#s) OR #s IN (:uploading, :failed, :created, :extracted)",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":processing": { S: "PROCESSING" },
      ":uploading": { S: "UPLOADING" },
      ":failed": { S: "FAILED" },
      ":created": { S: "CREATED" },
      ":extracted": { S: "EXTRACTED" },
      ":u": { S: new Date().toISOString() },
      ":k": { S: objectKey },
      ":f": { S: fileName },
      ":dt": { S: documentType }
    }
  }));

  // Process IC Memo (Textract + Bedrock + schema validation)
  const extracted = await processICMemo({
    fundId,
    documentType,
    inputBucket,
    objectKey,
    fileName,
    promptKey,
    schemaKey,
    requestId
  });

  // Write extracted JSON to DOC_BUCKET under fundId/documentType/
  // Note: S3 folders are virtual; no pre-creation is required.
  const safeBaseName = (fileName || "document")
    .replace(/\s+/g, "_")
    .replace(/[^\w.\-]/g, "");

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const resultKey = `${fundId}/${documentType}/${safeBaseName}.${ts}.json`;

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    fundId,
    documentType,
    stage: "S3_RESULT_WRITE_START",
    resultBucket: DOC_BUCKET,
    resultKey
  }));

  await s3.send(new PutObjectCommand({
    Bucket: DOC_BUCKET,
    Key: resultKey,
    Body: JSON.stringify(extracted, null, 2),
    ContentType: "application/json"
  }));

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    fundId,
    documentType,
    stage: "S3_RESULT_WRITE_SUCCESS",
    resultKey
  }));

  // Persist success to DynamoDB (store payload + where the output JSON was written)
  console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "DDB_PERSIST_SUCCESS" }));

  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { fundId: { S: fundId } },
    UpdateExpression: "SET #s = :extracted, updatedAt = :u, extractedAt = :x, payload = :p, resultBucket = :rb, resultKey = :rk REMOVE errorReason",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":extracted": { S: "EXTRACTED" },
      ":u": { S: new Date().toISOString() },
      ":x": { S: new Date().toISOString() },
      ":p": { S: JSON.stringify(extracted) },
      ":rb": { S: DOC_BUCKET },
      ":rk": { S: resultKey }
    }
  }));
};

/**
 * SQS Handler
 *
 * This Lambda is triggered by SQS (Standard queue recommended).
 * It processes each message independently and reports per-message failures using
 * partial batch response (reportBatchItemFailures).
 *
 * - On success: do nothing for that message (Lambda returns no failure entry).
 * - On failure: record messageId in batchItemFailures so only that message retries.
 */
export const handler = async (event, context) => {

  const requestId = context.awsRequestId;

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    stage: "BATCH_START",
    recordCount: event?.Records?.length || 0
  }));

  const batchItemFailures = [];

  for (const record of (event.Records || [])) {

    const messageId = record.messageId;

    let message;
    try {
      message = JSON.parse(record.body || "{}");
    } catch (e) {
      console.error(JSON.stringify({
        level: "ERROR",
        requestId,
        messageId,
        stage: "INVALID_SQS_JSON",
        error: e.message
      }));

      // Mark this message as failed so it can retry/DLQ
      batchItemFailures.push({ itemIdentifier: messageId });
      continue;
    }

    try {
      await processOneMessage({ message, requestId });
    } catch (err) {
      console.error(JSON.stringify({
        level: "ERROR",
        requestId,
        messageId,
        stage: "MESSAGE_FAILED",
        message: err.message,
        stack: err.stack
      }));

      // Best-effort mark FAILED if we have fundId (do not create new fund records here)
      const fundId = (typeof message.fundId === "string" && message.fundId.trim()) ? message.fundId.trim() : "";
      if (fundId && TABLE) {
        try {
          await dynamo.send(new UpdateItemCommand({
            TableName: TABLE,
            Key: { fundId: { S: fundId } },
            UpdateExpression: "SET #s = :failed, updatedAt = :u, errorReason = :e",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":failed": { S: "FAILED" },
              ":u": { S: new Date().toISOString() },
              ":e": { S: err.message }
            }
          }));
        } catch (e2) {
          console.error(JSON.stringify({
            level: "ERROR",
            requestId,
            messageId,
            stage: "FAILED_STATUS_UPDATE_FAILED",
            error: e2.message
          }));
        }
      }

      // Mark only this message as failed; others in the batch can succeed
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    stage: "BATCH_DONE",
    failedCount: batchItemFailures.length
  }));

  // Partial batch response for SQS
  return { batchItemFailures };
};
