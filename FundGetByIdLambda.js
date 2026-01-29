import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*"
};

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const log = (level, msg, data = {}) => {
  console.log(JSON.stringify({
    level,
    msg,
    ...data
  }));
};

const response = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body)
});

export const handler = async (event) => {
  const requestId = crypto.randomUUID();

  try {
    log("INFO", "FundStatusLambda invoked", {
      requestId,
      path: event.rawPath
    });

    const fundId = event?.pathParameters?.fundId;

    if (!fundId) {
      log("WARN", "Missing fundId", { requestId });
      return response(400, { error: "Missing fundId" });
    }

    const TABLE = process.env.DYNAMODB_TABLE;

    if (!TABLE) {
      log("ERROR", "DYNAMODB_TABLE not configured", { requestId });
      return response(500, { error: "Server misconfiguration" });
    }

    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { fundId }
      })
    );

    if (!result.Item) {
      log("INFO", "Fund not found", { fundId, requestId });
      return response(404, { error: "Fund not found" });
    }

    log("INFO", "Fund retrieved", {
      fundId,
      status: result.Item.status,
      requestId
    });

    // Return entire object exactly as stored
    return response(200, result.Item);

  } catch (err) {
    log("ERROR", "Unhandled exception", {
      error: err.message,
      stack: err.stack
    });

    return response(500, { error: "Internal server error" });
  }
};
