import { handleOnboardingRequest } from "./handler";

/**
 * AWS Lambda Handler Adapter for POST /tenants/register.
 * Translates APIGatewayProxyEvent to handleOnboardingRequest payload and formats
 * the response into an APIGatewayProxyResult. Mirrors the structure of
 * services/tenant-router/lambda-adapter.ts.
 */
export const handler = async (event: any): Promise<any> => {
  try {
    let rawBodyStr = event.body;

    if (event.isBase64Encoded && typeof rawBodyStr === "string") {
      rawBodyStr = Buffer.from(rawBodyStr, "base64").toString("utf-8");
    }

    let body: any = {};
    if (rawBodyStr) {
      if (typeof rawBodyStr === "string") {
        try {
          body = JSON.parse(rawBodyStr);
        } catch (parseError: any) {
          return {
            statusCode: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
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

    const rawHeaders = event.headers || {};
    const normalizedHeaders: Record<string, string | undefined> = {};
    for (const key of Object.keys(rawHeaders)) {
      normalizedHeaders[key.toLowerCase()] = rawHeaders[key];
      normalizedHeaders[key] = rawHeaders[key];
    }

    const response = await handleOnboardingRequest({ headers: normalizedHeaders, body });

    let statusCode = 200;
    if (!response.success) {
      switch (response.error?.code) {
        case "UNAUTHORIZED":
          statusCode = 401;
          break;
        case "FORBIDDEN":
          statusCode = 403;
          break;
        case "TENANT_ALREADY_EXISTS":
          statusCode = 409;
          break;
        case "BAD_REQUEST":
          statusCode = 400;
          break;
        default:
          statusCode = response.error?.retryable ? 503 : 500;
      }
    } else {
      statusCode = 201; // Resource created
    }

    return {
      statusCode,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(response),
    };
  } catch (error: any) {
    console.error("[OnboardingLambdaAdapter] Fatal execution error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
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