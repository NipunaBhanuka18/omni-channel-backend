import os
import time
from boto3.dynamodb.conditions import Key


class Repository:
    def __init__(self, dynamodb):
        self.mappings = dynamodb.Table(os.environ["PUBLIC_MAPPINGS_TABLE"])
        self.agents = dynamodb.Table(os.environ["AGENT_CONFIGS_TABLE"])
        self.conversations = dynamodb.Table(os.environ["CONVERSATIONS_TABLE"])

    def get_agent_by_public_key(self, agent_key: str) -> dict | None:
        mapping = self.mappings.get_item(Key={"publicAgentKey": agent_key}, ConsistentRead=True).get("Item")
        if not mapping or mapping.get("status") != "PUBLISHED":
            return None
        result = self.agents.get_item(Key={"tenantId": mapping["tenantId"], "agentId": mapping["agentId"]}, ConsistentRead=True)
        agent = result.get("Item")
        if not agent or agent.get("status") != "PUBLISHED":
            return None
        return agent

    def create_session(self, session_id: str, agent: dict) -> None:
        now = int(time.time())
        self.conversations.put_item(Item={
            "sessionId": session_id, "itemKey": "META", "tenantId": agent["tenantId"], "agentId": agent["agentId"],
            "publicAgentKey": agent["publicAgentKey"], "status": "AI_ACTIVE", "createdAt": now, "updatedAt": now,
            "tenantStatus": f"{agent['tenantId']}#AI_ACTIVE",
            "expiresAt": now + 60 * 60 * 24 * 30,
        }, ConditionExpression="attribute_not_exists(sessionId)")

    def get_session(self, session_id: str) -> dict | None:
        return self.conversations.get_item(Key={"sessionId": session_id, "itemKey": "META"}, ConsistentRead=True).get("Item")

    def get_agent(self, tenant_id: str, agent_id: str) -> dict | None:
        return self.agents.get_item(Key={"tenantId": tenant_id, "agentId": agent_id}, ConsistentRead=True).get("Item")

    def save_message(self, session: dict, message_id: str, role: str, text: str, created_at: str, **extra) -> None:
        item = {"sessionId": session["sessionId"], "itemKey": f"MSG#{created_at}#{message_id}", "messageId": message_id,
                "tenantId": session["tenantId"], "agentId": session["agentId"], "role": role, "text": text,
                "createdAt": created_at, "expiresAt": int(time.time()) + 60 * 60 * 24 * 30}
        item.update({k: v for k, v in extra.items() if v is not None})
        self.conversations.put_item(Item=item)

    def list_messages(self, session_id: str, limit: int = 30) -> list[dict]:
        result = self.conversations.query(KeyConditionExpression=Key("sessionId").eq(session_id) & Key("itemKey").begins_with("MSG#"),
                                          Limit=limit, ScanIndexForward=False)
        return list(reversed(result.get("Items", [])))

    def mark_handoff(self, session_id: str, reason: str) -> None:
        now = int(time.time())
        self.conversations.update_item(Key={"sessionId": session_id, "itemKey": "META"},
            UpdateExpression="SET #status=:status, tenantStatus=:tenantStatus, handoffReason=:reason, handoffRequestedAt=:now, updatedAt=:now",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":status": "HANDOFF_REQUESTED", ":tenantStatus": f"{self.get_session(session_id)['tenantId']}#HANDOFF_REQUESTED", ":reason": reason, ":now": now})

    def save_form_submission(self, session: dict, submission_id: str, form_id: str, values: dict, created_at: str) -> None:
        self.conversations.put_item(Item={"sessionId": session["sessionId"], "itemKey": f"FORM#{created_at}#{submission_id}",
            "submissionId": submission_id, "tenantId": session["tenantId"], "agentId": session["agentId"],
            "formId": form_id, "values": values, "createdAt": created_at,
            "expiresAt": int(time.time()) + 60 * 60 * 24 * 365})

    def save_feedback(self, session: dict, message_id: str, rating: str) -> None:
        now = int(time.time())
        self.conversations.put_item(Item={"sessionId": session["sessionId"], "itemKey": f"FEEDBACK#{message_id}",
            "messageId": message_id, "tenantId": session["tenantId"], "agentId": session["agentId"],
            "rating": rating, "createdAt": now, "expiresAt": now + 60 * 60 * 24 * 365})
