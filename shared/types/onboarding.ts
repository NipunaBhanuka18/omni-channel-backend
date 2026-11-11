export type RegistrationStatus =
  | "Active"
  | "Approved"
  | "Pending"
  | "Rejected"
  | "Suspended"
  | "Failed"
  | "Provisioning";

export type ProvisioningLifecycleState =
  | "REGISTERING"
  | "PROVISIONING"
  | "AWAITING_VERIFICATION"
  | "ACTIVE"
  | "FAILED"
  | "SUSPENDED"
  | "PENDING";

export interface OnboardingRequest {
  companyName: string;
  /** URL/DB-safe tenant slug. Must be unique across the platform. */
  tenantId: string;
  adminEmail: string;
  allowedChannels?: ("web" | "whatsapp" | "sms" | "messenger")[];
}

export interface OnboardingResult {
  tenantId: string;
  companyName: string;
  adminUsername: string;
  /**
   * One-time Cognito temporary password for the Admin Console login. The caller
   * (Member 1's UI) must prompt the admin to change it on first login — Cognito
   * enforces this automatically since the user is created with a temporary
   * password rather than a permanent one.
   */
  temporaryPassword: string;
  /** S3 key prefix provisioned for this tenant's knowledge base documents. */
  kbPrefix: string;
  status: "provisioned";
  createdAt: string;
}

export interface CompanyRegistrationRecord {
  id: string;
  companyName: string;
  name?: string;
  companySlug?: string;
  tenantId?: string;
  businessRegNumber?: string;
  companyEmail: string;
  email?: string;
  adminName: string;
  adminEmail: string;
  adminPhone?: string;
  phone?: string;
  website?: string;
  industry?: string;
  companyType?: string;
  country?: string;
  city?: string;
  address?: string;
  employeeCount?: string;
  about?: string;
  status: RegistrationStatus;
  provisioningStatus?: ProvisioningLifecycleState;
  onboardedAt?: string;
  submissionDate?: string;
  date?: string;
  requestedDate?: string;
  tier?: string;
  allocatedAgents?: number;
  channels?: string[];
  idempotencyKey?: string;
  passwordHash?: string;
  [key: string]: unknown;
}

export interface AutomaticOnboardingResult {
  success: boolean;
  tenantId: string;
  companyName: string;
  companySlug: string;
  status: RegistrationStatus;
  provisioningStatus: ProvisioningLifecycleState;
  onboardedAt: string;
  registration: CompanyRegistrationRecord;
  token?: string;
  user?: {
    id: string;
    name: string;
    email: string;
    role: "company";
    tenantId: string;
    companyName: string;
  };
  nextAction: string;
}
