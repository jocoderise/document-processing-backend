import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";

import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";

import {
  DynamoDBClient
} from "@aws-sdk/client-dynamodb";

import {
  DynamoDBDocumentClient,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import {
  SQSClient,
  SendMessageCommand
} from "@aws-sdk/client-sqs";


/* ---------------- CONFIG ---------------- */

const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = process.env.NOVA_MODEL_ID || "amazon.nova-pro-v1:0";
const PROMPT_S3_URI = process.env.PROMPT_S3_URI;
const ddbClient = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const DDB_TABLE_NAME = process.env.DDB_TABLE_NAME;
if (!DDB_TABLE_NAME) {
  throw new Error("DDB_TABLE_NAME environment variable is not set");
}
const sqs = new SQSClient({ region: REGION });
const SUCCESS_QUEUE_URL = process.env.SUCCESS_QUEUE_URL;

if (!SUCCESS_QUEUE_URL) {
  throw new Error("SUCCESS_QUEUE_URL environment variable is not set");
}

/* ---------------- CLIENTS ---------------- */

const bedrock = new BedrockRuntimeClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const textract = new TextractClient({ region: REGION });

/* ---------------- LOGGER ---------------- */

function log(level, message, meta = {}) {
  console.log(JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta
  }));
}

/* ---------------- HELPERS ---------------- */

function parseS3Uri(uri) {
  // s3://bucket/key...
  const [, , bucket, ...keyParts] = uri.split("/");
  if (!bucket || keyParts.length === 0) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }
  return {
    bucket,
    key: keyParts.join("/")
  };
}

async function readS3Text(uri) {
  const { bucket, key } = parseS3Uri(uri);

  const resp = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );

  return await resp.Body.transformToString("utf-8");
}

async function updateFundStatus({
  fundId,
  status,
  resultPath,
  errorMessage
}) {
  const now = new Date().toISOString();

  const updateExp = [
    "#s = :s",
    "updatedAt = :u"
  ];

  const exprNames = {
    "#s": "status"
  };

  const exprValues = {
    ":s": status,
    ":u": now
  };

  if (resultPath) {
    updateExp.push("resultPath = :r");
    exprValues[":r"] = resultPath;
  }

  if (errorMessage) {
    updateExp.push("errorMessage = :e");
    exprValues[":e"] = errorMessage;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: DDB_TABLE_NAME,
      Key: { fundId },
      UpdateExpression: "SET " + updateExp.join(", "),
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues
    })
  );
}

async function sendSuccessMessage({
  fundId,
  inputFiles,
  outputFiles
}) {
  const payload = {
    fundId,
    inputFiles,
    outputFiles,
    status: "SUCCEEDED",
    timestamp: new Date().toISOString()
  };

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: SUCCESS_QUEUE_URL,
      MessageBody: JSON.stringify(payload)
    })
  );
}



/* ---------------- HANDLER ---------------- */

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;
  log("DEBUG", "Raw SQS event received", {
    requestId,
    records: event.Records?.map(r => ({
      messageId: r.messageId,
      body: r.body
    }))
  });
  const start = Date.now();

  if (!PROMPT_S3_URI) {
    throw new Error("PROMPT_S3_URI environment variable is not set");
  }

  log("INFO", "SQS invocation started", {
    requestId,
    recordCount: event.Records?.length
  });

  // Load prompt once per invocation (cached on warm starts)
  const prompt = await readS3Text(PROMPT_S3_URI);
  log("INFO", "Prompt loaded", {
    requestId,
    promptUri: PROMPT_S3_URI,
    promptLength: prompt.length
  });
  for (const record of event.Records || []) {
    const payload = JSON.parse(record.body || "{}");

    const {
      fundId,
      inputFiles,
      schemaPath,
      outputPath
    } = payload;

    if (
      !fundId ||
      !Array.isArray(inputFiles) ||
      inputFiles.length === 0 ||
      !schemaPath ||
      !outputPath
    ) {
      throw new Error("Invalid SQS payload");
    }

    log("INFO", "Processing fund", {
      requestId,
      fundId,
      inputFilesCount: inputFiles.length
    });

    /* ---------------- TEXTRACT — extract text from each PDF ---------------- */

    const extractedTexts = [];

    for (const fileUri of inputFiles) {
      const { bucket: srcBucket, key: srcKey } = parseS3Uri(fileUri);
      const fileName = srcKey.split("/").pop();

      log("INFO", "Loading PDF for Textract", { requestId, fundId, fileUri });

      const pdfObj = await s3.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
      const pdfBytes = Buffer.from(await pdfObj.Body.transformToByteArray());

      log("INFO", "Textract start", { requestId, fundId, fileName });

      const textractResult = await textract.send(new DetectDocumentTextCommand({
        Document: { Bytes: pdfBytes }
      }));

      const extracted = (textractResult.Blocks || [])
        .filter(b => b.BlockType === "LINE")
        .map(b => b.Text || "")
        .filter(t => t)
        .join("\n");

      log("INFO", "Textract done", {
        requestId,
        fundId,
        fileName,
        blockCount: textractResult.Blocks?.length || 0,
        textChars: extracted.length
      });

      extractedTexts.push(extracted);
    }

    /* ---------------- BEDROCK — send extracted text ---------------- */

    const schema = await readS3Text(schemaPath);

    const userPrompt = `
JSON Schema (must conform exactly):
${schema}

IMA document text to extract from:
${extractedTexts.join("\n\n---\n\n")}

${prompt}
`;

    log("INFO", "Sending to Bedrock", { requestId, fundId });

    const bedrockStart = Date.now();
    let resp;
    try {
      resp = await bedrock.send(new ConverseCommand({
        modelId: MODEL_ID,
        messages: [{ role: "user", content: [{ text: userPrompt }] }],
        inferenceConfig: { maxTokens: 6000, temperature: 0.1, topP: 0.9 }
      }));
    } catch (err) {
      log("ERROR", "Bedrock invocation failed", { requestId, fundId, error: err.message, stack: err.stack });
      throw err;
    }

    log("INFO", "Bedrock response received", { requestId, fundId, durationMs: Date.now() - bedrockStart });

    const finalOutput =
      resp?.output?.message?.content
        ?.filter(c => c?.text)
        .map(c => c.text)
        .join("\n\n") || "";

    log("INFO", "Bedrock processing complete", {
      requestId,
      fundId,
      length: finalOutput.length
    });

    /* ---------------- WRITE RESULT TO S3 ---------------- */

    const { bucket } = parseS3Uri(outputPath);
    const safeBaseName = (inputFiles[0]?.split("/").pop() || "document").replace(/\s+/g, "_");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outputKey = `${fundId}/ima/${safeBaseName}.${ts}.ima.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey,
        Body: finalOutput,
        ContentType: "application/json"
      })
    );

    log("INFO", "Final JSON written to S3", {
      requestId,
      fundId,
      location: `s3://${bucket}/${outputKey}`,
      durationMs: Date.now() - start
    });
    await updateFundStatus({
      fundId,
      status: "SUCCEEDED",
      resultPath: `s3://${bucket}/${outputKey}`
    });

    log("INFO", "DynamoDB status updated", {
      requestId,
      fundId,
      status: "SUCCEEDED"
    });
    const outputFilePath = `s3://${bucket}/${outputKey}`;

    await sendSuccessMessage({
      fundId,
      inputFiles,                // already full s3:// paths
      outputFiles: [outputFilePath]
    });

    log("INFO", "Success message sent to SQS", {
      requestId,
      fundId,
      inputFilesCount: inputFiles.length,
      outputFilesCount: 1
    });


  }


  return {
    ok: true,
    requestId
  };
};
