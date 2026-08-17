import { handleTenantRequest } from "./handler";

/**
 * Parses JSON strings robustly, including auto-repairing unquoted keys or PowerShell argument stripping.
 */
function parseFlexibleJson(rawStr: string): any {
  let cleanStr = rawStr.trim();

  // Strip outer wrapping single or double quotes
  if ((cleanStr.startsWith("'") && cleanStr.endsWith("'")) || (cleanStr.startsWith('"') && cleanStr.endsWith('"'))) {
    cleanStr = cleanStr.substring(1, cleanStr.length - 1).trim();
  }

  // Attempt 1: Standard JSON parse
  try {
    return JSON.parse(cleanStr);
  } catch (err1) {
    // Attempt 2: Auto-repair unquoted JSON keys/string values stripped by PowerShell / Windows CLI
    try {
      let repaired = cleanStr
        // Quote unquoted object keys: {intent: ...} -> {"intent": ...}
        .replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":')
        // Quote unquoted string values: {"intent": check_balance} -> {"intent": "check_balance"}
        .replace(/:\s*([a-zA-Z0-9_\-\.]+)\s*([,}])/g, ':"$1"$2');

      console.log("[LambdaAdapter] Repaired PowerShell stripped JSON string:", repaired);
      return JSON.parse(repaired);
    } catch (err2) {
      console.error("[LambdaAdapter] Flexible JSON parse failed. Original raw string was:", rawStr);
      throw err1;
    }
  }
}

/**
 * AWS Lambda Handler Adapter
 * Translates APIGatewayProxyEvent to handleTenantRequest payload and formats response into APIGatewayProxyResult.
 */
export const handler = async (event: any): Promise<any> => {
  try {
    console.log("[LambdaAdapter] RAW event.isBase64Encoded:", event.isBase64Encoded);
    console.log("[LambdaAdapter] RAW event.body (type):", typeof event.body);
    console.log("[LambdaAdapter] RAW event.body (content):", JSON.stringify(event.body));

    let rawBodyStr = event.body;

    // Handle base64 encoded request body from API Gateway
    if (event.isBase64Encoded && typeof rawBodyStr === "string") {
      rawBodyStr = Buffer.from(rawBodyStr, "base64").toString("utf-8");
      console.log("[LambdaAdapter] Base64 decoded body:", rawBodyStr);
    }

    let body: any = {};
    if (rawBodyStr) {
      if (typeof rawBodyStr === "string") {
        body = parseFlexibleJson(rawBodyStr);
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
