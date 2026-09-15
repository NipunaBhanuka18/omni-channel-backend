import { fetchKbDocument } from "../agents/utils/s3-client";

async function runTest() {
  console.log("--- Starting S3 Fetch Test ---");

  try {
    const content = await fetchKbDocument("router-troubleshooting-guide.txt");
    console.log("\n✅ SUCCESS: Fetched document from S3!");
    console.log("\n--- Document Content ---");
    console.log(content);
    console.log("------------------------\n");
  } catch (error) {
    console.error("\n❌ ERROR: Failed to fetch from S3.", error);
  }
}

runTest();
