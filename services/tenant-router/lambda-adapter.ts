import { handleTenantRequest } from "./handler";

/**
 * AWS Lambda Handler Adapter
 * Translates APIGatewayProxyEvent to handleTenantRequest payload and formats response into APIGatewayProxyResult.
 */
export const handler = async (event: any): Promise<any> => {
  try {
    let rawBodyStr = event.body;

    // Handle standard API Gateway base64-encoded request bodies
    if (event.isBase64Encoded && typeof rawBodyStr === "string") {
      rawBodyStr = Buffer.from(rawBodyStr, "base64").toString("utf-8");
    }

    let body: any = {};
    if (rawBodyStr) {
      if (typeof rawBodyStr === "string") {
        try {
          body = JSON.parse(rawBodyStr);
        } catch (parseError: any) {
          // Strict Input Validation: Return structured 400 Bad Request error for malformed JSON payloads
          return {
            statusCode: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
            body: JSON.stringify({
              success: false,
              error: {
                code: "BAD_REQUEST",
                message: `Invalid or malformed JSON payload in request body: ${parseError.message}`,
                retryable: false,
                details: { parseError: parseError.message },
              },
            }),
          };
        }
      } else {
        body = rawBodyStr;
      }
    }

    // Normalize incoming headers to lowercase keys for consistent lookup
    const rawHeaders = event.headers || {};
    const normalizedHeaders: Record<string, string | undefined> = {};
    for (const key of Object.keys(rawHeaders)) {
      normalizedHeaders[key.toLowerCase()] = rawHeaders[key];
      // Keep original case as fallback
      normalizedHeaders[key] = rawHeaders[key];
    }

    const requestPayload = {
      headers: normalizedHeaders,
      body: body,
    };

    const response = await handleTenantRequest(requestPayload);

    let statusCode = 200;
    if (!response.success) {
      if (response.error?.code === "UNAUTHORIZED") {
        statusCode = 401;
      } else if (response.error?.code === "FORBIDDEN") {
        statusCode = 403;
      } else if (response.error?.code === "BAD_REQUEST") {
        statusCode = 400;
      } else {
        statusCode = 400;
      }
    }

    return {
      statusCode: statusCode,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(response),
    };
  } catch (error: any) {
    console.error("[LambdaAdapter] Fatal execution error:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Unhandled Lambda execution error",
          retryable: false,
          details: { message: error?.message || String(error) },
        },
      }),
    };
  }
};
