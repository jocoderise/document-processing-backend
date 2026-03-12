import {
  TextractClient,
  GetDocumentTextDetectionCommand
} from "@aws-sdk/client-textract";

import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

/* ---------------- CONFIG ---------------- */

const REGION                    = process.env.AWS_REGION || "us-east-1";
const MODEL_ID                  = process.env.NOVA_MODEL_ID || "amazon.nova-pro-v1:0";
const ICMEMO_PROMPT_S3_URI      = process.env.ICMEMO_PROMPT_S3_URI;
const ICMEMO_SCHEMA_S3_URI      = process.env.ICMEMO_SCHEMA_S3_URI;
const RULES_ENGINE_PROMPT_S3_URI = process.env.RULES_ENGINE_PROMPT_S3_URI;
const RULES_ENGINE_SCHEMA_S3_URI = process.env.RULES_ENGINE_SCHEMA_S3_URI;
const DDB_TABLE                 = process.env.DDB_TABLE;
const SUCCESS_QUEUE_URL         = process.env.SUCCESS_QUEUE_URL;
const DOC_BUCKET                = process.env.DOC_BUCKET;

if (!ICMEMO_PROMPT_S3_URI)       throw new Error("ICMEMO_PROMPT_S3_URI env var is not set");
if (!ICMEMO_SCHEMA_S3_URI)       throw new Error("ICMEMO_SCHEMA_S3_URI env var is not set");
if (!RULES_ENGINE_PROMPT_S3_URI) throw new Error("RULES_ENGINE_PROMPT_S3_URI env var is not set");
if (!RULES_ENGINE_SCHEMA_S3_URI) throw new Error("RULES_ENGINE_SCHEMA_S3_URI env var is not set");
if (!DDB_TABLE)                  throw new Error("DDB_TABLE env var is not set");
if (!SUCCESS_QUEUE_URL)          throw new Error("SUCCESS_QUEUE_URL env var is not set");
if (!DOC_BUCKET)                 throw new Error("DOC_BUCKET env var is not set");

/* ---------------- CLIENTS ---------------- */

const textract = new TextractClient({ region: REGION });
const bedrock  = new BedrockRuntimeClient({ region: REGION });
const s3       = new S3Client({ region: REGION });
const ddb      = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sqsClient = new SQSClient({ region: REGION });

/* ---------------- LOGGER ---------------- */

function log(level, message, meta = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta }));
}

/* ---------------- HELPERS ---------------- */

async function readS3Text(uri) {
  const [, , bucket, ...keyParts] = uri.split("/");
  const key = keyParts.join("/");
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return resp.Body.transformToString("utf-8");
}

/**
 * Paginate GetDocumentTextDetection to collect all LINE blocks.
 * Large documents produce results split across multiple pages.
 */
async function extractTextFromJob(jobId, requestId) {
  const lines = [];
  let nextToken;
  let page = 0;

  do {
    const params = { JobId: jobId };
    if (nextToken) params.NextToken = nextToken;

    const resp = await textract.send(new GetDocumentTextDetectionCommand(params));

    if (resp.JobStatus === "FAILED") {
      throw new Error(`Textract job ${jobId} failed: ${resp.StatusMessage || "unknown reason"}`);
    }

    const pageLines = (resp.Blocks || [])
      .filter(b => b.BlockType === "LINE")
      .map(b => b.Text || "")
      .filter(t => t.trim());

    lines.push(...pageLines);
    nextToken = resp.NextToken;
    page++;

    log("DEBUG", "Textract page processed", {
      requestId, jobId, page, linesThisPage: pageLines.length, hasMore: !!nextToken
    });
  } while (nextToken);

  log("INFO", "Textract pagination complete", {
    requestId, jobId, totalPages: page, totalLines: lines.length
  });

  return lines.join("\n");
}

async function updateFundStatus({ fundId, status, resultPath, errorReason }) {
  const updateExp    = ["#s = :s", "updatedAt = :u"];
  const exprNames    = { "#s": "status" };
  const exprValues   = { ":s": status, ":u": new Date().toISOString() };

  if (resultPath) { updateExp.push("resultPath = :r");   exprValues[":r"] = resultPath; }
  if (errorReason){ updateExp.push("errorReason = :e");  exprValues[":e"] = errorReason; }

  await ddb.send(new UpdateCommand({
    TableName: DDB_TABLE,
    Key: { fundId },
    UpdateExpression: "SET " + updateExp.join(", "),
    ExpressionAttributeNames: exprNames,
    ExpressionAttributeValues: exprValues
  }));
}

/* ---------------- CORE PROCESSING ---------------- */

async function processRecord(record, requestId) {

  // 1. Double-parse SNS→SQS envelope
  const snsEnvelope  = JSON.parse(record.body);
  const notification = JSON.parse(snsEnvelope.Message);

  const { JobId, Status, JobTag, DocumentLocation } = notification;

  if (!JobId)  throw new Error("Missing JobId in Textract notification");
  if (!JobTag) throw new Error("Missing JobTag in Textract notification");

  // JobTag format: "<P>:<uuid>:<documentType>"  P=I(INT#) or E(EXT#)
  const firstColon = JobTag.indexOf(":");
  const lastColon  = JobTag.lastIndexOf(":");
  if (firstColon === -1 || firstColon === lastColon) throw new Error(`Invalid JobTag format: ${JobTag}`);

  const prefixChar   = JobTag.slice(0, firstColon);
  const uuid         = JobTag.slice(firstColon + 1, lastColon);
  const documentType = JobTag.slice(lastColon + 1);
  const fundId       = `${prefixChar === "I" ? "INT" : "EXT"}#${uuid}`;

  // Derive original filename from the S3 key in the notification
  const originalKey  = DocumentLocation?.S3ObjectName || "";
  const fileName     = originalKey.split("/").pop() || "document";
  const safeFileName = fileName.replace(/\s+/g, "_").replace(/[^\w.\-]/g, "");

  log("INFO", "Processing Textract completion", { requestId, fundId, documentType, JobId, Status });

  // 2. Handle terminal FAILED status — mark DDB, return (no retry)
  if (Status !== "SUCCEEDED") {
    log("ERROR", "Textract job did not succeed", { requestId, fundId, JobId, Status });
    await updateFundStatus({
      fundId,
      status: "FAILED",
      errorReason: `Textract job ${JobId} ended with status: ${Status}`
    });
    return;
  }

  // 3. Paginate Textract results
  log("INFO", "Fetching Textract results", { requestId, fundId, JobId });
  const extractedText = await extractTextFromJob(JobId, requestId);

  log("INFO", "Text extracted", { requestId, fundId, documentType, chars: extractedText.length });

  // 4. Load prompt + schema based on document type
  const isICMemo = documentType === "icmemo";
  const promptUri = isICMemo ? ICMEMO_PROMPT_S3_URI      : RULES_ENGINE_PROMPT_S3_URI;
  const schemaUri = isICMemo ? ICMEMO_SCHEMA_S3_URI       : RULES_ENGINE_SCHEMA_S3_URI;

  const [prompt, schema] = await Promise.all([
    readS3Text(promptUri),
    readS3Text(schemaUri)
  ]);

  // 5. Call Bedrock
  const userPrompt = `JSON Schema (must conform exactly):\n${schema}\n\nDocument text:\n${extractedText}\n\n${prompt}`;

  log("INFO", "Sending to Bedrock", { requestId, fundId, documentType });

  const bedrockStart = Date.now();
  const bedrockResp = await bedrock.send(new ConverseCommand({
    modelId: MODEL_ID,
    messages: [{ role: "user", content: [{ text: userPrompt }] }],
    inferenceConfig: { maxTokens: 6000, temperature: 0.1, topP: 0.9 }
  }));

  log("INFO", "Bedrock response received", { requestId, fundId, durationMs: Date.now() - bedrockStart });

  const finalOutput =
    bedrockResp?.output?.message?.content
      ?.filter(c => c?.text)
      .map(c => c.text)
      .join("\n\n") || "";

  // 6. Write result to S3
  // Pattern: <fundId>/<documentType>/<safeFilename>.<ts>.<documentType>.json
  const ts        = new Date().toISOString().replace(/[:.]/g, "-");
  const outputKey = `${fundId}/${documentType}/${safeFileName}.${ts}.${documentType}.json`;

  await s3.send(new PutObjectCommand({
    Bucket: DOC_BUCKET,
    Key:    outputKey,
    Body:   finalOutput,
    ContentType: "application/json"
  }));

  const resultPath = `s3://${DOC_BUCKET}/${outputKey}`;

  log("INFO", "Result written to S3", { requestId, fundId, documentType, resultPath });

  // 7. Update DynamoDB to SUCCEEDED
  await updateFundStatus({ fundId, status: "SUCCEEDED", resultPath });

  log("INFO", "DynamoDB updated to SUCCEEDED", { requestId, fundId });

  // 8. Send to SuccessQueue
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: SUCCESS_QUEUE_URL,
    MessageBody: JSON.stringify({
      fundId,
      documentType,
      status:      "SUCCEEDED",
      outputFiles: [resultPath],
      timestamp:   new Date().toISOString()
    })
  }));

  log("INFO", "SuccessQueue notification sent", { requestId, fundId });
}

/* ---------------- HANDLER ---------------- */

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  log("INFO", "Batch start", { requestId, recordCount: event.Records?.length || 0 });

  const batchItemFailures = [];

  for (const record of (event.Records || [])) {
    try {
      await processRecord(record, requestId);
    } catch (err) {
      log("ERROR", "Record processing failed", {
        requestId, messageId: record.messageId, error: err.message, stack: err.stack
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  log("INFO", "Batch complete", { requestId, failedCount: batchItemFailures.length });

  return { batchItemFailures };
};
