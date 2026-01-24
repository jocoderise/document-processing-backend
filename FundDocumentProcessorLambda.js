import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";

/* ---------------- CONFIG ---------------- */

const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = process.env.NOVA_MODEL_ID || "amazon.nova-pro-v1:0";
const PROMPT_S3_URI = process.env.PROMPT_S3_URI;

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
          source: {
            s3Location: { uri: d.uri }
          }
        }
      }));

      const command = new ConverseCommand({
        modelId: MODEL_ID,
        messages: [
          {
            role: "user",
            content: [
              ...documentBlocks,
              { text: prompt }
            ]
          }
        ],
        inferenceConfig: {
          maxTokens: 6000,
          temperature: 0.1,
          topP: 0.9
        }
      });

      const resp = await bedrock.send(command);

      const text =
        resp?.output?.message?.content
          ?.filter(c => c?.text)
          .map(c => c.text)
          .join("\n\n") || "";

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
  }

  return {
    ok: true,
    requestId
  };
};
