import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { handleTenantRequest } from "./services/tenant-router/handler";
import { handleHandoffApi } from "./services/handoff/handler";

import { registerTenant, handleRegisterTenantRequest } from "./services/onboarding/register-tenant";
import { uploadKbDocument } from "./agents/utils/s3-client";
import { inMemoryTenants, inMemoryAgents, provisionTenantResources } from "./scripts/create-tenants-table";
import { TenantContext } from "./shared/types/tenant-context";

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

// GET /api/registrations
app.get("/api/registrations", (req, res) => {
  const db = readDB();
  res.json({ success: true, registrations: db.registrations });
});

// POST /api/registrations
app.post("/api/registrations", (req, res) => {
  const body = req.body;
  const db = readDB();

  const cleanSlug = (body.companyName || "company").toLowerCase().replace(/[^a-z0-9]/g, "-");
  const newReg = {
    id: `reg-${Date.now()}`,
    companyName: body.companyName || "Unnamed Company",
    companySlug: body.companySlug || cleanSlug,
    businessRegNumber: body.businessRegNumber || "BR-PENDING",
    companyEmail: body.companyEmail || "",
    adminName: body.adminName || "",
    password: body.password || "company123",
    status: "Pending",
    submissionDate: new Date().toISOString().split("T")[0],
    tier: body.tier || "Standard",
    allocatedAgents: body.allocatedAgents || 5,
    channels: body.channels || ["Web"],
  };

  db.registrations.push(newReg);
  writeDB(db);

  res.status(201).json({ success: true, registration: newReg });
});

// PUT /api/registrations/:id/status (Super Admin Approves / Rejects)
app.put("/api/registrations/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const db = readDB();
  const reg = db.registrations.find((r: any) => r.id === id);

  if (!reg) {
    return res.status(404).json({ success: false, error: "Registration not found" });
  }

  reg.status = status;

  // Auto-Provision Tenant Partition when Approved
  if (status === "Approved" && !reg.tenantId) {
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

  writeDB(db);
  res.json({ success: true, registration: reg });
});

// GET /api/stats (Admin Console Dashboard Stats)
app.get("/api/stats", (req, res) => {
  const db = readDB();
  const activeCount = db.registrations.filter((r: any) => r.status === "Approved").length;
  const pendingCount = db.registrations.filter((r: any) => r.status === "Pending").length;

  res.json({
    totalAvailability: activeCount,
    activeConnections: activeCount,
    pendingRequests: pendingCount,
    activeAgentsCount: 12,
    monthlyConversations: 14820,
    systemLatencyMs: 42,
  });
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

