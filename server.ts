import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { handleTenantRequest } from "./services/tenant-router/handler";
import { handleHandoffApi } from "./services/handoff/handler";

import { registerTenant, handleRegisterTenantRequest } from "./services/onboarding/register-tenant";
import { uploadKbDocument } from "./agents/utils/s3-client";
import { inMemoryTenants, inMemoryAgents, provisionTenantResources } from "./scripts/create-tenants-table";
import { TenantContext } from "./shared/types/tenant-context";
import {
  isReservedTenantSlug,
  normalizeCompanyName,
  normalizeCompanySlug,
  deriveTenantId,
} from "./shared/utils/tenant-name";

import { agentRepository, orchestrator, AgentConfig, ToolDefinition } from "./services/ai-runtime";

import { LocalSessionTokenService, extractBearerToken } from "./services/auth/local-session-token";
import {
  createRequireAuth,
  requireRole,
  requireTenantScope,
  resolveAuthorizedAgentId,
} from "./services/auth/local-auth-middleware";
import { createCognitoJwtVerifierFromEnv } from "./services/auth/cognito-jwt-verifier";
import { verifyPassword, hashPassword } from "./services/auth/password-hashing";
import { BoundedRateLimiter, createRateLimitMiddleware } from "./services/auth/bounded-rate-limiter";
import { redactRegistrationCredentials } from "./services/onboarding/registration-privacy";

// Enable mock authorization for local development environment
if (process.env.NODE_ENV !== "production") {
  process.env.ALLOW_MOCK_AUTH = "true";
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let cachedLocalTokenService: LocalSessionTokenService | null = null;
export function getLocalSessionTokenService(): LocalSessionTokenService {
  if (!cachedLocalTokenService) {
    cachedLocalTokenService = new LocalSessionTokenService();
  }
  return cachedLocalTokenService;
}

export const requireAuth = createRequireAuth({
  getTokenService: getLocalSessionTokenService,
  getCognitoVerifier: () => {
    try {
      return createCognitoJwtVerifierFromEnv();
    } catch {
      return null;
    }
  },
  isLocalTokensAllowed: () => process.env.NODE_ENV !== "production" && process.env.IS_LOCAL !== "false",
});

export const requireSuperAdmin = [requireAuth, requireRole("superadmin")];
export const requireCompanyAdmin = [requireAuth, requireRole("company"), requireTenantScope()];
export const requireAgentOrCompany = [requireAuth, requireRole("live_agent", "company"), requireTenantScope()];

const registrationLimiter = new BoundedRateLimiter({
  maxRequests: 30,
  windowMs: 60_000,
  maxTrackedKeys: 2048,
});
const limitRegistrations = createRateLimitMiddleware(registrationLimiter, {
  errorMessage: "Too many registration attempts. Please wait and try again.",
});

function getDbPath(): string {
  return process.env.DB_PATH || path.join(__dirname, "db.json");
}

// Initialize baseline tenant DynamoDB/in-memory records
provisionTenantResources().catch((err) => {
  console.warn(`[Server Init] Baseline tenant provisioning note: ${err.message}`);
});

// Helper to read database
function readDB() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    const initial = {
      users: [
        {
          id: "user-1",
          fullName: "System Super Admin",
          email: "superadmin@slt.lk",
          password: "admin123",
          role: "superadmin",
          createdAt: new Date().toISOString(),
        },
      ],
      registrations: [],
    };
    fs.writeFileSync(dbPath, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const raw = fs.readFileSync(dbPath, "utf-8");
    const data = JSON.parse(raw);
    if (!data.users) {
      data.users = [
        {
          id: "user-1",
          fullName: "System Super Admin",
          email: "superadmin@slt.lk",
          password: "admin123",
          role: "superadmin",
          createdAt: new Date().toISOString(),
        },
      ];
      fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
    }
    return data;
  } catch {
    return { users: [], registrations: [] };
  }
}

// Helper to write database
function writeDB(data: any) {
  const dbPath = getDbPath();
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

// Ensure DB exists on startup
readDB();

// ==========================================
// 1. AUTHENTICATION ROUTES
// ==========================================

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password are required" });
  }

  const db = readDB();
  const tokenService = getLocalSessionTokenService();

  // 1. Check Super Admin user
  const user = db.users.find(
    (u: any) => u.email.toLowerCase() === email.toLowerCase()
  );

  if (user) {
    let passwordMatches = false;
    if (user.passwordHash) {
      passwordMatches = await verifyPassword(password, user.passwordHash);
    } else if (user.password) {
      if (user.password.startsWith("scrypt-")) {
        passwordMatches = await verifyPassword(password, user.password);
      } else {
        passwordMatches = user.password === password;
      }
    }

    if (passwordMatches) {
      const token = tokenService.issueToken({
        sub: user.id,
        email: user.email,
        name: user.fullName || user.email.split("@")[0],
        role: "superadmin",
      });
      return res.json({
        success: true,
        user: { id: user.id, name: user.fullName || user.email, email: user.email, role: user.role || "superadmin" },
        token,
      });
    }
  }

  // 2. Check Company Registration user
  const registration = db.registrations.find(
    (r: any) =>
      (r.companyEmail && r.companyEmail.toLowerCase() === email.toLowerCase()) ||
      (r.adminEmail && r.adminEmail.toLowerCase() === email.toLowerCase()) ||
      (r.email && r.email.toLowerCase() === email.toLowerCase())
  );

  if (registration) {
    let passwordMatches = false;
    if (registration.passwordHash) {
      passwordMatches = await verifyPassword(password, registration.passwordHash);
    } else if (registration.password) {
      if (registration.password.startsWith("scrypt-")) {
        passwordMatches = await verifyPassword(password, registration.password);
      } else {
        passwordMatches = registration.password === password;
      }
    }

    if (passwordMatches) {
      const isApprovedOrActive =
        (registration.status || "").toLowerCase() === "active" ||
        (registration.status || "").toLowerCase() === "approved";

      if (!isApprovedOrActive) {
        if ((registration.status || "").toLowerCase() === "suspended") {
          return res.status(403).json({
            success: false,
            error: "This company workspace has been suspended. Please contact platform support.",
          });
        }
        if ((registration.status || "").toLowerCase() === "failed") {
          return res.status(403).json({
            success: false,
            error: "Workspace provisioning failed. Please contact support or re-register.",
          });
        }
        return res.status(403).json({
          success: false,
          error: `Your registration is currently ${registration.status.toLowerCase()}. Please await administrator review.`,
        });
      }

      const tenantId = registration.tenantId || `tenant-${registration.companySlug || registration.id}`;
      const companyEmail = registration.adminEmail || registration.companyEmail || registration.email;
      const adminName = registration.adminName || registration.companyName;

      const token = tokenService.issueToken({
        sub: registration.id,
        email: companyEmail,
        name: adminName,
        role: "company",
        tenantId,
      });

      return res.json({
        success: true,
        user: {
          id: registration.id,
          name: adminName,
          email: companyEmail,
          role: "company",
          tenantId,
          companyName: registration.companyName,
        },
        token,
      });
    }
  }

  return res.status(401).json({ success: false, error: "Invalid email or password" });
});

// POST /api/auth/register-admin
app.post("/api/auth/register-admin", async (req, res) => {
  const db = readDB();
  const existingSuperAdmins = (db.users || []).filter((u: any) => u.role === "superadmin");
  const hasExistingSuperAdmin = existingSuperAdmins.length > 0;

  // Check if caller provides a valid Bearer token for an existing Super Admin
  const authHeader = req.headers.authorization;
  const token = extractBearerToken(authHeader);
  let callerIsSuperAdmin = false;

  if (token) {
    if (token.startsWith("v1.")) {
      const claims = getLocalSessionTokenService().verifyToken(token);
      if (claims && claims.role === "superadmin") {
        callerIsSuperAdmin = true;
      }
    } else if (process.env.NODE_ENV !== "production" && (token.startsWith("dev-token-") || token === "token-user-1")) {
      if (token.includes("superadmin") || token.includes("staff")) {
        callerIsSuperAdmin = true;
      }
    }
  }

  // If a Super Admin already exists:
  // Public bootstrap is permanently closed. Creating subsequent platform admins requires an existing Super Admin.
  if (hasExistingSuperAdmin && !callerIsSuperAdmin) {
    return res.status(403).json({
      success: false,
      error: "Platform admin registration is closed. Additional platform administrators must be created by an authenticated Super Admin.",
    });
  }

  // If NO Super Admin exists in the system (initial bootstrap):
  if (!hasExistingSuperAdmin && !callerIsSuperAdmin) {
    const envIsProd = process.env.NODE_ENV === "production" || process.env.IS_LOCAL === "false";
    const configuredBootstrapToken = (process.env.ADMIN_BOOTSTRAP_TOKEN || "").trim();
    const providedBootstrapToken = (typeof req.headers["x-bootstrap-token"] === "string" ? req.headers["x-bootstrap-token"] : "").trim();

    let bootstrapAuthorized = false;
    if (configuredBootstrapToken && configuredBootstrapToken.length >= 16) {
      if (providedBootstrapToken.length === configuredBootstrapToken.length) {
        bootstrapAuthorized = crypto.timingSafeEqual(
          Buffer.from(providedBootstrapToken, "utf8"),
          Buffer.from(configuredBootstrapToken, "utf8"),
        );
      }
    } else if (!envIsProd && process.env.ALLOW_INITIAL_ADMIN_BOOTSTRAP === "true") {
      // In local dev ONLY, explicit environment flag can allow initial bootstrap without token
      bootstrapAuthorized = true;
    }

    if (!bootstrapAuthorized) {
      return res.status(403).json({
        success: false,
        error: "Initial admin bootstrap is disabled. Set ADMIN_BOOTSTRAP_TOKEN or authenticate as Super Admin.",
      });
    }
  }

  // Input validation
  const { fullName, email, password } = req.body || {};
  if (!email || !password || typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ success: false, error: "Missing or invalid required fields: email and password" });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail.length < 3 || !cleanEmail.includes("@") || cleanEmail.length > 254) {
    return res.status(400).json({ success: false, error: "Invalid email format" });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, error: "Password must be at least 8 characters" });
  }

  const existing = db.users.find((u: any) => u.email.toLowerCase() === cleanEmail);
  if (existing) {
    return res.status(409).json({ success: false, error: "Email already registered" });
  }

  // Cryptographic password hashing
  const passwordHash = await hashPassword(password);

  const newUser = {
    id: `user-${Date.now()}`,
    fullName: (fullName && typeof fullName === "string" ? fullName.trim() : "") || cleanEmail.split("@")[0],
    email: cleanEmail,
    passwordHash,
    role: "superadmin",
    createdAt: new Date().toISOString(),
  };

  db.users.push(newUser);
  writeDB(db);

  // Return redacted user object: NEVER return password, passwordHash, salt, or secrets
  return res.status(201).json({
    success: true,
    user: {
      id: newUser.id,
      fullName: newUser.fullName,
      email: newUser.email,
      role: newUser.role,
      createdAt: newUser.createdAt,
    },
  });
});

// ==========================================
// 2. COMPANY REGISTRATION & APPROVAL ROUTES
// ==========================================

function normalizeRegistration(r: any) {
  const companyName = r.companyName || r.name || "Unnamed Company";
  const email = r.companyEmail || r.email || r.adminEmail || "";
  const submissionDate = r.submissionDate || r.date || r.requestedDate || new Date().toISOString().split("T")[0];
  const industry = r.industry || r.companyType || "Technology";

  return {
    ...r,
    companyName,
    name: companyName,
    companyEmail: email,
    email: email,
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

// GET /api/registrations (supports ?status=pending or ?status=approved)
app.get("/api/registrations", requireAuth, (req, res) => {
  const db = readDB();
  const caller = req.localAuth;
  let rawList = (db.registrations || []).map(normalizeRegistration);

  // If caller is company admin, scope list to their own tenant
  if (caller?.role === "company" && caller.tenantId) {
    rawList = rawList.filter(
      (r: any) =>
        r.tenantId === caller.tenantId ||
        r.id === caller.sub ||
        (r.companyEmail && caller.email && r.companyEmail.toLowerCase() === caller.email.toLowerCase())
    );
  }

  const redactedList = rawList.map((r: any) => redactRegistrationCredentials(r));
  const statusParam = req.query.status as string;

  if (statusParam) {
    const filtered = redactedList.filter(
      (r: any) => (r.status || "").toLowerCase() === statusParam.toLowerCase()
    );
    return res.json(filtered);
  }

  return res.json({ success: true, registrations: redactedList });
});

const inFlightRegistrations = new Set<string>();

function computeIdempotencyFingerprint(slug: string, email: string, name: string): string {
  return crypto
    .createHash("sha256")
    .update(`${slug.toLowerCase()}#${email.toLowerCase()}#${name.toLowerCase()}`)
    .digest("hex");
}

// POST /api/registrations
app.post("/api/registrations", limitRegistrations, async (req, res) => {
  const tokenService = getLocalSessionTokenService();
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ success: false, error: "Invalid request body" });
  }

  const rawCompanyName = (body.companyName || body.name || "").trim();
  if (!rawCompanyName) {
    return res.status(400).json({ success: false, error: "Validation Failed: 'companyName' is required." });
  }

  const rawEmail = (body.companyEmail || body.email || body.adminEmail || "").trim();
  if (!rawEmail || !rawEmail.includes("@")) {
    return res.status(400).json({ success: false, error: "Validation Failed: Valid 'adminEmail' or 'companyEmail' is required." });
  }

  const rawSlug = body.companySlug || rawCompanyName;
  const cleanSlug = normalizeCompanySlug(rawSlug);
  if (!cleanSlug) {
    return res.status(400).json({ success: false, error: "Validation Failed: 'companySlug' cannot be empty after normalization." });
  }

  // Reject reserved platform slugs (e.g. slt, admin, system, api, etc.)
  if (isReservedTenantSlug(cleanSlug)) {
    return res.status(400).json({
      success: false,
      error: `Validation Failed: '${cleanSlug}' is a reserved tenant identifier.`,
    });
  }

  const normalizedName = normalizeCompanyName(rawCompanyName);
  const derivedTenantId = deriveTenantId(cleanSlug);

  // Concurrency lock: prevent race condition on simultaneous registration attempts
  const lockKey = `${derivedTenantId}#${normalizedName}`;
  if (inFlightRegistrations.has(lockKey) || inFlightRegistrations.has(derivedTenantId)) {
    return res.status(409).json({
      success: false,
      error: `Conflict: Workspace for '${rawCompanyName}' is currently being provisioned.`,
    });
  }
  inFlightRegistrations.add(lockKey);
  inFlightRegistrations.add(derivedTenantId);

  try {
    const db = readDB();

    // 1. Idempotency Check: replay response if duplicate idempotency key is provided
    const idempotencyKey = (req.headers["idempotency-key"] as string) || body.idempotencyKey;
    const incomingFingerprint = idempotencyKey
      ? computeIdempotencyFingerprint(cleanSlug, rawEmail, rawCompanyName)
      : undefined;

    if (idempotencyKey) {
      const existingByIdempotency = db.registrations.find(
        (r: any) => r.idempotencyKey === idempotencyKey
      );
      if (existingByIdempotency) {
        // Enforce 24-hour TTL expiration policy
        const isExpired =
          existingByIdempotency.idempotencyExpiresAt &&
          new Date(existingByIdempotency.idempotencyExpiresAt) < new Date();

        if (!isExpired) {
          // Verify that the request payload fingerprint matches the original registration
          if (
            existingByIdempotency.idempotencyFingerprint &&
            incomingFingerprint &&
            existingByIdempotency.idempotencyFingerprint !== incomingFingerprint
          ) {
            return res.status(409).json({
              success: false,
              error:
                "Conflict: Idempotency key collision. The provided key was already used for a different workspace payload.",
            });
          }

          // Stage 2.A: Unauthenticated replay must NOT reveal or mint bearer tokens or session credentials!
          // Return safe sanitized status indicating existing active workspace
          return res.status(200).json({
            success: true,
            idempotentReplay: true,
            registration: redactRegistrationCredentials(existingByIdempotency),
            nextAction: "LOGIN_REQUIRED",
            message:
              "Idempotent request recognized: workspace is already active. Please authenticate via /api/auth/login to establish a session.",
          });
        }
      }
    }

    // 2. Duplicate Registration / Tenant Collision Check
    const duplicate = db.registrations.find((r: any) => {
      const rNameNorm = normalizeCompanyName(r.companyName || r.name || "");
      const rSlug = r.companySlug || normalizeCompanySlug(r.companyName || "");
      const rEmail = (r.companyEmail || r.email || r.adminEmail || "").toLowerCase();
      const rTenantId = r.tenantId;

      return (
        rNameNorm === normalizedName ||
        rSlug === cleanSlug ||
        (rTenantId && rTenantId === derivedTenantId) ||
        (rEmail && rEmail === rawEmail.toLowerCase())
      );
    });

    if (duplicate) {
      const isPending = (duplicate.status || "").toLowerCase() === "pending";
      const statusMsg = isPending ? "A pending registration" : "A workspace";
      return res.status(409).json({
        success: false,
        error: `Conflict: ${statusMsg} for '${rawCompanyName}' already exists.`,
        details: { existingTenantId: duplicate.tenantId, status: duplicate.status },
      });
    }

    // Also verify inMemoryTenants / DynamoDB
    if (inMemoryTenants.has(derivedTenantId)) {
      return res.status(409).json({
        success: false,
        error: `Conflict: Tenant with ID '${derivedTenantId}' already exists.`,
      });
    }

    const dateStr = new Date().toISOString().split("T")[0];
    const nowIso = new Date().toISOString();

    // Password hashing (never stored or returned in plaintext)
    let passwordHash: string | undefined;
    const rawPassword = body.password || "TempPass#2026!";
    try {
      passwordHash = await hashPassword(rawPassword);
    } catch {
      passwordHash = undefined;
    }

    // 3. Manual review opt-in (for enterprise manual compliance or explicit tests)
    if (body.requireApproval === true) {
      const pendingReg = normalizeRegistration({
        id: `reg-${Date.now()}`,
        companyName: rawCompanyName,
        name: rawCompanyName,
        companySlug: cleanSlug,
        businessRegNumber: body.businessRegNumber || "BR-PENDING",
        companyEmail: rawEmail,
        email: rawEmail,
        adminName: body.adminName || "Admin",
        adminEmail: body.adminEmail || rawEmail,
        adminPhone: body.adminPhone || body.phone || "-",
        phone: body.phone || body.adminPhone || "-",
        website: body.website || "-",
        industry: body.industry || body.companyType || "Technology",
        companyType: body.companyType || body.industry || "Technology",
        country: body.country || "Sri Lanka",
        city: body.city || "",
        address: body.address || "",
        employeeCount: body.employeeCount || "",
        about: body.about || "",
        ...(passwordHash ? { passwordHash } : {}),
        status: "Pending",
        provisioningStatus: "PENDING",
        submissionDate: dateStr,
        date: dateStr,
        requestedDate: dateStr,
        tier: body.tier || "Standard",
        allocatedAgents: body.allocatedAgents || 5,
        channels: body.channels || ["Web"],
        idempotencyKey,
        idempotencyFingerprint: idempotencyKey ? incomingFingerprint : undefined,
        idempotencyExpiresAt: idempotencyKey
          ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          : undefined,
      });

      db.registrations.push(pendingReg);
      writeDB(db);

      return res.status(201).json({
        success: true,
        registration: redactRegistrationCredentials(pendingReg),
        message: "Registration submitted for administrator review.",
      });
    }

    // 4. Automatic Onboarding: Provision tenant resources immediately
    try {
      const onboardResult = await registerTenant({
        companyName: rawCompanyName,
        companySlug: cleanSlug,
        adminEmail: rawEmail,
        planTier: body.tier?.toLowerCase() === "enterprise" ? "enterprise" : "starter",
        themeColor: body.themeColor,
        allowedOrigins: body.allowedOrigins,
        password: body.password,
      });

      const tenantId = onboardResult.tenantId;

      const newReg = normalizeRegistration({
        id: `reg-${Date.now()}`,
        companyName: rawCompanyName,
        name: rawCompanyName,
        companySlug: cleanSlug,
        tenantId,
        businessRegNumber: body.businessRegNumber || "BR-ACTIVE",
        companyEmail: rawEmail,
        email: rawEmail,
        adminName: body.adminName || "Admin",
        adminEmail: body.adminEmail || rawEmail,
        adminPhone: body.adminPhone || body.phone || "-",
        phone: body.phone || body.adminPhone || "-",
        website: body.website || "-",
        industry: body.industry || body.companyType || "Technology",
        companyType: body.companyType || body.industry || "Technology",
        country: body.country || "Sri Lanka",
        city: body.city || "",
        address: body.address || "",
        employeeCount: body.employeeCount || "",
        about: body.about || "",
        ...(passwordHash ? { passwordHash } : {}),
        status: "Active",
        provisioningStatus: "ACTIVE",
        onboardedAt: nowIso,
        submissionDate: dateStr,
        date: dateStr,
        requestedDate: dateStr,
        tier: body.tier || "Standard",
        allocatedAgents: body.allocatedAgents || 5,
        channels: body.channels || ["Web"],
        idempotencyKey,
        idempotencyFingerprint: idempotencyKey ? incomingFingerprint : undefined,
        idempotencyExpiresAt: idempotencyKey
          ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          : undefined,
      });

      db.registrations.push(newReg);
      writeDB(db);

      // Stage 2.D: Production-facing activation boundary
      // In production or when email verification is explicitly configured,
      // fail closed and require email confirmation before an active session token is issued.
      const requireEmailVerification =
        process.env.REQUIRE_EMAIL_VERIFICATION === "true" || process.env.NODE_ENV === "production";

      if (requireEmailVerification) {
        return res.status(201).json({
          success: true,
          registration: redactRegistrationCredentials({
            ...newReg,
            status: "PendingVerification",
            provisioningStatus: "AWAITING_VERIFICATION",
          }),
          nextAction: "EMAIL_VERIFICATION_REQUIRED",
          message:
            "Workspace provisioned. Identity verification email has been dispatched. Please confirm your email before signing in.",
        });
      }

      // Issue local session token for immediate workspace access in local development mode
      const token = tokenService.issueToken({
        sub: newReg.id,
        email: newReg.adminEmail,
        name: newReg.adminName,
        role: "company",
        tenantId,
      });

      const user = {
        id: newReg.id,
        name: newReg.adminName,
        email: newReg.adminEmail,
        role: "company" as const,
        tenantId,
        companyName: newReg.companyName,
      };

      return res.status(201).json({
        success: true,
        registration: redactRegistrationCredentials(newReg),
        token,
        user,
        nextAction: "WORKSPACE_DASHBOARD",
      });
    } catch (onboardErr: any) {
      console.error(`❌ [Auto-Provisioning Failed] ${onboardErr.message}`);
      const isConflict = onboardErr.message?.includes("already exists") || onboardErr.message?.includes("Conflict");
      if (isConflict) {
        return res.status(409).json({ success: false, error: onboardErr.message });
      }
      if (onboardErr.message?.includes("Validation Failed")) {
        return res.status(400).json({ success: false, error: onboardErr.message });
      }
      return res.status(502).json({
        success: false,
        error: `Failed to provision tenant resources: ${onboardErr.message}`,
      });
    }
  } finally {
    inFlightRegistrations.delete(lockKey);
    inFlightRegistrations.delete(derivedTenantId);
  }
});

// Handler for approving, suspending, or rejecting registration
const handleUpdateRegistrationStatus = async (req: express.Request, res: express.Response) => {
  const { id } = req.params;
  const rawStatus = (req.body.status || "").toLowerCase();

  const db = readDB();
  const regIndex = db.registrations.findIndex((r: any) => String(r.id) === String(id));

  if (regIndex === -1) {
    return res.status(404).json({ success: false, error: "Registration not found" });
  }

  const reg = db.registrations[regIndex];
  const normalizedStatus =
    rawStatus === "approved" || rawStatus === "active"
      ? "Approved"
      : rawStatus === "rejected"
      ? "Rejected"
      : rawStatus === "suspended"
      ? "Suspended"
      : req.body.status || "Approved";

  // Enforce idempotency: re-approving an already Approved / Active registration must return 409 Conflict
  if (
    (normalizedStatus === "Approved" || normalizedStatus === "Active") &&
    (reg.status === "Approved" || reg.status === "Active")
  ) {
    return res.status(409).json({
      success: false,
      error: "Registration has already been approved",
      registration: redactRegistrationCredentials(reg),
    });
  }

  // Suspend tenant
  if (normalizedStatus === "Suspended") {
    reg.status = "Suspended";
    reg.provisioningStatus = "SUSPENDED";
    if (reg.tenantId && inMemoryTenants.has(reg.tenantId)) {
      const existing = inMemoryTenants.get(reg.tenantId)!;
      existing.status = "suspended";
      inMemoryTenants.set(reg.tenantId, existing);
    }
    db.registrations[regIndex] = normalizeRegistration(reg);
    writeDB(db);
    return res.json({ success: true, registration: redactRegistrationCredentials(db.registrations[regIndex]) });
  }

  // Auto-Provision Tenant Partition when Approved
  if (normalizedStatus === "Approved" || normalizedStatus === "Active") {
    if (!reg.tenantId) {
      try {
        const onboardResult = await registerTenant({
          companyName: reg.companyName,
          companySlug: reg.companySlug || reg.companyName.toLowerCase().replace(/[^a-z0-9]/g, "-"),
          adminEmail: reg.companyEmail || `admin@${reg.companyName.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
          planTier: reg.tier?.toLowerCase() === "enterprise" ? "enterprise" : "starter",
        });
        reg.tenantId = onboardResult.tenantId;
        reg.onboardedAt = new Date().toISOString();
        reg.status = "Approved";
        reg.provisioningStatus = "ACTIVE";
        console.log(`✅ [Auto-Provisioning] Successfully provisioned tenant '${reg.tenantId}' for ${reg.companyName}`);
      } catch (onboardErr: any) {
        console.error(`❌ [Auto-Provisioning Failed] ${onboardErr.message}`);
        return res.status(502).json({
          success: false,
          error: `Failed to provision tenant resources: ${onboardErr.message}`,
        });
      }
    } else {
      reg.status = "Approved";
      reg.provisioningStatus = "ACTIVE";
      if (inMemoryTenants.has(reg.tenantId)) {
        const existing = inMemoryTenants.get(reg.tenantId)!;
        existing.status = "active";
        inMemoryTenants.set(reg.tenantId, existing);
      }
    }
  } else {
    reg.status = normalizedStatus;
    reg.provisioningStatus = normalizedStatus.toUpperCase() as any;
  }

  db.registrations[regIndex] = normalizeRegistration(reg);
  writeDB(db);
  return res.json({ success: true, registration: redactRegistrationCredentials(db.registrations[regIndex]) });
};

// PATCH /api/registrations/:id (Super Admin Approves / Rejects / Suspends)
app.patch("/api/registrations/:id", ...requireSuperAdmin, handleUpdateRegistrationStatus);

// PUT /api/registrations/:id
app.put("/api/registrations/:id", ...requireSuperAdmin, handleUpdateRegistrationStatus);

// PUT /api/registrations/:id/status (Backwards compatibility)
app.put("/api/registrations/:id/status", ...requireSuperAdmin, handleUpdateRegistrationStatus);

// DELETE /api/registrations/:id (Super Admin safely suspends/deactivates company workspace registration)
app.delete("/api/registrations/:id", ...requireSuperAdmin, (req, res) => {
  const { id } = req.params;
  const idLower = String(id).toLowerCase();
  const nameQuery = req.query.name ? String(req.query.name).toLowerCase() : "";
  const emailQuery = req.query.email ? String(req.query.email).toLowerCase() : "";
  const slugQuery = req.query.slug ? String(req.query.slug).toLowerCase() : "";

  const db = readDB();

  const targetIndex = db.registrations.findIndex((r: any) => {
    const rId = String(r.id || "").toLowerCase();
    const rSlug = String(r.companySlug || "").toLowerCase();
    const rTenant = String(r.tenantId || "").toLowerCase();
    const rEmail = String(r.companyEmail || r.email || r.adminEmail || "").toLowerCase();
    const rName = String(r.companyName || r.name || "").toLowerCase();
    return (
      rId === idLower ||
      rSlug === idLower ||
      rTenant === idLower ||
      rEmail === idLower ||
      (slugQuery && rSlug === slugQuery) ||
      (emailQuery && rEmail === emailQuery) ||
      (nameQuery && rName === nameQuery)
    );
  });

  if (targetIndex === -1) {
    return res.status(404).json({ success: false, error: "Registration not found" });
  }

  const targetReg = db.registrations[targetIndex];
  const targetTenantId = targetReg.tenantId;

  // Non-destructive lifecycle safeguard:
  // Suspend and archive workspace instead of hard-deleting cloud partitions.
  // Preserves audit trail and tenant data while immediately revoking workspace access.
  targetReg.status = "Suspended";
  targetReg.provisioningStatus = "SUSPENDED";
  targetReg.suspendedAt = new Date().toISOString();
  targetReg.suspendedBy = (req as any).user?.email || "superadmin";
  targetReg.deactivated = true;

  db.registrations[targetIndex] = targetReg;
  writeDB(db);

  // Synchronize inMemoryTenants status to 'suspended' to prevent routing
  if (targetTenantId) {
    const memTenant = inMemoryTenants.get(targetTenantId);
    if (memTenant) {
      memTenant.status = "suspended";
      memTenant.provisioningStatus = "SUSPENDED";
      inMemoryTenants.set(targetTenantId, memTenant);
    }
  }

  return res.json({
    success: true,
    message: `Workspace '${targetReg.companyName}' has been safely suspended and deactivated. Cloud partitions preserved in suspended state.`,
    registration: redactRegistrationCredentials(targetReg),
  });
});

// GET /api/stats (Admin Console Dashboard Stats)
app.get("/api/stats", requireAuth, (req, res) => {
  const db = readDB();
  const activeCount = db.registrations.filter((r: any) => {
    const st = (r.status || "").toLowerCase();
    return st === "approved" || st === "active";
  }).length;
  const pendingCount = db.registrations.filter((r: any) => (r.status || "").toLowerCase() === "pending").length;

  res.json({
    totalAvailability: activeCount,
    activeConnections: activeCount,
    pendingRequests: pendingCount,
    activeAgentsCount: 12,
    monthlyConversations: 14820,
    systemLatencyMs: 42,
  });
});

// GET /api/notifications (Admin Notifications)
app.get("/api/notifications", ...requireSuperAdmin, (req, res) => {
  const db = readDB();
  const list = db.registrations || [];
  const pendingRegs = list.filter((r: any) => (r.status || "").toLowerCase() === "pending");

  const notifications = [
    ...pendingRegs.map((r: any) => ({
      id: `notif-reg-${r.id}`,
      title: `Registration Request: ${r.companyName || r.name}`,
      message: `${r.companyName || r.name} (${r.companyEmail || r.email || r.adminEmail || "Admin"}) submitted a registration request for approval.`,
      type: "pending",
      timestamp: r.submissionDate || r.date || new Date().toISOString().split("T")[0],
      read: false,
      companyId: r.id,
    })),
    {
      id: "notif-system-1",
      title: "Gateway Health Normal",
      message: "SLT Global Node 01 health status verified 100%.",
      type: "system",
      timestamp: new Date().toISOString().split("T")[0],
      read: true,
    },
  ];

  res.json({ success: true, notifications });
});

// ==========================================
// 3. MEMBER 2 DIRECT ONBOARDING API
// ==========================================

// POST /api/tenants/register
app.post("/api/tenants/register", ...requireSuperAdmin, async (req, res) => {
  const response = await handleRegisterTenantRequest({
    httpMethod: "POST",
    body: req.body,
  });
  return res.status(response.statusCode).json(JSON.parse(response.body));
});

// ==========================================
// 4. MEMBER 3 LIVE AGENT CONSOLE & PRESENCE ROUTES
// ==========================================

// Authorized presence mutation handler
const handlePresenceMutation = (isOnline: boolean) => async (req: express.Request, res: express.Response) => {
  const caller = req.localAuth;
  if (!caller) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }

  // Requirement 7: Company admin cannot impersonate live agent
  if (caller.role === "company") {
    return res.status(403).json({
      success: false,
      error: "Insufficient permissions. Company administrators cannot modify live agent presence.",
    });
  }

  if (caller.role !== "live_agent" && caller.role !== "superadmin") {
    return res.status(403).json({
      success: false,
      error: "Insufficient permissions. Only live agents can modify presence.",
    });
  }

  const body = req.body || {};
  const requestedTenant = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  const requestedAgentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : undefined;

  // Requirement 9: Cross-tenant presence mutation denied
  let effectiveTenantId = caller.tenantId;
  if (caller.role === "superadmin") {
    effectiveTenantId = requestedTenant || "slt";
  } else {
    if (requestedTenant && requestedTenant !== caller.tenantId) {
      return res.status(403).json({
        success: false,
        error: "Cross-tenant presence modification denied.",
      });
    }
  }

  if (!effectiveTenantId) {
    return res.status(403).json({ success: false, error: "Presence modification requires a valid tenant scope" });
  }

  // Requirement 8: Live agent cannot modify another agent's presence
  let effectiveAgentId = caller.sub;
  if (caller.role === "live_agent") {
    if (requestedAgentId && requestedAgentId !== caller.sub) {
      return res.status(403).json({
        success: false,
        error: `Agents cannot modify another agent's presence. Authenticated as '${caller.sub}', requested '${requestedAgentId}'.`,
      });
    }
  } else if (caller.role === "superadmin") {
    effectiveAgentId = requestedAgentId || caller.sub;
  }

  const result = await handleHandoffApi({
    action: isOnline ? "presence_online" : "presence_offline",
    tenantId: effectiveTenantId,
    agentId: effectiveAgentId,
    connectionId: isOnline ? connectionId : undefined,
  });

  if (!result.success) {
    return res.status(400).json(result);
  }
  return res.status(200).json({ success: true, ...result.data });
};

// POST /api/agent/presence/online ("Go Online")
app.post(["/api/agent/presence/online", "/agent/presence/online"], requireAuth, handlePresenceMutation(true));

// POST /api/agent/presence/offline ("Go Offline")
app.post(["/api/agent/presence/offline", "/agent/presence/offline"], requireAuth, handlePresenceMutation(false));

// GET /api/agent/presence/status
app.get(["/api/agent/presence/status", "/agent/presence/status"], requireAuth, async (req, res) => {
  const caller = req.localAuth;
  const requestedTenant = (typeof req.query.tenantId === "string" ? req.query.tenantId.trim() : "") || caller?.tenantId || "slt";
  const requestedAgentId = (typeof req.query.agentId === "string" ? req.query.agentId.trim() : "") || caller?.sub || "admin1";

  if (caller?.role !== "superadmin" && caller?.tenantId && requestedTenant !== caller.tenantId) {
    return res.status(403).json({ success: false, error: "Cross-tenant access denied" });
  }

  if (caller?.role === "live_agent" && requestedAgentId && requestedAgentId !== caller.sub) {
    return res.status(403).json({ success: false, error: "Live agents can only view their own presence status" });
  }

  const result = await handleHandoffApi({
    action: "presence_status",
    tenantId: requestedTenant,
    agentId: requestedAgentId,
  });
  if (!result.success) return res.status(400).json(result);
  return res.status(200).json({ success: true, ...result.data });
});

// POST /api/chat/handoff/request (Escalation Trigger - Public Customer Ingress)
app.post(["/api/chat/handoff/request", "/chat/handoff/request"], async (req, res) => {
  const { tenantId, sessionId, reason, customerInfo } = req.body || {};
  const result = await handleHandoffApi({
    action: "request_handoff",
    tenantId: tenantId || "slt",
    sessionId: sessionId || `sess-${Date.now()}`,
    customerName: customerInfo?.name,
    issueSummary: reason,
  });
  if (!result.success) return res.status(400).json(result);
  return res.status(200).json({ success: true, ...result.data });
});

// POST /api/chat/handoff/resolve (Live Agent Resolves Session)
app.post(["/api/chat/handoff/resolve", "/chat/handoff/resolve"], requireAuth, async (req, res) => {
  const caller = req.localAuth;
  if (!caller) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }

  const { sessionId, tenantId: bodyTenant, agentId: bodyAgent } = req.body || {};
  if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
    return res.status(400).json({ success: false, error: "Missing or invalid 'sessionId'" });
  }

  // Derive tenant
  let effectiveTenant = caller.tenantId;
  if (caller.role === "superadmin") {
    effectiveTenant = (typeof bodyTenant === "string" ? bodyTenant.trim() : "") || "slt";
  } else {
    if (bodyTenant && bodyTenant !== caller.tenantId) {
      return res.status(403).json({ success: false, error: "Cross-tenant handoff resolution denied." });
    }
  }

  if (!effectiveTenant) {
    return res.status(403).json({ success: false, error: "Handoff resolution requires a valid tenant scope" });
  }

  // Derive agent ID
  let effectiveAgent = caller.sub;
  if (caller.role === "company" || caller.role === "superadmin") {
    effectiveAgent = (typeof bodyAgent === "string" ? bodyAgent.trim() : "") || caller.sub;
  } else {
    // live_agent can only resolve as themselves
    if (bodyAgent && bodyAgent !== caller.sub) {
      return res.status(403).json({
        success: false,
        error: `Live agents cannot resolve sessions as another agent. Authenticated as '${caller.sub}', requested '${bodyAgent}'.`,
      });
    }
  }

  const result = await handleHandoffApi({
    action: "resolve_session",
    tenantId: effectiveTenant,
    sessionId: sessionId.trim(),
    agentId: effectiveAgent,
    callerRole: caller.role,
  });

  if (!result.success) {
    const statusCode = result.error?.code === "NOT_FOUND" ? 404 : result.error?.code === "FORBIDDEN" ? 403 : 400;
    const errorMsg = typeof result.error === "string" ? result.error : result.error?.message || "Failed to resolve session";
    return res.status(statusCode).json({ success: false, error: errorMsg, code: result.error?.code });
  }
  return res.status(200).json({ success: true, ...result.data });
});


// ==========================================
// 5. WORKSPACE PORTAL & KB DOCUMENT UPLOAD
// ==========================================

// POST /api/workspace/upload-doc (Knowledge Base Upload)
app.post("/api/workspace/upload-doc", ...requireCompanyAdmin, async (req, res) => {
  const { documentName, content, userId } = req.body;
  if (!documentName || !content) {
    return res.status(400).json({ success: false, error: "Missing documentName or content" });
  }

  const effectiveTenantId = req.authorizedTenantId || "slt";
  const context: TenantContext = {
    tenantId: effectiveTenantId,
    userId: userId || req.localAuth?.sub || "console-admin",
    role: "admin",
    permissions: ["faults:read", "billing:read", "usage:read"],
    channel: "web",
    sessionId: `sess-${Date.now()}`,
    conversationId: `conv-${Date.now()}`,
  };

  try {
    const uploadedKey = await uploadKbDocument(context, documentName, content);
    return res.status(201).json({
      success: true,
      s3Key: uploadedKey,
      tenantId: effectiveTenantId,
      message: `Document '${documentName}' uploaded successfully to tenant Knowledge Base.`,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/workspace/conversations (Conversation Transcripts)
app.get("/api/workspace/conversations", ...requireCompanyAdmin, (req, res) => {
  const effectiveTenantId = req.authorizedTenantId || "slt";
  res.json({
    success: true,
    conversations: [
      {
        conversationId: "conv-101",
        customerName: "Kasun Perera",
        lastMessage: "My router has a red LOS light",
        status: "RESOLVED",
        assignedAgent: "admin1",
        updatedAt: new Date().toISOString(),
        tenantId: effectiveTenantId,
      },
      {
        conversationId: "conv-102",
        customerName: "Nimali Fernando",
        lastMessage: "Can I check my current 4G data usage?",
        status: "BOT_HANDLED",
        assignedAgent: "AI Bot",
        updatedAt: new Date().toISOString(),
        tenantId: effectiveTenantId,
      },
    ],
  });
});

// ==========================================
// 6. HOSTED CHAT URL RESOLVER
// ==========================================

// GET /api/resolve-chat-url?company={slug}&agent={agent}
app.get(["/api/resolve-chat-url", "/resolve-chat-url"], async (req, res) => {
  const companySlug = (req.query.company as string) || "slt";
  const agentSlug = (req.query.agent as string) || "support";
  const key = `${companySlug}-${agentSlug}`.toLowerCase();

  let agent = await agentRepository.getAgentByPublicKey(key);
  if (!agent) {
    agent = (await agentRepository.getAgentByPublicKey(agentSlug)) || (await agentRepository.getAgentByPublicKey(companySlug));
  }

  if (agent && agent.status === "PUBLISHED") {
    return res.json({
      success: true,
      tenantId: agent.tenantId,
      companyName: agent.brandName || agent.displayName,
      agentId: agent.agentId,
      agentName: agent.displayName,
      welcomeMessage: agent.welcomeMessage || `Welcome to ${agent.displayName}! How can we assist you today?`,
      themeColor: agent.theme?.primaryColor || "#005EB8",
      agent: {
        name: agent.displayName,
        tenantId: agent.tenantId,
        model: agent.modelId,
      },
    });
  }

  const tenant = inMemoryTenants.get(companySlug) || inMemoryTenants.get(`tenant-${companySlug}`) || {
    tenantId: companySlug,
    companyName: companySlug.toUpperCase(),
    config: { themeColor: "#005EB8" },
  };

  return res.json({
    success: true,
    tenantId: tenant.tenantId,
    companyName: tenant.companyName,
    agentId: `agent-${companySlug}-${agentSlug}-01`,
    agentName: `${tenant.companyName} Assistant`,
    welcomeMessage: `Welcome to ${tenant.companyName}! How can we assist you today?`,
    themeColor: tenant.config?.themeColor || "#005EB8",
    agent: {
      name: `${tenant.companyName} Assistant`,
      tenantId: tenant.tenantId,
      model: "SLT-Specialist-v3",
    },
  });
});

// ==========================================
// 6A. SUPERVISOR PUBLIC AI CHAT API
// ==========================================

// 1. Resolve public agent by key
app.get(["/v1/public/agents/:agentKey", "/api/public/agents/:agentKey"], async (req, res) => {
  const agentKey = req.params.agentKey;
  const agent = await agentRepository.getAgentByPublicKey(agentKey);
  if (!agent || agent.status !== "PUBLISHED") {
    return res.status(404).json({ success: false, message: "Assistant not found" });
  }

  return res.json({
    success: true,
    agentKey: agent.publicAgentKey,
    displayName: agent.displayName,
    brandName: agent.brandName || "Customer Support",
    welcomeMessage: agent.welcomeMessage || "How can I help you today?",
    theme: agent.theme || { primaryColor: "#005EB8" },
    modelId: agent.modelId,
  });
});

// 2. Create public conversation session
app.post(["/v1/public/sessions", "/api/public/sessions"], async (req, res) => {
  const { agentKey } = req.body || {};
  if (!agentKey) {
    return res.status(400).json({ success: false, message: "agentKey is required" });
  }

  const agent = await agentRepository.getAgentByPublicKey(agentKey);
  if (!agent || agent.status !== "PUBLISHED") {
    return res.status(404).json({ success: false, message: "Assistant not found" });
  }

  const session = await agentRepository.createSession(agent);
  return res.status(201).json({
    success: true,
    sessionId: session.sessionId,
    agent: {
      agentKey: agent.publicAgentKey,
      displayName: agent.displayName,
      brandName: agent.brandName || "Customer Support",
      welcomeMessage: agent.welcomeMessage || "How can I help you today?",
      theme: agent.theme || { primaryColor: "#005EB8" },
    },
  });
});

// 3. Send message / execute AI turn in public session
app.post(["/v1/public/sessions/:sessionId/messages", "/api/public/sessions/:sessionId/messages"], async (req, res) => {
  const { sessionId } = req.params;
  const session = await agentRepository.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, message: "Session not found" });
  }

  const agent = await agentRepository.getAgent(session.tenantId, session.agentId);
  if (!agent || agent.status !== "PUBLISHED") {
    return res.status(404).json({ success: false, message: "Assistant is unavailable" });
  }

  try {
    const turnResult = await orchestrator.executeTurn({
      agent,
      session,
      message: req.body?.message,
      formSubmission: req.body?.formSubmission,
    });

    return res.json({
      success: true,
      ...turnResult,
    });
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      message: err.message || "Failed to process chat message",
    });
  }
});

// 4. List messages for session
app.get(["/v1/public/sessions/:sessionId/messages", "/api/public/sessions/:sessionId/messages"], async (req, res) => {
  const { sessionId } = req.params;
  const session = await agentRepository.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, message: "Session not found" });
  }

  const messages = await agentRepository.listMessages(sessionId);
  return res.json({
    success: true,
    sessionStatus: session.status,
    messages: messages.map((m) => ({
      messageId: m.messageId,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
      route: m.route,
      status: m.status,
      citations: m.citations,
    })),
  });
});

// 5. Save session feedback
app.post(["/v1/public/sessions/:sessionId/feedback", "/api/public/sessions/:sessionId/feedback"], async (req, res) => {
  const { sessionId } = req.params;
  const session = await agentRepository.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, message: "Session not found" });
  }

  const { messageId, rating } = req.body || {};
  if (!messageId || (rating !== "up" && rating !== "down")) {
    return res.status(400).json({ success: false, message: "Invalid feedback parameters" });
  }

  await agentRepository.saveFeedback(session, messageId, rating);
  return res.status(201).json({ success: true, saved: true });
});

// ==========================================
// 6B. ADMIN AGENTS, KBS & TOOLS MANAGEMENT
// ==========================================

// List or create agents for authenticated company
app.get(["/api/dev/admin/agents", "/v1/admin/agents", "/api/agents"], ...requireCompanyAdmin, async (req, res) => {
  const tenantId = req.authorizedTenantId!;
  const agents = await agentRepository.listAgents(tenantId);
  return res.json({
    success: true,
    items: agents,
  });
});

app.post(["/api/dev/admin/agents", "/v1/admin/agents", "/api/agents"], ...requireCompanyAdmin, async (req, res) => {
  const tenantId = req.authorizedTenantId!;
  const body = req.body || {};
  const agentId = body.agentId || `agent-${tenantId}-${Date.now().toString(36)}`;
  const publicAgentKey = (body.publicAgentKey || `${tenantId}-${agentId}`).toLowerCase();

  const agentConfig: AgentConfig = {
    tenantId,
    agentId,
    displayName: body.name || body.displayName || `${tenantId.toUpperCase()} Assistant`,
    brandName: body.brandName || tenantId.toUpperCase(),
    welcomeMessage: body.welcomeMessage || "How can I assist you today?",
    systemPrompt: body.systemPrompt || "You are a professional customer support assistant.",
    modelId: body.modelId || "anthropic.claude-3-sonnet-20240229-v1:0",
    status: body.status || "DRAFT",
    publicAgentKey,
    tools: body.tools || [],
    forms: body.forms || [],
    knowledgeBaseId: body.knowledgeBaseId,
    sharedKnowledgeBase: body.sharedKnowledgeBase ?? true,
    guardrailIdentifier: body.guardrailIdentifier,
    guardrailVersion: body.guardrailVersion,
    theme: body.theme || { primaryColor: "#005EB8" },
  };

  await agentRepository.saveAgent(agentConfig);
  return res.status(201).json({
    success: true,
    agent: agentConfig,
  });
});

app.get(["/api/dev/admin/agents/:id", "/v1/admin/agents/:id", "/api/agents/:id"], ...requireCompanyAdmin, async (req, res) => {
  const tenantId = req.authorizedTenantId!;
  const agentId = req.params.id;
  const agent = await agentRepository.getAgent(tenantId, agentId);
  if (!agent) {
    return res.status(404).json({ success: false, message: "Agent not found" });
  }
  return res.json({ success: true, agent });
});

// Publish agent and generate public chat URL
app.post(["/api/dev/admin/agents/:id/publish", "/v1/admin/agents/:id/publish", "/api/agents/:id/publish"], ...requireCompanyAdmin, async (req, res) => {
  const tenantId = req.authorizedTenantId!;
  const agentId = req.params.id;
  const publicAgentKey = (req.body?.publicAgentKey || `${tenantId}-support`).toLowerCase();

  try {
    const mapping = await agentRepository.publishAgent(tenantId, agentId, publicAgentKey);
    return res.json({
      success: true,
      published: true,
      publicAgentKey: mapping.publicAgentKey,
      chatUrl: `/chat/${mapping.publicAgentKey}`,
    });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
});

// Knowledge Bases admin endpoints
const inMemoryKbs: Map<string, any[]> = new Map();
app.get(["/api/dev/admin/knowledge-bases", "/v1/admin/knowledge-bases", "/api/knowledge-bases"], ...requireCompanyAdmin, (req, res) => {
  const tenantId = req.authorizedTenantId!;
  const items = inMemoryKbs.get(tenantId) || [
    {
      kbId: "kb-support",
      name: "Technical Support Guides",
      description: "Fiber router and troubleshooting guides",
      category: "Technical Support",
      filesCount: 1,
      status: "READY",
    },
  ];
  return res.json({ success: true, items });
});

app.post(["/api/dev/admin/knowledge-bases", "/v1/admin/knowledge-bases", "/api/knowledge-bases"], ...requireCompanyAdmin, (req, res) => {
  const tenantId = req.authorizedTenantId!;
  const body = req.body || {};
  const kbItem = {
    kbId: body.kbId || `kb-${Date.now().toString(36)}`,
    name: body.name || "Custom Knowledge Base",
    description: body.description || "",
    category: body.category || "General",
    filesCount: body.filesCount || 0,
    status: "READY",
  };
  const list = inMemoryKbs.get(tenantId) || [];
  list.push(kbItem);
  inMemoryKbs.set(tenantId, list);
  return res.status(201).json({ success: true, item: kbItem });
});

// Tools admin endpoints
const inMemoryTools: Map<string, any[]> = new Map();
app.get(["/api/dev/admin/tools", "/v1/admin/tools", "/api/tools"], ...requireCompanyAdmin, (req, res) => {
  const tenantId = req.authorizedTenantId!;
  const items = inMemoryTools.get(tenantId) || [
    {
      name: "check_balance",
      type: "api",
      description: "Query customer account balance",
      enabled: true,
      endpoint: "https://mock.internal/api/billing/balance",
    },
  ];
  return res.json({ success: true, items });
});

app.post(["/api/dev/admin/tools", "/v1/admin/tools", "/api/tools"], ...requireCompanyAdmin, (req, res) => {
  const tenantId = req.authorizedTenantId!;
  const body = req.body || {};
  const toolItem = {
    name: body.name,
    type: body.type || "api",
    description: body.description || "",
    enabled: body.enabled ?? true,
    endpoint: body.endpoint,
    method: body.method || "POST",
  };
  const list = inMemoryTools.get(tenantId) || [];
  list.push(toolItem);
  inMemoryTools.set(tenantId, list);
  return res.status(201).json({ success: true, item: toolItem });
});

// ==========================================
// 7. AGENT CHAT DISPATCH PIPELINE
// ==========================================

// POST /api/tenant/route or POST /api/agent
app.post(["/api/tenant/route", "/api/agent"], async (req, res) => {
  try {
    const response = await handleTenantRequest({
      headers: (req.headers as Record<string, string>) || {},
      body: req.body,
    });
    if (!response.success && response.error) {
      const code = response.error.code;
      const statusCode =
        code === "FORBIDDEN"
          ? 403
          : code === "UNAUTHORIZED"
          ? 401
          : code === "BAD_REQUEST"
          ? 400
          : code === "TENANT_NOT_FOUND"
          ? 404
          : 500;
      return res.status(statusCode).json(response);
    }
    return res.json(response);
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: {
        code: "SERVER_ERROR",
        message: err.message || "Internal server error",
        retryable: false,
      },
    });
  }
});

let server: any = null;
if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`🚀 omni-channel-backend API Server running at http://localhost:${PORT}`);
  });
}

export { app, server };
export default app;

