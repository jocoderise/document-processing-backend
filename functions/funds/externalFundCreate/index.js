import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const region = process.env.AWS_REGION;

const dynamo = new DynamoDBClient({ region });
const s3     = new S3Client({ region });

const TABLE                  = process.env.DDB_TABLE;
const BUCKET                 = process.env.DOC_BUCKET;
const PRESIGN_EXPIRES_SECONDS = parseInt(process.env.PRESIGN_EXPIRES_SECONDS || "900", 10);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*"
};

const jsonResponse = (statusCode, bodyObj) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj)
});

/**
 * ExternalFundCreateLambda
 *
 * POST /funds/register
 *
 * Called by a third-party system that manages fund IDs externally.
 * Unlike CreateFundUploadLambda (which generates an internal UUID),
 * this Lambda accepts the fund ID from the caller and stores it with
 * an EXT# prefix to distinguish it from internally generated IDs.
 *
 * Request body (JSON):
 *   {
 *     "fundId":   "string"  — required: the external fund identifier
 *     "fundName": "string"  — required: human-readable fund name
 *     "fileName": "string"  — optional: PDF filename (default: "memo.pdf")
 *   }
 *
 * Response 200:
 *   {
 *     "fundId":    "EXT#<externalFundId>",   — use this ID for subsequent API calls
 *     "uploadUrl": "https://...",             — presigned PUT URL (expires in 15 min)
 *     "fileName":  "...",
 *     "objectKey": "EXT#<id>/<fileName>"
 *   }
 *
 * Response 400: missing / invalid fields
 * Response 409: fund with this external ID already exists
 * Response 500: unexpected error
 *
 * After upload:
 *   POST /funds/{fundId}/extract  — synchronous Textract + Bedrock extraction
 *   OR wait for the SQS worker to pick it up via platform bucket S3 event (if configured).
 */
export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  console.log(JSON.stringify({
    level: "INFO",
    requestId,
    message: "ExternalFundCreateLambda invoked"
  }));

  try {
    if (!TABLE)  throw new Error("Missing env var DDB_TABLE");
    if (!BUCKET) throw new Error("Missing env var DOC_BUCKET");

    const body = JSON.parse(event.body || "{}");

    const externalFundId = typeof body.fundId === "string" ? body.fundId.trim() : "";
    if (!externalFundId) throw new Error("fundId is required");

    const fundName = typeof body.fundName === "string" ? body.fundName.trim() : "";
    if (!fundName) throw new Error("fundName is required");

    const fileName = (typeof body.fileName === "string" && body.fileName.trim())
      ? body.fileName.trim()
      : "memo.pdf";

    // EXT# prefix distinguishes externally provided IDs from internally generated INT# ones
    const fundId    = `EXT#${externalFundId}`;
    const objectKey = `${fundId}/${fileName}`;

    console.log(JSON.stringify({
      level: "INFO",
      requestId, fundId, fundName, fileName, objectKey,
      stage: "DDB_CREATE"
    }));

    // Create fund record — ConditionalExpression prevents overwriting an existing record.
    // Returns 409 if this external fund ID has already been registered.
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        fundId:    { S: fundId },
        fundName:  { S: fundName },
        status:    { S: "UPLOADING" },
        bucket:    { S: BUCKET },
        fileName:  { S: fileName },
        objectKey: { S: objectKey },
        source:    { S: "EXTERNAL_API" },
        createdAt: { S: new Date().toISOString() },
        updatedAt: { S: new Date().toISOString() }
      },
      ConditionExpression: "attribute_not_exists(fundId)"
    }));

    // Generate presigned PUT URL — external party uploads the PDF directly to S3
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         objectKey,
        ContentType: "application/pdf"
      }),
      { expiresIn: PRESIGN_EXPIRES_SECONDS }
    );

    console.log(JSON.stringify({
      level: "INFO",
      requestId, fundId,
      stage: "SUCCESS"
    }));

    return jsonResponse(200, {
      requestId,
      fundId,
      uploadUrl,
      fileName,
      objectKey
    });

  } catch (err) {
    const isConflict     = err.name === "ConditionalCheckFailedException";
    const isValidation   = /required|invalid/i.test(err.message);

    console.error(JSON.stringify({
      level: "ERROR",
      requestId,
      message: err.message,
      stack: err.stack
    }));

    if (isConflict) {
      return jsonResponse(409, {
        requestId,
        message: "A fund with this external ID already exists"
      });
    }

    return jsonResponse(isValidation ? 400 : 500, {
      requestId,
      message: err.message
    });
  }
};
