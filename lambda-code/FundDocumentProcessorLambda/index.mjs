import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";

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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

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

function ensureTrailingSlash(key) {
  return key.endsWith("/") ? key : `${key}/`;
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

    /* ---------------- BUILD DOCUMENT MANIFEST ---------------- */

    const docs = [
      {
        name: "RulesEngineJSONSchema",
        format: "txt",
        uri: schemaPath
      },
      ...inputFiles.map((uri, idx) => ({
        name: `pdf_${idx + 1}`,
        format: "pdf",
        uri
      }))
    ];

    /* ---------------- BEDROCK BATCHING ---------------- */

    const batches = chunk(docs, 5);
    const outputs = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      log("INFO", "Calling Bedrock batch", {
        requestId,
        fundId,
        batch: i + 1,
        docs: batch.length
      });

      const documentBlocks = batch.map(d => ({
        document: {
          name: d.name,
          format: d.format,
          source: { s3Location: { uri: d.uri } }
        }
      }));

      const command = new ConverseCommand({
        modelId: MODEL_ID,
        messages: [
          {
            role: "user",
            content: [...documentBlocks, { text: prompt }]
          }
        ],
        inferenceConfig: {
          maxTokens: 6000,
          temperature: 0.1,
          topP: 0.9
        }
      });

      const bedrockStart = Date.now();

      let resp;
      try {
        log("INFO", "Sending request to Bedrock", {
          requestId,
          fundId,
          batch: i + 1
        });

        resp = await bedrock.send(command);

      } catch (err) {
        log("ERROR", "Bedrock invocation failed", {
          requestId,
          fundId,
          batch: i + 1,
          error: err.message,
          stack: err.stack
        });
        throw err;
      }

      log("INFO", "Bedrock response received", {
        requestId,
        fundId,
        batch: i + 1,
        durationMs: Date.now() - bedrockStart
      });

      const text =
        resp?.output?.message?.content
          ?.filter(c => c?.text)
          .map(c => c.text)
          .join("\n\n") || "";

      log("INFO", "Extracted Bedrock text", {
        requestId,
        fundId,
        batch: i + 1,
        textLength: text.length,
        preview: text.substring(0, 300)
      });

      outputs.push(text);
    }


    /* ---------------- MERGE FINAL RESPONSE ---------------- */

    const finalOutput = outputs.join("\n\n----------------\n\n");

    log("INFO", "Bedrock processing complete", {
      requestId,
      fundId,
      length: finalOutput.length
    });

    /* ---------------- WRITE RESULT TO S3 ---------------- */

    const { bucket, key } = parseS3Uri(outputPath);
    const outputKey = `${ensureTrailingSlash(key)}rules-engine.json`;

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
