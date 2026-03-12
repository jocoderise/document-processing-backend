import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

/* ---------------- CONFIG ---------------- */

const REGION   = process.env.AWS_REGION || "us-east-1";
const BUCKET   = process.env.FORM_CHECK_BUCKET;
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.nova-pro-v1:0";

if (!BUCKET) throw new Error("FORM_CHECK_BUCKET env var is not set");

/* ---------------- CLIENTS ---------------- */

const bedrock = new BedrockRuntimeClient({ region: REGION });
const s3      = new S3Client({ region: REGION });

/* ---------------- LOGGER ---------------- */

function log(level, message, meta = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta }));
}

/* ---------------- SYSTEM PROMPT ---------------- */

const SYSTEM_PROMPT = `You are a document compliance analyst reviewing form completeness.

You will receive a list of form fields extracted from a specific page range of a PDF document, each with:
- key: the field label
- value: the field value (text string, boolean for checkboxes, or null if empty)
- type: "text" or "checkbox"
- page: the page number this field appears on

Your task is to identify GENUINELY INCOMPLETE sections — fields or groups that a respondent was REQUIRED to fill in but LEFT BLANK.

═══ CRITICAL RULES — read carefully ═══

RULE 1 — CONDITIONAL FIELDS (most common false-positive source):
If a field label starts with or contains phrases like "If Yes,", "If No,", "If Case by Case,", "If applicable,", "If so,", "If checked,", or any similar conditional qualifier, you MUST check whether the triggering condition was actually met before flagging it.
- Look at the nearby field that the condition depends on (e.g. "Has the fund ever had a default? Yes / No").
- If the parent answer does NOT trigger the condition, the conditional follow-up field is NOT incomplete — do NOT flag it.
- If you cannot determine the parent answer from the data provided, do NOT flag the conditional field.

RULE 2 — CHECKBOX GROUPS:
A checkbox group is ONLY incomplete when ZERO checkboxes in the group are selected (value: true).
- If even ONE checkbox in the group has value: true, the entire group is COMPLETE — do NOT flag it.
- Do not flag individual unchecked options within a group where another option is already selected.

RULE 3 — ANSWERED FIELDS:
A field with any non-null, non-empty value is COMPLETE, regardless of what the value says ("Confirmed", "Extensive", "N/A", "X", any text string, or true).
- Do NOT flag a field just because its value seems short or unusual — if it has a value, it was answered.

RULE 4 — OPTIONAL FIELDS:
Not every blank field is required. Only flag fields that are clearly mandatory for ALL respondents.
- Common optional fields: "Additional comments", "Other (please specify)", "Notes", supplementary details that only apply to some respondents.
- When in doubt, do NOT flag — it is better to miss a genuinely blank required field than to report a false positive.

RULE 5 — SIGNATURES / DATES:
Signature, initials, and date fields are required only where they are the primary signature line for the document (not witness or notary lines that may be optional). Only flag if the value is clearly null/empty.

RULE 6 — QUESTION-NUMBER PREFIXED LABELS:
Some field keys start with a number followed by a space and a label (e.g. "2 Registered Name", "8 General Partner or Managing Member"). The number is just the question number — treat the rest of the text as the field label. Do NOT treat the number itself as part of the semantic meaning. Evaluate the field the same way you would if the number were not there.

═══ OUTPUT FORMAT ═══

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "valid": boolean,
  "incompleteSections": [
    {
      "title": "Section title or field group name",
      "type": "checkbox_group" | "required_field" | "signature",
      "issue": "Human-readable description of the problem",
      "page": number,
      "items": [
        { "label": "Field label", "selected": boolean | null, "value": string | null }
      ]
    }
  ],
  "uncertainItems": [
    {
      "title": "Section title or field label",
      "reason": "Why you are uncertain — e.g. conditional field where parent answer is ambiguous, field that may or may not be required depending on context",
      "page": number,
      "items": [
        { "label": "Field label", "selected": boolean | null, "value": string | null }
      ]
    }
  ],
  "summary": "Brief summary: N incomplete sections found, M items flagged for human review / all sections complete"
}

Additional output rules:
- "valid" is true only when incompleteSections is empty (uncertainItems do NOT affect validity)
- Set "page" to the page number of the first item in the section
- Limit "items" to at most 5 representative examples per section
- Do NOT include a completeSections array — only return incomplete and uncertain ones
- Use "uncertainItems" for anything you are not confident about: conditional follow-ups where the parent answer is unclear, fields that look required but may be context-dependent, ambiguous checkbox groups where it is hard to tell if a selection was expected
- This prompt is document-type agnostic — apply the same rules to any kind of form`;

/* ---------------- BEDROCK CALL ---------------- */

async function analyzeChunkWithBedrock(chunkFields, startPage, endPage, totalFields, requestId) {
  const userPrompt = `Analyzing pages ${startPage}–${endPage} of a ${totalFields}-field form.\nThe following ${chunkFields.length} fields on these pages are empty or unselected — identify ONLY the incomplete sections present in this page range:\n\n${JSON.stringify(chunkFields, null, 2)}\n\nReturn the JSON analysis.`;

  const resp = await bedrock.send(new ConverseCommand({
    modelId: MODEL_ID,
    system:  [{ text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [{ text: userPrompt }] }],
    inferenceConfig: { maxTokens: 5120, temperature: 0 }
  }));

  const rawText = (resp.output?.message?.content?.[0]?.text || "").trim();
  log("INFO", "Bedrock chunk response", { requestId, startPage, endPage, outputChars: rawText.length });

  const jsonText = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error(`Bedrock returned non-JSON for pages ${startPage}-${endPage}: ${rawText.slice(0, 300)}`);
  }
}

/* ---------------- HANDLER ---------------- */

export const handler = async (event, context) => {
  const requestId = context.awsRequestId;
  const { jobId, fieldsS3Key, startPage, endPage, totalFields } = event;

  log("INFO", "FormCheckChunkAnalyzer invoked", {
    requestId, jobId, fieldsS3Key, startPage, endPage, totalFields
  });

  // Read all fields from S3
  const s3Resp = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key:    fieldsS3Key
  }));
  const body      = await s3Resp.Body.transformToString();
  const allFields = JSON.parse(body);

  // Filter to this chunk's page range — send ALL fields (both filled and empty)
  // so Bedrock can see the full context of each section (e.g. a checkbox group
  // where one option IS selected should not be flagged as incomplete).
  const chunkFields = allFields
    .filter(f => f.page >= startPage && f.page <= endPage);

  log("INFO", "Chunk fields filtered", {
    requestId, jobId, startPage, endPage,
    fieldCount: chunkFields.length
  });

  if (chunkFields.length === 0) {
    log("INFO", "No fields in chunk — skipping Bedrock", { requestId, jobId, startPage, endPage });
    return { incompleteSections: [], uncertainItems: [] };
  }

  const result = await analyzeChunkWithBedrock(chunkFields, startPage, endPage, totalFields, requestId);

  log("INFO", "Chunk analysis complete", {
    requestId, jobId, startPage, endPage,
    incompleteSections: result.incompleteSections?.length ?? 0,
    uncertainItems:     result.uncertainItems?.length ?? 0
  });

  return {
    incompleteSections: result.incompleteSections || [],
    uncertainItems:     result.uncertainItems     || []
  };
};
