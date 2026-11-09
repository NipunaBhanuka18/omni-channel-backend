import express from "express";
import cors from "cors";
import path from "path";
import { handleTenantRequest } from "./services/tenant-router/handler";
import { handleHandoffApi } from "./services/handoff/handler";
import { adjustActiveChats } from "./services/handoff/presence-manager";

import { provisionPendingCompanyApproval } from "./services/onboarding/approval-workflow";
import { redactRegistrationCredentials } from "./services/onboarding/registration-privacy";
import {
  RegistrationRepository,
  DynamoRegistrationRepository,
  JsonRegistrationRepository,
  ResilientLocalRegistrationRepository,
  RegistrationConflictError,
  RegistrationStorageUnavailableError,
} from "./services/onboarding/registration-repository";
import { deriveTenantId } from "./shared/utils/tenant-name";
import { resolveHostedChatConfig } from "./services/onboarding/chat-url-resolver";
import {
  createJsonDbStore,
  createLocalAuthRouter,
  normalizeRegistration,
} from "./services/auth/local-auth-router";
import {
  createRequireAuth,
  requireRole,
  requireTenantScope,
  resolveAuthorizedAgentId,
} from "./services/auth/local-auth-middleware";
import { BoundedRateLimiter, createRateLimitMiddleware } from "./services/auth/bounded-rate-limiter";
import { CognitoJwtVerifier, createCognitoJwtVerifierFromEnv } from "./services/auth/cognito-jwt-verifier";
import { LocalLoginAttemptGuard } from "./services/auth/local-login-attempt-guard";
import { LocalSessionTokenService } from "./services/auth/local-session-token";
import { listConversationsForTenant } from "./services/workspace-portal/list-conversations";
import { s3Client, uploadKbDocument } from "./agents/utils/s3-client";
import { ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { inMemoryTenants, provisionTenantResources } from "./scripts/create-tenants-table";
import { TenantContext } from "./shared/types/tenant-context";
import { docClient } from "./agents/utils/dynamo-client";
import { ScanCommand, QueryCommand, GetCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, "db.json");
const TENANT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

let cachedLocalTokenService: LocalSessionTokenService | null = null;
function getLocalSessionTokenService(): LocalSessionTokenService {
  if (!cachedLocalTokenService) {
    cachedLocalTokenService = new LocalSessionTokenService();
  }
  return cachedLocalTokenService;
}

// Initialize baseline tenant DynamoDB/in-memory records once per process in local dev/test mode
if (isLocalDevAllowed()) {
  provisionTenantResources().catch((err) => {
    console.warn(`[Server Init] Baseline tenant provisioning note: ${err.message}`);
  });
}

function asPlainBody(value: unknown): Record<string, any> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? (value as Record<string, any>) : null;
}

function isLocalDevAllowed(): boolean {
  const nodeEnv = (process.env.NODE_ENV || "").trim().toLowerCase();
  return nodeEnv !== "production" && nodeEnv !== "prod" && process.env.IS_LOCAL !== "false";
}

function resolveCorsOptions(): cors.CorsOptions {
  const rawOrigins = (process.env.CORS_ALLOWED_ORIGINS || "").trim();
  if (rawOrigins) {
    const allowed = new Set(
      rawOrigins
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
    return {
      origin: (origin, callback) => {
        if (!origin || allowed.has(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
    };
  }
  if (!isLocalDevAllowed()) {
    return { origin: false };
  }
  return {};
}

function isLoopbackOriginAllowed(req: express.Request): boolean {
  const remote = req.socket?.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const allowedOrigins = ["http://localhost:8080", "http://127.0.0.1:8080"];
  const origin = req.headers.origin;
  return loopback && (!origin || allowedOrigins.includes(origin));
}

function handoffErrorStatus(code?: string): number {
  switch (code) {
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "INTERNAL_ERROR":
      return 503;
    default:
      return 400;
  }
}

export interface CreateAppOptions {
  dbPath?: string;
  registrationRepo?: RegistrationRepository;
  tokenService?: LocalSessionTokenService;
  loginGuard?: LocalLoginAttemptGuard;
  cognitoVerifier?: CognitoJwtVerifier | null;
  acceptLocalTokens?: boolean;
  approvePendingRegistration?: typeof provisionPendingCompanyApproval;
  publicRegistrationLimiter?: BoundedRateLimiter;
  publicHandoffLimiter?: BoundedRateLimiter;
  publicChatResolverLimiter?: BoundedRateLimiter;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors(resolveCorsOptions()));
  app.use(express.json({ limit: "128kb" }));

  const dbStore = options.dbPath ? createJsonDbStore(options.dbPath) : (isLocalDevAllowed() ? createJsonDbStore(DB_PATH) : null);
  const baseRegistrationRepo: RegistrationRepository =
    options.registrationRepo ??
    (options.dbPath && isLocalDevAllowed() && dbStore
      ? new JsonRegistrationRepository(dbStore)
      : new DynamoRegistrationRepository());
  const registrationRepo: RegistrationRepository =
    !options.registrationRepo && isLocalDevAllowed() && dbStore
      ? new ResilientLocalRegistrationRepository(baseRegistrationRepo, new JsonRegistrationRepository(dbStore))
      : baseRegistrationRepo;
  const resolveTokenService = (): LocalSessionTokenService =>
    options.tokenService ?? getLocalSessionTokenService();
  const resolveCognitoVerifier = (): CognitoJwtVerifier | null =>
    options.cognitoVerifier !== undefined
      ? options.cognitoVerifier
      : createCognitoJwtVerifierFromEnv();
  const isLocalTokensAllowed = (): boolean =>
    isLocalDevAllowed() && (options.acceptLocalTokens ?? true);

  const fallbackApprovePendingRegistration = async (reg: any) => {
    try {
      const result = await provisionPendingCompanyApproval(reg);
      if (
        !result.success &&
        isLocalDevAllowed() &&
        (result.error?.message?.includes("ECONNREFUSED") ||
          result.error?.code === "ONBOARDING_UNAVAILABLE" ||
          result.error?.code === "INTERNAL_ERROR")
      ) {
        const tenantId = deriveTenantId(reg.companySlug, reg.companyName);
        console.warn(`[Approval] LocalStack unavailable for provisioning (${result.error?.message}); applying local dev approval fallback.`);
        return {
          success: true as const,
          approvedRegistration: {
            ...reg,
            status: "Approved" as const,
            tenantId,
            onboardedAt: new Date().toISOString(),
          },
          credentials: {
            username: `admin@${reg.companySlug || "company"}.lk`,
            temporaryPassword: "Dev-Temporary-Password-2026!",
          },
        };
      }
      return result;
    } catch (err: any) {
      if (isLocalDevAllowed() && (err?.message?.includes("ECONNREFUSED") || err?.code === "ECONNREFUSED")) {
        const tenantId = deriveTenantId(reg.companySlug, reg.companyName);
        console.warn(`[Approval] LocalStack unavailable for provisioning (${err.message}); applying local dev approval fallback.`);
        return {
          success: true as const,
          approvedRegistration: {
            ...reg,
            status: "Approved" as const,
            tenantId,
            onboardedAt: new Date().toISOString(),
          },
          credentials: {
            username: `admin@${reg.companySlug || "company"}.lk`,
            temporaryPassword: "Dev-Temporary-Password-2026!",
          },
        };
      }
      throw err;
    }
  };

  const approvePendingRegistration =
    options.approvePendingRegistration ?? fallbackApprovePendingRegistration;

  const publicHandoffLimiter =
    options.publicHandoffLimiter ??
    new BoundedRateLimiter({ maxRequests: 25, windowMs: 60_000, maxTrackedKeys: 2048 });
  const limitHandoffRequests = createRateLimitMiddleware(publicHandoffLimiter, {
    errorMessage: "Too many handoff requests. Please wait and try again.",
  });

  const publicChatResolverLimiter =
    options.publicChatResolverLimiter ??
    new BoundedRateLimiter({ maxRequests: 60, windowMs: 60_000, maxTrackedKeys: 2048 });
  const limitChatResolver = createRateLimitMiddleware(publicChatResolverLimiter, {
    errorMessage: "Too many configuration lookups. Please wait and try again.",
  });

  const requireAuth = createRequireAuth({
    getTokenService: resolveTokenService,
    getCognitoVerifier: resolveCognitoVerifier,
    isLocalTokensAllowed,
  });
  const requireSuperAdmin = [requireAuth, requireRole("superadmin")] as const;
  const requireCompanyAdmin = [requireAuth, requireRole("company"), requireTenantScope()] as const;
  const requireAgentOrCompany = [
    requireAuth,
    requireRole("live_agent", "company"),
    requireTenantScope(),
  ] as const;

  function readDB() {
    if (!dbStore) return { users: [], registrations: [] };
    return dbStore.readDB();
  }

  function writeDB(data: { users: Array<Record<string, any>>; registrations: Array<Record<string, any>> }) {
    if (dbStore) dbStore.writeDB(data);
  }

  // ==========================================
  // 1. AUTHENTICATION & REGISTRATION ROUTES
  // ==========================================
  app.use(
    createLocalAuthRouter({
      store: dbStore ?? undefined,
      registrationRepo,
      getTokenService: resolveTokenService,
      loginGuard: options.loginGuard,
      registrationLimiter: options.publicRegistrationLimiter,
    }),
  );

  // ==========================================
  // 2. COMPANY REGISTRATION & APPROVAL ROUTES
  // ==========================================

  // GET /api/registrations (supports ?status=pending or ?status=approved)
  // Protected by verified superadmin session token (Cognito in prod, or local token in dev).
  app.get("/api/registrations", ...requireSuperAdmin, async (req, res) => {
    if (req.query.status !== undefined && typeof req.query.status !== "string") {
      return res.status(400).json({ error: "Invalid status filter" });
    }
    const statusParam = typeof req.query.status === "string" ? req.query.status.trim() : "";
    try {
      const list = await registrationRepo.list(statusParam || undefined);
      if (statusParam) {
        return res.json(list);
      }
      return res.json({ success: true, registrations: list });
    } catch (error: any) {
      if (error instanceof RegistrationStorageUnavailableError) {
        return res.status(503).json({ error: "Company registration repository unavailable" });
      }
      console.error("[RegistrationsList] Error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/registrations is registered above via createLocalAuthRouter.

  // Platform superadmin registration review (approved records provision via Cognito pipeline).
  const registrationReviewsInFlight = new Set<string>();
  const handleUpdateRegistrationStatus = async (req: express.Request, res: express.Response) => {
    if (!req.is("application/json")) {
      return res.status(400).json({ error: "Content-Type application/json is required" });
    }

    const { id } = req.params;
    if (!/^reg-[A-Za-z0-9_-]{1,80}$/.test(id)) {
      return res.status(400).json({ error: "Invalid registration ID" });
    }
    const body = asPlainBody(req.body);
    const rawStatus = typeof body?.status === "string" ? body.status.trim().toLowerCase() : "";
    if (rawStatus !== "approved" && rawStatus !== "rejected") {
      return res.status(400).json({ error: "Status must be Approved or Rejected" });
    }
    if (registrationReviewsInFlight.has(id)) {
      return res.status(409).json({ error: "Registration review already in progress" });
    }
    registrationReviewsInFlight.add(id);
    try {
      if (rawStatus === "rejected") {
        const rejected = await registrationRepo.markRejected(id, req.localAuth?.sub);
        if (!rejected) {
          return res.status(404).json({ error: "Registration not found" });
        }
        return res.json({ success: true, registration: rejected });
      }

      // Atomic claim: Pending -> Provisioning
      const claim = await registrationRepo.claimForReview(id);
      if (claim.outcome === "not_found") {
        return res.status(404).json({ error: "Registration not found" });
      }
      if (claim.outcome === "conflict") {
        return res.status(409).json({ error: claim.reason });
      }

      const reg = claim.registration;
      let approval;
      try {
        approval = await approvePendingRegistration({
          id: reg.id,
          status: reg.status,
          tenantId: reg.tenantId,
          companyName: reg.companyName,
          companySlug: reg.companySlug,
          companyEmail: reg.companyEmail,
          adminEmail: reg.adminEmail,
          adminName: reg.adminName,
          channels: Array.isArray(reg.channels) ? (reg.channels as string[]) : undefined,
          tier: typeof reg.tier === "string" ? reg.tier : undefined,
          allocatedAgents: typeof reg.allocatedAgents === "number" ? reg.allocatedAgents : undefined,
          themeColor: typeof reg.themeColor === "string" ? reg.themeColor : undefined,
        });
      } catch (provisionErr) {
        await registrationRepo.releaseReviewClaim(id);
        throw provisionErr;
      }

      if (!approval.success) {
        await registrationRepo.releaseReviewClaim(id);
        const code = approval.error.code;
        const status =
          code === "BAD_REQUEST"
            ? 400
            : ["INVALID_REGISTRATION_STATE", "TENANT_ALREADY_EXISTS", "COMPANY_NAME_ALREADY_EXISTS"].includes(code)
              ? 409
              : 503;
        return res.status(status).json({ success: false, error: approval.error });
      }

      // Commit Approved state conditionally. One-time credentials returned ONLY in this response.
      const safeRegistration = await registrationRepo.markApproved(id, {
        tenantId: approval.approvedRegistration.tenantId,
        companySlug: approval.approvedRegistration.companySlug,
        onboardedAt: approval.approvedRegistration.onboardedAt,
        reviewedBy: req.localAuth?.sub,
      });

      return res.json({
        success: true,
        registration: safeRegistration,
        credentials: approval.credentials,
      });
    } catch (error: any) {
      if (error instanceof RegistrationConflictError) {
        return res.status(409).json({ error: error.message });
      }
      if (error instanceof RegistrationStorageUnavailableError) {
        return res.status(503).json({ error: error.message });
      }
      console.error("[CompanyReview] Registration review failed:", error);
      return res.status(503).json({ error: "Company review unavailable; registration may require reconciliation" });
    } finally {
      registrationReviewsInFlight.delete(id);
    }
  };

  // PATCH /api/registrations/:id (Super Admin Approves / Rejects)
  app.patch("/api/registrations/:id", ...requireSuperAdmin, handleUpdateRegistrationStatus);

  // PUT /api/registrations/:id
  app.put("/api/registrations/:id", ...requireSuperAdmin, handleUpdateRegistrationStatus);

  // PUT /api/registrations/:id/status (Backwards compatibility)
  app.put("/api/registrations/:id/status", ...requireSuperAdmin, handleUpdateRegistrationStatus);

  // GET /api/stats (Admin Console Dashboard Stats)
  app.get("/api/stats", ...requireSuperAdmin, async (_req, res) => {
    try {
      const stats = await registrationRepo.getPlatformStats();
      return res.json(stats);
    } catch (error: any) {
      if (error instanceof RegistrationStorageUnavailableError) {
        return res.status(503).json({ error: error.message });
      }
      console.error("[PlatformStats] Failed to retrieve platform stats:", error);
      return res.status(503).json({ error: "Platform statistics unavailable" });
    }
  });

  // GET /api/notifications (Admin Notifications)
  app.get("/api/notifications", ...requireSuperAdmin, async (_req, res) => {
    try {
      const pendingRegs = await registrationRepo.list("pending");
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

      return res.json({ success: true, notifications });
    } catch (error: any) {
      if (error instanceof RegistrationStorageUnavailableError) {
        return res.status(503).json({ error: error.message });
      }
      console.error("[Notifications] Failed to retrieve notifications:", error);
      return res.status(503).json({ error: "Notifications unavailable" });
    }
  });

  // ==========================================
  // 3. MEMBER 2 DIRECT ONBOARDING API
  // ==========================================

  // Disable the legacy direct HTTP provisioning route. It had no platform-admin
  // authentication and generated placeholder (non-Cognito) admin credentials.
  // Company creation now requires the separately guarded approval workflow.
  app.post("/api/tenants/register", (_req, res) => {
    return res.status(404).json({ error: "Direct tenant registration unavailable" });
  });

  // ==========================================
  // 4. MEMBER 3 LIVE AGENT CONSOLE & PRESENCE ROUTES
  // ==========================================

  // POST /api/agent/presence/online ("Go Online")
  app.post(["/api/agent/presence/online", "/agent/presence/online"], ...requireAgentOrCompany, async (req, res) => {
    const body = req.body === undefined ? {} : asPlainBody(req.body);
    if (!body) {
      return res.status(400).json({ success: false, error: "Invalid request payload" });
    }
    const resolvedAgent = resolveAuthorizedAgentId(req, body.agentId);
    if (!resolvedAgent.ok) {
      return res.status(resolvedAgent.status).json({ success: false, error: resolvedAgent.error });
    }
    if (body.connectionId !== undefined && (typeof body.connectionId !== "string" || body.connectionId.length > 128)) {
      return res.status(400).json({ success: false, error: "Invalid connectionId" });
    }
    const result = await handleHandoffApi({
      action: "presence_online",
      tenantId: req.authorizedTenantId!,
      agentId: resolvedAgent.agentId,
      connectionId: typeof body.connectionId === "string" ? body.connectionId.trim() : undefined,
    });
    if (!result.success) return res.status(handoffErrorStatus(result.error?.code)).json(result);
    return res.status(200).json({ success: true, ...result.data });
  });

  // POST /api/agent/presence/offline ("Go Offline")
  app.post(["/api/agent/presence/offline", "/agent/presence/offline"], ...requireAgentOrCompany, async (req, res) => {
    const body = req.body === undefined ? {} : asPlainBody(req.body);
    if (!body) {
      return res.status(400).json({ success: false, error: "Invalid request payload" });
    }
    const resolvedAgent = resolveAuthorizedAgentId(req, body.agentId);
    if (!resolvedAgent.ok) {
      return res.status(resolvedAgent.status).json({ success: false, error: resolvedAgent.error });
    }
    const result = await handleHandoffApi({
      action: "presence_offline",
      tenantId: req.authorizedTenantId!,
      agentId: resolvedAgent.agentId,
    });
    if (!result.success) return res.status(handoffErrorStatus(result.error?.code)).json(result);
    return res.status(200).json({ success: true, ...result.data });
  });

  // GET /api/agent/presence/status
  app.get(["/api/agent/presence/status", "/agent/presence/status"], ...requireAgentOrCompany, async (req, res) => {
    const resolvedAgent = resolveAuthorizedAgentId(req, req.query.agentId);
    if (!resolvedAgent.ok) {
      return res.status(resolvedAgent.status).json({ success: false, error: resolvedAgent.error });
    }
    const result = await handleHandoffApi({
      action: "presence_status",
      tenantId: req.authorizedTenantId!,
      agentId: resolvedAgent.agentId,
    });
    if (!result.success) return res.status(handoffErrorStatus(result.error?.code)).json(result);
    return res.status(200).json({ success: true, ...result.data });
  });

  // POST /api/chat/handoff/request (Public Customer Escalation Trigger)
  app.post(
    ["/api/chat/handoff/request", "/chat/handoff/request"],
    limitHandoffRequests,
    async (req, res) => {
      const body = asPlainBody(req.body);
      if (!body) {
        return res.status(400).json({
          success: false,
          error: { code: "BAD_REQUEST", message: "Invalid handoff payload", retryable: false },
        });
      }
      const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
      if (!TENANT_ID_PATTERN.test(tenantId)) {
        return res.status(400).json({
          success: false,
          error: { code: "BAD_REQUEST", message: "A valid 'tenantId' is required", retryable: false },
        });
      }
      let sessionId = `sess-${randomUUID()}`;
      if (body.sessionId !== undefined) {
        if (typeof body.sessionId !== "string" || !SAFE_ID_PATTERN.test(body.sessionId.trim())) {
          return res.status(400).json({
            success: false,
            error: { code: "BAD_REQUEST", message: "Invalid sessionId format", retryable: false },
          });
        }
        sessionId = body.sessionId.trim();
      }
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : undefined;
      const customerInfo = asPlainBody(body.customerInfo);
      const customerName =
        typeof customerInfo?.name === "string" ? customerInfo.name.trim().slice(0, 120) : undefined;

      const result = await handleHandoffApi({
        action: "request_handoff",
        tenantId,
        sessionId,
        customerName,
        issueSummary: reason,
      });
      if (!result.success) return res.status(handoffErrorStatus(result.error?.code)).json(result);
      return res.status(200).json({ success: true, ...result.data });
    });

  // POST /api/chat/handoff/resolve (Live Agent Resolves Session)
  app.post(["/api/chat/handoff/resolve", "/chat/handoff/resolve"], ...requireAgentOrCompany, async (req, res) => {
    const body = asPlainBody(req.body);
    if (!body) {
      return res.status(400).json({ success: false, error: "Invalid request payload" });
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!SAFE_ID_PATTERN.test(sessionId)) {
      return res.status(400).json({ success: false, error: "A valid 'sessionId' is required" });
    }
    const resolvedAgent = resolveAuthorizedAgentId(req, body.agentId);
    if (!resolvedAgent.ok) {
      return res.status(resolvedAgent.status).json({ success: false, error: resolvedAgent.error });
    }
    const result = await handleHandoffApi({
      action: "resolve_session",
      tenantId: req.authorizedTenantId!,
      sessionId,
      agentId: resolvedAgent.agentId,
    });
    if (!result.success) return res.status(handoffErrorStatus(result.error?.code)).json(result);
    return res.status(200).json({ success: true, ...result.data });
  });


  // Local-development-only queue preview for the live-agent console.
  // Protected by verified bearer auth, role, tenant scope, and agent identity.
  app.get("/api/dev/live/queue", ...requireAgentOrCompany, async (req, res) => {
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req)) {
      return res.status(404).json({ error: "Not found" });
    }

    const tenantId = req.authorizedTenantId!;
    const resolvedAgent = resolveAuthorizedAgentId(req, req.query.agentId);
    if (!resolvedAgent.ok) {
      return res.status(resolvedAgent.status).json({ error: resolvedAgent.error });
    }
    const agentId = resolvedAgent.agentId;

    try {
      const sessions: Array<Record<string, any>> = [];
      let lastKey: Record<string, any> | undefined;
      do {
        const result = await docClient.send(new ScanCommand({
          TableName: "omni-channel-chat-sessions",
          FilterExpression: "tenantId = :tenant AND assignedAgentId = :agent AND #status = :active",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":tenant": tenantId,
            ":agent": agentId,
            ":active": "HUMAN_ACTIVE",
          },
          ExclusiveStartKey: lastKey,
        }));
        sessions.push(...((result.Items || []) as Array<Record<string, any>>));
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);

      const assigned = sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map((session) => ({
          sessionId: session.sessionId,
          publicAgentKey: session.customerName || "Customer",
          status: session.status,
          assignedAgentId: session.assignedAgentId,
          updatedAt: Math.floor(Date.parse(session.updatedAt || session.createdAt) / 1000) ||
            Math.floor(Date.now() / 1000),
        }));
      return res.json({ assigned, waiting: [], demoOnly: true });
    } catch (error: any) {
      return res.status(503).json({ error: "Local handoff queue unavailable", detail: error.message });
    }
  });

  // Tenant-scoped dashboard counts from LocalStack, protected by company admin auth.
  app.get("/api/dev/admin/overview", ...requireCompanyAdmin, async (req, res) => {
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req)) {
      return res.status(404).json({ error: "Not found" });
    }
    const tenantId = req.authorizedTenantId!;

    const readTenantRows = async (tableName: string, scan = false) => {
      const rows: Array<Record<string, any>> = [];
      let nextKey: Record<string, any> | undefined;
      do {
        const args = {
          TableName: tableName,
          ...(scan ? { FilterExpression: "tenantId = :tenant" } : {
            KeyConditionExpression: "tenantId = :tenant",
          }),
          ExpressionAttributeValues: { ":tenant": tenantId },
          ExclusiveStartKey: nextKey,
        };
        const response = scan
          ? await docClient.send(new ScanCommand(args))
          : await docClient.send(new QueryCommand(args));
        rows.push(...((response.Items || []) as Array<Record<string, any>>));
        nextKey = response.LastEvaluatedKey;
      } while (nextKey);
      return rows;
    };

    try {
      const [agents, tools, liveAgents, sessions] = await Promise.all([
        readTenantRows("omni-channel-agents"),
        readTenantRows("omni-channel-tools"),
        readTenantRows("omni-channel-agent-presence"),
        readTenantRows("omni-channel-chat-sessions", true),
      ]);
      return res.json({
        tenantId, source: "localstack", demoOnly: true,
        dashboard: {
          agents: agents.length,
          publishedAgents: null, // No shared publication-status model yet.
          knowledgeBases: null, // No unified knowledge-base table yet.
          tools: tools.length,
          liveAgents: liveAgents.length,
          onlineAgents: liveAgents.filter(a => ["AVAILABLE", "BUSY"].includes(a.status)).length,
          waitingHandoffs: sessions.filter(s => s.status === "WAITING_FOR_HUMAN").length,
          activeHumanChats: sessions.filter(s => s.status === "HUMAN_ACTIVE").length,
        },
      });
    } catch (error) {
      console.error("[LocalAdminOverview] LocalStack query failed:", error);
      return res.status(503).json({ error: "Local dashboard metrics unavailable; check the DynamoDB tables" });
    }
  });

  // Tenant-scoped Chat Monitor (no message contents returned).
  app.get("/api/dev/admin/chats", ...requireCompanyAdmin, async (req, res) => {
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req)) {
      return res.status(404).json({ error: "Not found" });
    }
    const tenantId = req.authorizedTenantId!;

    try {
      const sessions: Array<Record<string, any>> = [];
      let nextKey: Record<string, any> | undefined;
      do {
        const response = await docClient.send(new ScanCommand({
          TableName: "omni-channel-chat-sessions",
          FilterExpression: "tenantId = :tenant",
          ExpressionAttributeValues: { ":tenant": tenantId },
          ExclusiveStartKey: nextKey,
        }));
        sessions.push(...((response.Items || []) as Array<Record<string, any>>));
        nextKey = response.LastEvaluatedKey;
      } while (nextKey);

      sessions.sort((a, b) => String(b.updatedAt || b.createdAt || "")
        .localeCompare(String(a.updatedAt || a.createdAt || "")));
      return res.json({
        tenantId, source: "localstack", demoOnly: true,
        total: sessions.length,
        items: sessions.slice(0, 100).map(s => ({
          sessionId: s.sessionId,
          customerName: s.customerName || "Guest Customer",
          assignedAgentId: s.assignedAgentId || null,
          status: s.status || "UNKNOWN",
          updatedAt: s.updatedAt || s.createdAt || null,
        })),
      });
    } catch (error) {
      console.error("[LocalAdminChats] LocalStack query failed:", error);
      return res.status(503).json({ error: "Chat Monitor unavailable; check the handoff DynamoDB table" });
    }
  });

  const localMemoryAgents = new Map<string, Array<Record<string, any>>>();

  // Tenant-scoped agent list.
  app.get("/api/dev/admin/agents", ...requireCompanyAdmin, async (req, res) => {
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req)) {
      return res.status(404).json({ error: "Not found" });
    }
    const tenantId = req.authorizedTenantId!;

    const records: Array<Record<string, any>> = [];
    try {
      let lastKey: Record<string, any> | undefined;
      do {
        const result = await docClient.send(new QueryCommand({
          TableName: "omni-channel-agents",
          KeyConditionExpression: "tenantId = :tenant",
          ExpressionAttributeValues: { ":tenant": tenantId },
          ExclusiveStartKey: lastKey,
        }));
        records.push(...((result.Items || []) as Array<Record<string, any>>));
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);
    } catch (error) {
      console.warn("[LocalAdminAgents] LocalStack offline, reading from local memory agent store");
    }

    const localList = localMemoryAgents.get(tenantId) || [];
    for (const item of localList) {
      if (!records.some((r) => r.agentId === item.agentId)) {
        records.push(item);
      }
    }

    records.sort((a, b) => String(a.agentId || "").localeCompare(String(b.agentId || "")));
    return res.json({
      tenantId,
      source: "local",
      demoOnly: true,
      total: records.length,
      items: records.map((a) => ({
        agentId: String(a.agentId || ""),
        displayName: String(a.displayName || a.name || a.agentName || a.agentId || "Unnamed agent"),
        brandName: String(a.brandName || ""),
        modelId: typeof a.modelId === "string" ? a.modelId : (typeof a.defaultModel === "string" ? a.defaultModel : null),
        status: typeof a.status === "string" ? a.status.toUpperCase() : "DRAFT",
        publicAgentKey: typeof a.publicAgentKey === "string" && a.publicAgentKey.trim() ? a.publicAgentKey : null,
        toolIds: a.toolIds || [],
        enabledSubAgents: a.enabledSubAgents || [],
        welcomeMessage: a.welcomeMessage || "",
        systemPrompt: a.systemPrompt || "",
        createdAt: a.createdAt || new Date().toISOString(),
      })),
    });
  });

  // Create tenant-scoped DRAFT agent record (requires explicit opt-in flag + company admin token).
  app.post("/api/dev/admin/agents", ...requireCompanyAdmin, async (req, res) => {
    const origin = req.headers.origin;
    const validOrigin = !origin || /^(http:\/\/(localhost|127\.0\.0\.1):(5173|3001|8080))$/.test(origin);
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req) || !validOrigin || !req.is("application/json")) {
      return res.status(404).json({ error: "Local agent record creation is disabled or request not allowed" });
    }

    const tenantId = req.authorizedTenantId!;
    const body: Record<string, unknown> = asPlainBody(req.body) ?? {};
    const trimmed = (name: string) => typeof body[name] === "string" ? (body[name] as string).trim() : "";
    const displayName = trimmed("displayName");
    const brandName = trimmed("brandName");
    const publicAgentKey = trimmed("publicAgentKey");
    const modelId = trimmed("modelId");
    const welcomeMessage = trimmed("welcomeMessage");
    const systemPrompt = trimmed("systemPrompt");
    const knowledgeBaseRef = trimmed("knowledgeBaseRef");
    if (!displayName || displayName.length > 100 || !modelId || modelId.length > 180 ||
      brandName.length > 100 || welcomeMessage.length > 1000 ||
      systemPrompt.length > 8000 || knowledgeBaseRef.length > 160 ||
      (publicAgentKey && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(publicAgentKey))) {
      return res.status(400).json({ error: "Invalid agent name, model ID, URL key or configuration field length" });
    }
    const stringArray = (name: string, max: number) =>
      Array.isArray(body[name]) && (body[name] as unknown[]).length <= max &&
        (body[name] as unknown[]).every(x => typeof x === "string" && x.length <= 150)
        ? body[name] as string[] : null;
    const toolIds = stringArray("toolIds", 25);
    const enabledSubAgents = stringArray("enabledSubAgents", 10);
    const suggestedPrompts = stringArray("suggestedPrompts", 15);
    const supportedSpecialists = new Set(["general", "sales", "billing", "technical", "lead"]);
    if (!toolIds || !enabledSubAgents || !suggestedPrompts ||
      !enabledSubAgents.every(x => supportedSpecialists.has(x))) {
      return res.status(400).json({ error: "Invalid agent list configuration" });
    }

    const agentId = `agent-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const item = {
      tenantId, agentId, name: displayName, displayName, brandName,
      modelId, defaultModel: modelId, publicAgentKey,
      status: "draft", createdAt, updatedAt: createdAt,
      welcomeMessage, systemPrompt, knowledgeBaseRef,
      suggestedPrompts, toolIds, enabledSubAgents,
      deploymentStatus: "NOT_DEPLOYED",
    };
    // Store in local memory cache
    const currentList = localMemoryAgents.get(tenantId) || [];
    currentList.push(item);
    localMemoryAgents.set(tenantId, currentList);

    try {
      const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
      await docClient.send(new PutCommand({
        TableName: "omni-channel-agents",
        Item: item,
        ConditionExpression: "attribute_not_exists(tenantId) AND attribute_not_exists(agentId)",
      }));
      return res.status(201).json({ source: "localstack", tenantId, demoOnly: true, item });
    } catch (error: any) {
      if (isLocalDevAllowed()) {
        console.warn("[LocalAdminAgents] LocalStack offline, saved in local memory:", error?.message);
        return res.status(201).json({ source: "local-memory", tenantId, demoOnly: true, item });
      }
      console.error("[LocalAdminAgents] Could not create DRAFT agent record:", error);
      return res.status(503).json({ error: "Could not save agent record to LocalStack DynamoDB" });
    }
  });

  // Retrieve an agent's stored configuration for the authenticated tenant.
  app.get("/api/dev/admin/agents/:agentId", ...requireCompanyAdmin, async (req, res) => {
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req)) {
      return res.status(404).json({ error: "Not found" });
    }
    const tenantId = req.authorizedTenantId!;
    if (!/^(?:main-agent|agent-[a-zA-Z0-9-]{1,80})$/.test(req.params.agentId)) {
      return res.status(400).json({ error: "Invalid local tenant or agent ID" });
    }
    try {
      const result = await docClient.send(new GetCommand({
        TableName: "omni-channel-agents",
        Key: { tenantId, agentId: req.params.agentId },
      }));
      if (!result.Item) return res.status(404).json({ error: "Agent not found" });
      const agent = result.Item;
      return res.json({
        source: "localstack", tenantId, demoOnly: true,
        item: {
          agentId: agent.agentId,
          displayName: agent.displayName || agent.name || agent.agentId,
          brandName: agent.brandName || "",
          modelId: agent.modelId || agent.defaultModel || "",
          publicAgentKey: agent.publicAgentKey || "",
          status: String(agent.status || "UNKNOWN").toUpperCase(),
          welcomeMessage: agent.welcomeMessage || "",
          systemPrompt: agent.systemPrompt || "",
          knowledgeBaseRef: agent.knowledgeBaseRef || "",
          suggestedPrompts: agent.suggestedPrompts || [],
          toolIds: agent.toolIds || [],
          enabledSubAgents: agent.enabledSubAgents || [],
          deploymentStatus: agent.deploymentStatus || "NOT_DEPLOYED",
          updatedAt: agent.updatedAt || null,
        },
      });
    } catch (error) {
      console.error("[LocalAdminAgentDetail] Failed:", error);
      return res.status(503).json({ error: "Agent details unavailable; check LocalStack" });
    }
  });

  // Edit approved configuration fields on a DRAFT agent record for the authenticated tenant.
  app.patch("/api/dev/admin/agents/:agentId", ...requireCompanyAdmin, async (req, res) => {
    const origin = req.headers.origin;
    const allowedOrigin = origin === "http://localhost:8080" || origin === "http://127.0.0.1:8080";
    if (!isLocalDevAllowed() ||
      process.env.ENABLE_LOCAL_AGENT_EDITING !== "true" || !isLoopbackOriginAllowed(req) || !allowedOrigin ||
      req.headers["x-local-admin-demo"] !== "edit-agent" || !req.is("application/json")) {
      return res.status(404).json({ error: "Local draft editing unavailable" });
    }
    const tenantId = req.authorizedTenantId!;
    const agentId = req.params.agentId;
    if (!/^agent-[a-zA-Z0-9-]{1,80}$/.test(agentId)) {
      return res.status(400).json({ error: "Only local demo agent IDs can be edited" });
    }
    const payload: Record<string, unknown> = asPlainBody(req.body) ?? {};
    const allowedFields = new Set([
      "displayName", "brandName", "modelId", "publicAgentKey", "welcomeMessage",
      "systemPrompt", "knowledgeBaseRef", "suggestedPrompts", "toolIds", "enabledSubAgents",
    ]);
    const keys = Object.keys(payload);
    if (!keys.length || keys.some(key => !allowedFields.has(key))) {
      return res.status(400).json({ error: "Specify only editable agent configuration fields" });
    }
    const maxLengths: Record<string, number> = {
      displayName: 100, brandName: 100, modelId: 180, publicAgentKey: 63,
      welcomeMessage: 1000, systemPrompt: 8000, knowledgeBaseRef: 160,
    };
    const changes: Record<string, string | string[]> = {};
    for (const key of keys) {
      const value = payload[key];
      if (Object.prototype.hasOwnProperty.call(maxLengths, key)) {
        if (typeof value !== "string" || value.trim().length > maxLengths[key]) {
          return res.status(400).json({ error: `Invalid ${key}` });
        }
        const cleaned = value.trim();
        if ((key === "displayName" || key === "modelId") && !cleaned) {
          return res.status(400).json({ error: `${key} cannot be empty` });
        }
        if (key === "publicAgentKey" && cleaned &&
          (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cleaned) || cleaned === "support")) {
          return res.status(400).json({ error: "Invalid or reserved public URL key" });
        }
        changes[key] = cleaned;
      } else {
        const maxItems = key === "toolIds" ? 25 : key === "suggestedPrompts" ? 15 : 10;
        if (!Array.isArray(value) || value.length > maxItems ||
          !value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 150)) {
          return res.status(400).json({ error: `Invalid ${key} list` });
        }
        const cleaned = value.map(item => (item as string).trim());
        if (new Set(cleaned).size !== cleaned.length ||
          (key === "enabledSubAgents" &&
            !cleaned.every(item => ["general", "sales", "billing", "technical", "lead"].includes(item)))) {
          return res.status(400).json({ error: `Invalid or duplicate ${key} values` });
        }
        changes[key] = cleaned;
      }
    }
    try {
      const key = { tenantId, agentId };
      const existing = await docClient.send(new GetCommand({ TableName: "omni-channel-agents", Key: key }));
      if (!existing.Item) return res.status(404).json({ error: "Agent not found" });
      if (String(existing.Item.status).toUpperCase() !== "DRAFT") {
        return res.status(409).json({ error: "Only draft agent records can be edited" });
      }
      if (typeof changes.publicAgentKey === "string" && changes.publicAgentKey) {
        let lastKey: Record<string, any> | undefined;
        do {
          const page = await docClient.send(new QueryCommand({
            TableName: "omni-channel-agents",
            KeyConditionExpression: "tenantId = :tenant",
            ExpressionAttributeValues: { ":tenant": tenantId },
            ExclusiveStartKey: lastKey,
          }));
          if ((page.Items || []).some(other =>
            other.agentId !== agentId && other.publicAgentKey === changes.publicAgentKey)) {
            return res.status(409).json({ error: "Public URL key is already used by another agent" });
          }
          lastKey = page.LastEvaluatedKey;
        } while (lastKey);
      }
      // Only update permitted fields; never accept caller-supplied tenant, ID or status.
      if (typeof changes.displayName === "string") changes.name = changes.displayName;
      if (typeof changes.modelId === "string") changes.defaultModel = changes.modelId;
      changes.updatedAt = new Date().toISOString();
      const names: Record<string, string> = { "#status": "status" };
      const values: Record<string, unknown> = { ":draft": "draft", ":draftUpper": "DRAFT" };
      const setters = Object.entries(changes).map(([field, value], index) => {
        names[`#f${index}`] = field;
        values[`:v${index}`] = value;
        return `#f${index} = :v${index}`;
      });
      const result = await docClient.send(new UpdateCommand({
        TableName: "omni-channel-agents", Key: key,
        UpdateExpression: `SET ${setters.join(", ")}`,
        ConditionExpression: "attribute_exists(agentId) AND (#status = :draft OR #status = :draftUpper)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }));
      const updated = result.Attributes || {};
      return res.json({
        source: "localstack", tenantId, demoOnly: true,
        agentId, status: "DRAFT", updatedAt: updated.updatedAt,
        updatedFields: keys,
      });
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return res.status(409).json({ error: "Agent changed or is no longer a draft; refresh and retry" });
      }
      console.error("[LocalAdminAgentEdit] Failed:", error);
      return res.status(503).json({ error: "Could not update agent in LocalStack" });
    }
  });

  // Delete disposable DRAFT agent records for the authenticated tenant.
  app.delete("/api/dev/admin/agents/:agentId", ...requireCompanyAdmin, async (req, res) => {
    const origin = req.headers.origin;
    const allowedOrigin = origin === "http://localhost:8080" || origin === "http://127.0.0.1:8080";
    if (!isLocalDevAllowed() ||
      process.env.ENABLE_LOCAL_AGENT_DELETION !== "true" || !isLoopbackOriginAllowed(req) || !allowedOrigin ||
      req.headers["x-local-admin-demo"] !== "delete-draft-agent") {
      return res.status(404).json({ error: "Local draft deletion unavailable" });
    }
    const tenantId = req.authorizedTenantId!;
    const agentId = req.params.agentId;
    if (!/^agent-[a-zA-Z0-9-]{1,80}$/.test(agentId) || agentId === "main-agent") {
      return res.status(400).json({ error: "Only disposable local draft agent IDs can be deleted" });
    }
    if (req.headers["x-confirm-delete-agent"] !== agentId) {
      return res.status(400).json({ error: "Confirm the exact agent ID to delete" });
    }

    const key = { tenantId, agentId };
    try {
      const existing = await docClient.send(new GetCommand({
        TableName: "omni-channel-agents", Key: key,
      }));
      if (!existing.Item) return res.status(404).json({ error: "Agent not found" });
      if (String(existing.Item.status).toUpperCase() !== "DRAFT" ||
        ![undefined, "NOT_DEPLOYED"].includes(existing.Item.deploymentStatus)) {
        return res.status(409).json({ error: "Only non-deployed DRAFT agents can be deleted" });
      }

      await docClient.send(new DeleteCommand({
        TableName: "omni-channel-agents", Key: key,
        ConditionExpression:
          "attribute_exists(tenantId) AND attribute_exists(agentId) " +
          "AND (#status = :draft OR #status = :draftLower) " +
          "AND (attribute_not_exists(deploymentStatus) OR deploymentStatus = :notDeployed)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":draft": "DRAFT", ":draftLower": "draft", ":notDeployed": "NOT_DEPLOYED",
        },
      }));
      return res.json({
        source: "localstack", tenantId, demoOnly: true,
        deleted: true, agentId, previousStatus: "DRAFT",
      });
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return res.status(409).json({ error: "Agent changed or is no longer a non-deployed draft" });
      }
      console.error("[LocalAdminDraftDelete] Failed:", error);
      return res.status(503).json({ error: "Could not delete draft agent from LocalStack" });
    }
  });

  // Publish a DRAFT agent configuration for the authenticated tenant.
  app.post("/api/dev/admin/agents/:agentId/publish", ...requireCompanyAdmin, async (req, res) => {
    const origin = req.headers.origin;
    const validOrigin = origin === "http://localhost:8080" || origin === "http://127.0.0.1:8080";
    if (!isLocalDevAllowed() ||
      process.env.ENABLE_LOCAL_AGENT_PUBLISHING !== "true" || !isLoopbackOriginAllowed(req) || !validOrigin ||
      req.headers["x-local-admin-demo"] !== "publish-agent" || !req.is("application/json")) {
      return res.status(404).json({ error: "Local publishing is not enabled" });
    }
    const tenantId = req.authorizedTenantId!;
    const agentId = req.params.agentId;
    if (!/^agent-[a-zA-Z0-9-]{1,80}$/.test(agentId)) {
      return res.status(400).json({ error: "Invalid draft agent ID" });
    }
    try {
      const record = await docClient.send(new GetCommand({
        TableName: "omni-channel-agents", Key: { tenantId, agentId },
      }));
      const agent = record.Item;
      if (!agent) return res.status(404).json({ error: "Draft agent not found" });
      if (String(agent.status).toLowerCase() !== "draft") {
        return res.status(409).json({ error: "Only draft agents can be published in this demo" });
      }
      const publicKey = typeof agent.publicAgentKey === "string" ? agent.publicAgentKey.trim() : "";
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(publicKey) || publicKey === "support") {
        return res.status(400).json({ error: "Set a valid unique public URL key (not 'support') before publishing" });
      }

      let lastKey: Record<string, any> | undefined;
      do {
        const page = await docClient.send(new QueryCommand({
          TableName: "omni-channel-agents",
          KeyConditionExpression: "tenantId = :tenant",
          ExpressionAttributeValues: { ":tenant": tenantId },
          ExclusiveStartKey: lastKey,
        }));
        if ((page.Items || []).some(other =>
          other.agentId !== agentId && other.publicAgentKey === publicKey)) {
          return res.status(409).json({ error: "This public URL key is already reserved by another agent" });
        }
        lastKey = page.LastEvaluatedKey;
      } while (lastKey);

      const now = new Date().toISOString();
      await docClient.send(new UpdateCommand({
        TableName: "omni-channel-agents", Key: { tenantId, agentId },
        UpdateExpression: "SET #status = :published, publishedAt = :now, updatedAt = :now",
        ConditionExpression: "attribute_exists(agentId) AND (#status = :draft OR #status = :draftUpper) AND publicAgentKey = :publicKey",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":published": "PUBLISHED", ":draft": "draft", ":draftUpper": "DRAFT",
          ":publicKey": publicKey, ":now": now,
        },
      }));
      return res.json({
        tenantId, agentId, status: "PUBLISHED", demoOnly: true,
        publicPath: `/chat.html?company=${encodeURIComponent(tenantId)}&agent=${encodeURIComponent(publicKey)}`,
        deploymentStatus: "NOT_DEPLOYED",
      });
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return res.status(409).json({ error: "Agent was modified or already published. Refresh and retry." });
      }
      console.error("[LocalAgentPublish] Failed:", error);
      return res.status(503).json({ error: "Local publication unavailable; check DynamoDB" });
    }
  });

  // Unpublish a NOT_DEPLOYED agent for the authenticated tenant.
  app.post("/api/dev/admin/agents/:agentId/unpublish", ...requireCompanyAdmin, async (req, res) => {
    const origin = req.headers.origin;
    const allowedOrigin = origin === "http://localhost:8080" || origin === "http://127.0.0.1:8080";
    if (!isLocalDevAllowed() ||
      process.env.ENABLE_LOCAL_AGENT_UNPUBLISHING !== "true" || !isLoopbackOriginAllowed(req) || !allowedOrigin ||
      req.headers["x-local-admin-demo"] !== "unpublish-agent" || !req.is("application/json")) {
      return res.status(404).json({ error: "Local unpublishing unavailable" });
    }
    const tenantId = req.authorizedTenantId!;
    const agentId = req.params.agentId;
    if (!/^agent-[a-zA-Z0-9-]{1,80}$/.test(agentId) ||
      req.headers["x-confirm-unpublish-agent"] !== agentId) {
      return res.status(400).json({ error: "Confirm the exact local agent ID to unpublish" });
    }
    const key = { tenantId, agentId };
    try {
      const result = await docClient.send(new GetCommand({ TableName: "omni-channel-agents", Key: key }));
      if (!result.Item) return res.status(404).json({ error: "Agent not found" });
      if (String(result.Item.status).toUpperCase() !== "PUBLISHED") {
        return res.status(409).json({ error: "Only published agents can be unpublished" });
      }
      if (result.Item.deploymentStatus !== "NOT_DEPLOYED") {
        return res.status(409).json({ error: "Deployed agents require a separate undeployment workflow" });
      }
      const now = new Date().toISOString();
      await docClient.send(new UpdateCommand({
        TableName: "omni-channel-agents", Key: key,
        UpdateExpression: "SET #status = :draft, updatedAt = :now REMOVE publishedAt",
        ConditionExpression: "attribute_exists(agentId) AND #status = :published AND deploymentStatus = :notDeployed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":draft": "DRAFT", ":published": "PUBLISHED",
          ":notDeployed": "NOT_DEPLOYED", ":now": now,
        },
      }));
      return res.json({
        tenantId, agentId, status: "DRAFT", demoOnly: true,
        deploymentStatus: "NOT_DEPLOYED", publicLinkActive: false, updatedAt: now,
      });
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return res.status(409).json({ error: "Agent was changed or is no longer an undeployed published agent" });
      }
      console.error("[LocalAgentUnpublish] Failed:", error);
      return res.status(503).json({ error: "Local unpublishing unavailable; check DynamoDB" });
    }
  });

  // Read-only S3 source file inventory for the authenticated tenant.
  app.get("/api/dev/admin/knowledge-files", ...requireCompanyAdmin, async (req, res) => {
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req)) {
      return res.status(404).json({ error: "Not found" });
    }
    const tenantId = req.authorizedTenantId!;
    const bucket = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";
    const prefix = `tenants/${tenantId}/`;
    try {
      const result = await s3Client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, MaxKeys: 100,
      }));
      const items = (result.Contents || [])
        .filter(object => object.Key && object.Key !== prefix && !object.Key.endsWith("/"))
        .map(object => ({
          key: object.Key as string,
          name: (object.Key as string).slice(prefix.length),
          bytes: object.Size ?? null,
          lastModified: object.LastModified?.toISOString() || null,
          storageStatus: "STORED_IN_S3",
          indexedInBedrock: null, // Not tracked by this backend.
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.json({
        tenantId, source: "localstack-s3", demoOnly: true,
        bucket, prefix, bucketStatus: "available",
        totalShown: items.length, truncated: !!result.IsTruncated, items,
        bedrockKnowledgeBasesTracked: false,
      });
    } catch (error: any) {
      if (["NoSuchBucket", "NotFound"].includes(error?.name)) {
        return res.json({
          tenantId, source: "localstack-s3", demoOnly: true,
          bucket, prefix, bucketStatus: "missing",
          totalShown: 0, truncated: false, items: [],
          bedrockKnowledgeBasesTracked: false,
        });
      }
      console.error("[LocalAdminKnowledge] S3 list failed:", error);
      return res.status(503).json({ error: "Local S3 inventory unavailable" });
    }
  });

  // Read a single small text document from the authenticated tenant's S3 prefix.
  app.get("/api/dev/admin/knowledge-files/:documentName", ...requireCompanyAdmin, async (req, res) => {
    const origin = req.headers.origin;
    const validOrigin = origin === "http://localhost:8080" || origin === "http://127.0.0.1:8080";
    if (!isLocalDevAllowed() ||
      process.env.ENABLE_LOCAL_KB_VIEWING !== "true" || !isLoopbackOriginAllowed(req) || !validOrigin ||
      req.headers["x-local-admin-demo"] !== "view-kb-document") {
      return res.status(404).json({ error: "Local KB document viewing unavailable" });
    }
    const tenantId = req.authorizedTenantId!;
    const documentName = req.params.documentName;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(?:txt|md)$/.test(documentName)) {
      return res.status(400).json({ error: "Invalid knowledge document filename" });
    }

    const bucket = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";
    const key = `tenants/${tenantId}/${documentName}`;
    const maxBytes = 32 * 1024;
    try {
      const object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!object.Body) {
        return res.status(503).json({ error: "Document content unavailable" });
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      const stream = object.Body as import("stream").Readable;
      for await (const part of stream) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        if (bytes > maxBytes) {
          return res.status(413).json({ error: "Document exceeds the 32 KB local preview limit" });
        }
        chunks.push(chunk);
      }
      const content = Buffer.concat(chunks).toString("utf8");
      return res.json({
        tenantId, source: "localstack-s3", demoOnly: true,
        name: documentName, key, bytes, content, etag: object.ETag || null,
        storageStatus: "STORED_IN_S3", indexedInBedrock: null,
      });
    } catch (error: any) {
      if (["NoSuchKey", "NotFound"].includes(error?.name) ||
        (error?.$metadata?.httpStatusCode === 404 && error?.name !== "NoSuchBucket")) {
        return res.status(404).json({ error: "Knowledge document not found" });
      }
      console.error("[LocalKBView] S3 document retrieval failed:", error);
      return res.status(503).json({ error: "Knowledge document unavailable; check LocalStack S3" });
    }
  });

  // Replace an existing small text document in the authenticated tenant's S3 prefix.
  const localKbUpdatesInFlight = new Set<string>();
  app.patch("/api/dev/admin/knowledge-files/:documentName", ...requireCompanyAdmin, async (req, res) => {
    const origin = req.headers.origin;
    const validOrigin = origin === "http://localhost:8080" || origin === "http://127.0.0.1:8080";
    if (!isLocalDevAllowed() ||
      process.env.ENABLE_LOCAL_KB_UPDATING !== "true" || !isLoopbackOriginAllowed(req) || !validOrigin ||
      req.headers["x-local-admin-demo"] !== "update-kb-document" ||
      !req.is("application/json")) {
      return res.status(404).json({ error: "Local KB document updating unavailable" });
    }
    const tenantId = req.authorizedTenantId!;
    const documentName = req.params.documentName;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(?:txt|md)$/.test(documentName)) {
      return res.status(400).json({ error: "Invalid knowledge document filename" });
    }
    if (req.headers["x-confirm-update-document"] !== documentName) {
      return res.status(400).json({ error: "Confirm the exact document name to update" });
    }
    const body: Record<string, unknown> = asPlainBody(req.body) ?? {};
    if (Object.keys(body).some(k => !["tenantId", "content", "expectedEtag"].includes(k))) {
      return res.status(400).json({ error: "Invalid update fields" });
    }
    const content = body.content;
    if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content, "utf8") > 32768) {
      return res.status(400).json({ error: "Document must contain 1-32768 bytes of UTF-8 text" });
    }
    const expectedEtag = body.expectedEtag;
    if (typeof expectedEtag !== "string" || !/^"[^"\r\n]{1,160}"$/.test(expectedEtag)) {
      return res.status(428).json({ error: "Provide the current document ETag before updating" });
    }

    const bucket = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";
    const key = `tenants/${tenantId}/${documentName}`;
    if (localKbUpdatesInFlight.has(key)) {
      return res.status(409).json({ error: "An update to this document is already in progress" });
    }
    localKbUpdatesInFlight.add(key);
    try {
      const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (!head.ETag) return res.status(503).json({ error: "Document version unavailable" });
      if (head.ETag !== expectedEtag) {
        return res.status(409).json({ error: "Document changed; reload it before updating" });
      }
      if ((head.ContentLength ?? 0) > 32768) {
        return res.status(413).json({ error: "Existing document exceeds local update limit" });
      }
      const documentBody = Buffer.from(content, "utf8");
      const result = await s3Client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: documentBody,
        ContentLength: documentBody.length,
        ContentType: "text/plain; charset=utf-8",
        IfMatch: expectedEtag,
        Metadata: { ...(head.Metadata || {}), "tenant-id": tenantId, "updated-by": req.localAuth!.sub },
      }));
      return res.json({
        success: true, demoOnly: true, tenantId, name: documentName, key,
        updated: true, bytes: documentBody.length,
        previousEtag: expectedEtag, etag: result.ETag || null,
        storageStatus: "STORED_IN_S3", indexedInBedrock: null,
      });
    } catch (error: any) {
      if (["NoSuchKey", "NotFound"].includes(error?.name) ||
        (error?.$metadata?.httpStatusCode === 404 && error?.name !== "NoSuchBucket")) {
        return res.status(404).json({ error: "Knowledge document not found" });
      }
      if (["PreconditionFailed", "ConditionalRequestConflict"].includes(error?.name) ||
        [409, 412].includes(error?.$metadata?.httpStatusCode)) {
        return res.status(409).json({ error: "Document changed or a conflicting update occurred" });
      }
      console.error("[LocalKBUpdate] S3 document update failed:", error);
      return res.status(503).json({ error: "Knowledge document update unavailable; check LocalStack S3" });
    } finally {
      localKbUpdatesInFlight.delete(key);
    }
  });

  // Delete disposable kb-upload-test-* documents in the authenticated tenant's S3 prefix.
  app.delete("/api/dev/admin/knowledge-files/:documentName", ...requireCompanyAdmin, async (req, res) => {
    const origin = req.headers.origin;
    const validOrigin = origin === "http://localhost:8080" || origin === "http://127.0.0.1:8080";
    if (!isLocalDevAllowed() ||
      process.env.ENABLE_LOCAL_KB_DELETING !== "true" || !isLoopbackOriginAllowed(req) || !validOrigin ||
      req.headers["x-local-admin-demo"] !== "delete-kb-document") {
      return res.status(404).json({ error: "Local KB document deletion unavailable" });
    }
    const tenantId = req.authorizedTenantId!;
    const documentName = req.params.documentName;
    if (!/^kb-upload-test-[A-Za-z0-9_-]{1,60}\.(?:txt|md)$/.test(documentName)) {
      return res.status(400).json({ error: "Only disposable kb-upload-test-* text documents can be deleted" });
    }
    if (req.headers["x-confirm-delete-document"] !== documentName) {
      return res.status(400).json({ error: "Confirm the exact document name to delete" });
    }
    const expectedEtag = req.headers["if-match"];
    if (typeof expectedEtag !== "string" || !/^"[^"\r\n]{1,160}"$/.test(expectedEtag)) {
      return res.status(428).json({ error: "Provide the current document ETag in If-Match" });
    }

    const bucket = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";
    const key = `tenants/${tenantId}/${documentName}`;
    if (localKbUpdatesInFlight.has(key)) {
      return res.status(409).json({ error: "A change to this document is already in progress" });
    }
    localKbUpdatesInFlight.add(key);
    try {
      const head = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (!head.ETag) return res.status(503).json({ error: "Document version unavailable" });
      if (head.ETag !== expectedEtag) {
        return res.status(409).json({ error: "Document changed; reload it before deleting" });
      }
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: expectedEtag }));
      return res.json({
        success: true, demoOnly: true, tenantId, name: documentName, key,
        deleted: true, previousEtag: expectedEtag, indexedInBedrock: null,
      });
    } catch (error: any) {
      if (["NoSuchKey", "NotFound"].includes(error?.name) ||
        (error?.$metadata?.httpStatusCode === 404 && error?.name !== "NoSuchBucket")) {
        return res.status(404).json({ error: "Knowledge document not found" });
      }
      if (["PreconditionFailed", "ConditionalRequestConflict"].includes(error?.name) ||
        [409, 412].includes(error?.$metadata?.httpStatusCode)) {
        return res.status(409).json({ error: "Document changed or a conflicting deletion occurred" });
      }
      console.error("[LocalKBDelete] S3 document deletion failed:", error);
      return res.status(503).json({ error: "Knowledge document deletion unavailable; check LocalStack S3" });
    } finally {
      localKbUpdatesInFlight.delete(key);
    }
  });

  const LOCAL_SESSION_TABLE = "omni-channel-chat-sessions";
  const LOCAL_MAX_MESSAGES = 100; // Demo limit: each session is one DynamoDB item.

  app.post("/api/dev/live/conversations/:sessionId/close", ...requireAgentOrCompany, async (req, res) => {
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req)) {
      return res.status(404).json({ error: "Not found" });
    }
    const sessionId = req.params.sessionId;
    if (!SAFE_ID_PATTERN.test(sessionId)) {
      return res.status(400).json({ error: "Invalid sessionId" });
    }
    const tenantId = req.authorizedTenantId!;
    const resolvedAgent = resolveAuthorizedAgentId(req, req.query.agentId);
    if (!resolvedAgent.ok) {
      return res.status(resolvedAgent.status).json({ error: resolvedAgent.error });
    }
    const agentId = resolvedAgent.agentId;

    try {
      await docClient.send(new UpdateCommand({
        TableName: LOCAL_SESSION_TABLE,
        Key: { sessionId },
        UpdateExpression: "SET #st = :resolved, updatedAt = :now",
        ConditionExpression: "attribute_exists(sessionId) AND tenantId = :tenant AND assignedAgentId = :agent AND #st = :active",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":tenant": tenantId, ":agent": agentId,
          ":active": "HUMAN_ACTIVE", ":resolved": "RESOLVED", ":now": new Date().toISOString(),
        },
      }));
      await adjustActiveChats(tenantId, agentId, -1);
      return res.json({ sessionId, status: "RESOLVED", demoOnly: true });
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return res.status(409).json({ error: "Conversation is missing, already resolved, or not assigned to this agent" });
      }
      console.error("[LocalMessages] Resolution error:", error);
      return res.status(503).json({ error: "Conversation resolution unavailable" });
    }
  });

  app.get("/api/dev/live/conversations/:sessionId/messages", ...requireAgentOrCompany, async (req, res) => {
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req)) {
      return res.status(404).json({ error: "Not found" });
    }
    const sessionId = req.params.sessionId;
    if (!SAFE_ID_PATTERN.test(sessionId)) {
      return res.status(400).json({ error: "Invalid sessionId" });
    }
    const tenantId = req.authorizedTenantId!;
    const resolvedAgent = resolveAuthorizedAgentId(req, req.query.agentId);
    if (!resolvedAgent.ok) {
      return res.status(resolvedAgent.status).json({ error: resolvedAgent.error });
    }
    const agentId = resolvedAgent.agentId;

    try {
      const result = await docClient.send(new GetCommand({
        TableName: LOCAL_SESSION_TABLE, Key: { sessionId },
      }));
      const session = result.Item;
      if (!session || session.tenantId !== tenantId || session.assignedAgentId !== agentId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (session.status !== "HUMAN_ACTIVE" && session.status !== "RESOLVED") {
        return res.status(409).json({ error: "Conversation is not active" });
      }
      return res.json({
        session: { sessionId, status: session.status },
        messages: session.messages || [], demoOnly: true,
      });
    } catch (error: any) {
      console.error("[LocalMessages] Read error:", error);
      return res.status(503).json({ error: "Message store unavailable" });
    }
  });

  app.post("/api/dev/live/conversations/:sessionId/messages", ...requireAgentOrCompany, async (req, res) => {
    if (!isLocalDevAllowed() || !isLoopbackOriginAllowed(req)) {
      return res.status(404).json({ error: "Not found" });
    }
    const sessionId = req.params.sessionId;
    if (!SAFE_ID_PATTERN.test(sessionId)) {
      return res.status(400).json({ error: "Invalid sessionId" });
    }
    const tenantId = req.authorizedTenantId!;
    const resolvedAgent = resolveAuthorizedAgentId(req, req.query.agentId);
    if (!resolvedAgent.ok) {
      return res.status(resolvedAgent.status).json({ error: resolvedAgent.error });
    }
    const agentId = resolvedAgent.agentId;

    const body = asPlainBody(req.body);
    const role = body?.role;
    const message = body?.message;
    if ((role !== "user" && role !== "live_agent") ||
      typeof message !== "string" || !message.trim() || message.length > 1600) {
      return res.status(400).json({ error: "Role must be user or live_agent, and message must contain 1–1600 characters" });
    }
    const chatMessage = {
      messageId: randomUUID(), role, text: message.trim(), createdAt: new Date().toISOString(),
    };
    try {
      await docClient.send(new UpdateCommand({
        TableName: LOCAL_SESSION_TABLE,
        Key: { sessionId },
        UpdateExpression: "SET #msgs = list_append(if_not_exists(#msgs, :empty), :new), updatedAt = :now",
        ConditionExpression: "attribute_exists(sessionId) AND tenantId = :tenant AND assignedAgentId = :agent AND #st = :active AND (attribute_not_exists(#msgs) OR size(#msgs) < :limit)",
        ExpressionAttributeNames: { "#msgs": "messages", "#st": "status" },
        ExpressionAttributeValues: {
          ":empty": [], ":new": [chatMessage], ":now": chatMessage.createdAt,
          ":tenant": tenantId, ":agent": agentId, ":active": "HUMAN_ACTIVE",
          ":limit": LOCAL_MAX_MESSAGES,
        },
      }));
      return res.status(201).json({ ...chatMessage, demoOnly: true });
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return res.status(409).json({ error: "Session is not active, assigned to this agent, or has reached the demo message limit" });
      }
      console.error("[LocalMessages] Write error:", error);
      return res.status(503).json({ error: "Message store unavailable" });
    }
  });

  // ==========================================
  // 5. WORKSPACE PORTAL & KB DOCUMENT UPLOAD
  // ==========================================

  // Protected by verified company admin token; derives tenantId strictly from verified claims.
  app.post("/api/workspace/upload-doc", ...requireCompanyAdmin, async (req, res) => {
    if (!isLocalDevAllowed()) {
      return res.status(404).json({ success: false, error: "Local KB document uploading unavailable" });
    }
    if (!req.is("application/json")) {
      return res.status(400).json({ success: false, error: "Content-Type application/json is required" });
    }

    const tenantId = req.authorizedTenantId!;
    const body: Record<string, unknown> = asPlainBody(req.body) ?? {};
    const documentName = typeof body.documentName === "string" ? body.documentName.trim() : "";
    const content = body.content;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(?:txt|md)$/.test(documentName)) {
      return res.status(400).json({ success: false, error: "Use a simple .txt or .md filename (letters, digits, dash, underscore)" });
    }
    if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content, "utf8") > 32 * 1024) {
      return res.status(400).json({ success: false, error: "Document must contain 1-32768 bytes of UTF-8 text" });
    }

    const context: TenantContext = {
      tenantId,
      userId: req.localAuth!.sub,
      role: "admin",
      permissions: ["faults:read", "billing:read", "usage:read"],
      channel: "web",
      sessionId: `sess-${randomUUID()}`,
      conversationId: `conv-${randomUUID()}`,
    };

    try {
      const uploadedKey = await uploadKbDocument(context, documentName, content, { createOnly: true });
      return res.status(201).json({
        success: true,
        s3Key: uploadedKey,
        tenantId,
        storageStatus: "STORED_IN_S3",
        indexedInBedrock: null,
        message: `Document '${documentName}' stored in local S3.`,
      });
    } catch (err: any) {
      if (err?.name === "PreconditionFailed" || err?.$metadata?.httpStatusCode === 412 ||
        err?.name === "ConditionalRequestConflict") {
        return res.status(409).json({ success: false, error: "Document already exists or upload conflicted" });
      }
      console.error("[LocalKBUpload] S3 upload failed:", err);
      return res.status(503).json({ success: false, error: "Document upload failed; check LocalStack S3" });
    }
  });

  // GET /api/workspace/conversations (Tenant-Scoped Conversation Transcripts)
  app.get("/api/workspace/conversations", ...requireCompanyAdmin, async (req, res) => {
    if (!isLocalDevAllowed()) {
      return res.status(404).json({ success: false, error: "Local workspace conversations unavailable" });
    }

    let limit = 50;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== "string" || !/^\d+$/.test(req.query.limit.trim())) {
        return res.status(400).json({ success: false, error: "Invalid limit parameter" });
      }
      limit = Number(req.query.limit.trim());
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ success: false, error: "limit must be between 1 and 100" });
      }
    }

    const tenantId = req.authorizedTenantId!;
    try {
      const conversations = await listConversationsForTenant(tenantId, limit);
      return res.status(200).json({
        success: true,
        tenantId,
        conversations,
      });
    } catch (error) {
      console.error("[WorkspaceConversations] Failed to query tenant conversations:", error);
      return res.status(503).json({
        success: false,
        error: "Conversations unavailable; check DynamoDB",
      });
    }
  });

  // ==========================================
  // 6. HOSTED CHAT URL RESOLVER
  // ==========================================

  // GET /api/resolve-chat-url?company={slug}&agent={agent} (Public customer chat widget bootstrap)
  app.get(["/api/resolve-chat-url", "/resolve-chat-url"], limitChatResolver, async (req, res) => {
    const result = await resolveHostedChatConfig(req.query.company, req.query.agent);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(200).json(result.config);
  });

  // ==========================================
  // 7. AGENT CHAT DISPATCH PIPELINE
  // ==========================================

  const ALLOWED_CHANNELS = new Set<TenantContext["channel"]>([
    "web",
    "whatsapp",
    "sms",
    "messenger",
  ]);

  // POST /api/tenant/route or POST /api/agent
  app.post(["/api/tenant/route", "/api/agent"], ...requireAgentOrCompany, async (req, res) => {
    try {
      const auth = req.localAuth!;
      const rawChannel = typeof req.headers["x-channel"] === "string"
        ? req.headers["x-channel"].trim().toLowerCase()
        : "";
      const channel: TenantContext["channel"] = ALLOWED_CHANNELS.has(rawChannel as TenantContext["channel"])
        ? (rawChannel as TenantContext["channel"])
        : "web";

      const rawSessionId = typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"].trim()
        : "";
      const sessionId = SAFE_ID_PATTERN.test(rawSessionId) ? rawSessionId : `sess-${randomUUID()}`;

      const rawConvId = typeof req.headers["x-conversation-id"] === "string"
        ? req.headers["x-conversation-id"].trim()
        : "";
      const conversationId = SAFE_ID_PATTERN.test(rawConvId) ? rawConvId : `conv-${randomUUID()}`;

      const verifiedContext: TenantContext = {
        tenantId: req.authorizedTenantId!,
        userId: auth.sub,
        role: auth.role === "company" ? "admin" : "live_agent",
        permissions:
          auth.role === "company"
            ? ["billing:read", "billing:purchase", "usage:read", "faults:read", "faults:create"]
            : ["billing:read", "usage:read", "faults:read", "faults:create"],
        channel,
        sessionId,
        conversationId,
      };

      const body = asPlainBody(req.body);
      if (req.body !== undefined && !body) {
        return res.status(400).json({
          success: false,
          error: { code: "BAD_REQUEST", message: "Invalid JSON object payload", retryable: false },
        });
      }

      const response = await handleTenantRequest({
        headers: (req.headers as Record<string, string>) || {},
        body: body || {},
        verifiedContext,
      });

      if (!response.success) {
        const code = response.error?.code;
        const status =
          code === "UNAUTHORIZED"
            ? 401
            : code === "FORBIDDEN" || code === "TENANT_INACTIVE"
              ? 403
              : code === "TENANT_NOT_FOUND"
                ? 404
                : code === "BAD_REQUEST"
                  ? 400
                  : 500;
        return res.status(status).json(response);
      }

      return res.status(200).json(response);
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

  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!err) return next();
    if (err.type === "entity.too.large" || err.status === 413) {
      return res.status(413).json({
        success: false,
        error: "Request payload too large",
      });
    }
    if (err instanceof SyntaxError || err.type === "entity.parse.failed" || err.status === 400) {
      return res.status(400).json({
        success: false,
        error: "Malformed JSON request body",
      });
    }
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  });

  return app;
}

const app = createApp();

const isDirectExecution =
  (typeof require !== "undefined" && require.main === module) ||
  Boolean(process.argv[1] && /(?:^|[\\/])server\.(?:ts|js)$/i.test(process.argv[1]));

let server: any = null;
if (isDirectExecution) {
  server = app.listen(Number(PORT), "127.0.0.1", () => {
    console.log(`🚀 omni-channel-backend API Server running at http://localhost:${PORT}`);
  });
}

export { app, server, getLocalSessionTokenService };
export default app;

