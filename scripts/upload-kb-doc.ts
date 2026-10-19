import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({

  region: "us-east-1",
  endpoint: "http://127.0.0.1:4566",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "mock_access_key",
    secretAccessKey: "mock_secret_key",
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
});

const mockDocumentContent = `
SLT Router Troubleshooting Guide:

Issue: No Internet Light on Router
1. Check if the power cable is securely connected.
2. Restart the router by unplugging it for 30 seconds.
3. If the light remains off, contact SLT Support.

Issue: Slow Internet Speed
1. Move closer to the router.
2. Disconnect unused devices from Wi-Fi.
3. Run a speed test at speedtest.slt.lk.
`;

async function uploadDoc() {
  try {
    const documentBody = Buffer.from(mockDocumentContent, "utf8");

    const command = new PutObjectCommand({
      Bucket: "omni-channel-kb-docs",
      Key: "tenants/slt/router-troubleshooting-guide.txt",
      Body: documentBody,
      ContentLength: documentBody.length,
      ContentType: "text/plain; charset=utf-8",
    });
    await s3Client.send(command);
    console.log("✅ Knowledge Base document uploaded successfully!");
  } catch (err) {
    console.error("❌ Error uploading document:", err);
  }
}

uploadDoc();
