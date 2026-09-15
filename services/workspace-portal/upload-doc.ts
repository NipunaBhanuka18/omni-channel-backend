import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client } from "../../agents/utils/s3-client";

/**
 * Workspace Portal API: Upload a new Knowledge Base document to S3.
 */
export const handler = async (event: { fileName: string; content: string }) => {
  console.log(`[Workspace Portal] Uploading document: ${event.fileName}`);

  try {
    const command = new PutObjectCommand({
      Bucket: "omni-channel-kb-docs",
      Key: event.fileName,
      Body: event.content,
      ContentType: "text/plain",
    });

    await s3Client.send(command);

    console.log("[Workspace Portal] ✅ Document uploaded successfully.");
    return {
      success: true,
      data: {
        message: `Document '${event.fileName}' uploaded to KB.`,
      },
    };
  } catch (error) {
    console.error("[Workspace Portal] ❌ Failed to upload document:", error);
    return {
      success: false,
      error: {
        code: "S3_UPLOAD_FAILED",
        message: "Could not upload document to S3.",
        retryable: true,
      },
    };
  }
};
