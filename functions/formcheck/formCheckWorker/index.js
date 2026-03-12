import { TextractClient, StartDocumentAnalysisCommand } from "@aws-sdk/client-textract";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/* ---------------- CONFIG ---------------- */

const REGION                 = process.env.AWS_REGION || "us-east-1";
const TABLE                  = process.env.FORM_CHECK_TABLE;
const TEXTRACT_SNS_TOPIC_ARN = process.env.TEXTRACT_SNS_TOPIC_ARN;
const TEXTRACT_SNS_ROLE_ARN  = process.env.TEXTRACT_SNS_ROLE_ARN;

if (!TABLE)                  throw new Error("FORM_CHECK_TABLE env var is not set");
if (!TEXTRACT_SNS_TOPIC_ARN) throw new Error("TEXTRACT_SNS_TOPIC_ARN env var is not set");
if (!TEXTRACT_SNS_ROLE_ARN)  throw new Error("TEXTRACT_SNS_ROLE_ARN env var is not set");

/* ---------------- CLIENTS ---------------- */

const textract = new TextractClient({ region: REGION });
const ddb      = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

/* ---------------- LOGGER ---------------- */

function log(level, message, meta = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta }));
}

/* ---------------- HELPERS ---------------- */

/**
 * Extract the jobId (FCHK#<uuid>) from the S3 key.
 * Key format: uploads/FormCheck/FCHK#<uuid>/<fileName>
 */
function extractJobId(key) {
  const parts = key.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].toLowerCase() === "formcheck") {
      return parts[i + 1] || null;
    }
  }
  return null;
}

/* ---------------- HANDLER ---------------- */

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  log("INFO", "FormCheckWorker invoked", { requestId, recordCount: event.Records?.length || 0 });

  for (const record of (event.Records || [])) {
    const bucket = record.s3?.bucket?.name;
    const rawKey = record.s3?.object?.key;
    const key    = rawKey ? decodeURIComponent(rawKey.replace(/\+/g, " ")) : "";

    if (!bucket || !key) {
      log("WARN", "Missing S3 info in record", { requestId });
      continue;
    }

    if (!key.toLowerCase().endsWith(".pdf")) {
      log("INFO", "Skipped non-PDF object", { requestId, key });
      continue;
    }

    const jobId = extractJobId(key);
    if (!jobId) {
      log("WARN", "Could not extract jobId from S3 key", { requestId, key });
      continue;
    }

    log("INFO", "Starting Textract document analysis (FORMS+TABLES)", { requestId, jobId, bucket, key });

    let textractJobId;
    try {
      const resp = await textract.send(new StartDocumentAnalysisCommand({
        DocumentLocation: {
          S3Object: { Bucket: bucket, Name: key }
        },
        FeatureTypes: ["FORMS", "TABLES"],
        NotificationChannel: {
          SNSTopicArn: TEXTRACT_SNS_TOPIC_ARN,
          RoleArn:     TEXTRACT_SNS_ROLE_ARN
        },
        // JobTag identifies this job back to our record when Textract notifies us
        JobTag: jobId.slice(0, 64)
      }));

      textractJobId = resp.JobId;
    } catch (err) {
      log("ERROR", "StartDocumentAnalysis failed", { requestId, jobId, error: err.message });
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { jobId },
        UpdateExpression: "SET #s = :failed, updatedAt = :u, errorReason = :e",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":u":      new Date().toISOString(),
          ":e":      `StartDocumentAnalysis failed: ${err.message}`
        }
      })).catch(() => {});
      continue;
    }

    // Update status to TEXTRACT_PROCESSING
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { jobId },
      UpdateExpression: "SET #s = :s, updatedAt = :u, textractJobId = :j",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "TEXTRACT_PROCESSING",
        ":u": new Date().toISOString(),
        ":j": textractJobId
      }
    }));

    log("INFO", "Textract analysis job started", { requestId, jobId, textractJobId });
  }

  return { ok: true, requestId };
};
