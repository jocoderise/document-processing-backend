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
- value: the field value (text string, boolean for individual checkboxes, or null if empty)
- type: "text", "checkbox", or "checkbox_group"
- page: the page number this field appears on
- For checkbox_group fields: "anySelected" is true if ANY option in the group is checked; "options" lists all individual choices with their selected state

Your task is to identify GENUINELY INCOMPLETE sections — fields or groups that a respondent was REQUIRED to fill in but LEFT BLANK.

═══ CRITICAL RULES — read carefully ═══

RULE 1 — CONDITIONAL FIELDS (most common false-positive source):
If a field label starts with or contains phrases like "If Yes,", "If No,", "If Case by Case,", "If applicable,", "If so,", "If checked,", or any similar conditional qualifier, you MUST check whether the triggering condition was actually met before flagging it.
- Look at the nearby field that the condition depends on (e.g. "Has the fund ever had a default? Yes / No").
- You will also receive a "filledFields" reference list showing all non-empty fields across the ENTIRE document — use this to check parent answers even if they appear on different pages.
- If the parent answer does NOT trigger the condition, the conditional follow-up field is NOT incomplete — do NOT flag it.
- If you cannot determine the parent answer from either the chunk data or the filledFields list, do NOT flag the conditional field.

RULE 2 — CHECKBOX GROUPS:
For "checkbox_group" type: the group is ONLY incomplete if "anySelected" is false.
For individual "checkbox" type: a group is ONLY incomplete when ZERO checkboxes in the group are selected (value: true).
- If even ONE checkbox in the group has value: true or anySelected is true, the entire group is COMPLETE — do NOT flag it.
- Do not flag individual unchecked options within a group where another option is already selected.

RULE 3 — ANSWERED FIELDS:
A field with any non-null, non-empty value is COMPLETE, regardless of what the value says ("Confirmed", "Extensive", "N/A", "X", any text string, or true).
- Do NOT flag a field just because its value seems short or unusual — if it has a value, it was answered.

RULE 4 — LOW-CONFIDENCE FIELDS:
Some fields carry a "lowConfidence: true" flag, meaning Textract was uncertain about the field label itself (OCR confidence between 40–70%).
- If a lowConfidence field has a non-null value, treat it as COMPLETE (Rule 3 still applies).
- If a lowConfidence field has a null value, place it in "uncertainItems" (NOT incompleteSections) — the label may be misread noise rather than a genuine required field.

RULE 5 — OPTIONAL FIELDS:
Not every blank field is required. Only flag fields that are clearly mandatory for ALL respondents.
- Common optional fields: "Additional comments", "Other (please specify)", "Notes", supplementary details that only apply to some respondents.
- When in doubt, do NOT flag — it is better to miss a genuinely blank required field than to report a false positive.

RULE 6 — SIGNATURES / DATES:
Signature, initials, and date fields are required only where they are the primary signature line for the document (not witness or notary lines that may be optional). Only flag if the value is clearly null/empty.

RULE 7 — QUESTION-NUMBER PREFIXED LABELS:
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

/* ---------------- BEDROCK HELPERS ---------------- */

function parseBedrockJson(rawText, label) {
  const jsonText = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error(`Bedrock returned non-JSON for ${label}: ${rawText.slice(0, 300)}`);
  }
}

/* ---------------- FIRST-PASS: full chunk analysis ---------------- */

async function analyzeChunkWithBedrock(chunkFields, filledSummary, startPage, endPage, totalFields, requestId) {
  // Fix 6: include a compact reference list of ALL filled fields in the document
  // so the LLM can resolve conditional field parents even if they're on different pages.
  const filledRef = filledSummary.length > 0
    ? `\n\nFILLED FIELDS REFERENCE (non-empty fields from the entire document — use to resolve conditional parents):\n${JSON.stringify(filledSummary, null, 2)}`
    : "";

  const userPrompt = `Analyzing pages ${startPage}–${endPage} of a ${totalFields}-field form.\nThe following ${chunkFields.length} fields appear on these pages. Fields with a null value or value: false are potentially empty — identify ONLY the genuinely incomplete required sections in this page range:\n\n${JSON.stringify(chunkFields, null, 2)}${filledRef}\n\nIMPORTANT: Your entire response must be a single valid JSON object starting with { — no explanation, no markdown, no preamble before or after the JSON.`;

  const resp = await bedrock.send(new ConverseCommand({
    modelId: MODEL_ID,
    system:  [{ text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [{ text: userPrompt }] }],
    inferenceConfig: { maxTokens: 16384, temperature: 0 }
  }));

  const rawText = (resp.output?.message?.content?.[0]?.text || "").trim();
  log("INFO", "Bedrock first-pass response", { requestId, startPage, endPage, outputChars: rawText.length });
  return parseBedrockJson(rawText, `pages ${startPage}-${endPage} first pass`);
}

/* ---------------- SECOND-PASS: verification of flagged items ---------------- */

// Fix 4: Run a targeted second Bedrock call to verify each flagged incomplete section.
// Only items both passes agree on are returned as incompleteSections.
// Items the second pass demotes are moved to uncertainItems.
async function verifyWithBedrock(flaggedSections, chunkFields, filledSummary, startPage, endPage, requestId) {
  if (flaggedSections.length === 0) return { confirmed: [], demoted: [] };

  const filledRef = filledSummary.length > 0
    ? `\n\nFILLED FIELDS REFERENCE (entire document):\n${JSON.stringify(filledSummary, null, 2)}`
    : "";

  const verifyPrompt = `You are a strict quality-control reviewer. A first analysis pass flagged the following sections as incomplete. Your job is to CHALLENGE each flag and only confirm those you are HIGHLY CONFIDENT are genuinely required and blank.

For each flagged section, ask yourself:
1. Is this field truly required for ALL respondents, or only conditionally required?
2. Could the field have been answered elsewhere in the document or via a checkbox that was already selected?
3. Is the blank intentional (e.g. "N/A" situation, optional field, non-applicable section)?

Be SKEPTICAL. If you have any doubt, move the section to "uncertainItems" rather than confirming it.

FLAGGED SECTIONS TO VERIFY:
${JSON.stringify(flaggedSections, null, 2)}

ALL FIELDS ON THESE PAGES (for context):
${JSON.stringify(chunkFields, null, 2)}${filledRef}

Return ONLY a valid JSON object:
{
  "confirmedIncomplete": [ /* sections you are HIGHLY CONFIDENT are genuinely required and blank */ ],
  "uncertain": [ /* sections you are not fully confident about — add a "reason" field explaining your doubt */ ]
}

Each item in confirmedIncomplete keeps its original structure. Each item in uncertain adds: "reason": "explanation".
IMPORTANT: Your entire response must be a single valid JSON object starting with { — no markdown, no preamble.`;

  const resp = await bedrock.send(new ConverseCommand({
    modelId: MODEL_ID,
    system:  [{ text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [{ text: verifyPrompt }] }],
    inferenceConfig: { maxTokens: 8192, temperature: 0 }
  }));

  const rawText = (resp.output?.message?.content?.[0]?.text || "").trim();
  log("INFO", "Bedrock second-pass response", { requestId, startPage, endPage, outputChars: rawText.length });

  const parsed = parseBedrockJson(rawText, `pages ${startPage}-${endPage} verification`);
  return {
    confirmed: parsed.confirmedIncomplete || [],
    demoted:   parsed.uncertain           || []
  };
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

  // Fix 6: Build a compact filled-fields reference from the ENTIRE document.
  // The LLM uses this to resolve conditional field parents that may be on other pages.
  // Cap at 200 entries and truncate values to keep prompt size manageable.
  const filledSummary = allFields
    .filter(f => f.value !== null && f.value !== false && f.value !== "")
    .slice(0, 200)
    .map(f => ({
      key:   f.key,
      value: typeof f.value === "string" ? f.value.slice(0, 80) : f.value,
      page:  f.page
    }));

  log("INFO", "Chunk fields filtered", {
    requestId, jobId, startPage, endPage,
    fieldCount:       chunkFields.length,
    filledSummaryLen: filledSummary.length
  });

  if (chunkFields.length === 0) {
    log("INFO", "No fields in chunk — skipping Bedrock", { requestId, jobId, startPage, endPage });
    return { incompleteSections: [], uncertainItems: [] };
  }

  // Fix 6 applied: pass filledSummary so the LLM can resolve cross-chunk conditionals
  const firstPass = await analyzeChunkWithBedrock(chunkFields, filledSummary, startPage, endPage, totalFields, requestId);

  const firstPassIncomplete = firstPass.incompleteSections || [];
  const firstPassUncertain  = firstPass.uncertainItems     || [];

  log("INFO", "First-pass complete", {
    requestId, jobId, startPage, endPage,
    incompleteSections: firstPassIncomplete.length,
    uncertainItems:     firstPassUncertain.length
  });

  // Fix 4: Run a second verification pass on anything flagged as incomplete.
  // Only keep items both passes agree on; demoted items move to uncertainItems.
  let incompleteSections = firstPassIncomplete;
  let uncertainItems     = firstPassUncertain;

  if (firstPassIncomplete.length > 0) {
    const { confirmed, demoted } = await verifyWithBedrock(
      firstPassIncomplete, chunkFields, filledSummary, startPage, endPage, requestId
    );

    incompleteSections = confirmed;
    // Merge first-pass uncertain items with items demoted by the second pass
    uncertainItems = [
      ...firstPassUncertain,
      ...demoted.map(d => ({
        title:  d.title,
        reason: d.reason || "Flagged as incomplete by first pass but could not be confirmed",
        page:   d.page,
        items:  d.items || []
      }))
    ];

    log("INFO", "Second-pass verification complete", {
      requestId, jobId, startPage, endPage,
      confirmedIncomplete: confirmed.length,
      demotedToUncertain:  demoted.length
    });
  }

  return { incompleteSections, uncertainItems };
};
