export const handler = async (event, context) => {
  const requestId = context.awsRequestId;
  const timestamp = new Date().toISOString();

  // Entry log
  console.log(JSON.stringify({
    level: "INFO",
    stage: "ENTRY",
    message: "FundDocumentUploadLambda invoked",
    timestamp,
    requestId
  }));

  // Log full incoming event (important for POC/debug)
  console.log(JSON.stringify({
    level: "DEBUG",
    stage: "EVENT",
    message: "Incoming API Gateway event",
    requestId,
    event
  }));

  // Extract path parameter
  const fundId = event.pathParameters?.fundId;

  console.log(JSON.stringify({
    level: "INFO",
    stage: "PARAMS",
    message: "Extracted path parameters",
    requestId,
    fundId
  }));

  // Validate input
  if (!fundId) {
    console.error(JSON.stringify({
      level: "ERROR",
      stage: "VALIDATION",
      message: "Missing fundId path parameter",
      requestId
    }));

    return {
      statusCode: 400,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*"
      },
      body: JSON.stringify({
        error: "Missing fundId path parameter"
      })
    };
  }

  // (POC placeholder) — no upload yet
  console.log(JSON.stringify({
    level: "INFO",
    stage: "PROCESSING",
    message: "POC: fundId validated successfully",
    requestId,
    fundId
  }));

  // Successful response
  const response = {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*"
    },
    body: JSON.stringify({
      message: "fundId received successfully",
      fundId
    })
  };

  console.log(JSON.stringify({
    level: "INFO",
    stage: "EXIT",
    message: "Lambda execution completed successfully",
    requestId,
    response
  }));

  return response;
};
