import {
  TextractClient,
  StartDocumentTextDetectionCommand
} from "@aws-sdk/client-textract";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/* ---------------- CONFIG ---------------- */

const REGION                  = process.env.AWS_REGION || "us-east-1";
const DDB_TABLE               = process.env.DDB_TABLE;
const TEXTRACT_SNS_TOPIC_ARN  = process.env.TEXTRACT_SNS_TOPIC_ARN;
const TEXTRACT_SNS_ROLE_ARN   = process.env.TEXTRACT_SNS_ROLE_ARN;

if (!DDB_TABLE)              throw new Error("DDB_TABLE env var is not set");
if (!TEXTRACT_SNS_TOPIC_ARN) throw new Error("TEXTRACT_SNS_TOPIC_ARN env var is not set");
if (!TEXTRACT_SNS_ROLE_ARN)  throw new Error("TEXTRACT_SNS_ROLE_ARN env var is not set");

/* ---------------- CLIENTS ---------------- */

const textract = new TextractClient({ region: REGION });
const ddb      = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

/* ---------------- LOGGER ---------------- */

function log(level, message, meta = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta }));
}

/* ---------------- HANDLER ---------------- */

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  log("INFO", "Batch start", { requestId, recordCount: event.Records?.length || 0 });

  for (const record of (event.Records || [])) {
    const { fundId, documentType, bucket, key, fileName } = JSON.parse(record.body || "{}");

    if (!fundId || !documentType || !bucket || !key) {
      log("ERROR", "Invalid SQS payload — missing required fields", { requestId, body: record.body });
      throw new Error("Invalid SQS payload");
    }

    // JobTag: Textract allows only [a-zA-Z0-9_.\-:] — strip "INT#" prefix and use ":" separator
    // Format: "<uuid>:<documentType>"  e.g. "abc-123:fundstructure" = 55 chars max (within 64)
    const uuid   = fundId.replace(/^INT#/, "");
    const jobTag = `${uuid}:${documentType}`.slice(0, 64);

    log("INFO", "Starting async Textract job", { requestId, fundId, documentType, bucket, key, jobTag });

    let textractJobId;
    try {
      const resp = await textract.send(new StartDocumentTextDetectionCommand({
        DocumentLocation: {
          S3Object: { Bucket: bucket, Name: key }
        },
        NotificationChannel: {
          SNSTopicArn: TEXTRACT_SNS_TOPIC_ARN,
          RoleArn:     TEXTRACT_SNS_ROLE_ARN
        },
        JobTag: jobTag
      }));

      textractJobId = resp.JobId;
    } catch (err) {
      log("ERROR", "StartDocumentTextDetection failed", {
        requestId, fundId, documentType, error: err.message
      });
      // Mark FAILED in DDB and rethrow so SQS retries / sends to DLQ
      await ddb.send(new UpdateCommand({
        TableName: DDB_TABLE,
        Key: { fundId },
        UpdateExpression: "SET #s = :failed, updatedAt = :u, errorReason = :e",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": "FAILED",
          ":u":      new Date().toISOString(),
          ":e":      `StartDocumentTextDetection failed: ${err.message}`
        }
      })).catch(() => {});
      throw err;
    }

    log("INFO", "Textract job started", { requestId, fundId, documentType, textractJobId });

    // Update DynamoDB: TEXTRACT_PROCESSING + store jobId for traceability
    await ddb.send(new UpdateCommand({
      TableName: DDB_TABLE,
      Key: { fundId },
      UpdateExpression: "SET #s = :s, updatedAt = :u, textractJobId = :j",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "TEXTRACT_PROCESSING",
        ":u": new Date().toISOString(),
        ":j": textractJobId
      }
    }));

    log("INFO", "DynamoDB updated to TEXTRACT_PROCESSING", { requestId, fundId, textractJobId });
  }

  return { ok: true, requestId };
};
