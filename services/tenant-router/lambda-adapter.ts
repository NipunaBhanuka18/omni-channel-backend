import { handleTenantRequest } from "./handler";

/**
 * AWS Lambda Handler Adapter
 * Translates APIGatewayProxyEvent to handleTenantRequest payload and formats response into APIGatewayProxyResult.
 */
export const handler = async (event: any): Promise<any> => {
  try {
    let rawBodyStr = event.body;

    // Detailed character-level & byte-level logging for diagnosis
    if (typeof rawBodyStr === "string") {
      const charCodes = Array.from(rawBodyStr.slice(0, 30)).map((c) => `${c}: ${c.charCodeAt(0)}`);
      console.log(`[LambdaAdapter] RAW event.body (len=${rawBodyStr.length}):`, JSON.stringify(rawBodyStr));
      console.log(`[LambdaAdapter] RAW event.body char codes (first 30):`, charCodes.join(", "));
    } else {
      console.log("[LambdaAdapter] RAW event.body (type):", typeof rawBodyStr);
    }

    // Handle standard API Gateway base64-encoded request bodies
    if (event.isBase64Encoded && typeof rawBodyStr === "string") {
      rawBodyStr = Buffer.from(rawBodyStr, "base64").toString("utf-8");
      console.log("[LambdaAdapter] Base64 decoded body:", rawBodyStr);
    }

    let body: any = {};
    if (rawBodyStr) {
      if (typeof rawBodyStr === "string") {
        try {
          body = JSON.parse(rawBodyStr);
        } catch (parseError: any) {
          console.error("[LambdaAdapter] Strict JSON.parse failed. Raw payload string was:", JSON.stringify(rawBodyStr));
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
                details: { parseError: parseError.message, rawBody: rawBodyStr },
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
      switch (response.error?.code) {
        case "UNAUTHORIZED":
          statusCode = 401;
          break;
        case "FORBIDDEN":
        case "TENANT_INACTIVE":
          statusCode = 403;
          break;
        case "TENANT_NOT_FOUND":
          statusCode = 404;
          break;
        case "BAD_REQUEST":
          statusCode = 400;
          break;
        case "INTERNAL_ERROR":
          statusCode = response.error?.retryable ? 503 : 500;
          break;
        default:
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
