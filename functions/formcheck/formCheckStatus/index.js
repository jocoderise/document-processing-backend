import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

/* ---------------- CONFIG ---------------- */

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE  = process.env.FORM_CHECK_TABLE;

if (!TABLE) throw new Error("FORM_CHECK_TABLE env var is not set");

/* ---------------- CLIENTS ---------------- */

const dynamo = new DynamoDBClient({ region: REGION });

/* ---------------- CONSTANTS ---------------- */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*"
};

/* ---------------- HELPERS ---------------- */

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body)
});

function log(level, message, meta = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta }));
}

/* ---------------- HANDLER ---------------- */

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  log("INFO", "FormCheckStatus invoked", {
    requestId,
    pathParameters: event?.pathParameters,
    rawPath: event?.rawPath,
    resource: event?.resource,
    path: event?.path
  });

  try {
    const rawJobId = event?.pathParameters?.jobId;
    // API Gateway may pass URL-encoded values; decode just in case
    const jobId = rawJobId ? decodeURIComponent(rawJobId) : undefined;

    log("INFO", "Resolved jobId", { requestId, rawJobId, jobId });

    if (!jobId) {
      return jsonResponse(400, { error: "jobId path parameter is required" });
    }

    log("INFO", "DynamoDB lookup", { requestId, table: TABLE, jobId });

    const resp = await dynamo.send(new GetItemCommand({
      TableName: TABLE,
      Key: { jobId: { S: jobId } }
    }));

    log("INFO", "DynamoDB result", { requestId, found: !!resp.Item });

    if (!resp.Item) {
      return jsonResponse(404, { error: `Form check job not found: ${jobId}` });
    }

    const item = resp.Item;

    const record = {
      jobId:         item.jobId?.S       ?? jobId,
      status:        item.status?.S      ?? "UNKNOWN",
      fileName:      item.fileName?.S,
      createdAt:     item.createdAt?.S,
      updatedAt:     item.updatedAt?.S,
      completedAt:   item.completedAt?.S,
      textractJobId: item.textractJobId?.S,
      errorReason:   item.errorReason?.S
    };

    // Parse and attach analysis result when job has completed
    if (item.analysisResult?.S) {
      try {
        record.result = JSON.parse(item.analysisResult.S);
      } catch {
        record.result = null;
      }
    }

    // Remove undefined/null fields to keep response clean
    for (const key of Object.keys(record)) {
      if (record[key] === undefined || record[key] === null) delete record[key];
    }

    log("INFO", "FormCheck status returned", { requestId, jobId, status: record.status });

    return jsonResponse(200, record);

  } catch (err) {
    log("ERROR", "FormCheckStatus failed", { requestId, error: err.message, stack: err.stack });
    return jsonResponse(500, { error: "Failed to retrieve form check status" });
  }
};
