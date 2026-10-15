import { findAvailableAgent, adjustActiveChats } from "./presence-manager";
import { docClient } from "../../agents/utils/dynamo-client";
import { PutCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

export interface ChatSessionRecord {
  sessionId: string;
  tenantId: string;
  status: "BOT_ACTIVE" | "WAITING_FOR_HUMAN" | "HUMAN_ACTIVE" | "RESOLVED" | "MISSED_HANDOFF";
  assignedAgentId?: string;
  customerName?: string;
  issueSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffResult {
  success: boolean;
  assigned: boolean;
  status: ChatSessionRecord["status"];
  agentId?: string;
  message: string;
  sessionId: string;
}

// In-memory fallback session store for local offline testing
const MEMORY_SESSION_STORE: Map<string, ChatSessionRecord> = new Map();
const MEMORY_MISSED_HANDOFFS: Array<{ tenantId: string; sessionId: string; timestamp: string }> = [];

/**
 * Handles incoming escalation requests when a customer requests a human assistant.
 */
export async function requestHumanHandoff(params: {
  tenantId: string;
  sessionId: string;
  customerName?: string;
  issueSummary?: string;
}): Promise<HandoffResult> {
  const { tenantId, sessionId, customerName = "Guest Customer", issueSummary = "Live assistance requested" } = params;

  console.log(`[EscalationEngine] Received handoff request for session '${sessionId}' in tenant '${tenantId}'`);

  // Step 1: Find best available human agent
  const availableAgent = await findAvailableAgent(tenantId);

  const now = new Date().toISOString();

  if (availableAgent) {
    // Agent is available! Assign session and increment workload
    await adjustActiveChats(tenantId, availableAgent.agentId, 1);

    const sessionRecord: ChatSessionRecord = {
      sessionId,
      tenantId,
      status: "HUMAN_ACTIVE",
      assignedAgentId: availableAgent.agentId,
      customerName,
      issueSummary,
      createdAt: now,
      updatedAt: now,
    };

    MEMORY_SESSION_STORE.set(sessionId, sessionRecord);

    try {
      await docClient.send(
        new PutCommand({
          TableName: "omni-channel-chat-sessions",
          Item: sessionRecord,
        })
      );
    } catch (err: any) {
      console.warn(`[EscalationEngine] Failed to save session to DynamoDB (${err?.message || err}).`);
    }

    console.log(`[EscalationEngine] ✅ Assigned session '${sessionId}' to human agent '${availableAgent.agentId}'`);
    return {
      success: true,
      assigned: true,
      status: "HUMAN_ACTIVE",
      agentId: availableAgent.agentId,
      message: `You are now connected with human agent ${availableAgent.agentId}.`,
      sessionId,
    };
  }

  // No agent is online -> trigger Missed Handoff flow
  console.warn(`[EscalationEngine] ⚠️ No live agents online for tenant '${tenantId}'. Recording missed handoff.`);

  const missedRecord = {
    tenantId,
    missedId: `missed-${randomUUID()}`,
    sessionId,
    customerName,
    issueSummary,
    timestamp: now,
  };

  MEMORY_MISSED_HANDOFFS.push(missedRecord);

  const sessionRecord: ChatSessionRecord = {
    sessionId,
    tenantId,
    status: "MISSED_HANDOFF",
    customerName,
    issueSummary,
    createdAt: now,
    updatedAt: now,
  };
  MEMORY_SESSION_STORE.set(sessionId, sessionRecord);

  try {
    await docClient.send(
      new PutCommand({
        TableName: "omni-channel-missed-handoffs",
        Item: missedRecord,
      })
    );
  } catch (err: any) {
    console.warn(`[EscalationEngine] Failed saving missed handoff to DynamoDB (${err?.message || err}).`);
  }

  return {
    success: true,
    assigned: false,
    status: "MISSED_HANDOFF",
    message: "All our human agents are currently offline. A support ticket has been created and our team will follow up.",
    sessionId,
  };
}

/**
 * Resolves an active chat session and decrements the agent's workload.
 */
export async function resolveChatSession(params: {
  tenantId: string;
  sessionId: string;
  agentId: string;
}): Promise<{ success: boolean; status: string }> {
  const { tenantId, sessionId, agentId } = params;

  // Decrement agent's active chat count
  await adjustActiveChats(tenantId, agentId, -1);

  const existing = MEMORY_SESSION_STORE.get(sessionId);
  if (existing) {
    existing.status = "RESOLVED";
    existing.updatedAt = new Date().toISOString();
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: "omni-channel-chat-sessions",
        Key: { sessionId },
        UpdateExpression: "SET #st = :st, updatedAt = :u",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: {
          ":st": "RESOLVED",
          ":u": new Date().toISOString(),
        },
      })
    );
  } catch (err: any) {
    console.warn(`[EscalationEngine] Failed updating session in DynamoDB (${err?.message || err}).`);
  }

  console.log(`[EscalationEngine] ✅ Chat session '${sessionId}' resolved by agent '${agentId}'`);
  return {
    success: true,
    status: "RESOLVED",
  };
}

/**
 * Helper to fetch session status.
 */
export async function getSessionStatus(sessionId: string): Promise<ChatSessionRecord | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: "omni-channel-chat-sessions",
        Key: { sessionId },
      })
    );
    if (result.Item) {
      return result.Item as ChatSessionRecord;
    }
  } catch (err: any) {
    // fallback
  }

  return MEMORY_SESSION_STORE.get(sessionId) || null;
}
