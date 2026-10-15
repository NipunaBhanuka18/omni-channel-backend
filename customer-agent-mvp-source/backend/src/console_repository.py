import os
import time
from decimal import Decimal

from boto3.dynamodb.conditions import Key


class ConsoleRepository:
    def __init__(self, dynamodb):
        self.agents = dynamodb.Table(os.environ["AGENT_CONFIGS_TABLE"])
        self.mappings = dynamodb.Table(os.environ["PUBLIC_MAPPINGS_TABLE"])
        self.knowledge = dynamodb.Table(os.environ["KNOWLEDGE_BASES_TABLE"])
        self.tools = dynamodb.Table(os.environ["TOOLS_TABLE"])
        self.live_agents = dynamodb.Table(os.environ["LIVE_AGENTS_TABLE"])
        self.conversations = dynamodb.Table(os.environ["CONVERSATIONS_TABLE"])
        self.tenants = dynamodb.Table(os.environ["TENANTS_TABLE"])
        self.members = dynamodb.Table(os.environ["TENANT_MEMBERS_TABLE"])
        self.seat_requests = dynamodb.Table(os.environ["SEAT_REQUESTS_TABLE"])
        self.audit = dynamodb.Table(os.environ["AUDIT_EVENTS_TABLE"])
        self.client = dynamodb.meta.client

    @staticmethod
    def _query(table, tenant_id: str) -> list[dict]:
        return table.query(KeyConditionExpression=Key("tenantId").eq(tenant_id)).get("Items", [])

    def list_agents(self, tenant_id): return self._query(self.agents, tenant_id)
    def list_knowledge(self, tenant_id): return self._query(self.knowledge, tenant_id)
    def list_tools(self, tenant_id): return self._query(self.tools, tenant_id)
    def list_live_agents(self, tenant_id): return self._query(self.live_agents, tenant_id)
    def list_members(self, tenant_id): return self._query(self.members, tenant_id)
    def list_seat_requests(self, tenant_id): return self._query(self.seat_requests, tenant_id)

    def get_tenant(self, tenant_id):
        return self.tenants.get_item(Key={"tenantId": tenant_id}, ConsistentRead=True).get("Item")

    def get_agent(self, tenant_id, agent_id):
        return self.agents.get_item(Key={"tenantId": tenant_id, "agentId": agent_id}, ConsistentRead=True).get("Item")

    def get_knowledge(self, tenant_id, kb_id):
        return self.knowledge.get_item(Key={"tenantId": tenant_id, "kbId": kb_id}, ConsistentRead=True).get("Item")

    def get_tool(self, tenant_id, tool_id):
        return self.tools.get_item(Key={"tenantId": tenant_id, "toolId": tool_id}, ConsistentRead=True).get("Item")

    def put_agent(self, item): self.agents.put_item(Item=_numbers(item))
    def put_knowledge(self, item): self.knowledge.put_item(Item=_numbers(item))
    def put_tool(self, item): self.tools.put_item(Item=_numbers(item))
    def put_live_agent(self, item): self.live_agents.put_item(Item=_numbers(item))
    def put_member(self, item): self.members.put_item(Item=_numbers(item), ConditionExpression="attribute_not_exists(userId)")
    def put_seat_request(self, item): self.seat_requests.put_item(Item=_numbers(item))
    def put_audit(self, item): self.audit.put_item(Item=_numbers(item))

    def reserve_seat(self, tenant_id, role, now):
        used = "usedAdminSeats" if role == "COMPANY_ADMIN" else "usedLiveAgentSeats"
        limit = "adminSeatLimit" if role == "COMPANY_ADMIN" else "liveAgentSeatLimit"
        return self.tenants.update_item(Key={"tenantId": tenant_id},
            UpdateExpression=f"SET {used} = {used} + :one, updatedAt=:now",
            ConditionExpression=f"#status=:active AND {used} < {limit}",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":one": 1, ":now": now, ":active": "ACTIVE"},
            ReturnValues="ALL_NEW").get("Attributes")

    def release_seat(self, tenant_id, role, now):
        used = "usedAdminSeats" if role == "COMPANY_ADMIN" else "usedLiveAgentSeats"
        self.tenants.update_item(Key={"tenantId": tenant_id},
            UpdateExpression=f"SET {used} = {used} - :one, updatedAt=:now",
            ConditionExpression=f"{used} > :zero",
            ExpressionAttributeValues={":one": 1, ":zero": 0, ":now": now})

    def delete_agent(self, tenant_id, agent_id): self.agents.delete_item(Key={"tenantId": tenant_id, "agentId": agent_id})
    def delete_knowledge(self, tenant_id, kb_id): self.knowledge.delete_item(Key={"tenantId": tenant_id, "kbId": kb_id})
    def delete_tool(self, tenant_id, tool_id): self.tools.delete_item(Key={"tenantId": tenant_id, "toolId": tool_id})

    def publish_mapping(self, public_key, tenant_id, agent_id):
        self.mappings.put_item(Item={"publicAgentKey": public_key, "tenantId": tenant_id, "agentId": agent_id, "status": "PUBLISHED"},
            ConditionExpression="attribute_not_exists(publicAgentKey) OR tenantId = :tenant",
            ExpressionAttributeValues={":tenant": tenant_id})

    def remove_mapping(self, public_key, tenant_id):
        self.mappings.delete_item(Key={"publicAgentKey": public_key}, ConditionExpression="tenantId = :tenant",
                                  ExpressionAttributeValues={":tenant": tenant_id})

    def query_sessions(self, tenant_status: str, limit=100):
        return self.conversations.query(IndexName="TenantStatusIndex",
            KeyConditionExpression=Key("tenantStatus").eq(tenant_status), ScanIndexForward=False, Limit=limit).get("Items", [])

    def dashboard(self, tenant_id):
        agents = self.list_agents(tenant_id)
        live_agents = self.list_live_agents(tenant_id)
        waiting = self.query_sessions(f"{tenant_id}#HANDOFF_REQUESTED")
        active = []
        for live in live_agents:
            active.extend(self.query_sessions(f"{tenant_id}#ASSIGNED#{live['userId']}", 50))
        return {"agents": len(agents), "publishedAgents": sum(a.get("status") == "PUBLISHED" for a in agents),
                "knowledgeBases": len(self.list_knowledge(tenant_id)), "tools": len(self.list_tools(tenant_id)),
                "liveAgents": len(live_agents), "onlineAgents": sum(a.get("presence") == "ONLINE" for a in live_agents),
                "waitingHandoffs": len(waiting), "activeHumanChats": len(active)}

    def update_presence(self, tenant_id, user_id, status, now):
        return self.live_agents.update_item(Key={"tenantId": tenant_id, "userId": user_id},
            UpdateExpression="SET presence=:presence, lastSeenAt=:now",
            ExpressionAttributeValues={":presence": status, ":now": now}, ReturnValues="ALL_NEW").get("Attributes")

    def accept_session(self, tenant_id, session_id, user_id, now):
        return self.conversations.update_item(Key={"sessionId": session_id, "itemKey": "META"},
            UpdateExpression="SET #status=:active, assignedAgentId=:agent, tenantStatus=:tenantStatus, updatedAt=:now",
            ConditionExpression="tenantId=:tenant AND #status=:waiting",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":active": "HUMAN_ACTIVE", ":waiting": "HANDOFF_REQUESTED", ":agent": user_id,
                                       ":tenant": tenant_id, ":tenantStatus": f"{tenant_id}#ASSIGNED#{user_id}", ":now": now},
            ReturnValues="ALL_NEW").get("Attributes")

    def close_session(self, tenant_id, session_id, user_id, now):
        return self.conversations.update_item(Key={"sessionId": session_id, "itemKey": "META"},
            UpdateExpression="SET #status=:closed, tenantStatus=:tenantStatus, closedAt=:now, updatedAt=:now",
            ConditionExpression="tenantId=:tenant AND assignedAgentId=:agent AND #status=:active",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":closed": "CLOSED", ":active": "HUMAN_ACTIVE", ":tenant": tenant_id,
                                       ":agent": user_id, ":tenantStatus": f"{tenant_id}#CLOSED", ":now": now},
            ReturnValues="ALL_NEW").get("Attributes")


def _numbers(value):
    if isinstance(value, float): return Decimal(str(value))
    if isinstance(value, dict): return {k: _numbers(v) for k, v in value.items()}
    if isinstance(value, list): return [_numbers(v) for v in value]
    return value
