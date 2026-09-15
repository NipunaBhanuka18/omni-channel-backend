import { handler } from "../services/workspace-portal/upload-doc";

async function runTest() {
  console.log("--- Starting Workspace Upload Test ---");

  const result = await handler({
    fileName: "new-router-firmware-guide.txt",
    content:
      "SLT Router Firmware Update Guide:\n1. Download the firmware.\n2. Upload via router admin panel.\n3. Wait 5 minutes for reboot.",
  });

  console.log("\n--- Result ---");
  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    console.log(
      "\n✅ SUCCESS: Admin successfully uploaded a new document to the S3 KB!",
    );
  } else {
    console.log("\n❌ ERROR: Upload failed.");
  }
}

runTest();
