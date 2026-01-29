import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const s3 = new S3Client({});

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Allow-Headers": "*"
};

const dynamo = DynamoDBDocumentClient.from(
    new DynamoDBClient({})
);


export const handler = async (event, context) => {
    const FILE_SNIPPET_LEN = 100;
    const requestId = context.awsRequestId;



    const bucketName = process.env.DOCUMENTS_BUCKET;

    if (!bucketName) {
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "DOCUMENTS_BUCKET not configured" })
        };
    }

    const fundIdFromPath = event.pathParameters?.fundId;
    const body = JSON.parse(event.body || '{}');
    console.log(JSON.stringify({
        level: "DEBUG",
        stage: "RAW_EVENT_WITH_FILE_SNIPPET",
        requestId,
        pathParameters: event.pathParameters,
        headers: event.headers,
        bodyPreview: {
            fundId: body.fundId,
            documents: body.documents?.map(doc => ({
                fileName: doc.fileName,
                fileType: doc.fileType,
                contentType: doc.contentType,
                base64Length: doc.fileBase64?.length || 0,
                base64Snippet: doc.fileBase64
                    ? doc.fileBase64.substring(0, FILE_SNIPPET_LEN)
                    : null
            }))
        }
    }));
    const { fundId, documents } = body;
    const nowIso = new Date().toISOString();

    // example: keep records 7 days
    const ttlSeconds = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);

    console.log(JSON.stringify({
        level: "INFO",
        stage: "ENTRY",
        requestId,
        fundIdFromPath,
        documentCount: documents?.length
    }));

    if (!fundIdFromPath || fundIdFromPath !== fundId) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "fundId mismatch" })
        };
    }

    if (!Array.isArray(documents) || documents.length === 0) {
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "No documents provided" })
        };
    }

    // Decode once and prepare uploads
    const uploads = documents.map(doc => {
        const buffer = Buffer.from(doc.fileBase64, "base64");

        return {
            fileName: doc.fileName,
            fileType: doc.fileType,
            sizeBytes: buffer.length,
            upload: s3.send(
                new PutObjectCommand({
                    Bucket: bucketName,
                    Key: `${fundId}/files/${doc.fileName}`,
                    Body: buffer,
                    ContentType: doc.contentType,
                    Metadata: {
                        fileType: doc.fileType
                    }
                })
            )
        };
    });

    console.log(JSON.stringify({
        level: "INFO",
        stage: "UPLOAD_START",
        requestId,
        documents: uploads.map(u => ({
            fileName: u.fileName,
            fileType: u.fileType,
            sizeBytes: u.sizeBytes
        }))
    }));

    await Promise.all(uploads.map(u => u.upload));

    const tableName = process.env.DYNAMODB_TABLE;

    if (!tableName) {
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "DYNAMODB_TABLE not configured" })
        };
    }

    const item = {
        fundId,

        status: "UPLOADED",

        inputFiles: documents.map(doc =>
            `s3://${bucketName}/${fundId}/files/${doc.fileName}`
        ),
        schemaPath: `s3://${bucketName}/RulesEngineJSONSchema.txt`,
        resultPath: `s3://${bucketName}/${fundId}/results/rules-engine.json`,

        createdAt: nowIso,
        updatedAt: nowIso,

        // ttl: ttlSeconds
    };
    await dynamo.send(
        new PutCommand({
            TableName: tableName,
            Item: item
        })
    );
    console.log(JSON.stringify({
        level: "INFO",
        stage: "DYNAMODB_PUT",
        requestId,
        fundId,
        status: item.status
    }));


    return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
            fundId,
            uploadedFiles: uploads.map(u => u.fileName)
        })
    };
};
