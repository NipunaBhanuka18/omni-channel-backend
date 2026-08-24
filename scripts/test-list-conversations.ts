import { handler } from "../services/workspace-portal/list-conversations";

async function runTest() {
  console.log("--- Starting Workspace Portal Test ---");

  // Call the workspace portal handler
  const result = await handler();

  console.log("\n--- Result ---");
  console.log(JSON.stringify(result, null, 2));

  if (result.success && result.data && result.data.length > 0) {
    console.log(
      `\n✅ SUCCESS: Found ${result.data.length} conversation(s) in the DB!`,
    );
  } else if (result.success && result.data && result.data.length === 0) {
    console.log(
      "\n⚠️ WARNING: DB Scan worked, but the table is empty. Run the check_balance test first to put data in it!",
    );
  } else {
    console.log("\n❌ ERROR: Failed to list conversations.");
  }
}

runTest();
