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