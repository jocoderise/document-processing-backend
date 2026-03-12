import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

/* ---------------- CONFIG ---------------- */

const REGION               = process.env.AWS_REGION || "us-east-1";
const TABLE                = process.env.FORM_CHECK_TABLE;
const BUCKET               = process.env.FORM_CHECK_BUCKET;
const PRESIGN_EXPIRES      = parseInt(process.env.PRESIGN_EXPIRES_SECONDS || "900", 10);

if (!TABLE)  throw new Error("FORM_CHECK_TABLE env var is not set");
if (!BUCKET) throw new Error("FORM_CHECK_BUCKET env var is not set");

/* ---------------- CLIENTS ---------------- */

const dynamo = new DynamoDBClient({ region: REGION });
const s3     = new S3Client({ region: REGION });

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

  log("INFO", "FormCheckInit invoked", { requestId });

  try {
    const params   = event.queryStringParameters || {};
    const fileName = (params.fileName || "document.pdf").trim();

    const jobId     = `FCHK-${randomUUID()}`;
    const objectKey = `uploads/FormCheck/${jobId}/${fileName}`;
    const now       = new Date().toISOString();

    // Create job record in DynamoDB
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        jobId:     { S: jobId },
        status:    { S: "UPLOADING" },
        fileName:  { S: fileName },
        bucket:    { S: BUCKET },
        objectKey: { S: objectKey },
        createdAt: { S: now },
        updatedAt: { S: now }
      }
    }));

    log("INFO", "FormCheck record created", { requestId, jobId, status: "UPLOADING" });

    // Generate presigned PUT URL — client uploads PDF directly to S3
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         objectKey,
        ContentType: "application/pdf"
      }),
      { expiresIn: PRESIGN_EXPIRES }
    );

    log("INFO", "Presigned PUT URL generated", { requestId, jobId, expiresIn: PRESIGN_EXPIRES });

    return jsonResponse(200, {
      jobId,
      uploadUrl,
      objectKey,
      expiresIn: PRESIGN_EXPIRES
    });

  } catch (err) {
    log("ERROR", "FormCheckInit failed", { requestId, error: err.message, stack: err.stack });
    return jsonResponse(500, { error: "Failed to initialise form check" });
  }
};
