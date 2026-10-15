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
