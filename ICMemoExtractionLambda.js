import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION;

const s3 = new S3Client({ region });
const textract = new TextractClient({ region });
const bedrock = new BedrockRuntimeClient({ region });
const dynamo = new DynamoDBClient({ region });

const DOC_BUCKET = process.env.DOC_BUCKET;
const PROMPT_KEY = process.env.PROMPT_KEY;
const SCHEMA_KEY = process.env.SCHEMA_KEY;
const MODEL_ID = process.env.BEDROCK_MODEL_ID;
const TABLE = process.env.DDB_TABLE;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*"
};

const streamToString = async (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", c => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;
  const start = Date.now();

  try {
    const fundId = event.pathParameters?.fundId;
    if (!fundId) throw new Error("fundId required");

    const body = JSON.parse(event.body || "{}");
    const fileName = body.fileName;

    if (!fileName) throw new Error("fileName required in request body");

    const pdfKey = `${fundId}/${fileName}`;

    console.log(JSON.stringify({
      level: "INFO",
      requestId,
      fundId,
      pdfKey,
      stage: "START"
    }));

    /* ---------- Confirm fund exists ---------- */

    const fundRecord = await dynamo.send(new GetItemCommand({
      TableName: TABLE,
      Key: {
        fundId: { S: fundId }
      }
    }));

    if (!fundRecord.Item) throw new Error("Fund not found");

    /* ---------- Load Prompt ---------- */

    const promptObj = await s3.send(new GetObjectCommand({
      Bucket: DOC_BUCKET,
      Key: PROMPT_KEY
    }));

    const systemPrompt = await streamToString(promptObj.Body);

    /* ---------- Load Schema ---------- */

    const schemaObj = await s3.send(new GetObjectCommand({
      Bucket: DOC_BUCKET,
      Key: SCHEMA_KEY
    }));

    const schemaJson = await streamToString(schemaObj.Body);

    /* ---------- Load PDF ---------- */

    const pdfObj = await s3.send(new GetObjectCommand({
      Bucket: DOC_BUCKET,
      Key: pdfKey
    }));

    const pdfBytes = Buffer.from(await pdfObj.Body.transformToByteArray());

    /* ---------- Textract ---------- */

    const textractResult = await textract.send(
      new DetectDocumentTextCommand({
        Document: { Bytes: pdfBytes }
      })
    );

    const memoText = textractResult.Blocks
      .filter(b => b.BlockType === "LINE")
      .map(b => b.Text)
      .join("\n");

    /* ---------- Nova ---------- */

    const userPrompt = `
JSON Schema (must conform exactly):
${schemaJson}

IC Memo text to extract from:
${memoText}

Now extract and return exactly one JSON object that conforms to the schema.
`;

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

    const rawJson = response.output?.message?.content?.[0]?.text;
    if (!rawJson) throw new Error("Empty model response");

    const extracted = JSON.parse(rawJson);

    /* ---------- Persist ---------- */

    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        fundId: { S: fundId },
        extractedAt: { S: new Date().toISOString() },
        payload: { S: JSON.stringify(extracted) }
      }
    }));

    console.log(JSON.stringify({
      level: "INFO",
      requestId,
      fundId,
      durationMs: Date.now() - start
    }));

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ fundId, extracted })
    };

  } catch (err) {
    console.error(JSON.stringify({
      level: "ERROR",
      requestId,
      message: err.message
    }));

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        requestId,
        message: "IC memo extraction failed"
      })
    };
  }
};
