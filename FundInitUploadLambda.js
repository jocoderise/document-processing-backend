import {
    S3Client,
    ListObjectsV2Command,
    CopyObjectCommand,
    DeleteObjectsCommand,
    PutObjectCommand
} from "@aws-sdk/client-s3";

import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/* ------------ CONFIG ------------ */

const REGION = process.env.AWS_REGION || "us-east-1";
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET;

if (!DOCUMENTS_BUCKET) throw new Error("DOCUMENTS_BUCKET required");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const DDB_TABLE_NAME = process.env.DDB_TABLE_NAME;
if (!DDB_TABLE_NAME) throw new Error("DDB_TABLE_NAME required");
const PRESIGN_EXPIRES = 900;

/* ------------ CLIENTS ------------ */

const s3 = new S3Client({ region: REGION });

/* ------------ CORS ------------ */

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Allow-Headers": "*"
};

/* ------------ LOG ------------ */

function log(level, message, meta = {}) {
    console.log(JSON.stringify({
        level,
        message,
        timestamp: new Date().toISOString(),
        ...meta
    }));
}

/* ------------ HELPERS ------------ */

function tsSafe() {
    return new Date().toISOString().replaceAll(":", "-");
}

async function prefixHasObjects(prefix) {
    const r = await s3.send(new ListObjectsV2Command({
        Bucket: DOCUMENTS_BUCKET,
        Prefix: prefix,
        MaxKeys: 1
    }));
    return (r.Contents || []).some(o => o?.Key && o.Size > 0);
}

async function listKeys(prefix) {
    const out = [];
    let token;

    do {
        const r = await s3.send(new ListObjectsV2Command({
            Bucket: DOCUMENTS_BUCKET,
            Prefix: prefix,
            ContinuationToken: token
        }));

        out.push(...(r.Contents || []).filter(o => o.Size > 0).map(o => o.Key));
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);

    return out;
}

async function archiveFiles(filesPrefix) {
    const keys = await listKeys(filesPrefix);
    if (!keys.length) return 0;

    const archivePrefix = `${filesPrefix.replace("/files/", "/archive/")}${tsSafe()}/`;

    for (const k of keys) {
        const dest = archivePrefix + k.substring(filesPrefix.length);
        await s3.send(new CopyObjectCommand({
            Bucket: DOCUMENTS_BUCKET,
            CopySource: `${DOCUMENTS_BUCKET}/${k}`,
            Key: dest
        }));
    }

    for (let i = 0; i < keys.length; i += 1000) {
        await s3.send(new DeleteObjectsCommand({
            Bucket: DOCUMENTS_BUCKET,
            Delete: {
                Objects: keys.slice(i, i + 1000).map(Key => ({ Key }))
            }
        }));
    }

    return keys.length;
}

async function putMarker(prefix) {
    await s3.send(new PutObjectCommand({
        Bucket: DOCUMENTS_BUCKET,
        Key: prefix,
        Body: ""
    }));
}
async function upsertFundRecord({ fundId, uploadPrefixKey, resultsPrefixKey }) {
    const nowIso = new Date().toISOString();

    const exprNames = { "#s": "status" };
    const exprValues = {
        ":status": "INITIATED",
        ":updatedAt": nowIso,
        ":createdAt": nowIso,
        ":uploadPrefix": `s3://${DOCUMENTS_BUCKET}/${uploadPrefixKey}`,
        ":resultPrefix": `s3://${DOCUMENTS_BUCKET}/${resultsPrefixKey}`,
        ":schemaPath": `s3://${DOCUMENTS_BUCKET}/RulesEngineJSONSchema.txt`
    };

    const sets = [
        "#s = :status",
        "updatedAt = :updatedAt",
        "uploadPrefix = :uploadPrefix",
        "resultPrefix = :resultPrefix",
        "schemaPath = :schemaPath",
        "createdAt = if_not_exists(createdAt, :createdAt)"
    ];

    // Optional TTL
    const ttlDays = process.env.RECORD_TTL_DAYS ? Number(process.env.RECORD_TTL_DAYS) : null;
    if (ttlDays && Number.isFinite(ttlDays) && ttlDays > 0) {
        const ttl = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
        exprValues[":ttl"] = ttl;
        sets.push("ttl = :ttl");
    }

    await ddb.send(new UpdateCommand({
        TableName: DDB_TABLE_NAME,
        Key: { fundId },
        UpdateExpression: "SET " + sets.join(", "),
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues
    }));

    return {
        fundId,
        status: "INITIATED",
        uploadPrefix: exprValues[":uploadPrefix"],
        resultPrefix: exprValues[":resultPrefix"]
    };
}

/* ------------ HANDLER ------------ */

export const handler = async (event, context) => {

    const requestId = context.awsRequestId;

    log("INFO", "Fund init called", {
        requestId,
        path: event?.path
    });

    try {

        const fundId = event?.pathParameters?.fundId;
        if (!fundId) {
            return {
                statusCode: 400,
                headers: CORS,
                body: JSON.stringify({ error: "fundId required" })
            };
        }

        const fundPrefix = `${fundId}/`;
        const filesPrefix = `${fundId}/files/`;
        const archivePrefix = `${fundId}/archive/`;
        const resultsPrefix = `${fundId}/results/`;

        log("INFO", "Resolved prefixes", {
            fundPrefix,
            filesPrefix
        });

        //
        // Create markers if first time
        //
        await putMarker(fundPrefix);
        await putMarker(filesPrefix);
        await putMarker(archivePrefix);
        await putMarker(resultsPrefix);

        //
        // Archive existing uploads
        //
        if (await prefixHasObjects(filesPrefix)) {
            const moved = await archiveFiles(filesPrefix);

            log("INFO", "Archived previous files", {
                requestId,
                fundId,
                moved
            });
        }
        const record = await upsertFundRecord({
            fundId,
            uploadPrefixKey: `${fundId}/files/`,
            resultsPrefixKey: `${fundId}/results/`
        });

        log("INFO", "DynamoDB upsert complete", {
            requestId,
            fundId,
            status: record.status,
            uploadPrefix: record.uploadPrefix,
            resultPrefix: record.resultPrefix
        });

        //
        // Create presigned POST allowing uploads to fundId/files/*
        //
        const presigned = await createPresignedPost(s3, {
            Bucket: DOCUMENTS_BUCKET,
            Key: `${filesPrefix}\${filename}`,
            Conditions: [
                ["starts-with", "$key", filesPrefix]
            ],
            Expires: PRESIGN_EXPIRES
        });

        log("INFO", "Presigned POST created", { requestId, fundId });

        return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
                fundId,
                // uploadPrefix: `s3://${DOCUMENTS_BUCKET}/${filesPrefix}`,
                presignedPost: presigned
            })
        };

    } catch (err) {

        log("ERROR", "Init failed", {
            requestId,
            error: err.message
        });

        return {
            statusCode: 500,
            headers: CORS,
            body: JSON.stringify({ error: err.message })
        };
    }
};
