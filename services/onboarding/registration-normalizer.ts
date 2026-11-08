import { deriveTenantId, normalizeCompanyName, normalizeCompanySlug } from "../../shared/utils/tenant-name";

/**
 * Normalizes a company registration record across legacy UI fields and
 * canonical backend fields while preserving credential fields only when
 * explicitly passed (callers must redact before API serialization).
 */
export function normalizeRegistration(r: Record<string, any>): Record<string, any> {
  const companyName = String(r.companyName || r.name || "Unnamed Company").trim() || "Unnamed Company";
  const email = String(r.companyEmail || r.email || r.adminEmail || "").trim();
  const submissionDate =
    r.submissionDate || r.date || r.requestedDate || new Date().toISOString().split("T")[0];
  const industry = r.industry || r.companyType || "Technology";
  const companySlug = normalizeCompanySlug(
    String(r.companySlug || (typeof r.tenantId === "string" ? r.tenantId.replace(/^tenant-/, "") : "") || companyName)
  ) || "company";

  return {
    ...r,
    companyName,
    name: companyName,
    normalizedName: r.normalizedName || normalizeCompanyName(companyName),
    companySlug,
    companyEmail: email,
    email,
    adminName: r.adminName || "Admin",
    adminEmail: String(r.adminEmail || email).trim(),
    phone: r.phone || r.adminPhone || "-",
    adminPhone: r.adminPhone || r.phone || "-",
    website: r.website || "-",
    industry,
    companyType: industry,
    country: r.country || "Sri Lanka",
    city: r.city || "",
    address: r.address || "",
    employeeCount: r.employeeCount || "",
    about: r.about || "",
    status: r.status || "Pending",
    submissionDate,
    date: submissionDate,
    requestedDate: submissionDate,
    createdAt: r.createdAt || (typeof submissionDate === "string" ? `${submissionDate}T00:00:00.000Z` : new Date().toISOString()),
    tier: r.tier || "Standard",
    themeColor: r.themeColor || "#005EB8",
    allocatedAgents: r.allocatedAgents || 5,
    channels: Array.isArray(r.channels) && r.channels.length > 0 ? r.channels : ["Web"],
    ...(typeof r.tenantId === "string" && r.tenantId ? { tenantId: r.tenantId } : {}),
  };
}

export function expectedTenantIdForRegistration(r: Record<string, any>): string {
  return deriveTenantId(
    typeof r.companySlug === "string" ? r.companySlug : undefined,
    typeof r.companyName === "string" ? r.companyName : undefined
  );
}

