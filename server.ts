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
      if (registration.status !== "Approved") {
        return res.status(403).json({
          success: false,
          error: `Your registration is currently ${registration.status.toLowerCase()}. Please await Super Admin approval.`,
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

// POST /api/registrations
app.post("/api/registrations", limitRegistrations, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ success: false, error: "Invalid request body" });
  }

  const rawCompanyName = (body.companyName || body.name || "").trim();
  if (!rawCompanyName) {
    return res.status(400).json({ success: false, error: "Validation Failed: 'companyName' is required." });
  }

  const db = readDB();

  // Check for duplicate pending registration
  const duplicatePending = db.registrations.find(
    (r: any) =>
      (r.status || "").toLowerCase() === "pending" &&
      ((r.companyName || "").toLowerCase().trim() === rawCompanyName.toLowerCase() ||
       (r.name || "").toLowerCase().trim() === rawCompanyName.toLowerCase())
  );
  if (duplicatePending) {
    return res.status(409).json({
      success: false,
      error: `Conflict: A pending registration for '${rawCompanyName}' already exists.`,
    });
  }

  const cleanSlug = (body.companySlug || rawCompanyName).toLowerCase().replace(/[^a-z0-9]/g, "-");
  const dateStr = new Date().toISOString().split("T")[0];

  let passwordHash: string | undefined;
  if (body.password && typeof body.password === "string") {
    try {
      passwordHash = await hashPassword(body.password);
    } catch {
      passwordHash = undefined;
    }
  }

  const newReg = normalizeRegistration({
    id: `reg-${Date.now()}`,
    companyName: rawCompanyName,
    name: rawCompanyName,
    companySlug: cleanSlug,
    businessRegNumber: body.businessRegNumber || "BR-PENDING",
    companyEmail: body.companyEmail || body.email || "",
    email: body.companyEmail || body.email || body.adminEmail || "",
    adminName: body.adminName || "Admin",
    adminEmail: body.adminEmail || body.companyEmail || body.email || "",
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
    password: body.password || "company123",
    ...(passwordHash ? { passwordHash } : {}),
    status: "Pending",
    submissionDate: dateStr,
    date: dateStr,
    requestedDate: dateStr,
    tier: body.tier || "Standard",
    allocatedAgents: body.allocatedAgents || 5,
    channels: body.channels || ["Web"],
  });

  db.registrations.push(newReg);
  writeDB(db);

  res.status(201).json({ success: true, registration: redactRegistrationCredentials(newReg) });
});

// Handler for approving or rejecting registration
const handleUpdateRegistrationStatus = async (req: express.Request, res: express.Response) => {
  const { id } = req.params;
  const rawStatus = (req.body.status || "").toLowerCase();

  const db = readDB();
  const regIndex = db.registrations.findIndex((r: any) => String(r.id) === String(id));

  if (regIndex === -1) {
    return res.status(404).json({ success: false, error: "Registration not found" });
  }

  const reg = db.registrations[regIndex];
  const normalizedStatus = rawStatus === "approved" ? "Approved" : rawStatus === "rejected" ? "Rejected" : req.body.status || "Approved";

  // Enforce idempotency: re-approving an already Approved registration must return 409 Conflict
  if (normalizedStatus === "Approved" && reg.status === "Approved") {
    return res.status(409).json({
      success: false,
      error: "Registration has already been approved",
      registration: redactRegistrationCredentials(reg),
    });
  }

  // Auto-Provision Tenant Partition when Approved
  if (normalizedStatus === "Approved") {
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
        console.log(`✅ [Auto-Provisioning] Successfully provisioned tenant '${reg.tenantId}' for ${reg.companyName}`);
      } catch (onboardErr: any) {
        console.error(`❌ [Auto-Provisioning Failed] ${onboardErr.message}`);
        // Fail closed: retain Pending status, do not issue fake tenantId
        return res.status(502).json({
          success: false,
          error: `Failed to provision tenant resources: ${onboardErr.message}`,
        });
      }
    } else {
      reg.status = "Approved";
    }
  } else {
    reg.status = normalizedStatus;
  }

  db.registrations[regIndex] = normalizeRegistration(reg);
  writeDB(db);
  return res.json({ success: true, registration: redactRegistrationCredentials(db.registrations[regIndex]) });
};

// PATCH /api/registrations/:id (Super Admin Approves / Rejects)
app.patch("/api/registrations/:id", ...requireSuperAdmin, handleUpdateRegistrationStatus);

// PUT /api/registrations/:id
app.put("/api/registrations/:id", ...requireSuperAdmin, handleUpdateRegistrationStatus);

// PUT /api/registrations/:id/status (Backwards compatibility)
app.put("/api/registrations/:id/status", ...requireSuperAdmin, handleUpdateRegistrationStatus);

// GET /api/stats (Admin Console Dashboard Stats)
app.get("/api/stats", requireAuth, (req, res) => {
  const db = readDB();
  const activeCount = db.registrations.filter((r: any) => (r.status || "").toLowerCase() === "approved").length;
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
app.get(["/api/resolve-chat-url", "/resolve-chat-url"], (req, res) => {
  const companySlug = (req.query.company as string) || "slt";
  const agentSlug = (req.query.agent as string) || "support";

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
  });
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

