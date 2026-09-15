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
    console.warn(`[S3 Client] LocalStack S3 unreachable, returning offline KB fallback document for ${docName}`);
    return `Issue: Slow Internet Connection
Solution: 1. Power cycle your Wi-Fi optical fiber router for 30 seconds.
2. Check LAN cable connection on PORT 1.
3. Switch Wi-Fi frequency band from 2.4GHz to 5GHz.
4. Contact SLT Technical Helpline 1212 if LOS LED light is glowing RED.`;
  }
};
