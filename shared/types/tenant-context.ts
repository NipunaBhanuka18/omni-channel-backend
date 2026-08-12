export interface TenantContext {
  tenantId: string;
  userId: string;
  role: "staff" | "admin";
  permissions: string[];
  channel: "web" | "whatsapp" | "sms" | "messenger";
  sessionId: string;
  // Distinguishes a single conversation thread from the broader auth session (sessionId), since one session can span multiple conversations over time.
  conversationId: string;
}