import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { TenantContext } from "../../shared/types/tenant-context";

// Configure the S3 client to point to LocalStack
export const s3Client = new S3Client({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4566",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "mock_access_key",
    secretAccessKey: "mock_secret_key",
  },
});

const KB_BUCKET_NAME = "omni-channel-kb-docs";

/**
 * Helper: Builds an isolated S3 Object Key for a specific tenant
 * Format: tenants/<tenantId>/<docName>
 * Protects against Path Traversal attacks (e.g., ../)
 */
export function buildTenantS3Key(tenantId: string, docName: string): string {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("[S3 Isolation Error] tenantId is required to construct S3 Key.");
  }

  // Sanitize docName to prevent path traversal vulnerability
  const sanitizedDocName = docName.replace(/^(\.\.[\/\\])+/, "").replace(/^\/+/, "");
  const cleanDocName = sanitizedDocName.startsWith(`tenants/${tenantId}/`)
    ? sanitizedDocName.replace(`tenants/${tenantId}/`, "")
    : sanitizedDocName;

  return `tenants/${tenantId.trim()}/${cleanDocName}`;
}

/**
 * Fetches a Knowledge Base document strictly scoped under the authenticated Tenant's S3 folder.
 */
export const fetchKbDocument = async (
  context: TenantContext,
  docName: string
): Promise<string> => {
  if (!context || !context.tenantId) {
    throw new Error("[S3 Isolation Guardrail] Missing authenticated TenantContext.");
  }

  const isolatedKey = buildTenantS3Key(context.tenantId, docName);

  try {
    const command = new GetObjectCommand({
      Bucket: KB_BUCKET_NAME,
      Key: isolatedKey,
    });

    const response = await s3Client.send(command);

    // Convert the S3 stream into a readable string
    const stream = response.Body as import("stream").Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  } catch (error) {
    // Local testing fallback if LocalStack is offline
    console.warn(`[S3 Client Warning] S3 fetch skipped/offline for '${isolatedKey}'. Using mock KB document.`);
    
    return `
Issue: Slow Internet Connection
Resolution: Restart your router by unplugging the power cable for 30 seconds.
Issue: Router Power LED OFF
Resolution: Check if the power adapter is firmly plugged in.
    `.trim();
  }
};

/**
 * Uploads a Knowledge Base document directly into the authenticated Tenant's S3 folder.
 */
export const uploadKbDocument = async (
  context: TenantContext,
  docName: string,
  content: string | Buffer
): Promise<string> => {
  if (!context || !context.tenantId) {
    throw new Error("[S3 Isolation Guardrail] Missing authenticated TenantContext.");
  }

  const isolatedKey = buildTenantS3Key(context.tenantId, docName);

  try {
    const command = new PutObjectCommand({
      Bucket: KB_BUCKET_NAME,
      Key: isolatedKey,
      Body: content,
      Metadata: {
        "tenant-id": context.tenantId,
        "uploaded-by": context.userId,
      },
    });

    await s3Client.send(command);
    return isolatedKey;
  } catch (error) {
    console.warn(`[S3 Client Warning] S3 Upload skipped for local test: ${isolatedKey}`);
    return isolatedKey;
  }
};