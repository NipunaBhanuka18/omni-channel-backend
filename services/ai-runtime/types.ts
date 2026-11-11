export interface ToolDefinition {
  name: string;
  type: "api" | "mcp";
  description?: string;
  enabled: boolean;
  readOnly?: boolean;
  endpoint?: string;
  method?: "POST" | "PUT" | "PATCH";
  gatewayUrl?: string;
  targetToolName?: string;
  inputSchema?: Record<string, any>;
  timeoutSeconds?: number;
  secretId?: string;
}

export interface FormField {
  id: string;
  label: string;
  type: "text" | "email" | "number" | "select";
  required?: boolean;
  options?: string[];
}

export interface FormDefinition {
  formId: string;
  title?: string;
  fields: FormField[];
  confirmationMessage?: string;
}

export interface AgentConfig {
  tenantId: string;
  agentId: string;
  displayName: string;
  brandName?: string;
  welcomeMessage?: string;
  systemPrompt?: string;
  modelId: string;
  guardrailIdentifier?: string;
  guardrailVersion?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  forms?: FormDefinition[];
  knowledgeBaseId?: string;
  sharedKnowledgeBase?: boolean;
  retrievalResultCount?: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  publicAgentKey: string;
  handoffMessage?: string;
  enabledSubAgents?: string[];
  theme?: {
    primaryColor?: string;
    logoUrl?: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface PublicMapping {
  publicAgentKey: string;
  tenantId: string;
  agentId: string;
  status: "PUBLISHED" | "INACTIVE";
  updatedAt: number;
}

export interface ConversationSession {
  sessionId: string;
  tenantId: string;
  agentId: string;
  publicAgentKey: string;
  status: "AI_ACTIVE" | "HANDOFF_REQUESTED" | "HUMAN_ACTIVE" | "CLOSED";
  sessionSecretHash?: string;
  createdAt: number;
  updatedAt: number;
  handoffReason?: string;
  handoffRequestedAt?: number;
  assignedAgentId?: string;
}

export interface ChatMessage {
  sessionId: string;
  messageId: string;
  tenantId: string;
  agentId: string;
  role: "user" | "assistant" | "live_agent" | "system";
  text: string;
  createdAt: string;
  route?: string;
  citations?: Array<{ title: string; uri: string }>;
  status: "completed" | "delivered_to_human" | "handoff_requested" | "error";
  toolEvents?: Array<{ name: string; status: "success" | "error" }>;
  uiAction?: any;
  senderId?: string;
  senderName?: string;
}

export interface RouteDecision {
  route: string;
  reason: string;
  handoff: boolean;
}

export interface TurnResult {
  messageId: string;
  message: string;
  route: string;
  status: "completed" | "delivered_to_human" | "handoff_requested" | "error";
  citations: Array<{ title: string; uri: string }>;
  uiAction?: any;
  toolEvents?: Array<{ name: string; status: "success" | "error" }>;
  submissionId?: string;
}
