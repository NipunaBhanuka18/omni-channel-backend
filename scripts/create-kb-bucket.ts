import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4566",
  forcePathStyle: true, // Required for LocalStack S3
  credentials: {
    accessKeyId: "mock_access_key",
    secretAccessKey: "mock_secret_key",
  },
});

async function createBucket() {
  try {
    const command = new CreateBucketCommand({
      Bucket: "omni-channel-kb-docs",
    });
    await s3Client.send(command);
    console.log("✅ S3 Bucket created successfully: omni-channel-kb-docs");
  } catch (err: any) {
    if (err.name === "BucketAlreadyOwnedByYou") {
      console.log("Bucket already exists. That's fine, moving on!");
    } else {
      console.error("❌ Error creating S3 bucket:", err);
    }
  }
}

createBucket();
