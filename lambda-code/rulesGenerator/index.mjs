import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";

import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";

/* ---------------- CONFIG ---------------- */

const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = process.env.NOVA_MODEL_ID || "amazon.nova-pro-v1:0";

const SCHEMA_KEY = "RulesEngineJSONSchema.txt"; // MUST exist at bucket root
const OUTPUT_PREFIX = "results/";

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

function isPdf(key = "") {
  return key.toLowerCase().endsWith(".pdf");
}

/* ---------------- S3 HELPERS ---------------- */

async function verifySchema(bucket) {
  await s3.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: SCHEMA_KEY
    })
  );
}

async function listAllPdfs(bucket, prefix, requestId) {
  const keys = [];
  let token;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token
      })
    );

    const batch =
      resp.Contents
        ?.filter(o => o.Size > 0 && isPdf(o.Key))
        .map(o => o.Key) || [];

    keys.push(...batch);

    token = resp.IsTruncated
      ? resp.NextContinuationToken
      : undefined;

    log("INFO", "Listed S3 page", {
      requestId,
      returned: batch.length,
      totalSoFar: keys.length
    });

  } while (token);

  return keys;
}

/* ---------------- HANDLER ---------------- */

export const handler = async (event, context) => {

  const requestId = context.awsRequestId;
  const start = Date.now();

  log("INFO", "Invocation started", { requestId });

  try {

    const { s3Bucket, s3Prefix, prompt } = event || {};

    if (!s3Bucket || !s3Prefix) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "s3Bucket and s3Prefix are required"
        })
      };
    }

    /* 1. VERIFY SCHEMA */

    log("INFO", "Verifying schema exists", {
      requestId,
      schema: SCHEMA_KEY
    });

    try {
      await verifySchema(s3Bucket);
    } catch {
      throw new Error(
        `Missing required schema: s3://${s3Bucket}/${SCHEMA_KEY}`
      );
    }

    /* 2. LIST PDF FILES */

    const pdfKeys = await listAllPdfs(
      s3Bucket,
      s3Prefix,
      requestId
    );

    if (!pdfKeys.length) {
      throw new Error("No PDF files found");
    }

    log("INFO", "PDFs discovered", {
      requestId,
      count: pdfKeys.length
    });

    /* 3. BUILD DOCUMENT MANIFEST */

    const docs = [
      {
        key: SCHEMA_KEY,
        name: "RulesEngineJSONSchema",
        format: "txt"
      },
      ...pdfKeys.map((k, idx) => ({
        key: k,
        name: `pdf_${idx + 1}`,
        format: "pdf"
      }))
    ];

    /* 4. BATCH (MAX 5 DOCS) */

    const batches = chunk(docs, 5);
    const outputs = [];

    for (let i = 0; i < batches.length; i++) {

      const batch = batches[i];

      log("INFO", "Calling Bedrock batch", {
        requestId,
        batch: i + 1,
        docs: batch.length
      });

      const documentBlocks = batch.map((d, idx) => ({
        document: {
          name: d.name, // already unique
          format: d.format,
          source: {
            s3Location: {
              uri: `s3://${s3Bucket}/${d.key}`
            }
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
              {
                text: prompt ||
                  "Process documents using schema rules."
              }
            ]
          }
        ],
        inferenceConfig: {
          maxTokens: 3000,
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

    /* 5. MERGE FINAL RESPONSE */

    const finalOutput =
      outputs.join("\n\n----------------\n\n");

    log("INFO", "FINAL_BEDROCK_RESPONSE", {
      requestId,
      length: finalOutput.length,
      preview: finalOutput.substring(0, 500)
    });

    /* 6. WRITE TO S3 */

    const outputKey =
      `${OUTPUT_PREFIX}${requestId}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: outputKey,
        Body: finalOutput,
        ContentType: "application/json"
      })
    );

    log("INFO", "Final JSON written to S3", {
      requestId,
      location: `s3://${s3Bucket}/${outputKey}`
    });

    /* 7. RETURN */

    return {
      statusCode: 200,
      body: JSON.stringify({
        requestId,
        inputFiles: pdfKeys.length,
        resultLocation:
          `s3://${s3Bucket}/${outputKey}`
      })
    };

  } catch (err) {

    log("ERROR", "Invocation failed", {
      requestId,
      error: err.message,
      stack: err.stack
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        requestId,
        error: err.message
      })
    };
  }
};
