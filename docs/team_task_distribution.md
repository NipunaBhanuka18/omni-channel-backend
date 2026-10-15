# Multi-Tenant AI Platform — 4-Member Rapid Execution Guide (Finish by Tomorrow)

> [!IMPORTANT]
> **CRITICAL DEADLINE & CONTEXT**:
> 1. **Deadline**: **Finish by tomorrow**. All tasks must be executed concurrently in high-priority, parallel blocks.
> 2. **UI Status**: **The frontend applications are already built in a separate repository**. Member 1 does **NOT** build the UI from scratch—their job is **UI Integration**: connecting the pre-built frontends to this backend, wiring Cognito authentication, configuring environment endpoints, and hooking up the real-time WebSocket/AppSync streams.

---

## 1. Team Role Allocation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ MEMBER 1: UI Integration (Connecting Pre-Built Frontends to Backend)        │
│ • Connect Admin Console, Live Agent Console & Public Chat to Backend APIs   │
│ • Wire Cognito Auth SDK (Admin & Live Agent logins), WebSockets & CORS      │
├─────────────────────────────────────────────────────────────────────────────┤
│ MEMBER 2: Multi-Tenancy, Isolation & Company Onboarding                     │
│ • Cognito Multi-Tenant Auth (custom:tenant_id claims)                       │
│ • Zero-Trust Tenant Resolver & Spoofing Guard                               │
│ • DynamoDB Tenant Partitioning (omni-channel-tenants, omni-channel-agents)  │
│ • AWS Step Functions / Lambda Company Onboarding Pipeline                   │
├─────────────────────────────────────────────────────────────────────────────┤
│ MEMBER 3: Backend Plane A — Real-Time Chat & Live Human Handoff             │
│ • AWS AppSync Events / WebSockets (/tenant/.../session/...)                 │
│ • Agent Presence Store in DynamoDB ("Go Online / Go Offline" heartbeats)    │
│ • SQS Escalation Queue & Human Assignment Engine (Queue -> Live Agent)      │
│ • Missed Handoffs counter & conversation transcript logging                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ MEMBER 4: Backend Plane B — AI Engine, Tools & Multi-Tenant RAG             │
│ • Amazon Bedrock AgentCore Runtime (Supervisor + Sub-Agents A2A)            │
│ • Dynamic Tools Engine via AgentCore Gateway (OpenAPI, Forms, MCP Servers)  │
│ • Multi-Tenant Knowledge Base RAG (S3 Prefixes + Vector Store)              │
│ • Server-Side Hosted Chat URL Resolver (/chat/:company/:agent)              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Current Baseline in this Repository

We are starting from the active codebase in `omni-channel-backend`:
- `infra/cognito/`: Re-activated with `custom:tenant_id` and user groups (`admin`, `live_agent`, `staff`).
- `services/tenant-resolver/`: Extracts `tenantId` strictly from verified JWT claims; rejects header spoofing (`403 TENANT_MISMATCH`).
- `scripts/create-tenants-table.ts`: Schema definition for `omni-channel-tenants`, `omni-channel-agents`, and `omni-channel-tools`.
- `services/tenant-router/router.ts`: Asynchronous router querying DynamoDB with active/suspended checks and channel validation.

---

## 3. High-Speed Task Breakdown per Member

---

### MEMBER 1: UI Integration (Connecting Pre-Built Frontends)

> **Key Context**: The frontend code already exists in a separate repository. Your mission is to wire all three UI apps to the backend APIs, Cognito auth, and real-time streaming sockets.

#### Action Items:
1. **Environment Configuration & API Client Setup**:
   - In the frontend repository, configure environment files (`.env`):
     ```env
     VITE_API_BASE_URL=http://localhost:4566/restapis/{API_ID}/dev/_user_request_
     VITE_WS_URL=ws://localhost:4566/... (or AppSync endpoint)
     VITE_COGNITO_USER_POOL_ID={USER_POOL_ID}
     VITE_COGNITO_CLIENT_ID={CLIENT_ID}
     ```
   - Standardize the HTTP client (Axios/Fetch) to automatically attach the Cognito Bearer JWT to the `Authorization` header on all protected requests.

2. **Connect Company Admin Console (Dashboard)**:
   - **Auth**: Wire the login screen to Cognito using AWS Amplify / Amazon Cognito Auth SDK. Verify that users in group `admin` can log in and extract `custom:tenant_id`.
   - **Create Agent (Agent Builder)**: Hook the form up to `POST /agents` (managed by Member 2/4) to save prompts, model selection, tool toggles, and KB upload.
   - **Create Live Agent**: Hook the agent creation form up to `POST /tenants/agents/invite` (creates Cognito user with `role: live_agent`).
   - **Dashboard Cards**: Connect the metrics cards (CSAT, Leads, Missed Handoffs, Chat Monitor) to the reporting GET endpoints.

3. **Connect Live Agent Console (Live Chat & Presence)**:
   - **Auth**: Wire login to authenticate users with `role: live_agent`.
   - **"Go Online / Go Offline" Toggle**: Connect the switch to Member 3's presence API (`POST /agent/presence/online` and `POST /agent/presence/offline`).
   - **Incoming Queue & Live Messaging**: Connect WebSocket/AppSync client to listen to the agent's assigned queue (`/tenant/{tenantId}/agent/{agentId}/inbox`).
   - **Two-Way Chat**: Wire sending and receiving live chat messages through Member 3's real-time stream.

4. **Connect Public Customer Chat Widget (Hosted URL)**:
   - **Hosted URL Resolution**: On load at `/chat/:companySlug/:agentSlug`, call `GET /resolve-chat-url?company={company}&agent={agent}` (Member 4) to fetch agent configuration without exposing tenant IDs.
   - **Chat Stream**: Connect customer chat input/output to the session WebSocket.
   - **Dynamic Form Rendering**: When a bot response contains `{ type: "FORM", formId: "...", fields: [...] }`, render the interactive form in the chat bubble and submit payload to `POST /forms/submit`.
   - **"Request Human Assistant" Button**: Wire button to send an escalation request to Member 3's handoff endpoint.

5. **CORS Configuration**:
   - Ensure API Gateway and Lambda adapters return headers:
     `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Authorization, Content-Type, x-channel`.

---

### MEMBER 2: Multi-Tenancy, Isolation & Company Onboarding

**Objective**: Own company data isolation, zero-trust tenant boundaries, database partitioning, and automated company onboarding.

#### Action Items:
1. **Multi-Tenant Identity & Access Management (`infra/cognito/`)**:
   - Ensure `infra/cognito/main.tf` has the `live_agent` group and `custom:tenant_id` attribute deployed.
   - Set up Cognito App Client settings so the frontend (Member 1) can authenticate admins and live agents.

2. **DynamoDB Tenant Partitioning (`scripts/create-tenants-table.ts`)**:
   - Ensure tables are created in LocalStack / AWS:
     - `omni-channel-tenants` (PK: `tenantId`)
     - `omni-channel-agents` (PK: `tenantId`, SK: `agentId`)
     - `omni-channel-tools` (PK: `tenantId`, SK: `toolId`)
   - Seed baseline companies (`slt`, `tenant-test-123`).

3. **Company Onboarding API & Workflow (Step Functions / Lambda)**:
   - Implement `POST /tenants/register` endpoint:
     1. Creates company record in `omni-channel-tenants` with status `active`.
     2. Provisions Company Admin user in Cognito with `custom:tenant_id`.
     3. Provisions isolated S3 prefix: `s3://platform-kb/{tenantId}/`.
     4. Initializes default agent record in `omni-channel-agents`.
     5. Sends response with temporary login credentials for the Admin Console.

4. **Zero-Trust Security Verification**:
   - Ensure `services/tenant-resolver/resolver.ts` rejects any request where an `x-tenant-id` header doesn't match the token claim with `403 FORBIDDEN (TENANT_MISMATCH)`.
   - Verification command: `npx tsx scripts/test-tenant-resolver.ts`.

---

### MEMBER 3: Backend Plane A — Real-Time Chat & Live Human Handoff

**Objective**: Own the real-time messaging pipeline, agent presence management, escalation queue, and human handoff routing.

#### Action Items:
1. **Real-Time Pub/Sub Ingress (AppSync Events or WebSocket API Gateway)**:
   - Deploy real-time messaging channels: `/tenant/{tenantId}/session/{sessionId}`.
   - Ensure both Member 1's Public Chat and Live Agent Console can establish persistent socket connections.

2. **Live Agent Presence Store (`omni-channel-agent-presence`)**:
   - Provision DynamoDB table: `omni-channel-agent-presence` (PK: `tenantId`, SK: `agentId`).
   - Implement Presence Lambdas:
     - `POST /agent/presence/online` $\rightarrow$ sets `status = AVAILABLE`, `activeChats = 0`.
     - `POST /agent/presence/offline` $\rightarrow$ sets `status = OFFLINE`.
     - `GET /agent/presence/status` $\rightarrow$ returns current status.

3. **Human Handoff & Escalation Queue (SQS + Assignment Lambda)**:
   - Provision SQS queue: `omni-channel-escalation-queue`.
   - **When Escalation is Triggered**:
     - Bot outputs `ESCALATION_REQUIRED` or customer clicks "Request Human":
       1. Push escalation event to SQS queue with `{ tenantId, sessionId, customerId }`.
       2. Mark conversation status in DynamoDB as `WAITING_FOR_HUMAN`.
   - **Assignment Worker (Lambda)**:
     1. Polls queue, queries `omni-channel-agent-presence` for an agent in `tenantId` with `status == "AVAILABLE"` and lowest `activeChats`.
     2. If found: Assigns `sessionId` to `agentId`, increments `activeChats`, and pushes an alert to the agent's socket (`/tenant/{tenantId}/agent/{agentId}/inbox`).
     3. If no agent online: Increments `MissedHandoffs` in DynamoDB and returns: *"All human agents are currently offline. Your request has been logged."*

---

### MEMBER 4: Backend Plane B — AI Engine, Tools & Multi-Tenant RAG

**Objective**: Own Amazon Bedrock AgentCore execution, Main/Sub-agent A2A communication, dynamic tools (OpenAPI, Forms, MCP), and Knowledge Base RAG.

#### Action Items:
1. **AgentCore Runtime & Supervisor Pattern**:
   - Replace hardcoded switch in `agents/registry.ts` with dynamic agent execution.
   - Main Agent acts as Supervisor/Router delegating to Sub-Agents (Billing, Support, Usage, Leads).
   - Session state runs in isolated microVMs per customer session.

2. **Dynamic Tool Integrations (AgentCore Gateway)**:
   - **OpenAPI Tool**: Expose company APIs (e.g. SLT Billing API) dynamically via OpenAPI specifications.
   - **Form Tool**: Implement `show_form` structured tool emitting JSON schemas (e.g. New Connection, Complaint Ticket) to be rendered by Member 1's UI.
   - **MCP Server Connector**: Connect remote Model Context Protocol servers for external databases and CRM systems.

3. **Multi-Tenant Knowledge Base RAG (`agents/utils/kb-retriever.ts`)**:
   - Replace naive text search with Amazon Bedrock Knowledge Bases + Vector Store (S3 Vectors / OpenSearch Serverless).
   - Ensure tenant isolation: S3 paths partitioned by `s3://platform-kb/{tenantId}/*` and vector queries filtered by `tenant_id`.

4. **Server-Side Hosted URL Resolver API**:
   - Implement `GET /resolve-chat-url?company={companySlug}&agent={agentSlug}`:
     - Looks up DynamoDB `omni-channel-tenants` and `omni-channel-agents`.
     - Returns `{ tenantId, agentId, agentName, welcomeMessage, theme }`.
     - Allows public customers to load the chatbot without knowing or passing internal tenant IDs.

---

## 4. Accelerated 24-Hour Execution Schedule (Finish by Tomorrow)

```mermaid
gantt
    title Rapid 24-Hour Execution Timeline
    dateFormat HH:mm
    axisFormat %H:%M

    section Block 1: Foundations (Hours 0-4)
    M1: Config & Env in UI Repo           :active, m1_b1, 00:00, 4h
    M2: Cognito App Client & DDB Tables   :active, m2_b1, 00:00, 4h
    M3: AppSync/WebSocket & Presence DDB  :active, m3_b1, 00:00, 4h
    M4: Hosted URL Resolver & Tool Router :active, m4_b1, 00:00, 4h

    section Block 2: Core Features (Hours 4-9)
    M1: Wire Admin Login & Agent Builder  :m1_b2, 04:00, 5h
    M2: Onboarding API & Tenant Routing   :m2_b2, 04:00, 5h
    M3: SQS Escalation & Handoff Engine   :m3_b2, 04:00, 5h
    M4: Bedrock AgentCore & S3 RAG        :m4_b2, 04:00, 5h

    section Block 3: Wire UI & Backend (Hours 9-16)
    M1: Wire Live Agent Console & Chat UI :m1_b3, 09:00, 7h
    M3: Connect WebSocket to M1 Frontends :m3_b3, 09:00, 7h
    M4: Connect MCP & Form Submissions    :m4_b3, 09:00, 7h
    M2: End-to-End Tenant Isolation Test  :m2_b3, 09:00, 7h

    section Block 4: Polish & Sign-Off (Hours 16-22)
    All: End-to-End Live Demo Run-Through :all_b4, 16:00, 6h
```

---

## 5. Quick Integration Contract Reference

### 1. Auth Header Contract (Member 1 $\rightarrow$ Backend)
```http
Authorization: Bearer <Cognito_ID_or_Access_Token>
Content-Type: application/json
x-channel: web
```

### 2. Presence Toggle Payload (Member 1 $\rightarrow$ Member 3)
```http
POST /agent/presence/online
Authorization: Bearer <LiveAgent_Cognito_Token>

Response 200 OK:
{
  "success": true,
  "status": "AVAILABLE",
  "agentId": "usr-live-agent-01",
  "tenantId": "slt"
}
```

### 3. Handoff Message Event (Member 3 $\rightarrow$ Member 1)
```json
{
  "event": "CHAT_ASSIGNED",
  "sessionId": "sess-8832-47a1",
  "customerName": "John Doe",
  "issueSummary": "Internet router blinking red light",
  "timestamp": "2026-09-15T10:30:00Z"
}
```

### 4. Form Tool Payload (Member 4 $\rightarrow$ Member 1 Chat Widget)
```json
{
  "type": "FORM",
  "formId": "new_fiber_connection",
  "title": "New Fiber Connection Application",
  "fields": [
    { "name": "fullName", "label": "Full Name", "type": "text", "required": true },
    { "name": "nic", "label": "NIC / Passport", "type": "text", "required": true },
    { "name": "address", "label": "Installation Address", "type": "text", "required": true },
    { "name": "package", "label": "Selected Package", "type": "select", "options": ["Fibre 100", "Fibre 300"] }
  ]
}
```

---

## 6. Definition of Done (DoD) for Tomorrow's Delivery

To consider the project fully complete and ready for submission:
1. **Admin Console**: Company Admin can log in via Cognito, view the dashboard cards, create an agent, invite a live agent, and view mock reports.
2. **Public Chat**: A user visits `https://chat.platform.com/slt/support`, chats with the AI agent, submits a dynamic form, and clicks *"Request Human Assistant"*.
3. **Live Agent Console**: A live agent logs in, toggles *"Go Online"*, receives the customer's escalated conversation in real-time, exchanges messages, and resolves the session.
4. **Tenant Isolation**: Company A's live agent and admin cannot see or access Company B's data under any circumstance.
