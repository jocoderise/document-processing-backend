import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
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
const BUCKET = process.env.DOC_BUCKET;
const PROMPT_KEY = process.env.PROMPT_KEY;     // e.g. "icmemoextractionprompt.txt"
const SCHEMA_KEY = process.env.SCHEMA_KEY;     // e.g. "schema.json"
const MODEL_ID = process.env.BEDROCK_MODEL_ID; // e.g. "amazon.nova-pro-v1:0"

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

// Stream -> string helper
const streamToString = async (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;
  const start = Date.now();

  try {
    if (!TABLE) throw new Error("Missing env var DDB_TABLE");
    if (!BUCKET) throw new Error("Missing env var DOC_BUCKET");
    if (!PROMPT_KEY) throw new Error("Missing env var PROMPT_KEY");
    if (!SCHEMA_KEY) throw new Error("Missing env var SCHEMA_KEY");
    if (!MODEL_ID) throw new Error("Missing env var BEDROCK_MODEL_ID");

    const fundId = event.pathParameters?.fundId;
    if (!fundId) return jsonResponse(400, { requestId, message: "fundId path parameter required" });

    const body = JSON.parse(event.body || "{}");
    const fileName = (typeof body.fileName === "string" && body.fileName.trim())
      ? body.fileName.trim()
      : "";

    if (!fileName) return jsonResponse(400, { requestId, message: "fileName required in request body" });

    const objectKey = `${fundId}/${fileName}`;

    console.log(JSON.stringify({
      level: "INFO",
      requestId,
      fundId,
      objectKey,
      stage: "START"
    }));

    // Fetch fund record
    const fundRecord = await dynamo.send(new GetItemCommand({
      TableName: TABLE,
      Key: { fundId: { S: fundId } }
    }));

    if (!fundRecord.Item) {
      return jsonResponse(404, { requestId, message: "Fund not found" });
    }

    const currentStatus = fundRecord.Item.status?.S || "";

    // Idempotency / gating
    if (currentStatus === "PROCESSING") {
      return jsonResponse(409, { requestId, fundId, message: "Processing already in progress" });
    }

    if (currentStatus === "EXTRACTED" && fundRecord.Item.payload?.S) {
      // Return existing extracted payload (idempotent)
      return jsonResponse(200, {
        requestId,
        fundId,
        status: "EXTRACTED",
        extracted: JSON.parse(fundRecord.Item.payload.S)
      });
    }

    // Move to PROCESSING with conditional gate to avoid races
    console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "STATUS_TO_PROCESSING" }));

    await dynamo.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { fundId: { S: fundId } },
      UpdateExpression: "SET #s = :processing, updatedAt = :u, objectKey = :k, fileName = :f REMOVE errorReason",
      ConditionExpression: "attribute_not_exists(#s) OR #s IN (:uploading, :failed, :created)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":processing": { S: "PROCESSING" },
        ":uploading": { S: "UPLOADING" },
        ":failed": { S: "FAILED" },
        ":created": { S: "CREATED" },
        ":u": { S: new Date().toISOString() },
        ":k": { S: objectKey },
        ":f": { S: fileName }
      }
    }));

    // Confirm the object exists before paying Textract/Bedrock
    console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "S3_HEAD" }));

    await s3.send(new HeadObjectCommand({
      Bucket: BUCKET,
      Key: objectKey
    }));

    // Load prompt + schema from bucket root
    console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "LOAD_PROMPT_SCHEMA" }));

    const promptObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: PROMPT_KEY }));
    const schemaObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: SCHEMA_KEY }));

    const systemPrompt = await streamToString(promptObj.Body);
    const schemaJsonText = await streamToString(schemaObj.Body);

    let schema;
    try {
      schema = JSON.parse(schemaJsonText);
    } catch {
      throw new Error("Schema file in S3 is not valid JSON");
    }

    // Load PDF bytes
    console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "LOAD_PDF" }));

    const pdfObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: objectKey }));
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

    // Nova Converse
    console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "NOVA_START" }));

    const converse = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [
        {
          role: "user",
          content: [{ text: userPrompt }]
        }
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
      // Store failure reason, mark FAILED, return safe error
      await dynamo.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { fundId: { S: fundId } },
        UpdateExpression: "SET #s = :failed, updatedAt = :u, errorReason = :e",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": { S: "FAILED" },
          ":u": { S: new Date().toISOString() },
          ":e": { S: "Model output was not valid JSON" }
        }
      }));

      return jsonResponse(500, { requestId, fundId, message: "Extraction failed (invalid model JSON)" });
    }

    // AJV validate against schema
    console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "AJV_VALIDATE" }));

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    const valid = validate(extracted);
    if (!valid) {
      const errText = JSON.stringify(validate.errors || []);

      await dynamo.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: { fundId: { S: fundId } },
        UpdateExpression: "SET #s = :failed, updatedAt = :u, errorReason = :e",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":failed": { S: "FAILED" },
          ":u": { S: new Date().toISOString() },
          ":e": { S: `Schema validation failed: ${errText}` }
        }
      }));

      // 422 is a good signal for “output didn’t match schema”
      return jsonResponse(422, {
        requestId,
        fundId,
        message: "Extraction failed (schema validation)",
        validationErrors: validate.errors
      });
    }

    // Persist success (UpdateItem, no clobber)
    console.log(JSON.stringify({ level: "INFO", requestId, fundId, stage: "DDB_PERSIST_SUCCESS" }));

    await dynamo.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { fundId: { S: fundId } },
      UpdateExpression: "SET #s = :extracted, updatedAt = :u, extractedAt = :x, payload = :p REMOVE errorReason",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":extracted": { S: "EXTRACTED" },
        ":u": { S: new Date().toISOString() },
        ":x": { S: new Date().toISOString() },
        ":p": { S: JSON.stringify(extracted) }
      }
    }));

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
      status: "EXTRACTED",
      extracted
    });

  } catch (err) {
    console.error(JSON.stringify({
      level: "ERROR",
      requestId,
      message: err.message,
      stack: err.stack
    }));

    // Best-effort mark FAILED if we have fundId
    const fundId = event?.pathParameters?.fundId;
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
          message: "Failed to update FAILED status",
          error: e2.message
        }));
      }
    }

    return jsonResponse(500, {
      requestId,
      message: "IC memo extraction failed"
    });
  }
};
