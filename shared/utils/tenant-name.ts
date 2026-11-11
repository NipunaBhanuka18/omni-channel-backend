/**
 * Normalizes a company name for duplicate-detection purposes: lowercased,
 * leading/trailing whitespace trimmed, and internal runs of whitespace collapsed
 * to a single space. "Acme Corp", "ACME CORP", and "  acme   corp " all normalize
 * to "acme corp", so they're caught as the same company regardless of how the
 * onboarding form was typed. Stored on the tenant record as `normalizedName` and
 * queried via the omni-channel-tenants table's NormalizedNameIndex GSI (see
 * scripts/create-tenants-table.ts) rather than comparing raw companyName values,
 * since DynamoDB has no case-insensitive query support.
 */
export function normalizeCompanyName(companyName: string): string {
  return companyName.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Normalizes a company slug or name into a lowercase URL/DB-safe slug.
 */
export function normalizeCompanySlug(rawSlug: string): string {
  return rawSlug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54);
}

/**
 * Reserved platform slugs that cannot be claimed by ordinary tenant registrations.
 */
export const RESERVED_TENANT_SLUGS = new Set<string>([
  "slt",
  "admin",
  "administrator",
  "superadmin",
  "system",
  "platform",
  "api",
  "root",
  "null",
  "undefined",
  "console",
  "auth",
  "login",
  "register",
  "workspace",
  "internal",
]);

/**
 * Checks if a company slug is reserved for platform operations.
 */
export function isReservedTenantSlug(rawSlug: string): boolean {
  const clean = normalizeCompanySlug(rawSlug);
  return RESERVED_TENANT_SLUGS.has(clean) || clean.startsWith("system-") || clean.startsWith("platform-");
}

/**
 * Derives a canonical tenantId from a company slug or company name.
 * Preserves "slt" as the baseline seeded tenant ID and prefixes others with "tenant-".
 */
export function deriveTenantId(companySlug?: string, companyName?: string): string {
  const cleanSlug = normalizeCompanySlug(companySlug || companyName || "");
  if (!cleanSlug) return "";
  if (cleanSlug === "slt") return "slt";
  return cleanSlug.startsWith("tenant-") ? cleanSlug : `tenant-${cleanSlug}`;
}
