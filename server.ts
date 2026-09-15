import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { handleTenantRequest } from "./services/tenant-router/handler";

// Enable mock authorization for local development environment
if (process.env.NODE_ENV !== "production") {
  process.env.ALLOW_MOCK_AUTH = "true";
}

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const DB_PATH = path.join(__dirname, "db.json");

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

// --- AUTH ROUTES ---

// POST /api/auth/login
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password are required" });
  }

  const db = readDB();
  const user = db.users.find((u: any) => u.email.toLowerCase() === email.toLowerCase() && u.password === password);

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

// --- REGISTRATION & COMPANY MANAGEMENT ROUTES ---

// GET /api/registrations
app.get("/api/registrations", (req, res) => {
  const db = readDB();
  res.json({ success: true, registrations: db.registrations });
});

// POST /api/registrations
app.post("/api/registrations", (req, res) => {
  const body = req.body;
  const db = readDB();

  const newReg = {
    id: `reg-${Date.now()}`,
    companyName: body.companyName || "Unnamed Company",
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

// PUT /api/registrations/:id/status
app.put("/api/registrations/:id/status", (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const db = readDB();
  const reg = db.registrations.find((r: any) => r.id === id);

  if (!reg) {
    return res.status(404).json({ success: false, error: "Registration not found" });
  }

  reg.status = status;
  writeDB(db);

  res.json({ success: true, registration: reg });
});

// GET /api/stats
app.get("/api/stats", (req, res) => {
  const db = readDB();
  const activeCount = db.registrations.filter((r: any) => r.status === "Approved").length;
  const pendingCount = db.registrations.filter((r: any) => r.status === "Pending").length;

  res.json({
    totalAvailability: activeCount,
    activeConnections: activeCount,
    pendingRequests: pendingCount,
  });
});

// --- TENANT ROUTER & AGENT PIPELINE ROUTE ---
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

app.listen(PORT, () => {
  console.log(`🚀 omni-channel-backend-dev running at http://localhost:${PORT}`);
});
