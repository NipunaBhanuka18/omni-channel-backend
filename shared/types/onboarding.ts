export type RegistrationStatus = "Pending" | "Provisioning" | "Approved" | "Rejected";

export interface OnboardingRequest {
  companyName: string;
  /** URL/DB-safe tenant slug. Must be unique across the platform. */
  tenantId: string;
  adminEmail: string;
  allowedChannels?: ("web" | "whatsapp" | "sms" | "messenger")[];
  companySlug?: string;
  adminName?: string;
  tier?: string;
  allocatedAgents?: number;
  themeColor?: string;
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
  normalizedName: string;
  companySlug: string;
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
  tier?: string;
  allocatedAgents?: number;
  channels?: string[];
  status: RegistrationStatus;
  submissionDate: string;
  date?: string;
  requestedDate?: string;
  createdAt: string;
  updatedAt?: string;
  onboardedAt?: string;
  reviewedBy?: string;
  passwordHash?: string;
  password?: string;
  temporaryPassword?: string;
  [key: string]: unknown;
}