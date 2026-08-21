import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// Configure the S3 client to point to LocalStack
const s3Client = new S3Client({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4566",
  forcePathStyle: true, // Required for LocalStack S3
  credentials: {
    accessKeyId: "mock_access_key",
    secretAccessKey: "mock_secret_key",
  },
});

/**
 * Fetches a Knowledge Base document from the S3 bucket.
 */
export const fetchKbDocument = async (docName: string): Promise<string> => {
  try {
    const command = new GetObjectCommand({
      Bucket: "omni-channel-kb-docs",
      Key: docName,
    });

    const response = await s3Client.send(command);

    // Convert the S3 stream into a readable string
    const stream = response.Body as import("stream").Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const documentContent = Buffer.concat(chunks).toString("utf-8");

    return documentContent;
  } catch (error) {
    console.error(`[S3 Client] Failed to fetch document ${docName}:`, error);
    throw new Error("Failed to retrieve knowledge base document.");
  }
};
