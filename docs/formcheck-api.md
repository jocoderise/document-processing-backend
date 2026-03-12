# FormCheck API — Dev Integration Guide

## How it works

1. Call the API to get a presigned upload URL
2. PUT the PDF to that URL
3. Everything else is async — the system processes and writes the final result to DynamoDB automatically
4. Your app reads from DynamoDB directly when needed

---

## Step 1 — Get an upload URL

**Current API base URL:** `https://qtr7viace9.execute-api.us-east-1.amazonaws.com/dev`
POST {ApiEndpoint}/formcheck/init?fileName=my-document.pdf
```
POST https://qtr7viace9.execute-api.us-east-1.amazonaws.com/dev/formcheck/init?fileName=my-document.pdf
```

**Response:**
```json
{
  "jobId":     "FCHK-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "uploadUrl": "https://s3.amazonaws.com/...",
  "expiresIn": 900
}
```

Store the `jobId` against whatever record you are processing (loan application, investor onboarding, etc).

---

## Step 2 — Upload the PDF

```
PUT {uploadUrl}
Content-Type: application/pdf

<raw PDF bytes>
```

No auth needed — presigned URL handles it. Expires in 15 minutes.

---

## Step 3 — Read results from DynamoDB

**Table:** CloudFormation output `FormCheckTableName`
**Primary key:** `jobId` (string, e.g. `FCHK-xxxxxxxx-...`)

Query whenever your app needs the result. The record is always there from the moment the job is created.

**Key fields:**

| Field | Type | Description |
|---|---|---|
| `jobId` | String | Primary key |
| `status` | String | `UPLOADING` → `TEXTRACT_PROCESSING` → `ANALYZING` → `SUCCEEDED` or `FAILED` |
| `fileName` | String | Original filename |
| `createdAt` | String | ISO timestamp |
| `completedAt` | String | ISO timestamp — present when `SUCCEEDED` |
| `errorReason` | String | Present only when `FAILED` |
| `analysisResult` | String | JSON string — present when `SUCCEEDED`, parse it |

**Parsed `analysisResult`:**

```json
{
  "valid": false,
  "summary": "3 incomplete sections found, 1 item flagged for human review",
  "incompleteSections": [
    {
      "title": "Investor Signature",
      "type": "signature",
      "issue": "Signature field is blank",
      "page": 12,
      "items": [{ "label": "Investor Signature", "value": null }]
    }
  ],
  "uncertainItems": [
    {
      "title": "Bank Account Details",
      "reason": "May only be required if wire transfer was selected",
      "page": 8,
      "items": [{ "label": "Bank Name", "value": null }]
    }
  ]
}
```

- `valid: true` — no mandatory fields missing, document is complete
- `incompleteSections` — fields Bedrock is confident are missing required data
- `uncertainItems` — fields that may be incomplete, flag for human review
- `uncertainItems` does **not** affect `valid`

---

## Notes

- Processing takes ~30–120 seconds after upload depending on PDF size
- If `status` is `FAILED`, check `errorReason` — could be a bad PDF or Textract failure
- `analysisResult` is stored as a JSON **string** in DynamoDB — parse it before use
