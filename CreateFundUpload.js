import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

const region = process.env.AWS_REGION;

const dynamo = new DynamoDBClient({ region });
const s3 = new S3Client({ region });

const TABLE = process.env.DDB_TABLE;
const BUCKET = process.env.DOC_BUCKET;
const PRESIGN_EXPIRES_SECONDS = parseInt(process.env.PRESIGN_EXPIRES_SECONDS || "900", 10);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*"
};

const jsonResponse = (statusCode, bodyObj) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj)
});

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;
  const start = Date.now();

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    message: "CreateFundUploadLambda invoked"
  }));

  try {
    if (!TABLE) throw new Error("Missing env var DDB_TABLE");
    if (!BUCKET) throw new Error("Missing env var DOC_BUCKET");

    const body = JSON.parse(event.body || "{}");

    const fundName = typeof body.fundName === "string" ? body.fundName.trim() : "";
    const fileName = (typeof body.fileName === "string" && body.fileName.trim())
      ? body.fileName.trim()
      : "memo.pdf";

    // Generate fundId here (because no fund exists before IC memo init. INT indicates internal. In the future when we recieve fund ids it will be EXT#fundid recieved)
    const fundId = `INT#${randomUUID()}`;
    const objectKey = `${fundId}/${fileName}`;

    console.log(JSON.stringify({
      level: "INFO",
      requestId,
      fundId,
      stage: "DDB_CREATE",
      fileName,
      objectKey
    }));

    // Create initial record (do NOT allow collisions)
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        fundId: { S: fundId },
        fundName: { S: fundName },
        status: { S: "UPLOADING" },
        bucket: { S: BUCKET },
        fileName: { S: fileName },
        objectKey: { S: objectKey },
        createdAt: { S: new Date().toISOString() },
        updatedAt: { S: new Date().toISOString() }
      },
      ConditionExpression: "attribute_not_exists(fundId)"
    }));

    console.log(JSON.stringify({
      level: "INFO",
      requestId,
      fundId,
      stage: "PRESIGN_START"
    }));

    // Presigned PUT URL (browser uploads directly)
    const putCmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: objectKey,
      ContentType: "application/pdf"
    });

    const uploadUrl = await getSignedUrl(s3, putCmd, {
      expiresIn: PRESIGN_EXPIRES_SECONDS
    });

    console.log(JSON.stringify({
      level: "INFO",
      requestId,
      fundId,
      stage: "SUCCESS",
      durationMs: Date.now() - start
    }));

    return jsonResponse(200, {
      requestId,
      fundId,
      uploadUrl,
      fileName,
      objectKey
    });

  } catch (err) {
    console.error(JSON.stringify({
      level: "ERROR",
      requestId,
      message: err.message,
      stack: err.stack
    }));

    return jsonResponse(500, {
      requestId,
      message: "Failed to initialize memo upload"
    });
  }
};
