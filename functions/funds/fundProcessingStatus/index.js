import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand
} from "@aws-sdk/lib-dynamodb";

/* ---------- CONFIG ---------- */

const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE_NAME = process.env.DDB_TABLE_NAME;
const STATUS_INDEX = "status-index";

/* ---------- CLIENT ---------- */

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION })
);

/* ---------- CORS ---------- */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*"
};

/* ---------- HANDLER ---------- */

export const handler = async (event, context) => {

  const requestId = context.awsRequestId;

  const limit = Number(event.queryStringParameters?.limit || 20);
  const status = event.queryStringParameters?.status;

  const lastKeyParam = event.queryStringParameters?.lastKey;

  const lastKey = lastKeyParam
    ? JSON.parse(Buffer.from(lastKeyParam, "base64").toString())
    : undefined;

  console.log(JSON.stringify({
    level: "INFO",
    message: "Status request received",
    requestId,
    limit,
    status,
    hasLastKey: !!lastKey
  }));

  let resp;

  try {

    if (status) {

      resp = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: STATUS_INDEX,
        KeyConditionExpression: "#s = :s",
        ExpressionAttributeNames: {
          "#s": "status"
        },
        ExpressionAttributeValues: {
          ":s": status
        },
        Limit: limit,
        ExclusiveStartKey: lastKey,
        ScanIndexForward: false
      }));

    } else {

      resp = await ddb.send(new ScanCommand({
        TableName: TABLE_NAME,
        Limit: limit,
        ExclusiveStartKey: lastKey
      }));

    }

  } catch (err) {

    console.error(JSON.stringify({
      level: "ERROR",
      message: "DynamoDB query failed",
      requestId,
      error: err.message,
      stack: err.stack
    }));

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Failed to fetch fund status"
      })
    };
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      items: resp.Items || [],
      lastKey: resp.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(resp.LastEvaluatedKey)).toString("base64")
        : null
    })
  };
};
