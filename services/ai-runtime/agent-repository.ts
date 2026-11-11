import crypto from "crypto";
import { docClient } from "../../agents/utils/dynamo-client";
import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AgentConfig, PublicMapping, ConversationSession, ChatMessage } from "./types";

export class AgentRepository {
  // In-memory fallback stores for local offline tests / LocalStack offline
  private inMemoryAgents: Map<string, AgentConfig> = new Map();
  private inMemoryMappings: Map<string, PublicMapping> = new Map();
  private inMemorySessions: Map<string, ConversationSession> = new Map();
  private inMemoryMessages: Map<string, ChatMessage[]> = new Map();
  private inMemorySubmissions: Map<string, any[]> = new Map();
  private inMemoryFeedback: Map<string, any[]> = new Map();

  constructor() {
    this.seedDefaultAgents();
  }

  private seedDefaultAgents() {
    // Seed default SLT demo support agent
    const sltAgent: AgentConfig = {
      tenantId: "slt",
      agentId: "agent-slt-support-01",
      displayName: "SLT Support Assistant",
      brandName: "Sri Lanka Telecom",
      welcomeMessage: "Welcome to Sri Lanka Telecom! How can we assist you today?",
      systemPrompt: "You are an official AI assistant for Sri Lanka Telecom. Help customers with broadband, billing, and technical queries.",
      modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
      status: "PUBLISHED",
      publicAgentKey: "slt-support",
      knowledgeBaseId: "kb-slt-support-01",
      sharedKnowledgeBase: true,
      enabledSubAgents: ["general", "sales", "billing", "technical", "lead"],
      theme: { primaryColor: "#005EB8" },
      forms: [
        {
          formId: "sales_interest",
          title: "Sales & Upgrade Inquiry",
          fields: [
            { id: "fullName", label: "Full Name", type: "text", required: true },
            { id: "contactPhone", label: "Contact Phone", type: "text", required: true },
            { id: "packageInterest", label: "Interested Package", type: "text", required: true },
          ],
          confirmationMessage: "Thank you for your interest! A sales specialist will contact you shortly.",
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.inMemoryAgents.set(`slt#${sltAgent.agentId}`, sltAgent);
    this.inMemoryMappings.set("slt-support", {
      publicAgentKey: "slt-support",
      tenantId: "slt",
      agentId: sltAgent.agentId,
      status: "PUBLISHED",
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  async getAgentByPublicKey(agentKey: string): Promise<AgentConfig | null> {
    const cleanKey = String(agentKey || "").trim().toLowerCase();
    if (!cleanKey) return null;

    try {
      const mappingResult = await docClient.send(
        new GetCommand({
          TableName: "omni-channel-public-mappings",
          Key: { publicAgentKey: cleanKey },
          ConsistentRead: true,
        })
      );
      const mapping = mappingResult.Item as PublicMapping | undefined;
      if (mapping && mapping.status === "PUBLISHED") {
        return await this.getAgent(mapping.tenantId, mapping.agentId);
      }
    } catch {
      // Fallback to in-memory store
    }

    const memMapping = this.inMemoryMappings.get(cleanKey);
    if (!memMapping || memMapping.status !== "PUBLISHED") {
      return null;
    }
    return this.getAgent(memMapping.tenantId, memMapping.agentId);
  }

  async getAgent(tenantId: string, agentId: string): Promise<AgentConfig | null> {
    if (!tenantId || !agentId) return null;

    try {
      const res = await docClient.send(
        new GetCommand({
          TableName: "omni-channel-agent-configs",
          Key: { tenantId, agentId },
          ConsistentRead: true,
        })
      );
      if (res.Item) {
        return res.Item as AgentConfig;
      }
    } catch {
      // Fallback to in-memory store
    }

    return this.inMemoryAgents.get(`${tenantId}#${agentId}`) || null;
  }

  async saveAgent(agent: AgentConfig): Promise<void> {
    if (!agent.tenantId || !agent.agentId) {
      throw new Error("Cannot save agent without tenantId and agentId");
    }

    const now = new Date().toISOString();
    const item: AgentConfig = {
      ...agent,
      updatedAt: now,
      createdAt: agent.createdAt || now,
    };

    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-agent-configs",
          Item: item,
        })
      );
    } catch {
      // Fallback to in-memory store
    }

    this.inMemoryAgents.set(`${agent.tenantId}#${agent.agentId}`, item);
  }

  async listAgents(tenantId: string): Promise<AgentConfig[]> {
    if (!tenantId) return [];

    try {
      const res = await docClient.send(
        new QueryCommand({
          TableName: "omni-channel-agent-configs",
          KeyConditionExpression: "tenantId = :tid",
          ExpressionAttributeValues: { ":tid": tenantId },
        })
      );
      if (res.Items && res.Items.length > 0) {
        return res.Items as AgentConfig[];
      }
    } catch {
      // Fallback
    }

    const results: AgentConfig[] = [];
    for (const [key, agent] of this.inMemoryAgents.entries()) {
      if (agent.tenantId === tenantId) {
        results.push(agent);
      }
    }
    return results;
  }

  async publishAgent(tenantId: string, agentId: string, publicAgentKey: string): Promise<PublicMapping> {
    const cleanKey = String(publicAgentKey || "").trim().toLowerCase();
    if (!cleanKey) {
      throw new Error("Invalid public agent key");
    }

    const existingAgent = await this.getAgent(tenantId, agentId);
    if (!existingAgent) {
      throw new Error("Agent not found in tenant partition");
    }

    const existingMapping = await this.getMapping(cleanKey);
    if (existingMapping && (existingMapping.tenantId !== tenantId || existingMapping.agentId !== agentId)) {
      throw new Error("Public agent key is already claimed by another agent or tenant");
    }

    const now = Math.floor(Date.now() / 1000);
    const mapping: PublicMapping = {
      publicAgentKey: cleanKey,
      tenantId,
      agentId,
      status: "PUBLISHED",
      updatedAt: now,
    };

    existingAgent.status = "PUBLISHED";
    existingAgent.publicAgentKey = cleanKey;
    existingAgent.updatedAt = new Date().toISOString();

    await this.saveAgent(existingAgent);

    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-public-mappings",
          Item: mapping,
        })
      );
    } catch {
      // Fallback
    }

    this.inMemoryMappings.set(cleanKey, mapping);
    return mapping;
  }

  async getMapping(publicAgentKey: string): Promise<PublicMapping | null> {
    const cleanKey = String(publicAgentKey || "").trim().toLowerCase();
    try {
      const res = await docClient.send(
        new GetCommand({
          TableName: "omni-channel-public-mappings",
          Key: { publicAgentKey: cleanKey },
        })
      );
      if (res.Item) {
        return res.Item as PublicMapping;
      }
    } catch {
      // Fallback
    }
    return this.inMemoryMappings.get(cleanKey) || null;
  }

  async createSession(agent: AgentConfig): Promise<{ session: ConversationSession; sessionToken: string }> {
    const sessionId = `sess_${crypto.randomBytes(16).toString("hex")}`;
    const sessionToken = `stk_${crypto.randomBytes(24).toString("hex")}`;
    const sessionSecretHash = crypto.createHash("sha256").update(sessionToken).digest("hex");
    const now = Math.floor(Date.now() / 1000);

    const session: ConversationSession = {
      sessionId,
      tenantId: agent.tenantId,
      agentId: agent.agentId,
      publicAgentKey: agent.publicAgentKey,
      status: "AI_ACTIVE",
      sessionSecretHash,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-conversations",
          Item: {
            ...session,
            itemKey: "META",
            tenantStatus: `${agent.tenantId}#AI_ACTIVE`,
            expiresAt: now + 60 * 60 * 24 * 30,
          },
        })
      );
    } catch {
      // Fallback
    }

    this.inMemorySessions.set(sessionId, session);
    this.inMemoryMessages.set(sessionId, []);
    return { session, sessionToken };
  }

  validateSessionToken(session: ConversationSession, token: unknown): boolean {
    if (!session) return false;
    // Backward compatibility for sessions created without a secret (if any legacy)
    if (!session.sessionSecretHash) return true;
    if (typeof token !== "string" || !token.trim()) return false;
    const computed = crypto.createHash("sha256").update(token.trim()).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(session.sessionSecretHash, "hex"));
    } catch {
      return false;
    }
  }

  async getSession(sessionId: string): Promise<ConversationSession | null> {
    if (!sessionId) return null;

    try {
      const res = await docClient.send(
        new GetCommand({
          TableName: "omni-channel-conversations",
          Key: { sessionId, itemKey: "META" },
          ConsistentRead: true,
        })
      );
      if (res.Item) {
        return res.Item as ConversationSession;
      }
    } catch {
      // Fallback
    }

    return this.inMemorySessions.get(sessionId) || null;
  }

  async saveMessage(session: ConversationSession, message: ChatMessage): Promise<void> {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const item = {
      ...message,
      itemKey: `MSG#${message.createdAt}#${message.messageId}`,
      expiresAt: nowEpoch + 60 * 60 * 24 * 30,
    };

    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-conversations",
          Item: item,
        })
      );
    } catch {
      // Fallback
    }

    const list = this.inMemoryMessages.get(session.sessionId) || [];
    list.push(message);
    this.inMemoryMessages.set(session.sessionId, list);
  }

  async listMessages(sessionId: string, limit: number = 30): Promise<ChatMessage[]> {
    try {
      const res = await docClient.send(
        new QueryCommand({
          TableName: "omni-channel-conversations",
          KeyConditionExpression: "sessionId = :sid AND begins_with(itemKey, :msgPrefix)",
          ExpressionAttributeValues: {
            ":sid": sessionId,
            ":msgPrefix": "MSG#",
          },
          Limit: limit,
          ScanIndexForward: true,
        })
      );
      if (res.Items && res.Items.length > 0) {
        return res.Items as ChatMessage[];
      }
    } catch {
      // Fallback
    }

    const list = this.inMemoryMessages.get(sessionId) || [];
    return list.slice(-limit);
  }

  async markHandoff(sessionId: string, reason: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    const now = Math.floor(Date.now() / 1000);
    session.status = "HANDOFF_REQUESTED";
    session.handoffReason = reason;
    session.handoffRequestedAt = now;
    session.updatedAt = now;

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: "omni-channel-conversations",
          Key: { sessionId, itemKey: "META" },
          UpdateExpression: "SET #status = :s, tenantStatus = :ts, handoffReason = :r, handoffRequestedAt = :now, updatedAt = :now",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":s": "HANDOFF_REQUESTED",
            ":ts": `${session.tenantId}#HANDOFF_REQUESTED`,
            ":r": reason,
            ":now": now,
          },
        })
      );
    } catch {
      // Fallback
    }

    this.inMemorySessions.set(sessionId, session);
  }

  async saveFormSubmission(session: ConversationSession, formId: string, values: Record<string, any>): Promise<string> {
    const submissionId = `sub-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();
    const item = {
      sessionId: session.sessionId,
      itemKey: `FORM#${now}#${submissionId}`,
      submissionId,
      tenantId: session.tenantId,
      agentId: session.agentId,
      formId,
      values,
      createdAt: now,
    };

    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-conversations",
          Item: item,
        })
      );
    } catch {
      // Fallback
    }

    const subs = this.inMemorySubmissions.get(session.sessionId) || [];
    subs.push(item);
    this.inMemorySubmissions.set(session.sessionId, subs);
    return submissionId;
  }

  async saveFeedback(session: ConversationSession, messageId: string, rating: "up" | "down"): Promise<void> {
    const item = {
      sessionId: session.sessionId,
      itemKey: `FEEDBACK#${messageId}`,
      messageId,
      tenantId: session.tenantId,
      agentId: session.agentId,
      rating,
      createdAt: Math.floor(Date.now() / 1000),
    };

    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-conversations",
          Item: item,
        })
      );
    } catch {
      // Fallback
    }

    const fb = this.inMemoryFeedback.get(session.sessionId) || [];
    fb.push(item);
    this.inMemoryFeedback.set(session.sessionId, fb);
  }

  // Clear for test isolation
  clearInMemory() {
    this.inMemoryAgents.clear();
    this.inMemoryMappings.clear();
    this.inMemorySessions.clear();
    this.inMemoryMessages.clear();
    this.inMemorySubmissions.clear();
    this.inMemoryFeedback.clear();
    this.seedDefaultAgents();
  }
}

export const agentRepository = new AgentRepository();
