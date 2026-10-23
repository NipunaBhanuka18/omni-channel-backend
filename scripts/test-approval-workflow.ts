/** Offline tests. No local db.json, LocalStack, S3, or Cognito writes. */
import { provisionPendingCompanyApproval } from "../services/onboarding/approval-workflow";
import { OnboardingRequest } from "../shared/types/onboarding";

async function main() {
  let passed = 0;
  function check(name: string, ok: boolean) {
    if (!ok) throw new Error(`FAIL: ${name}`);
    console.log(`PASS: ${name}`);
    passed++;
  }

  const original = {
    id: "reg-offline-test", status: "Pending", companyName: "Example Lanka Ltd",
    companySlug: "Example-Lanka", companyEmail: "admin@example.test",
  };
  let calls = 0;
  const happy = async (request: Partial<OnboardingRequest>) => {
    calls++;
    check("Maps registration to unique tenant + admin email",
      request.tenantId === "tenant-example-lanka" && request.adminEmail === "admin@example.test");
    return { success: true as const, data: {
      tenantId: "tenant-example-lanka", companyName: "Example Lanka Ltd",
      adminUsername: "admin@example.test", temporaryPassword: "FAKE-OFFLINE-PASSWORD",
      kbPrefix: "tenants/tenant-example-lanka/", status: "provisioned" as const,
      createdAt: new Date().toISOString(),
    } };
  };
  const ok = await provisionPendingCompanyApproval(original, happy);
  check("Approval occurs only after provisioning succeeds", ok.success && ok.approvedRegistration.status === "Approved");
  check("Default input registration remains unmodified", original.status === "Pending");
  check("Temporary credential excluded from persisted registration shape",
    ok.success && !("temporaryPassword" in ok.approvedRegistration));

  const already = await provisionPendingCompanyApproval({ ...original, status: "Approved" }, happy);
  check("Already approved record is rejected without reprovisioning", !already.success && calls === 1);

  const unavailable = await provisionPendingCompanyApproval(original, async () => { throw new Error("Cognito unavailable"); });
  check("Unavailable Cognito prevents approval", !unavailable.success && original.status === "Pending");

  const failed = await provisionPendingCompanyApproval(original, async () => ({
    success: false, error: { code: "INTERNAL_ERROR", message: "Simulated S3 failure", retryable: true },
  }));
  check("Provisioning failure prevents approval", !failed.success && original.status === "Pending");

  const invalid = await provisionPendingCompanyApproval({ ...original, companySlug: "---", companyName: "" }, happy);
  check("Invalid registration blocked before provisioning", !invalid.success && calls === 1);

  const mismatch = await provisionPendingCompanyApproval(original, async () => ({
    success: true, data: {
      tenantId: "tenant-wrong", companyName: "Wrong", adminUsername: "admin@example.test",
      temporaryPassword: "FAKE", kbPrefix: "tenants/tenant-wrong/",
      status: "provisioned", createdAt: new Date().toISOString(),
    },
  }));
  check("Mismatched tenant result rejected", !mismatch.success);

  console.log(`\n--- ${passed} passed, 0 failed ---`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
