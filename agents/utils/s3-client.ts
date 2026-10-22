import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { TenantContext } from "../../shared/types/tenant-context";

// Dynamic LocalStack vs AWS Cloud S3 configuration
const isLocal = process.env.IS_LOCAL !== "false";
const localstackEndpoint = process.env.LOCALSTACK_HOSTNAME
  ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
  : "http://127.0.0.1:4566";

export const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  requestChecksumCalculation: "WHEN_REQUIRED",
  ...(isLocal && {
    endpoint: localstackEndpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: "mock_access_key",
      secretAccessKey: "mock_secret_key",
    },
  }),
});

const KB_BUCKET_NAME = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";
// Prevent simultaneous create-only uploads for the same key in this local process.
const inFlightCreates = new Set<string>();

/**
 * Helper: Builds an isolated S3 Object Key strictly partitioned by Tenant ID
 * Format: tenants/<tenantId>/<docName> or platform-kb/<tenantId>/<docName>
 */
export function buildTenantS3Key(tenantId: string, docName: string): string {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("[S3 Isolation Error] tenantId is required to construct S3 Key.");
  }

  // Sanitize docName to prevent path traversal vulnerability (e.g., ../ or /)
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
    throw new Error("[S3 Isolation Guardrail] Missing authenticated TenantContext for RAG query.");
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
    console.error(
      `[S3 Client Error] Failed to fetch '${isolatedKey}' from bucket '${KB_BUCKET_NAME}':`,
      error
    );

    throw new Error(
      `Knowledge Base document unavailable for tenant '${context.tenantId}'.`
    );
  }
};

/**
 * Uploads a Knowledge Base document directly into the authenticated Tenant's S3 folder.
 */
export const uploadKbDocument = async (
  context: TenantContext,
  docName: string,
  content: string | Buffer,
  options: { createOnly?: boolean } = {}
): Promise<string> => {
  if (!context || !context.tenantId) {
    throw new Error("[S3 Isolation Guardrail] Missing authenticated TenantContext for RAG upload.");
  }

  const isolatedKey = buildTenantS3Key(context.tenantId, docName);
  const documentBody = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");

  // LocalStack 3.0 may accept If-None-Match without enforcing it. A HEAD check
  // blocks sequential overwrites in the local demo. The conditional PUT below
  // remains necessary for atomic protection on S3 implementations that support it.
  if (options.createOnly) {
    if (inFlightCreates.has(isolatedKey)) {
      const conflict = new Error("Another upload to this document is in progress");
      conflict.name = "ConditionalRequestConflict";
      throw conflict;
    }
    inFlightCreates.add(isolatedKey);
  }

  try {
    if (options.createOnly) {
      let exists = true;
      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: KB_BUCKET_NAME, Key: isolatedKey }));
      } catch (error: any) {
        if (error?.name === "NotFound" || error?.name === "NoSuchKey" ||
            (error?.$metadata?.httpStatusCode === 404 && error?.name !== "NoSuchBucket")) {
          exists = false;
        } else {
          // Do not interpret permission errors or connectivity failures as "not found".
          throw error;
        }
      }
      if (exists) {
        const conflict = new Error("Document already exists in S3");
        conflict.name = "PreconditionFailed";
        throw conflict;
      }
    }

    const command = new PutObjectCommand({
      Bucket: KB_BUCKET_NAME,
      Key: isolatedKey,
      Body: documentBody,
      ContentLength: documentBody.length,
      ContentType: "text/plain; charset=utf-8",
      ...(options.createOnly ? { IfNoneMatch: "*" } : {}),
      Metadata: {
        "tenant-id": context.tenantId,
        "uploaded-by": context.userId,
      },
    });

    await s3Client.send(command);
    return isolatedKey;
  } catch (error) {
    console.error(`[S3 Client Error] S3 Upload failed: ${isolatedKey}`, error);
    throw error;
  } finally {
    if (options.createOnly) inFlightCreates.delete(isolatedKey);
  }
};