import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import crypto from "crypto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*"
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const s3 = new S3Client({});

const log = (level, msg, data = {}) => {
  console.log(JSON.stringify({ level, msg, ...data }));
};

export const handler = async (event) => {
  const requestId = crypto.randomUUID();

  try {
    log("INFO", "FundUploadCompleteLambda invoked", {
      requestId,
      path: event.rawPath,
      method: event.requestContext?.http?.method
    });

    const fundId = event?.pathParameters?.fundId;

    if (!fundId) {
      log("WARN", "Missing fundId", { requestId });
      return response(400, { error: "Missing fundId" });
    }

    const { DYNAMODB_TABLE, BUCKET_NAME, SQS_QUEUE_URL } = process.env;

    if (!DYNAMODB_TABLE || !BUCKET_NAME || !SQS_QUEUE_URL) {
      log("ERROR", "Missing env vars", { requestId });
      return response(500, { error: "Server misconfiguration" });
    }

    // Verify fund exists
    const fund = await ddb.send(new GetCommand({
      TableName: DYNAMODB_TABLE,
      Key: { fundId }
    }));

    if (!fund.Item) {
      log("WARN", "Fund not found", { fundId, requestId });
      return response(404, { error: "Fund not found" });
    }

    // List uploaded files from S3
    const s3Prefix = `${fundId}/files/`;

    const objects = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: s3Prefix
    }));

    const files = (objects.Contents || []).filter(o => o.Size > 0);

    if (!files.length) {
      log("WARN", "No files found in S3", { fundId, s3Prefix, requestId });
      return response(400, { error: "No documents uploaded yet" });
    }

    log("INFO", "Files discovered", {
      fundId,
      count: files.length,
      requestId
    });

    const now = new Date().toISOString();

    const payload = {
      fundId,
      status: "UPLOADED",
      inputFiles: files.map(f => `s3://${BUCKET_NAME}/${f.Key}`),
      schemaPath: `s3://${BUCKET_NAME}/RulesEngineJSONSchema.txt`,
      resultPath: `s3://${BUCKET_NAME}/${fundId}/results/rules-engine.json`,
      updatedAt: now
    };

    // Update DynamoDB
    const update = await ddb.send(new UpdateCommand({
      TableName: DYNAMODB_TABLE,
      Key: { fundId },
      ConditionExpression: "attribute_exists(fundId)",
      UpdateExpression: `
        SET #s = :s,
            inputFiles = :i,
            schemaPath = :sc,
            resultPath = :r,
            updatedAt = :u
      `,
      ExpressionAttributeNames: {
        "#s": "status"
      },
      ExpressionAttributeValues: {
        ":s": "UPLOADED",
        ":i": payload.inputFiles,
        ":sc": payload.schemaPath,
        ":r": payload.resultPath,
        ":u": now
      },
      ReturnValues: "ALL_NEW"
    }));

    payload.createdAt = update.Attributes.createdAt;
    const sqsPayload = {
      fundId,
      inputFiles: payload.inputFiles,
      outputPath: `s3://${BUCKET_NAME}/${fundId}/results/`,
      schemaPath: payload.schemaPath
    };
    log("DEBUG", "Sending SQS payload", {
      requestId,
      sqsPayload
    });
    // Push to SQS
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: SQS_QUEUE_URL,
        MessageBody: JSON.stringify(sqsPayload)
      })
    );

    log("INFO", "Workflow advanced to UPLOADED", {
      fundId,
      requestId
    });

    return response(200, {
      fundId,
      uploadedFiles: files.map(f => f.Key.split("/").pop())
    });

  } catch (err) {
    log("ERROR", "Unhandled exception", {
      error: err.message,
      stack: err.stack
    });

    return response(500, { error: "Internal server error" });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body)
});
