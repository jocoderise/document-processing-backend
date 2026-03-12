import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/* ---------------- CONFIG ---------------- */

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE  = process.env.FORM_CHECK_TABLE;

if (!TABLE) throw new Error("FORM_CHECK_TABLE env var is not set");

/* ---------------- CLIENTS ---------------- */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

/* ---------------- LOGGER ---------------- */

function log(level, message, meta = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta }));
}

/* ---------------- HANDLER ---------------- */

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;

  // event.jobId comes from the Step Functions execution input
  // event.chunkResults is the output of the Map state: array of { incompleteSections: [] }
  const { jobId, chunkResults } = event;

  log("INFO", "FormCheckAggregator invoked", {
    requestId,
    jobId,
    chunkCount: chunkResults?.length ?? 0
  });

  // Merge all chunk results, deduplicating by section title
  const seenIncomplete = new Set();
  const seenUncertain  = new Set();
  const allIncompleteSections = [];
  const allUncertainItems     = [];

  for (const chunkResult of (chunkResults || [])) {
    for (const section of (chunkResult.incompleteSections || [])) {
      if (!seenIncomplete.has(section.title)) {
        seenIncomplete.add(section.title);
        allIncompleteSections.push(section);
      }
    }
    for (const item of (chunkResult.uncertainItems || [])) {
      if (!seenUncertain.has(item.title)) {
        seenUncertain.add(item.title);
        allUncertainItems.push(item);
      }
    }
  }

  const summaryParts = [];
  if (allIncompleteSections.length > 0) summaryParts.push(`${allIncompleteSections.length} incomplete sections found`);
  if (allUncertainItems.length > 0)     summaryParts.push(`${allUncertainItems.length} items flagged for human review`);

  const analysis = {
    valid:              allIncompleteSections.length === 0,
    incompleteSections: allIncompleteSections,
    uncertainItems:     allUncertainItems,
    summary:            summaryParts.length > 0 ? summaryParts.join(", ") : "Document is complete"
  };

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { jobId },
    UpdateExpression: "SET #s = :succeeded, updatedAt = :u, completedAt = :c, analysisResult = :r REMOVE errorReason",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: {
      ":succeeded": "SUCCEEDED",
      ":u":         new Date().toISOString(),
      ":c":         new Date().toISOString(),
      ":r":         JSON.stringify(analysis)
    }
  }));

  log("INFO", "FormCheck aggregation complete", {
    requestId,
    jobId,
    valid:              analysis.valid,
    incompleteSections: allIncompleteSections.length,
    uncertainItems:     allUncertainItems.length
  });

  return { jobId, status: "SUCCEEDED" };
};
