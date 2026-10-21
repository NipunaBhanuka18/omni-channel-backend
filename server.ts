import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { handleTenantRequest } from "./services/tenant-router/handler";
import { handleHandoffApi } from "./services/handoff/handler";
import { adjustActiveChats } from "./services/handoff/presence-manager";

import { registerTenant, handleRegisterTenantRequest } from "./services/onboarding/register-tenant";
import { s3Client, uploadKbDocument } from "./agents/utils/s3-client";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { inMemoryTenants, inMemoryAgents, provisionTenantResources } from "./scripts/create-tenants-table";
import { TenantContext } from "./shared/types/tenant-context";
import { docClient } from "./agents/utils/dynamo-client";
import { ScanCommand, QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

// Enable mock authorization for local development environment
if (process.env.NODE_ENV !== "production") {
  process.env.ALLOW_MOCK_AUTH = "true";
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, "db.json");

// Initialize baseline tenant DynamoDB/in-memory records
provisionTenantResources().catch((err) => {
  console.warn(`[Server Init] Baseline tenant provisioning note: ${err.message}`);
});

// Helper to read database
function readDB() {
  if (!fs.existsSync(DB_PATH)) {
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
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
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
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    }
    return data;
  } catch {
    return { users: [], registrations: [] };
  }
}

// Helper to write database
function writeDB(data: any) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Ensure DB exists on startup
readDB();

// ==========================================
// 1. AUTHENTICATION ROUTES
// ==========================================

// POST /api/auth/login
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password are required" });
  }

  const db = readDB();
  const user = db.users.find(
    (u: any) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
  );

  if (user) {
    return res.json({
      success: true,
      user: { id: user.id, name: user.fullName || user.email, email: user.email, role: user.role },
      token: `token-${user.id}-${Date.now()}`,
    });
  }

  const registration = db.registrations.find(
    (r: any) => r.companyEmail && r.companyEmail.toLowerCase() === email.toLowerCase() && r.password === password
  );

  if (registration) {
    if (registration.status !== "Approved") {
      return res.status(403).json({
        success: false,
        error: `Your registration is currently ${registration.status.toLowerCase()}. Please await Super Admin approval.`,
      });
    }

    return res.json({
      success: true,
      user: {
        id: registration.id,
        name: registration.adminName || registration.companyName,
        email: registration.companyEmail,
        role: "company",
        tenantId: registration.tenantId || `tenant-${registration.id}`,
      },
      token: `token-org-${registration.id}-${Date.now()}`,
    });
  }

  return res.status(401).json({ success: false, error: "Invalid email or password" });
});

// POST /api/auth/register-admin
app.post("/api/auth/register-admin", (req, res) => {
  const { fullName, email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  const db = readDB();
  const existing = db.users.find((u: any) => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.status(400).json({ success: false, error: "Email already registered" });
  }

  const newUser = {
    id: `user-${Date.now()}`,
    fullName: fullName || email.split("@")[0],
    email,
    password,
    role: "superadmin",
    createdAt: new Date().toISOString(),
  };

  db.users.push(newUser);
  writeDB(db);

  return res.status(201).json({ success: true, user: newUser });
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
app.get("/api/registrations", (req, res) => {
  const db = readDB();
  const rawList = (db.registrations || []).map(normalizeRegistration);
  const statusParam = req.query.status as string;

  if (statusParam) {
    const filtered = rawList.filter(
      (r: any) => (r.status || "").toLowerCase() === statusParam.toLowerCase()
    );
    return res.json(filtered);
  }

  return res.json({ success: true, registrations: rawList });
});

// POST /api/registrations
app.post("/api/registrations", (req, res) => {
  const body = req.body;
  const db = readDB();

  const cleanSlug = (body.companyName || body.name || "company").toLowerCase().replace(/[^a-z0-9]/g, "-");
  const dateStr = new Date().toISOString().split("T")[0];
  const newReg = normalizeRegistration({
    id: `reg-${Date.now()}`,
    companyName: body.companyName || body.name || "Unnamed Company",
    name: body.companyName || body.name || "Unnamed Company",
    companySlug: body.companySlug || cleanSlug,
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

  res.status(201).json({ success: true, registration: newReg });
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
  reg.status = normalizedStatus;

  // Auto-Provision Tenant Partition when Approved
  if (normalizedStatus === "Approved" && !reg.tenantId) {
    try {
      const onboardResult = await registerTenant({
        companyName: reg.companyName,
        companySlug: reg.companySlug || reg.companyName.toLowerCase().replace(/[^a-z0-9]/g, "-"),
        adminEmail: reg.companyEmail || `admin@${reg.companyName.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`,
        planTier: reg.tier?.toLowerCase() === "enterprise" ? "enterprise" : "starter",
      });
      reg.tenantId = onboardResult.tenantId;
      reg.onboardedAt = new Date().toISOString();
      console.log(`✅ [Auto-Provisioning] Successfully provisioned tenant '${reg.tenantId}' for ${reg.companyName}`);
    } catch (onboardErr: any) {
      console.warn(`⚠️ [Auto-Provisioning Warning] ${onboardErr.message}`);
      reg.tenantId = `tenant-${id}`;
    }
  }

  db.registrations[regIndex] = normalizeRegistration(reg);
  writeDB(db);
  return res.json({ success: true, registration: db.registrations[regIndex] });
};

// PATCH /api/registrations/:id (Super Admin Approves / Rejects)
app.patch("/api/registrations/:id", handleUpdateRegistrationStatus);

// PUT /api/registrations/:id
app.put("/api/registrations/:id", handleUpdateRegistrationStatus);

// PUT /api/registrations/:id/status (Backwards compatibility)
app.put("/api/registrations/:id/status", handleUpdateRegistrationStatus);

// GET /api/stats (Admin Console Dashboard Stats)
app.get("/api/stats", (req, res) => {
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
app.get("/api/notifications", (req, res) => {
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
app.post("/api/tenants/register", async (req, res) => {
  const response = await handleRegisterTenantRequest({
    httpMethod: "POST",
    body: req.body,
  });
  return res.status(response.statusCode).json(JSON.parse(response.body));
});

// ==========================================
// 4. MEMBER 3 LIVE AGENT CONSOLE & PRESENCE ROUTES
// ==========================================

// POST /api/agent/presence/online ("Go Online")
app.post(["/api/agent/presence/online", "/agent/presence/online"], async (req, res) => {
  const { tenantId, agentId, connectionId } = req.body;
  const result = await handleHandoffApi({
    action: "presence_online",
    tenantId: tenantId || "slt",
    agentId: agentId || "admin1",
    connectionId,
  });
  if (!result.success) return res.status(400).json(result);
  return res.status(200).json({ success: true, ...result.data });
});

// POST /api/agent/presence/offline ("Go Offline")
app.post(["/api/agent/presence/offline", "/agent/presence/offline"], async (req, res) => {
  const { tenantId, agentId } = req.body;
  const result = await handleHandoffApi({
    action: "presence_offline",
    tenantId: tenantId || "slt",
    agentId: agentId || "admin1",
  });
  if (!result.success) return res.status(400).json(result);
  return res.status(200).json({ success: true, ...result.data });
});

// GET /api/agent/presence/status
app.get(["/api/agent/presence/status", "/agent/presence/status"], async (req, res) => {
  const tenantId = (req.query.tenantId as string) || "slt";
  const agentId = (req.query.agentId as string) || "admin1";
  const result = await handleHandoffApi({
    action: "presence_status",
    tenantId,
    agentId,
  });
  if (!result.success) return res.status(400).json(result);
  return res.status(200).json({ success: true, ...result.data });
});

// POST /api/chat/handoff/request (Escalation Trigger)
app.post(["/api/chat/handoff/request", "/chat/handoff/request"], async (req, res) => {
  const { tenantId, sessionId, reason, customerInfo } = req.body;
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
app.post(["/api/chat/handoff/resolve", "/chat/handoff/resolve"], async (req, res) => {
  const { tenantId, sessionId, agentId } = req.body;
  const result = await handleHandoffApi({
    action: "resolve_session",
    tenantId: tenantId || "slt",
    sessionId,
    agentId,
  });
  if (!result.success) return res.status(400).json(result);
  return res.status(200).json({ success: true, ...result.data });
});


// Local-development-only queue preview for the unified MVP live-agent console.
// This route is NOT production authentication. Replace it with Cognito-based
// agent identity and tenant-scoped authorization before deployment.
app.get("/api/dev/live/queue", async (req, res) => {
  const remote = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const allowedOrigins = ["http://localhost:8080", "http://127.0.0.1:8080"];
  if (process.env.NODE_ENV === "production" || !loopback ||
      (req.headers.origin && !allowedOrigins.includes(req.headers.origin))) {
    return res.status(404).json({ error: "Not found" });
  }

  const tenantId = String(req.query.tenantId || "");
  const agentId = String(req.query.agentId || "");
  if (tenantId !== "slt" || agentId !== "local-agent-01") {
    return res.status(400).json({ error: "Only the local SLT test agent is supported" });
  }

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

// Read-only SLT dashboard counts from LocalStack. This is a local test adapter,
// NOT an authenticated company-admin endpoint. Never deploy this route publicly.
app.get("/api/dev/admin/overview", async (req, res) => {
  const remote = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const allowedOrigins = ["http://localhost:8080", "http://127.0.0.1:8080"];
  if (process.env.NODE_ENV === "production" || !loopback ||
      (req.headers.origin && !allowedOrigins.includes(req.headers.origin))) {
    return res.status(404).json({ error: "Not found" });
  }
  if (req.query.tenantId !== "slt") {
    return res.status(400).json({ error: "Only the local SLT test tenant is supported" });
  }

  // Query tenant-partitioned tables; scan session table only for this small local demo.
  // Production needs authenticated role/tenant authorization and indexed queries.
  const readTenantRows = async (tableName: string, scan = false) => {
    const rows: Array<Record<string, any>> = [];
    let nextKey: Record<string, any> | undefined;
    do {
      const args = {
        TableName: tableName,
        ...(scan ? { FilterExpression: "tenantId = :tenant" } : {
          KeyConditionExpression: "tenantId = :tenant",
        }),
        ExpressionAttributeValues: { ":tenant": "slt" },
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
      tenantId: "slt", source: "localstack", demoOnly: true,
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

// Read-only Chat Monitor for the fixed SLT local-development tenant.
// No message contents are returned. This must NOT be deployed as an admin API:
// proper Cognito authentication and tenant authorization are required first.
app.get("/api/dev/admin/chats", async (req, res) => {
  const remote = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const allowedOrigins = ["http://localhost:8080", "http://127.0.0.1:8080"];
  if (process.env.NODE_ENV === "production" || !loopback ||
      (req.headers.origin && !allowedOrigins.includes(req.headers.origin))) {
    return res.status(404).json({ error: "Not found" });
  }
  if (req.query.tenantId !== "slt") {
    return res.status(400).json({ error: "Only the local SLT test tenant is supported" });
  }

  try {
    const sessions: Array<Record<string, any>> = [];
    let nextKey: Record<string, any> | undefined;
    do {
      const response = await docClient.send(new ScanCommand({
        TableName: "omni-channel-chat-sessions",
        FilterExpression: "tenantId = :tenant",
        ExpressionAttributeValues: { ":tenant": "slt" },
        ExclusiveStartKey: nextKey,
      }));
      sessions.push(...((response.Items || []) as Array<Record<string, any>>));
      nextKey = response.LastEvaluatedKey;
    } while (nextKey);

    // ISO timestamps sort chronologically; use createdAt if updatedAt is absent.
    sessions.sort((a, b) => String(b.updatedAt || b.createdAt || "")
      .localeCompare(String(a.updatedAt || a.createdAt || "")));
    return res.json({
      tenantId: "slt", source: "localstack", demoOnly: true,
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

// Local SLT agent list. This is only for the loopback-only admin preview.
// Do not expose this endpoint in production; it has no Cognito authorization.
app.get("/api/dev/admin/agents", async (req, res) => {
  const remote = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const allowedOrigins = ["http://localhost:8080", "http://127.0.0.1:8080"];
  if (process.env.NODE_ENV === "production" || !loopback ||
      (req.headers.origin && !allowedOrigins.includes(req.headers.origin))) {
    return res.status(404).json({ error: "Not found" });
  }
  if (req.query.tenantId !== "slt") {
    return res.status(400).json({ error: "Only the local SLT test tenant is supported" });
  }

  try {
    const records: Array<Record<string, any>> = [];
    let lastKey: Record<string, any> | undefined;
    do {
      const result = await docClient.send(new QueryCommand({
        TableName: "omni-channel-agents",
        KeyConditionExpression: "tenantId = :tenant",
        ExpressionAttributeValues: { ":tenant": "slt" },
        ExclusiveStartKey: lastKey,
      }));
      records.push(...((result.Items || []) as Array<Record<string, any>>));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    records.sort((a, b) => String(a.agentId || "").localeCompare(String(b.agentId || "")));
    return res.json({
      tenantId: "slt", source: "localstack", demoOnly: true,
      total: records.length,
      items: records.map(a => ({
        agentId: String(a.agentId || ""),
        displayName: String(a.displayName || a.name || a.agentName || a.agentId || "Unnamed agent"),
        modelId: typeof a.modelId === "string" ? a.modelId :
          (typeof a.defaultModel === "string" ? a.defaultModel : null),
        status: typeof a.status === "string" ? a.status.toUpperCase() : "UNKNOWN",
        // Seeded agent records do not necessarily have a published chat URL.
        publicAgentKey: typeof a.publicAgentKey === "string" && a.publicAgentKey.trim()
          ? a.publicAgentKey : null,
      })),
    });
  } catch (error) {
    console.error("[LocalAdminAgents] LocalStack query failed:", error);
    return res.status(503).json({ error: "Agent list unavailable; check the agent DynamoDB table" });
  }
});

// Explicitly opt-in to creating DRAFT agent records for the fixed SLT local demo.
// SECURITY: This is intentionally NOT a production admin API. Localhost alone is
// not authentication; remove/replace this route with Cognito authorization before deploy.
app.post("/api/dev/admin/agents", async (req, res) => {
  const remote = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const origin = req.headers.origin;
  const validOrigin = origin === "http://localhost:8080" || origin === "http://127.0.0.1:8080";
  if (process.env.NODE_ENV === "production" || process.env.IS_LOCAL === "false" ||
      process.env.ENABLE_LOCAL_AGENT_CREATION !== "true" || !loopback || !validOrigin ||
      req.headers["x-local-admin-demo"] !== "create-agent" ||
      !req.is("application/json")) {
    return res.status(404).json({ error: "Local agent record creation is disabled or request not allowed" });
  }

  const body: Record<string, unknown> = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body : {};
  if (body.tenantId !== undefined && body.tenantId !== "slt") {
    return res.status(400).json({ error: "Only tenant slt can be used in this local demo" });
  }
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
    tenantId: "slt", agentId, name: displayName, displayName, brandName,
    modelId, defaultModel: modelId, publicAgentKey,
    status: "draft", createdAt, updatedAt: createdAt,
    welcomeMessage, systemPrompt, knowledgeBaseRef,
    suggestedPrompts, toolIds, enabledSubAgents,
    // Configuration is metadata until the runtime/publishing integration is implemented.
    deploymentStatus: "NOT_DEPLOYED",
  };
  try {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await docClient.send(new PutCommand({
      TableName: "omni-channel-agents",
      Item: item,
      ConditionExpression: "attribute_not_exists(tenantId) AND attribute_not_exists(agentId)",
    }));
    return res.status(201).json({ source: "localstack", tenantId: "slt", demoOnly: true, item });
  } catch (error) {
    console.error("[LocalAdminAgents] Could not create DRAFT agent record:", error);
    return res.status(503).json({ error: "Could not save agent record to LocalStack DynamoDB" });
  }
});

// LOCAL DEMO ONLY: publishing here makes a stored configuration accessible via
// the existing mock-backed chat UI. It does NOT deploy an AI agent or expose a
// public internet URL. Production requires real admin authentication and hosting.
app.post("/api/dev/admin/agents/:agentId/publish", async (req, res) => {
  const remote = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const origin = req.headers.origin;
  const validOrigin = origin === "http://localhost:8080" || origin === "http://127.0.0.1:8080";
  if (process.env.NODE_ENV === "production" || process.env.IS_LOCAL === "false" ||
      process.env.ENABLE_LOCAL_AGENT_PUBLISHING !== "true" || !loopback || !validOrigin ||
      req.headers["x-local-admin-demo"] !== "publish-agent" || !req.is("application/json")) {
    return res.status(404).json({ error: "Local publishing is not enabled" });
  }
  const agentId = req.params.agentId;
  if (!/^agent-[a-zA-Z0-9-]{1,80}$/.test(agentId)) {
    return res.status(400).json({ error: "Invalid draft agent ID" });
  }
  try {
    const record = await docClient.send(new GetCommand({
      TableName: "omni-channel-agents", Key: { tenantId: "slt", agentId },
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

    // Reject duplicate slugs for this tenant. The production model should
    // enforce slug uniqueness atomically with a separate slug-lock item.
    let lastKey: Record<string, any> | undefined;
    do {
      const page = await docClient.send(new QueryCommand({
        TableName: "omni-channel-agents",
        KeyConditionExpression: "tenantId = :tenant",
        ExpressionAttributeValues: { ":tenant": "slt" },
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
      TableName: "omni-channel-agents", Key: { tenantId: "slt", agentId },
      UpdateExpression: "SET #status = :published, publishedAt = :now, updatedAt = :now",
      ConditionExpression: "attribute_exists(agentId) AND (#status = :draft OR #status = :draftUpper) AND publicAgentKey = :publicKey",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":published": "PUBLISHED", ":draft": "draft", ":draftUpper": "DRAFT",
        ":publicKey": publicKey, ":now": now,
      },
    }));
    return res.json({
      tenantId: "slt", agentId, status: "PUBLISHED", demoOnly: true,
      publicPath: `/chat.html?company=slt&agent=${encodeURIComponent(publicKey)}`,
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

// Read-only S3 source file inventory for the local SLT admin preview.
// An S3 object is NOT proof of a Bedrock Knowledge Base registration or successful indexing.
// This endpoint has no Cognito authorization and must not be deployed publicly.
app.get("/api/dev/admin/knowledge-files", async (req, res) => {
  const remote = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const allowedOrigins = ["http://localhost:8080", "http://127.0.0.1:8080"];
  if (process.env.NODE_ENV === "production" || process.env.IS_LOCAL === "false" || !loopback ||
      (req.headers.origin && !allowedOrigins.includes(req.headers.origin))) {
    return res.status(404).json({ error: "Not found" });
  }
  if (req.query.tenantId !== "slt") {
    return res.status(400).json({ error: "Only the local SLT test tenant is supported" });
  }

  const bucket = process.env.KB_BUCKET_NAME || "omni-channel-kb-docs";
  const prefix = "tenants/slt/";
  try {
    // A bounded listing keeps this local debugging endpoint inexpensive.
    // If more than 100 objects exist, show that the inventory is incomplete.
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
      tenantId: "slt", source: "localstack-s3", demoOnly: true,
      bucket, prefix, bucketStatus: "available",
      totalShown: items.length, truncated: !!result.IsTruncated, items,
      bedrockKnowledgeBasesTracked: false,
    });
  } catch (error: any) {
    if (["NoSuchBucket", "NotFound"].includes(error?.name)) {
      return res.json({
        tenantId: "slt", source: "localstack-s3", demoOnly: true,
        bucket, prefix, bucketStatus: "missing",
        totalShown: 0, truncated: false, items: [],
        bedrockKnowledgeBasesTracked: false,
      });
    }
    console.error("[LocalAdminKnowledge] S3 list failed:", error);
    return res.status(503).json({ error: "Local S3 inventory unavailable" });
  }
});

// TEMPORARY LOCAL MESSAGE API — NOT SUITABLE FOR PRODUCTION.
// The agent ID is fixed for the SLT demo and there is no Cognito identity here.
// Keep these endpoints loopback-only until proper customer/agent authorization exists.
function allowLocalMessageRequest(req: express.Request): boolean {
  const remote = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  const origins = ["http://localhost:8080", "http://127.0.0.1:8080"];
  return process.env.NODE_ENV !== "production" && loopback &&
    (!req.headers.origin || origins.includes(req.headers.origin)) &&
    req.query.tenantId === "slt" && req.query.agentId === "local-agent-01";
}

const LOCAL_SESSION_TABLE = "omni-channel-chat-sessions";
const LOCAL_MAX_MESSAGES = 100; // Demo limit: each session is one DynamoDB item.

// Local-only resolution endpoint: the conditional write is the source of truth.
// Unlike the legacy resolve endpoint, it does not report success if the session
// was absent, assigned to someone else, or already resolved.
app.post("/api/dev/live/conversations/:sessionId/close", async (req, res) => {
  if (!allowLocalMessageRequest(req)) return res.status(404).json({ error: "Not found" });
  const sessionId = req.params.sessionId;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    return res.status(400).json({ error: "Invalid sessionId" });
  }
  try {
    await docClient.send(new UpdateCommand({
      TableName: LOCAL_SESSION_TABLE,
      Key: { sessionId },
      UpdateExpression: "SET #st = :resolved, updatedAt = :now",
      ConditionExpression: "attribute_exists(sessionId) AND tenantId = :tenant AND assignedAgentId = :agent AND #st = :active",
      ExpressionAttributeNames: { "#st": "status" },
      ExpressionAttributeValues: {
        ":tenant": "slt", ":agent": "local-agent-01",
        ":active": "HUMAN_ACTIVE", ":resolved": "RESOLVED", ":now": new Date().toISOString(),
      },
    }));
    // Decrement only after the first successful transition, not on repeat clicks.
    await adjustActiveChats("slt", "local-agent-01", -1);
    return res.json({ sessionId, status: "RESOLVED", demoOnly: true });
  } catch (error: any) {
    if (error?.name === "ConditionalCheckFailedException") {
      return res.status(409).json({ error: "Conversation is missing, already resolved, or not assigned to this local agent" });
    }
    console.error("[LocalMessages] Resolution error:", error);
    return res.status(503).json({ error: "Conversation resolution unavailable" });
  }
});

app.get("/api/dev/live/conversations/:sessionId/messages", async (req, res) => {
  if (!allowLocalMessageRequest(req)) return res.status(404).json({ error: "Not found" });
  const sessionId = req.params.sessionId;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    return res.status(400).json({ error: "Invalid sessionId" });
  }
  try {
    const result = await docClient.send(new GetCommand({
      TableName: LOCAL_SESSION_TABLE, Key: { sessionId },
    }));
    const session = result.Item;
    if (!session || session.tenantId !== "slt" || session.assignedAgentId !== "local-agent-01") {
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

app.post("/api/dev/live/conversations/:sessionId/messages", async (req, res) => {
  if (!allowLocalMessageRequest(req)) return res.status(404).json({ error: "Not found" });
  const sessionId = req.params.sessionId;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    return res.status(400).json({ error: "Invalid sessionId" });
  }
  const role = req.body?.role;
  const message = req.body?.message;
  if ((role !== "user" && role !== "live_agent") ||
      typeof message !== "string" || !message.trim() || message.length > 1600) {
    return res.status(400).json({ error: "Role must be user or live_agent, and message must contain 1–1600 characters" });
  }
  const chatMessage = {
    messageId: randomUUID(), role, text: message.trim(), createdAt: new Date().toISOString(),
  };
  try {
    // Conditional append: do not create a missing session, cross tenants/agents,
    // reopen a resolved session, or exceed the demo per-session message cap.
    await docClient.send(new UpdateCommand({
      TableName: LOCAL_SESSION_TABLE,
      Key: { sessionId },
      UpdateExpression: "SET #msgs = list_append(if_not_exists(#msgs, :empty), :new), updatedAt = :now",
      ConditionExpression: "attribute_exists(sessionId) AND tenantId = :tenant AND assignedAgentId = :agent AND #st = :active AND (attribute_not_exists(#msgs) OR size(#msgs) < :limit)",
      ExpressionAttributeNames: { "#msgs": "messages", "#st": "status" },
      ExpressionAttributeValues: {
        ":empty": [], ":new": [chatMessage], ":now": chatMessage.createdAt,
        ":tenant": "slt", ":agent": "local-agent-01", ":active": "HUMAN_ACTIVE",
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

// POST /api/workspace/upload-doc (Knowledge Base Upload)
app.post("/api/workspace/upload-doc", async (req, res) => {
  const { documentName, content, tenantId, userId } = req.body;
  if (!documentName || !content) {
    return res.status(400).json({ success: false, error: "Missing documentName or content" });
  }

  const effectiveTenantId = tenantId || "slt";
  const context: TenantContext = {
    tenantId: effectiveTenantId,
    userId: userId || "console-admin",
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
app.get("/api/workspace/conversations", (req, res) => {
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
      },
      {
        conversationId: "conv-102",
        customerName: "Nimali Fernando",
        lastMessage: "Can I check my current 4G data usage?",
        status: "BOT_HANDLED",
        assignedAgent: "AI Bot",
        updatedAt: new Date().toISOString(),
      },
    ],
  });
});

// ==========================================
// 6. HOSTED CHAT URL RESOLVER
// ==========================================

// GET /api/resolve-chat-url?company={slug}&agent={agent}
app.get(["/api/resolve-chat-url", "/resolve-chat-url"], async (req, res) => {
  const remote = req.socket.remoteAddress || "";
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
  if (process.env.NODE_ENV === "production" || process.env.IS_LOCAL === "false" || !loopback) {
    return res.status(404).json({ error: "Local chat resolver is unavailable" });
  }
  const companySlug = typeof req.query.company === "string" ? req.query.company : "slt";
  const agentSlug = typeof req.query.agent === "string" ? req.query.agent : "support";
  if (companySlug !== "slt" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(agentSlug)) {
    return res.status(404).json({ error: "Chatbot not found" });
  }

  // Preserve the original SLT support chatbot for the existing demonstration.
  if (agentSlug === "support") {
    const tenant = inMemoryTenants.get("slt");
    const companyName = tenant?.companyName || "Sri Lanka Telecom";
    return res.json({
      success: true, demoOnly: true, tenantId: "slt", companyName,
      agentId: "agent-slt-support-01", agentName: `${companyName} Assistant`,
      welcomeMessage: `Welcome to ${companyName}! How can we assist you today?`,
      themeColor: tenant?.config?.themeColor || "#005EB8",
      suggestedPrompts: ["Check my bill", "Check my usage", "Slow internet", "Talk to a person"],
    });
  }

  try {
    const records: Array<Record<string, any>> = [];
    let nextKey: Record<string, any> | undefined;
    do {
      const page = await docClient.send(new QueryCommand({
        TableName: "omni-channel-agents",
        KeyConditionExpression: "tenantId = :tenant",
        ExpressionAttributeValues: { ":tenant": "slt" },
        ExclusiveStartKey: nextKey,
      }));
      records.push(...((page.Items || []) as Array<Record<string, any>>));
      nextKey = page.LastEvaluatedKey;
    } while (nextKey);
    const matches = records.filter(agent =>
      agent.publicAgentKey === agentSlug && String(agent.status).toUpperCase() === "PUBLISHED");
    if (matches.length !== 1) return res.status(404).json({ error: "This chatbot has not been published" });
    const agent = matches[0];
    return res.json({
      success: true, demoOnly: true, tenantId: "slt",
      companyName: String(agent.brandName || "Sri Lanka Telecom"),
      agentId: String(agent.agentId),
      agentName: String(agent.displayName || agent.name || "Customer Assistant"),
      welcomeMessage: String(agent.welcomeMessage || "Hello! How can I help you?"),
      suggestedPrompts: Array.isArray(agent.suggestedPrompts) ? agent.suggestedPrompts : [],
      themeColor: "#005EB8",
      deploymentStatus: "NOT_DEPLOYED",
    });
  } catch (error) {
    console.error("[LocalChatResolver] DynamoDB error:", error);
    return res.status(503).json({ error: "Chatbot configuration unavailable" });
  }
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

