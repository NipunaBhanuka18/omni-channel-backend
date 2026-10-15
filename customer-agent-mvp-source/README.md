# Multi-Tenant AI Customer Engagement Platform

This project provides a serverless, multi-tenant customer-support SaaS with five connected parts:

1. Public product landing page and self-service company registration
2. Public customer chat
3. AI main agent and specialist sub-agents
4. Company admin console
5. Human live-agent console

The production backend uses AWS Lambda, API Gateway, Cognito, DynamoDB, Amazon Bedrock, Bedrock Knowledge Bases, S3, CloudFront, Secrets Manager, and optional AgentCore Gateway MCP tools.

---

## Included features

### Company onboarding and tenant isolation

- Public enterprise landing page
- Email-OTP company verification through Amazon SES
- Server-generated tenant ID and collision-safe company slug
- Default Cognito invitation for one company admin
- Default Cognito invitation for one live agent
- Starter entitlement of one admin seat and one live-agent seat
- Admin seat-increase request workflow
- Tenant membership registry and control-plane audit events
- Retry-safe onboarding provisioning
- Tenant identity derived from verified Cognito claims, never from browser input

### Customer chat

- Public chat URL for each published AI agent
- Responsive desktop and mobile interface
- Suggested customer questions
- Bedrock-generated answers
- Knowledge Base citations
- Dynamic forms inside the conversation
- Thumbs-up and thumbs-down feedback
- Human-assistance request
- Automatic switch from AI mode to live-agent mode

### AI agent runtime

- Main-agent intent routing
- General, Sales, Billing, Technical, and Lead sub-agents
- Tenant-specific system instructions
- Optional tenant-specific Bedrock Knowledge Base
- HTTPS API tools
- AgentCore Gateway MCP tools
- Customer form tools
- Bedrock Guardrail support
- Conversation history in DynamoDB

### Company admin console

- Dashboard metrics
- Create, edit, publish, and delete AI agents
- Assign sub-agents, Knowledge Bases, tools, and forms
- Register Bedrock Knowledge Bases
- Upload tenant Knowledge Base files
- Start Bedrock ingestion synchronization
- Create API, MCP, and form tools
- View the company workspace, plan, seat usage, and tenant slug
- Invite company admins and human live agents within seat limits
- Request additional admin or live-agent seats
- Monitor live-agent availability
- Monitor waiting, active, and closed handoff sessions

### Live-agent console

- Cognito-authenticated accounts
- Online and offline presence
- Waiting handoff queue
- Atomic conversation acceptance
- Customer transcript
- Two-way customer messaging
- Conversation closure
- Automatic queue refresh

---

## Project folders

```text
customer-agent-mvp/
├── frontend/
│   ├── index.html              Public landing page
│   ├── register.html           Company registration and OTP verification
│   ├── chat.html               Customer chat
│   ├── admin.html              Company admin console
│   ├── agent-console.html      Live-agent console
│   ├── app.js                  Customer chat logic
│   ├── registration.js         Company onboarding flow
│   ├── admin.js                Admin console logic
│   ├── live-agent.js           Live-agent logic
│   ├── auth.js                 Cognito authorization-code + PKCE login
│   ├── config.js               Frontend configuration
│   ├── styles.css              Customer chat styles
│   ├── landing.css             Landing and registration styles
│   └── console.css             Admin/live-agent styles
├── backend/
│   ├── src/
│   │   ├── handler.py          Public customer API
│   │   ├── admin_handler.py    Company admin API
│   │   ├── live_handler.py     Live-agent API
│   │   ├── onboarding_handler.py Public company onboarding API
│   │   ├── tenant_security.py  Tenant ID, slug, email, and role validation
│   │   ├── orchestrator.py     Main/sub-agent routing
│   │   ├── bedrock_service.py  Bedrock and KB integration
│   │   ├── tool_executor.py    API and MCP tools
│   │   ├── repository.py       Conversation storage
│   │   ├── console_repository.py
│   │   ├── auth.py
│   │   └── security.py
│   └── tests/
├── infrastructure/
│   └── template.yaml           AWS SAM infrastructure
└── scripts/
    ├── seed_demo_agent.py
    └── create_company_admin.py
```

---

# Option 1 — Run the interfaces locally in demo mode

Use this option first. It does not require AWS credentials, Docker, Node.js, npm, a database, or an AI model.

The frontend contains demo data and simulated AI responses when `apiBaseUrl` is empty.

## 1. Extract the source ZIP

Extract `customer-agent-mvp-source.zip` to a normal folder.

Example:

```text
C:\Projects\customer-agent-mvp
```

or:

```text
/home/user/projects/customer-agent-mvp
```

## 2. Confirm demo configuration

Open `frontend/config.js` and keep it as follows:

```javascript
window.CHAT_CONFIG = {
  apiBaseUrl: "",
  defaultAgentKey: "demo-support",
  auth: {
    domain: "",
    clientId: ""
  }
};
```

An empty `apiBaseUrl` enables local demo mode. An empty Cognito domain skips real authentication for the two console demos.

## 3. Start the local web server

Open a terminal in the project directory.

### Windows PowerShell or Command Prompt

```powershell
cd C:\Projects\customer-agent-mvp\frontend
py -m http.server 8080
```

If the `py` command is unavailable, try:

```powershell
python -m http.server 8080
```

### Ubuntu, Linux, or macOS

```bash
cd /home/user/projects/customer-agent-mvp/frontend
python3 -m http.server 8080
```

Expected terminal output:

```text
Serving HTTP on 0.0.0.0 port 8080 ...
```

Keep this terminal open while using the application.

## 4. Open the applications

### Landing page

```text
http://localhost:8080/
```

### Create a company

```text
http://localhost:8080/register.html
```

In demo mode, enter any valid-looking company and two different email addresses. Enter any six-digit verification code. The browser demonstrates the complete onboarding experience without creating AWS resources.

### Customer chat

```text
http://localhost:8080/chat.html?agent=demo-support
```

Try these messages:

```text
I need a new connection
Why was I charged on my bill?
My internet is slow
I want to speak with a human agent
```

### Company admin console

```text
http://localhost:8080/admin.html
```

You can locally demonstrate:

- Creating and editing an AI agent
- Publishing an agent
- Adding a Knowledge Base
- Creating API, MCP, and form tools
- Inviting a live agent
- Viewing dashboard and chat-monitor data

### Live-agent console

```text
http://localhost:8080/agent-console.html
```

You can locally demonstrate:

- Online/offline status
- Waiting customers
- Accepting a handoff
- Viewing the transcript
- Sending live-agent messages
- Closing the conversation

> Demo mode stores each page's example state in browser memory. It demonstrates the interfaces and workflows, but it does not call Bedrock, Cognito, DynamoDB, or another browser tab. Use connected mode for a real end-to-end handoff.

## 5. Stop the local server

Return to the terminal and press:

```text
Ctrl + C
```

---

# Option 2 — Run the frontend on localhost with the real AWS backend

Use this option for real Bedrock answers, persistent DynamoDB sessions, Cognito login, Knowledge Base retrieval, and customer-to-live-agent communication.

The frontend runs on your computer, while the required managed services run in your AWS account.

## Prerequisites

Install and configure:

- Python 3.11 or later
- AWS CLI v2
- AWS SAM CLI
- Docker Desktop or Docker Engine only if you later use `sam local` or container-based builds
- An AWS account
- AWS CLI credentials with deployment permission
- Amazon Bedrock model access in the selected Region

Check the installations:

```bash
python3 --version
aws --version
sam --version
docker --version
aws sts get-caller-identity
```

On Windows, use `python` or `py` where the guide uses `python3`.

## 1. Select an AWS Region

Use a Region where the selected Bedrock model and Knowledge Bases are available.

Example:

```bash
aws configure set region ap-southeast-1
```

The default model in the template is:

```text
amazon.nova-lite-v1:0
```

You can enter another enabled Bedrock model or inference-profile ID during deployment.

## 2. Validate and build the SAM application

From the project root:

```bash
sam validate --lint --template-file infrastructure/template.yaml
sam build --template-file infrastructure/template.yaml
```

## 3. Deploy the AWS stack

```bash
sam deploy --guided
```

Suggested answers:

```text
Stack Name: customer-agent-platform-dev
AWS Region: ap-southeast-1
BedrockModelId: amazon.nova-lite-v1:0
KnowledgeBaseId: leave blank
GuardrailId: leave blank initially
GuardrailVersion: DRAFT
AllowedOrigin: *
OnboardingEmailFrom: verified-sender@your-domain.example
CognitoDomainPrefix: your-company-ai-console-unique-name
Confirm changes before deploy: Y
Allow SAM CLI IAM role creation: Y
Save arguments to configuration file: Y
```

`CognitoDomainPrefix` must be globally unique, lowercase, and should contain only letters, numbers, and hyphens. `OnboardingEmailFrom` must be an email identity verified in Amazon SES in the selected Region. If the SES account is still in the sandbox, recipient verification rules also apply.

For the first localhost test, keep `AllowedOrigin` as `*`. Before production, change it to the CloudFront or custom-domain origin.

## 4. Record the stack outputs

After deployment, note these outputs:

- `ApiUrl`
- `ConsoleUserPoolId`
- `ConsoleUserPoolClientId`
- `CognitoLoginDomain`
- `PublicMappingsTable`
- `AgentConfigsTable`
- `WebBucket`
- `DistributionId`
- `AdminConsoleUrl`
- `LiveAgentConsoleUrl`
- `LandingPageUrl`
- `CompanyRegistrationUrl`
- `TenantsTable`
- `TenantMembersTable`
- `SeatRequestsTable`

You can retrieve them again:

```bash
aws cloudformation describe-stacks \
  --stack-name customer-agent-platform-dev \
  --query "Stacks[0].Outputs" \
  --output table
```

## 5. Create the first company through self-service onboarding

Start the frontend, then open:

```text
http://localhost:8080/register.html
```

Enter the company, company-admin, and default live-agent details. The service emails a six-digit code to the admin. After verification it:

1. Generates a tenant ID and unique slug on the server.
2. Creates the active Starter workspace.
3. Assigns one admin seat and one live-agent seat.
4. Creates both users in Cognito with immutable tenant and role claims.
5. Sends temporary-password invitations to both users.
6. Records tenant membership and an audit event.

The included `scripts/create_company_admin.py` remains available only for recovery or controlled migration. New companies should use the registration flow so the tenant, membership, and seat records are created together.

## 6. Optionally seed the demonstration customer agent

```bash
python3 scripts/seed_demo_agent.py \
  --region ap-southeast-1 \
  --mappings-table YOUR_PUBLIC_MAPPINGS_TABLE \
  --agents-table YOUR_AGENT_CONFIGS_TABLE \
  --model-id amazon.nova-lite-v1:0
```

This creates the public key:

```text
demo-support
```

## 7. Configure the localhost frontend

Open `frontend/config.js` and replace the empty values with your stack outputs:

```javascript
window.CHAT_CONFIG = {
  apiBaseUrl: "https://YOUR_API_ID.execute-api.ap-southeast-1.amazonaws.com",
  defaultAgentKey: "demo-support",
  auth: {
    domain: "https://YOUR_PREFIX.auth.ap-southeast-1.amazoncognito.com",
    clientId: "YOUR_COGNITO_APP_CLIENT_ID"
  }
};
```

Important:

- Do not add a slash to the end of `apiBaseUrl`.
- Do not add `/oauth2/authorize` to `domain`.
- Use the Cognito app-client ID, not the user-pool ID.
- Never place AWS secret keys, API keys, client secrets, or passwords in this file.

## 8. Start the localhost frontend

```bash
cd frontend
python3 -m http.server 8080
```

Open:

```text
Landing:   http://localhost:8080/
Register:  http://localhost:8080/register.html
Customer:  http://localhost:8080/chat.html?agent=demo-support
Admin:     http://localhost:8080/admin.html
Live Agent:http://localhost:8080/agent-console.html
```

The admin and live-agent pages redirect to the Cognito-hosted login page and return to localhost after successful authentication.

## 9. Add team members and request seats

1. Sign in to `http://localhost:8080/admin.html` as the company administrator.
2. Open **Team & Seats**.
3. The Starter workspace initially shows `1 / 1` admin seats and `1 / 1` live-agent seats.
4. Select **Request seats** and submit the number of additional admin and live-agent seats required.
5. After your platform billing/operations workflow approves and updates the tenant limits, select **Invite member**.
6. Choose Company Admin or Live Agent and enter the member's name and email.
7. Cognito emails a temporary password. Live agents sign in at `http://localhost:8080/agent-console.html`.

The API atomically reserves an available role seat before creating the user. It rejects invitations that exceed the tenant entitlement.

The new account automatically receives the same immutable tenant ID and the `LIVE_AGENT` role.

## 10. Test the real human-handoff flow

1. Open the live-agent console and select **Go online**.
2. In another browser window, open the customer chat.
3. Enter `I want to speak with a human agent`.
4. The customer session changes to `HANDOFF_REQUESTED`.
5. Wait up to four seconds for it to appear in the live-agent queue.
6. Select the conversation and choose **Accept**.
7. Send a message from the live-agent console.
8. Wait up to three seconds for it to appear in the customer chat.
9. Continue the two-way conversation.
10. Select **Close chat** when finished.

The current version uses short polling. This keeps the local and AWS setup simple. AppSync Events or API Gateway WebSockets can replace polling later.

---

# Knowledge Base setup

The admin screen registers an existing Amazon Bedrock Knowledge Base and its data source.

Before adding it in the admin console:

1. Create a Bedrock Knowledge Base in the same AWS Region.
2. Configure its data source to use the `KnowledgeDocumentsBucket` created by this stack.
3. Restrict the data source to the tenant/KB prefix where applicable.
4. Copy the Bedrock Knowledge Base ID.
5. Copy the Bedrock data-source ID.
6. Add a Bedrock resource tag named `TenantId` whose value exactly matches the company tenant ID shown in **Team & Seats**. The API rejects a Knowledge Base without this ownership tag.
7. In **Knowledge Bases**, select **Add knowledge base** and enter both IDs.
8. Upload PDF, DOCX, TXT, Markdown, CSV, or HTML files.
9. Select **Sync** to start the Bedrock ingestion job.
10. Assign the Knowledge Base to an AI agent and publish that agent again.

The upload path uses this structure:

```text
tenant-id/kb-id/random-file-id-original-filename
```

This prevents one company's admin screen from uploading into another company's prefix.

---

# API and MCP tool setup

## HTTPS API tool

Create the API credential as a JSON secret in AWS Secrets Manager. Its secret name must use the company-scoped path `tenant/TENANT_ID/`, for example `tenant/ten_abcd1234/orders-api`:

```json
{
  "Authorization": "Bearer REPLACE_WITH_TOKEN",
  "X-API-Key": "REPLACE_WITH_API_KEY"
}
```

In the admin console, create an **HTTPS API** tool and provide:

- A unique tool name using letters, numbers, and underscores
- HTTPS endpoint
- HTTP method
- Secrets Manager secret ID
- JSON input schema

The model can only call tools explicitly assigned to the published agent. Both the API validation and Lambda IAM policy reject credentials outside the tenant secret namespace.

## MCP tool

In the admin console, create an **MCP / AgentCore Gateway** tool and provide:

- Tool name
- AgentCore Gateway MCP URL
- Target tool name exposed by the gateway
- Optional credential secret ID
- JSON input schema

If no secret is configured, the runtime signs the AgentCore Gateway request using the Lambda execution role.

## Customer form

Create a **Customer form** tool and provide:

- Form title
- Form description
- Fields in `Label:field_name` format

Example:

```text
Your name:name, Mobile number:contact, Required service:need
```

Assign the form to an agent and publish the agent. The form can then appear inside the public customer conversation.

---

# Run automated checks

From the project root:

```bash
python3 -m unittest discover -s backend/tests -v
node --check frontend/app.js
node --check frontend/auth.js
node --check frontend/admin.js
node --check frontend/live-agent.js
python3 -m py_compile backend/src/*.py scripts/*.py
```

The Node.js checks are optional for running the static frontend, but recommended before deployment.

---

# Common localhost problems

## `python` or `python3` is not recognized

Install Python 3 and enable **Add Python to PATH** during installation. On Windows, also try:

```powershell
py -m http.server 8080
```

## Port 8080 is already in use

Use another port:

```bash
python3 -m http.server 8090
```

Then open `http://localhost:8090`. For real Cognito login, add the matching `http://localhost:8090/admin.html` and `agent-console.html` callback/logout URLs to the Cognito app client.

## The page opens but buttons do not work

Do not open the HTML as a `file:///` URL. Always start the local HTTP server and use `http://localhost:8080`.

Open the browser developer console and check for a JavaScript error.

## `Assistant not found`

Confirm that:

- The agent exists in DynamoDB.
- Its status is `PUBLISHED`.
- Its public mapping exists.
- The URL contains the correct `?agent=PUBLIC_KEY` value.
- You seeded the demo agent or published an agent through the admin console.

## Cognito redirects repeatedly

Confirm that:

- `frontend/config.js` uses the correct Cognito domain and client ID.
- The callback URL exactly matches the current browser URL.
- You are using `localhost`, not an IP address such as `127.0.0.1`.
- The browser clock is correct.
- Old session data has been cleared from the browser's session storage.

## API returns `401 Unauthorized`

The Cognito session may have expired or the wrong app-client ID may be configured. Sign out and sign in again.

Also confirm that the account contains:

```text
custom:tenant_id
custom:role
```

Company admins require:

```text
custom:role = COMPANY_ADMIN
```

Human agents require:

```text
custom:role = LIVE_AGENT
```

## Browser reports a CORS error

For initial localhost testing, deploy with:

```text
AllowedOrigin = *
```

For production, deploy with the exact CloudFront or custom-domain origin.

## Bedrock access is denied

Confirm that:

- The model is enabled for the AWS account.
- The model is available in the selected Region.
- `BedrockModelId` is correct.
- The Lambda execution role can invoke the model or inference profile.

## Knowledge Base returns no information

Confirm that:

- The Knowledge Base and data-source IDs are correct.
- Files were uploaded into the expected S3 prefix.
- The ingestion job completed successfully.
- The Knowledge Base is assigned to the agent.
- The agent was republished after assigning or modifying the KB.

## Handoff does not appear in the live-agent console

Confirm that:

- The live agent selected **Go online**.
- The customer asked explicitly for a human or live agent.
- Both accounts belong to the same tenant ID.
- The customer is using a published agent owned by that tenant.
- You waited at least four seconds for the queue refresh.

---

# Production security checklist

Before launching publicly:

- Change `AllowedOrigin` from `*` to the production origin.
- Add AWS WAF rate-based rules to CloudFront and the public API.
- Make MFA mandatory for administrators where required.
- Restrict Secrets Manager permissions to approved tenant secret ARNs.
- Restrict Bedrock and AgentCore permissions to provisioned resources.
- Use a dedicated Cognito app client without localhost callbacks for production.
- Add CloudWatch alarms for Lambda errors, latency, throttling, and failed handoffs.
- Enable CloudTrail and retain important audit events.
- Review data retention and DynamoDB TTL periods.
- Avoid logging customer messages, credentials, tokens, or form values.
- Run security and tenant-isolation tests before onboarding companies.

---

# Deploy the static frontend to AWS

After configuring `frontend/config.js`:

```bash
aws s3 sync frontend/ s3://YOUR_WEB_BUCKET
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/*"
```

Then use the stack outputs:

```text
CustomerChatUrl
AdminConsoleUrl
LiveAgentConsoleUrl
```

For production, use a custom Route 53 domain and ACM certificate if required.
