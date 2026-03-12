import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

/* ---------------- CONFIG ---------------- */

const REGION                  = process.env.AWS_REGION || "us-east-1";
const TABLE                   = process.env.DDB_TABLE;
const BUCKET                  = process.env.DOC_BUCKET;
const PRESIGN_EXPIRES_SECONDS = parseInt(process.env.PRESIGN_EXPIRES_SECONDS || "900", 10);

if (!TABLE)  throw new Error("DDB_TABLE env var is not set");
if (!BUCKET) throw new Error("DOC_BUCKET env var is not set");

/* ---------------- CLIENTS ---------------- */

const dynamo = new DynamoDBClient({ region: REGION });
const s3     = new S3Client({ region: REGION });

/* ---------------- CONSTANTS ---------------- */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*"
};

// Must match KNOWN_DOC_TYPES in s3UploadTrigger and map to the folder name
// the trigger uses to detect document type from the S3 key path.
const DOC_TYPE_CONFIG = {
  icmemo: { folder: "ICMemo" },
  ima:    { folder: "IMA" }
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

/**
 * Resolve the internal fundId for an IMA upload.
 *
 * Rules:
 *   - If the caller passes back an INT#<uuid> (returned from a prior ICMemo upload)
 *     → use it as-is (IMA belongs to an internally created fund)
 *   - If the caller passes an EXT#<id> (already prefixed external ID)
 *     → use it as-is
 *   - Any other raw value
 *     → treat as an external fund ID and prefix with EXT#
 */
function resolveIMAFundId(rawFundId) {
  if (rawFundId.startsWith("INT#") || rawFundId.startsWith("EXT#")) {
    return rawFundId;
  }
  return `EXT#${rawFundId}`;
}

/* ---------------- HANDLER ---------------- */

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  log("INFO", "InitDocumentUpload invoked", { requestId });

  try {
    const params = event.queryStringParameters || {};

    // ── Validate inputs ──────────────────────────────────────────────────────

    const rawDocType = (params.documentType || "").trim().toLowerCase();
    if (!DOC_TYPE_CONFIG[rawDocType]) {
      return jsonResponse(400, {
        error: `documentType must be one of: ${Object.keys(DOC_TYPE_CONFIG).join(", ")}`
      });
    }

    const fundName = (params.fundName || "").trim();
    if (!fundName) {
      return jsonResponse(400, { error: "fundName is required" });
    }

    const fileName = (params.fileName || "document.pdf").trim();

    // ── Resolve fundId ───────────────────────────────────────────────────────

    let fundId;

    if (rawDocType === "icmemo") {
      // ICMemo always creates a brand-new internal fund
      fundId = `INT#${randomUUID()}`;
    } else {
      // IMA requires the caller to supply a fundId (from a prior ICMemo upload or external)
      const rawFundId = (params.fundId || "").trim();
      if (!rawFundId) {
        return jsonResponse(400, { error: "fundId is required for documentType=ima" });
      }
      fundId = resolveIMAFundId(rawFundId);
    }

    // ── Build S3 key ─────────────────────────────────────────────────────────
    //
    // Path convention that s3UploadTrigger.extractDocumentType() relies on:
    //   uploads/<DocTypeFolder>/<fundId>/<fileName>
    //
    // e.g. uploads/ICMemo/INT#abc-123/memo.pdf
    //      uploads/IMA/INT#abc-123/report.pdf

    const { folder } = DOC_TYPE_CONFIG[rawDocType];
    const objectKey  = `uploads/${folder}/${fundId}/${fileName}`;

    log("INFO", "Resolved upload target", { requestId, fundId, rawDocType, objectKey });

    // ── Create DDB record ────────────────────────────────────────────────────

    const now = new Date().toISOString();

    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        fundId:       { S: fundId },
        fundName:     { S: fundName },
        status:       { S: "UPLOADING" },
        documentType: { S: rawDocType },
        bucket:       { S: BUCKET },
        objectKey:    { S: objectKey },
        source:       { S: "REST_API" },
        createdAt:    { S: now },
        updatedAt:    { S: now }
      },
      // Prevent overwriting an existing record (e.g. duplicate IMA call with same INT# fundId)
      ConditionExpression: "attribute_not_exists(fundId)"
    }));

    log("INFO", "DDB record created", { requestId, fundId, status: "UPLOADING" });

    // ── Generate presigned PUT URL ───────────────────────────────────────────
    //
    // Metadata is signed into the URL so the client must send these headers
    // verbatim when performing the PUT. s3UploadTrigger reads them via HeadObject:
    //   x-amz-meta-fund-name  → used by all document types
    //   x-amz-meta-fund-id    → used by IMA (and any other non-ICMemo type)
    //     to look up the existing fund record in DDB

    const metadata = { "fund-name": fundName };
    if (rawDocType !== "icmemo") {
      metadata["fund-id"] = fundId;
    }

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         objectKey,
        ContentType: "application/pdf",
        Metadata:    metadata
      }),
      { expiresIn: PRESIGN_EXPIRES_SECONDS }
    );

    log("INFO", "Presigned PUT URL generated", { requestId, fundId, expiresIn: PRESIGN_EXPIRES_SECONDS });

    return jsonResponse(200, {
      fundId,
      uploadUrl,
      objectKey,
      documentType: rawDocType,
      expiresIn: PRESIGN_EXPIRES_SECONDS
    });

  } catch (err) {
    const isConflict = err.name === "ConditionalCheckFailedException";

    log("ERROR", isConflict ? "Fund record already exists" : "Unhandled error", {
      requestId,
      error: err.message,
      stack: err.stack
    });

    if (isConflict) {
      return jsonResponse(409, { error: "A record for this fundId already exists" });
    }

    return jsonResponse(500, { error: "Failed to initialise document upload" });
  }
};
