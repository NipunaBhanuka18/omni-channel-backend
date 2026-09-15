import { handleCompanyOnboarding } from "../services/tenant-onboarding/handler";

async function runOnboardingTest() {
  console.log("Starting Member 2 Company Onboarding Pipeline Test...");

  try {
    const result = await handleCompanyOnboarding({
      companyName: "SLT Mobitel",
      adminEmail: "admin@mobitel.lk",
    });

    console.log("Onboarding Pipeline Executed Successfully! Result:");
    console.dir(result, { depth: null });
  } catch (error) {
    console.error("Onboarding Pipeline Failed:", error);
  }
}

runOnboardingTest();