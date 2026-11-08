/**
 * LOCAL-DEMO-ONLY authentication & company registration route handlers.
 * Enforces scrypt-v2 hashing on registration, fail-closed hashed credential
 * verification + bounded attempt rate/concurrency limiting on login, and
 * HMAC-SHA256 signed local bearer tokens.
 */
import express from "express";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { hashPassword } from "./password-hashing";
import { verifyLocalCredentialRecord } from "./local-credential-verifier";
import { LocalLoginAttemptGuard } from "./local-login-attempt-guard";
import { LocalAuthRole, LocalSessionTokenService } from "./local-session-token";
import { redactRegistrationCredentials } from "../onboarding/registration-privacy";

export interface LocalDbShape {
  users: Array<Record<string, any>>;
  registrations: Array<Record<string, any>>;
}

export interface LocalDbStore {
  readDB(): LocalDbShape;
  writeDB(data: LocalDbShape): void;
}

export interface LocalAuthRouterOptions {
  store: LocalDbStore;
  tokenService?: LocalSessionTokenService;
  getTokenService?: () => LocalSessionTokenService;
  loginGuard?: LocalLoginAttemptGuard;
  hashFn?: (password: string) => Promise<string>;
  maxConcurrentRegistrations?: number;
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 4096;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TENANT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUPPORTED_USER_ROLES = new Set<LocalAuthRole>(["superadmin", "company", "live_agent"]);

export function createJsonDbStore(dbPath: string): LocalDbStore {
  function readDB(): LocalDbShape {
    if (!fs.existsSync(dbPath)) {
      return { users: [], registrations: [] };
    }
    try {
      const raw = fs.readFileSync(dbPath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        users: Array.isArray(parsed?.users) ? parsed.users : [],
        registrations: Array.isArray(parsed?.registrations) ? parsed.registrations : [],
      };
    } catch {
      return { users: [], registrations: [] };
    }
  }

  function writeDB(data: LocalDbShape): void {
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    const tempPath = `${dbPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tempPath, dbPath);
    } catch (error) {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }

  return { readDB, writeDB };
}

export function normalizeRegistration(r: Record<string, any>): Record<string, any> {
  const companyName = r.companyName || r.name || "Unnamed Company";
  const email = r.companyEmail || r.email || r.adminEmail || "";
  const submissionDate =
    r.submissionDate || r.date || r.requestedDate || new Date().toISOString().split("T")[0];
  const industry = r.industry || r.companyType || "Technology";

  return {
    ...r,
    companyName,
    name: companyName,
    companyEmail: email,
    email,
    adminName: r.adminName || "Admin",
    adminEmail: r.adminEmail || email,
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
    tier: r.tier || "Standard",
    allocatedAgents: r.allocatedAgents || 5,
    channels: r.channels || ["Web"],
  };
}

function isLocalAuthEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.IS_LOCAL !== "false";
}

function asPlainObject(value: unknown): Record<string, any> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? (value as Record<string, any>) : null;
}

export function createLocalAuthRouter(options: LocalAuthRouterOptions): express.Router {
  const router = express.Router();
  const resolveTokenService = (): LocalSessionTokenService => {
    if (options.getTokenService) return options.getTokenService();
    if (options.tokenService) return options.tokenService;
    throw new Error("LocalSessionTokenService is not configured");
  };
  const loginGuard =
    options.loginGuard ??
    new LocalLoginAttemptGuard({
      maxAttemptsPerWindow: 10,
      windowMs: 60_000,
      maxConcurrent: 2,
      maxTrackedKeys: 1024,
    });
  const hashFn = options.hashFn ?? hashPassword;
  const maxConcurrentRegistrations = options.maxConcurrentRegistrations ?? 2;
  let registrationsInFlight = 0;

  router.post("/api/auth/login", async (req, res) => {
    if (!isLocalAuthEnabled()) {
      return res.status(404).json({ success: false, error: "Local authentication unavailable" });
    }
    const body = asPlainObject(req.body);
    if (!body) {
      return res.status(400).json({ success: false, error: "Invalid login payload" });
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = body.password;
    if (!email || typeof password !== "string" || password.length === 0) {
      return res.status(400).json({ success: false, error: "Email and password are required" });
    }
    if (email.length > 254) {
      return res.status(400).json({ success: false, error: "Invalid email address" });
    }

    const remoteAddress = req.socket?.remoteAddress || "unknown";
    const guardKey = `ip:${remoteAddress}`;
    const normalizedEmail = email.toLowerCase();

    const db = options.store.readDB();
    const matchedUser = db.users.find(
      (u) => typeof u?.email === "string" && u.email.trim().toLowerCase() === normalizedEmail,
    );

    const matchingRegistrations = matchedUser
      ? []
      : db.registrations.filter(
        (r) =>
          typeof r?.companyEmail === "string" &&
          r.companyEmail.trim().toLowerCase() === normalizedEmail,
      );
    const matchedRegistration = matchedUser
      ? undefined
      : matchingRegistrations.find((r) => r.status === "Approved") ||
      matchingRegistrations[matchingRegistrations.length - 1];

    const candidateRecord = matchedUser ?? matchedRegistration ?? null;

    const outcome = await loginGuard.run(guardKey, async () => {
      if (!candidateRecord) return false;
      return verifyLocalCredentialRecord(candidateRecord, password);
    });

    if (outcome === "rate_limited") {
      return res.status(429).json({
        success: false,
        error: "Too many login attempts. Please wait and try again.",
      });
    }
    if (outcome === "busy") {
      return res.status(503).json({
        success: false,
        error: "Authentication service is busy. Please retry shortly.",
      });
    }
    if (outcome !== "verified" || !candidateRecord) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }

    if (matchedUser) {
      const role = matchedUser.role as LocalAuthRole;
      if (!SUPPORTED_USER_ROLES.has(role) || typeof matchedUser.id !== "string" || !matchedUser.id.trim()) {
        return res.status(403).json({ success: false, error: "Account role configuration is invalid" });
      }
      const userId = matchedUser.id.trim();
      const userEmail = String(matchedUser.email).trim();
      const userName = String(matchedUser.fullName || userEmail).trim();

      if (role === "superadmin") {
        if (matchedUser.tenantId !== undefined) {
          return res.status(403).json({ success: false, error: "Invalid superadmin tenant scope" });
        }
        const token = resolveTokenService().issueToken({
          sub: userId,
          email: userEmail,
          name: userName,
          role: "superadmin",
        });
        return res.json({
          success: true,
          user: { id: userId, name: userName, email: userEmail, role: "superadmin" },
          token,
        });
      }

      const tenantId = typeof matchedUser.tenantId === "string" ? matchedUser.tenantId.trim() : "";
      if (!TENANT_ID_PATTERN.test(tenantId)) {
        return res.status(403).json({ success: false, error: "User account is missing a valid tenant" });
      }
      const token = resolveTokenService().issueToken({
        sub: userId,
        email: userEmail,
        name: userName,
        role,
        tenantId,
      });
      return res.json({
        success: true,
        user: { id: userId, name: userName, email: userEmail, role, tenantId },
        token,
      });
    }

    // Status and tenant checks happen strictly AFTER password verification so
    // unauthenticated callers cannot probe registration review states.
    if (matchedRegistration!.status !== "Approved") {
      return res.status(403).json({
        success: false,
        error: `Your registration is currently ${String(matchedRegistration!.status || "pending").toLowerCase()}. Please await Super Admin approval.`,
      });
    }
    const tenantId =
      typeof matchedRegistration!.tenantId === "string"
        ? matchedRegistration!.tenantId.trim()
        : "";
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      return res.status(403).json({
        success: false,
        error: "Company tenant provisioning is incomplete. Please contact support.",
      });
    }

    const regId = String(matchedRegistration!.id).trim();
    const companyEmail = String(matchedRegistration!.companyEmail).trim();
    const adminName = String(
      matchedRegistration!.adminName || matchedRegistration!.companyName || companyEmail,
    ).trim();
    const token = resolveTokenService().issueToken({
      sub: regId,
      email: companyEmail,
      name: adminName,
      role: "company",
      tenantId,
    });
    return res.json({
      success: true,
      user: {
        id: regId,
        name: adminName,
        email: companyEmail,
        role: "company",
        tenantId,
      },
      token,
    });
  });

  // Prevent unauthenticated callers from creating platform superadmin identities.
  // Production provisioning must use a verified, privileged administration path.
  router.post("/api/auth/register-admin", (_req, res) => {
    return res.status(404).json({ error: "Platform administrator self-registration unavailable" });
  });

  router.post("/api/registrations", async (req, res) => {
    if (!isLocalAuthEnabled()) {
      return res.status(404).json({ success: false, error: "Local registration unavailable" });
    }
    const body = asPlainObject(req.body);
    if (!body) {
      return res.status(400).json({ success: false, error: "Invalid registration payload" });
    }

    const rawCompanyName =
      typeof body.companyName === "string"
        ? body.companyName.trim()
        : typeof body.name === "string"
          ? body.name.trim()
          : "";
    if (!rawCompanyName || rawCompanyName.length > 120) {
      return res.status(400).json({ success: false, error: "Company name is required" });
    }

    const rawEmail =
      typeof body.companyEmail === "string"
        ? body.companyEmail.trim()
        : typeof body.email === "string"
          ? body.email.trim()
          : typeof body.adminEmail === "string"
            ? body.adminEmail.trim()
            : "";
    if (!rawEmail || rawEmail.length > 254 || !EMAIL_PATTERN.test(rawEmail)) {
      return res.status(400).json({ success: false, error: "A valid company email is required" });
    }

    const password = body.password;
    if (
      typeof password !== "string" ||
      password.trim().length === 0 ||
      password.length < MIN_PASSWORD_LENGTH ||
      Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES
    ) {
      return res.status(400).json({
        success: false,
        error: `Password is required and must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_BYTES} bytes`,
      });
    }

    if (registrationsInFlight >= maxConcurrentRegistrations) {
      return res.status(503).json({
        success: false,
        error: "Registration service is busy. Please retry shortly.",
      });
    }

    registrationsInFlight++;
    let passwordHash: string;
    try {
      passwordHash = await hashFn(password);
    } catch {
      return res.status(500).json({
        success: false,
        error: "Unable to process registration credentials",
      });
    } finally {
      registrationsInFlight--;
    }

    const cleanSlug = rawCompanyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "company";
    const requestedSlug =
      typeof body.companySlug === "string" && body.companySlug.trim()
        ? body.companySlug
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "")
        : cleanSlug;
    const dateStr = new Date().toISOString().split("T")[0];
    const adminEmail =
      typeof body.adminEmail === "string" && EMAIL_PATTERN.test(body.adminEmail.trim())
        ? body.adminEmail.trim()
        : rawEmail;
    const allocatedAgents =
      typeof body.allocatedAgents === "number" &&
        Number.isInteger(body.allocatedAgents) &&
        body.allocatedAgents >= 1 &&
        body.allocatedAgents <= 500
        ? body.allocatedAgents
        : 5;
    const channels = Array.isArray(body.channels) &&
      body.channels.every((c: unknown) => typeof c === "string" && c.trim().length > 0 && c.length <= 32)
      ? body.channels.slice(0, 10)
      : ["Web"];

    const newReg = normalizeRegistration({
      id: `reg-${Date.now()}-${randomBytes(3).toString("hex")}`,
      companyName: rawCompanyName,
      name: rawCompanyName,
      companySlug: requestedSlug || cleanSlug,
      businessRegNumber:
        typeof body.businessRegNumber === "string" && body.businessRegNumber.trim()
          ? body.businessRegNumber.trim().slice(0, 64)
          : "BR-PENDING",
      companyEmail: rawEmail,
      email: rawEmail,
      adminName:
        typeof body.adminName === "string" && body.adminName.trim()
          ? body.adminName.trim().slice(0, 120)
          : "Admin",
      adminEmail,
      adminPhone:
        typeof body.adminPhone === "string" && body.adminPhone.trim()
          ? body.adminPhone.trim().slice(0, 40)
          : typeof body.phone === "string" && body.phone.trim()
            ? body.phone.trim().slice(0, 40)
            : "-",
      phone:
        typeof body.phone === "string" && body.phone.trim()
          ? body.phone.trim().slice(0, 40)
          : typeof body.adminPhone === "string" && body.adminPhone.trim()
            ? body.adminPhone.trim().slice(0, 40)
            : "-",
      website: typeof body.website === "string" && body.website.trim() ? body.website.trim().slice(0, 200) : "-",
      industry:
        typeof body.industry === "string" && body.industry.trim()
          ? body.industry.trim().slice(0, 80)
          : typeof body.companyType === "string" && body.companyType.trim()
            ? body.companyType.trim().slice(0, 80)
            : "Technology",
      companyType:
        typeof body.companyType === "string" && body.companyType.trim()
          ? body.companyType.trim().slice(0, 80)
          : typeof body.industry === "string" && body.industry.trim()
            ? body.industry.trim().slice(0, 80)
            : "Technology",
      country: typeof body.country === "string" && body.country.trim() ? body.country.trim().slice(0, 80) : "Sri Lanka",
      city: typeof body.city === "string" ? body.city.trim().slice(0, 80) : "",
      address: typeof body.address === "string" ? body.address.trim().slice(0, 240) : "",
      employeeCount: typeof body.employeeCount === "string" ? body.employeeCount.trim().slice(0, 40) : "",
      about: typeof body.about === "string" ? body.about.trim().slice(0, 1000) : "",
      passwordHash,
      status: "Pending",
      submissionDate: dateStr,
      date: dateStr,
      requestedDate: dateStr,
      tier: typeof body.tier === "string" && body.tier.trim() ? body.tier.trim().slice(0, 40) : "Standard",
      allocatedAgents,
      channels,
    });

    // Read-modify-write happens synchronously after awaiting hashPassword so
    // concurrent registration submissions cannot overwrite one another.
    const db = options.store.readDB();
    db.registrations.push(newReg);
    options.store.writeDB(db);

    return res.status(201).json({
      success: true,
      registration: redactRegistrationCredentials(newReg),
    });
  });

  return router;
}
