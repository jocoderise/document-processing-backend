import {
  TextractClient,
  GetDocumentAnalysisCommand
} from "@aws-sdk/client-textract";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

/* ---------------- CONFIG ---------------- */

const REGION   = process.env.AWS_REGION || "us-east-1";
const TABLE    = process.env.FORM_CHECK_TABLE;
const BUCKET   = process.env.FORM_CHECK_BUCKET;
const SFN_ARN  = process.env.FORM_CHECK_SFN_ARN;

if (!TABLE)   throw new Error("FORM_CHECK_TABLE env var is not set");
if (!BUCKET)  throw new Error("FORM_CHECK_BUCKET env var is not set");
if (!SFN_ARN) throw new Error("FORM_CHECK_SFN_ARN env var is not set");

/* ---------------- CLIENTS ---------------- */

const textract = new TextractClient({ region: REGION });
const ddb      = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3       = new S3Client({ region: REGION });
const sfn      = new SFNClient({ region: REGION });

/* ---------------- CONSTANTS ---------------- */

const PAGES_PER_CHUNK = 5;

/* ---------------- LOGGER ---------------- */

function log(level, message, meta = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta }));
}

/* ---------------- TEXTRACT HELPERS ---------------- */

/**
 * Paginate GetDocumentAnalysis to collect all blocks.
 * Raises if the job did not SUCCEED.
 */
async function getAllBlocks(textractJobId, requestId) {
  const blocks = [];
  let nextToken;
  let page = 0;

  do {
    page++;
    const params = { JobId: textractJobId };
    if (nextToken) params.NextToken = nextToken;

    const resp = await textract.send(new GetDocumentAnalysisCommand(params));

    if (resp.JobStatus === "FAILED") {
      throw new Error(`Textract job FAILED: ${resp.StatusMessage || "no status message"}`);
    }
    if (resp.JobStatus !== "SUCCEEDED") {
      throw new Error(`Unexpected Textract job status: ${resp.JobStatus}`);
    }

    blocks.push(...(resp.Blocks || []));
    nextToken = resp.NextToken;

    log("INFO", `Fetched Textract page ${page}`, {
      requestId, textractJobId,
      pageBlocks: resp.Blocks?.length || 0,
      hasMore: !!nextToken
    });
  } while (nextToken);

  return blocks;
}

/**
 * Get concatenated word text from a block's CHILD relationships.
 */
function getBlockText(block, byId) {
  const childRel = (block.Relationships || []).find(r => r.Type === "CHILD");
  if (!childRel) return (block.Text || "").trim();
  return (childRel.Ids || [])
    .map(id => byId[id])
    .filter(b => b?.BlockType === "WORD")
    .map(b => b.Text || "")
    .join(" ")
    .trim();
}

/**
 * Returns true if a KEY block's row overlaps vertically with any SELECTION_ELEMENT
 * on the same page.  These KEY blocks are section-header labels (e.g. "Jurisdiction",
 * "Domicile State or Country") that Textract surfaces as null text fields — they are
 * NOT genuine empty fill-in fields and should be excluded from the field list.
 */
function isSectionHeaderLabel(keyBlock, selectionRowsByPage) {
  const bb  = keyBlock.Geometry?.BoundingBox;
  const page = keyBlock.Page ?? 1;
  const rows = selectionRowsByPage[page];
  if (!bb || !rows?.length) return false;

  const top    = bb.Top;
  const bottom = bb.Top + bb.Height;
  // Strict vertical overlap: the KEY row and a SELECTION_ELEMENT row must share
  // at least one pixel of vertical space on the page.
  return rows.some(r => r.top < bottom && r.bottom > top);
}

/**
 * Build a flat list of form fields from KEY_VALUE_SET and SELECTION_ELEMENT blocks.
 * Returns: [{ key, value, type, page }]
 *   type = "checkbox"   → value is boolean (true = selected)
 *   type = "text"       → value is string or null (null = empty)
 *   page                → 1-based page number from Textract
 */
function buildFormFields(blocks) {
  const byId = Object.fromEntries(blocks.map(b => [b.Id, b]));

  // Pre-compute SELECTION_ELEMENT Y-ranges per page so we can detect section-header
  // KEY blocks (e.g. "Jurisdiction", "Domicile State or Country") that share their
  // row with checkboxes but have no text value of their own.
  const selectionRowsByPage = {};
  for (const block of blocks) {
    if (block.BlockType !== "SELECTION_ELEMENT") continue;
    const page = block.Page ?? 1;
    const bb   = block.Geometry?.BoundingBox;
    if (!bb) continue;
    if (!selectionRowsByPage[page]) selectionRowsByPage[page] = [];
    selectionRowsByPage[page].push({ top: bb.Top, bottom: bb.Top + bb.Height });
  }

  const fields = [];

  for (const block of blocks) {
    if (block.BlockType !== "KEY_VALUE_SET") continue;
    if (!block.EntityTypes?.includes("KEY")) continue;

    const keyText = getBlockText(block, byId);
    if (!keyText) continue;

    const page = block.Page ?? 1;

    const valueRel = (block.Relationships || []).find(r => r.Type === "VALUE");
    if (!valueRel?.Ids?.length) {
      // Key with no value block — skip if it looks like a section header label
      if (!isSectionHeaderLabel(block, selectionRowsByPage)) {
        fields.push({ key: keyText, value: null, type: "text", page });
      }
      continue;
    }

    for (const valueId of valueRel.Ids) {
      const valueBlock = byId[valueId];
      if (!valueBlock) continue;

      const childRel = (valueBlock.Relationships || []).find(r => r.Type === "CHILD");
      if (childRel?.Ids?.length) {
        let hasSelection = false;
        for (const childId of childRel.Ids) {
          const child = byId[childId];
          if (child?.BlockType === "SELECTION_ELEMENT") {
            fields.push({
              key:   keyText,
              value: child.SelectionStatus === "SELECTED",
              type:  "checkbox",
              page
            });
            hasSelection = true;
          }
        }
        if (!hasSelection) {
          const valText = getBlockText(valueBlock, byId);
          // Null value + no selections: skip if this KEY row overlaps with checkboxes
          if (valText || !isSectionHeaderLabel(block, selectionRowsByPage)) {
            fields.push({ key: keyText, value: valText || null, type: "text", page });
          }
        }
      } else {
        const valText = getBlockText(valueBlock, byId);
        if (valText || !isSectionHeaderLabel(block, selectionRowsByPage)) {
          fields.push({ key: keyText, value: valText || null, type: "text", page });
        }
      }
    }
  }

  return fields;
}

/* ---------------- CHUNK RANGE BUILDER ---------------- */

/**
 * Given a list of form fields, build an array of { startPage, endPage } chunk descriptors.
 * Each chunk covers PAGES_PER_CHUNK pages. If the last page of a chunk has a sequential
 * neighbour page in the document, that page is included in the chunk so sections that
 * span the boundary are not split across two Bedrock calls.
 */
function buildChunkRanges(fields) {
  const byPage = {};
  for (const f of fields) {
    const p = f.page ?? 1;
    if (!byPage[p]) byPage[p] = true;
  }

  const pages   = Object.keys(byPage).map(Number).sort((a, b) => a - b);
  const maxPage = pages[pages.length - 1];

  const chunks = [];

  for (let i = 0; i < pages.length; i += PAGES_PER_CHUNK) {
    const chunkPages = pages.slice(i, i + PAGES_PER_CHUNK);
    const lastPage   = chunkPages[chunkPages.length - 1];

    // Include the next sequential page so boundary-spanning sections are seen in full
    const nextPage = lastPage + 1;
    if (nextPage <= maxPage && byPage[nextPage] && !chunkPages.includes(nextPage)) {
      chunkPages.push(nextPage);
    }

    chunks.push({
      startPage: chunkPages[0],
      endPage:   chunkPages[chunkPages.length - 1]
    });
  }

  return chunks;
}

/* ---------------- MESSAGE PROCESSOR ---------------- */

async function processOneMessage({ message, requestId }) {
  // SQS body is the raw SNS notification JSON
  const sns = typeof message.Message === "string" ? JSON.parse(message.Message) : message;

  const textractJobId = sns.JobId;
  const jobId         = sns.JobTag;   // We stored FCHK-<uuid> as JobTag
  const jobStatus     = sns.Status;

  if (!textractJobId || !jobId) {
    throw new Error(`Missing JobId or JobTag in SNS notification: ${JSON.stringify(sns)}`);
  }

  log("INFO", "Processing Textract completion notification", { requestId, jobId, textractJobId, jobStatus });

  if (jobStatus === "FAILED") {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { jobId },
      UpdateExpression: "SET #s = :failed, updatedAt = :u, errorReason = :e",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":failed": "FAILED",
        ":u":      new Date().toISOString(),
        ":e":      `Textract job failed: ${sns.StatusMessage || "no details"}`
      }
    }));
    return;
  }

  // Move to ANALYZING while we process
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { jobId },
    UpdateExpression: "SET #s = :s, updatedAt = :u",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":s": "ANALYZING",
      ":u": new Date().toISOString()
    }
  }));

  // Paginate and collect all Textract blocks
  log("INFO", "Fetching all Textract blocks", { requestId, jobId, textractJobId });
  const blocks = await getAllBlocks(textractJobId, requestId);
  log("INFO", "Textract blocks fetched", { requestId, jobId, totalBlocks: blocks.length });

  // Extract form fields from KEY_VALUE_SET + SELECTION_ELEMENT blocks
  const rawFields = buildFormFields(blocks);

  // Remove fields whose key is purely a number (e.g. "7", "11") — these are question
  // numbers that Textract picks up as standalone KEY blocks with no meaningful value.
  const fields = rawFields.filter(f => !/^\s*\d+\s*$/.test(f.key));

  log("INFO", "Form fields extracted", {
    requestId, jobId,
    rawFieldCount:     rawFields.length,
    filteredFieldCount: fields.length,
    numericKeysDropped: rawFields.length - fields.length
  });

  // Handle documents with no detected form fields
  if (fields.length === 0) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { jobId },
      UpdateExpression: "SET #s = :succeeded, updatedAt = :u, completedAt = :c, analysisResult = :r REMOVE errorReason",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":succeeded": "SUCCEEDED",
        ":u":         new Date().toISOString(),
        ":c":         new Date().toISOString(),
        ":r":         JSON.stringify({
          valid: true, incompleteSections: [], uncertainItems: [],
          summary: "No form fields detected"
        })
      }
    }));
    return;
  }

  // Write all fields to S3 so chunk analyzers can read them independently
  const fieldsS3Key = `formcheck-jobs/${jobId}/fields.json`;
  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         fieldsS3Key,
    Body:        JSON.stringify(fields),
    ContentType: "application/json"
  }));
  log("INFO", "Fields written to S3", { requestId, jobId, fieldsS3Key, fieldCount: fields.length });

  // Build chunk ranges (5 pages each, with boundary extension)
  const chunks = buildChunkRanges(fields);
  log("INFO", "Chunk ranges built", { requestId, jobId, chunkCount: chunks.length, chunks });

  // Start the Step Functions execution — Map state fans out to one ChunkAnalyzer per chunk
  const executionInput = JSON.stringify({
    jobId,
    fieldsS3Key,
    totalFields: fields.length,
    chunks
  });

  const sfnResp = await sfn.send(new StartExecutionCommand({
    stateMachineArn: SFN_ARN,
    name:            `${jobId}-${Date.now()}`,
    input:           executionInput
  }));

  log("INFO", "Step Functions execution started", {
    requestId, jobId,
    executionArn: sfnResp.executionArn,
    chunkCount:   chunks.length
  });
}

/* ---------------- SQS HANDLER ---------------- */

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  log("INFO", "FormCheckResultsWorker batch start", {
    requestId,
    recordCount: event.Records?.length || 0
  });

  const batchItemFailures = [];

  for (const record of (event.Records || [])) {
    const messageId = record.messageId;

    let message;
    try {
      message = JSON.parse(record.body || "{}");
    } catch (e) {
      log("ERROR", "Invalid SQS JSON", { requestId, messageId, error: e.message });
      batchItemFailures.push({ itemIdentifier: messageId });
      continue;
    }

    try {
      await processOneMessage({ message, requestId });
    } catch (err) {
      log("ERROR", "Message processing failed", {
        requestId, messageId,
        error: err.message,
        stack: err.stack
      });
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  log("INFO", "FormCheckResultsWorker batch done", {
    requestId,
    failedCount: batchItemFailures.length
  });

  return { batchItemFailures };
};
