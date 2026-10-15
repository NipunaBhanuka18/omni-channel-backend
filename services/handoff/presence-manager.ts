import { docClient } from "../../agents/utils/dynamo-client";
import { GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

export interface AgentPresenceRecord {
  tenantId: string;
  agentId: string;
  status: "AVAILABLE" | "OFFLINE" | "BUSY";
  activeChats: number;
  connectionId?: string;
  lastHeartbeat: string;
}

/**
 * In-memory presence registry fallback for local development and offline unit tests.
 */
const MEMORY_PRESENCE_STORE: Map<string, AgentPresenceRecord> = new Map();

function getPresenceKey(tenantId: string, agentId: string): string {
  return `${tenantId}#${agentId}`;
}

/**
 * Updates an agent's presence status (e.g., clicking 'Go Online' or 'Go Offline').
 */
export async function setAgentPresence(
  tenantId: string,
  agentId: string,
  status: "AVAILABLE" | "OFFLINE" | "BUSY",
  connectionId?: string
): Promise<AgentPresenceRecord> {
  const key = getPresenceKey(tenantId, agentId);
  const existing = MEMORY_PRESENCE_STORE.get(key);
  const currentActiveChats = existing?.activeChats || 0;

  const record: AgentPresenceRecord = {
    tenantId,
    agentId,
    status,
    activeChats: status === "OFFLINE" ? 0 : currentActiveChats,
    connectionId: connectionId || existing?.connectionId,
    lastHeartbeat: new Date().toISOString(),
  };

  // Update memory store
  MEMORY_PRESENCE_STORE.set(key, record);

  // Attempt to persist to DynamoDB
  try {
    await docClient.send(
      new PutCommand({
        TableName: "omni-channel-agent-presence",
        Item: record,
      })
    );
  } catch (err: any) {
    console.warn(`[PresenceManager] DynamoDB update failed (${err?.message || err}). Using in-memory fallback.`);
  }

  console.log(`[PresenceManager] Agent '${agentId}' for tenant '${tenantId}' status set to '${status}'`);
  return record;
}

/**
 * Retrieves the current presence status of a human agent.
 */
export async function getAgentPresence(tenantId: string, agentId: string): Promise<AgentPresenceRecord | null> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: "omni-channel-agent-presence",
        Key: { tenantId, agentId },
      })
    );
    if (result.Item) {
      return result.Item as AgentPresenceRecord;
    }
  } catch (err: any) {
    console.warn(`[PresenceManager] DynamoDB get failed (${err?.message || err}). Checking in-memory store.`);
  }

  return MEMORY_PRESENCE_STORE.get(getPresenceKey(tenantId, agentId)) || null;
}

/**
 * Finds the best available online agent for a tenant (lowest active chat count).
 */
export async function findAvailableAgent(tenantId: string): Promise<AgentPresenceRecord | null> {
  let candidates: AgentPresenceRecord[] = [];

  try {
    // Query DynamoDB for agents in this tenant
    const result = await docClient.send(
      new QueryCommand({
        TableName: "omni-channel-agent-presence",
        KeyConditionExpression: "tenantId = :tid",
        ExpressionAttributeValues: {
          ":tid": tenantId,
        },
      })
    );
    if (result.Items && result.Items.length > 0) {
      candidates = (result.Items as AgentPresenceRecord[]).filter((a) => a.status === "AVAILABLE");
    }
  } catch (err: any) {
    console.warn(`[PresenceManager] DynamoDB query failed (${err?.message || err}). Checking in-memory store.`);
  }

  if (candidates.length === 0) {
    // Check in-memory store
    for (const record of MEMORY_PRESENCE_STORE.values()) {
      if (record.tenantId === tenantId && record.status === "AVAILABLE") {
        candidates.push(record);
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Sort by lowest activeChats
  candidates.sort((a, b) => a.activeChats - b.activeChats);
  return candidates[0];
}

/**
 * Adjusts an agent's active chat count (e.g. +1 on assignment, -1 on resolution).
 */
export async function adjustActiveChats(tenantId: string, agentId: string, delta: number): Promise<number> {
  const current = await getAgentPresence(tenantId, agentId);
  const newCount = Math.max(0, (current?.activeChats || 0) + delta);

  if (current) {
    current.activeChats = newCount;
    current.lastHeartbeat = new Date().toISOString();
    MEMORY_PRESENCE_STORE.set(getPresenceKey(tenantId, agentId), current);
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: "omni-channel-agent-presence",
        Key: { tenantId, agentId },
        UpdateExpression: "SET activeChats = :ac, lastHeartbeat = :lh",
        ExpressionAttributeValues: {
          ":ac": newCount,
          ":lh": new Date().toISOString(),
        },
      })
    );
  } catch (err: any) {
    console.warn(`[PresenceManager] DynamoDB count update failed (${err?.message || err}).`);
  }

  return newCount;
}
