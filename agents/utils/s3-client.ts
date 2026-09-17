import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// Use LOCALSTACK_HOSTNAME if running inside a Lambda container, else fallback to 127.0.0.1
const localstackEndpoint = process.env.LOCALSTACK_HOSTNAME
  ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
  : "http://127.0.0.1:4566";

export const s3Client = new S3Client({
  region: "us-east-1",
  endpoint: localstackEndpoint,
  forcePathStyle: true,
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
