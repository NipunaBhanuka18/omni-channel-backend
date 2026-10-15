import json
import logging
import os
import re
import time
import uuid

import boto3
from botocore.exceptions import ClientError

from auth import require_principal
from console_repository import ConsoleRepository
from security import RequestError, parse_json_body, validate_agent_key
from tenant_security import normalized_email, validate_role

log = logging.getLogger()
log.setLevel(logging.INFO)
repo = ConsoleRepository(boto3.resource("dynamodb"))
s3 = boto3.client("s3")
bedrock_agent = boto3.client("bedrock-agent")
cognito = boto3.client("cognito-idp")
ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{2,80}$")


def lambda_handler(event, _context):
    try:
        principal = require_principal(event, ("COMPANY_ADMIN",))
        method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
        parts = [p for p in (event.get("rawPath") or "/").split("/") if p][2:]
        body = parse_json_body(event) if method in ("POST", "PUT", "PATCH") else {}
        result, status = route(principal, method, parts, body), 200
        if method == "POST" and parts and parts[-1] not in ("publish", "sync", "upload-url"):
            status = 201
        return response(status, result)
    except RequestError as exc:
        return response(exc.status_code, {"message": exc.message})
    except ClientError as exc:
        log.exception("AWS operation failed")
        code = exc.response.get("Error", {}).get("Code", "")
        message = "That public URL is already used by another company." if code == "ConditionalCheckFailedException" else "The requested operation could not be completed."
        return response(409 if code == "ConditionalCheckFailedException" else 500, {"message": message})
    except Exception:
        log.exception("Admin API failed")
        return response(500, {"message": "The admin service is temporarily unavailable."})


def route(p, method, parts, body):
    if parts == ["dashboard"] and method == "GET": return repo.dashboard(p.tenant_id)
    if parts == ["agents"]:
        if method == "GET": return {"items": repo.list_agents(p.tenant_id)}
        if method == "POST": return save_agent(p.tenant_id, None, body)
    if len(parts) == 2 and parts[0] == "agents":
        if method == "GET": return require_item(repo.get_agent(p.tenant_id, valid_id(parts[1])))
        if method == "PUT": return save_agent(p.tenant_id, parts[1], body)
        if method == "DELETE": return delete_agent(p.tenant_id, parts[1])
    if len(parts) == 3 and parts[0] == "agents" and parts[2] == "publish" and method == "POST":
        return publish_agent(p.tenant_id, parts[1])
    if parts == ["knowledge-bases"]:
        if method == "GET": return {"items": repo.list_knowledge(p.tenant_id)}
        if method == "POST": return save_kb(p.tenant_id, body)
    if len(parts) == 2 and parts[0] == "knowledge-bases" and method == "DELETE":
        repo.delete_knowledge(p.tenant_id, valid_id(parts[1])); return {"deleted": True}
    if len(parts) == 3 and parts[0] == "knowledge-bases" and parts[2] == "upload-url" and method == "POST":
        return upload_url(p.tenant_id, parts[1], body)
    if len(parts) == 3 and parts[0] == "knowledge-bases" and parts[2] == "sync" and method == "POST":
        return sync_kb(p.tenant_id, parts[1])
    if parts == ["tools"]:
        if method == "GET": return {"items": repo.list_tools(p.tenant_id)}
        if method == "POST": return save_tool(p.tenant_id, None, body)
    if len(parts) == 2 and parts[0] == "tools":
        if method == "PUT": return save_tool(p.tenant_id, parts[1], body)
        if method == "DELETE": repo.delete_tool(p.tenant_id, valid_id(parts[1])); return {"deleted": True}
    if parts == ["live-agents"]:
        if method == "GET": return {"items": repo.list_live_agents(p.tenant_id)}
        if method == "POST": return create_member(p, {**body, "role": "LIVE_AGENT"})
    if parts == ["workspace"] and method == "GET": return workspace(p.tenant_id)
    if parts == ["team"]:
        if method == "GET": return team(p.tenant_id)
        if method == "POST": return create_member(p, body)
    if parts == ["seat-requests"]:
        if method == "GET": return {"items": repo.list_seat_requests(p.tenant_id)}
        if method == "POST": return request_seats(p, body)
    if parts == ["chats"] and method == "GET": return list_chats(p.tenant_id)
    raise RequestError("Route not found", 404)


def save_agent(tenant_id, agent_id, body):
    agent_id = valid_id(agent_id or f"agent-{uuid.uuid4().hex[:10]}")
    existing = repo.get_agent(tenant_id, agent_id) or {}
    public_key = validate_agent_key(body.get("publicAgentKey") or existing.get("publicAgentKey") or agent_id.lower())
    if existing.get("status") == "PUBLISHED" and existing.get("publicAgentKey") != public_key:
        repo.remove_mapping(existing["publicAgentKey"], tenant_id)
    now = int(time.time())
    item = {**existing, "tenantId": tenant_id, "agentId": agent_id, "publicAgentKey": public_key,
            "displayName": text(body, "displayName", 120, existing.get("displayName", "AI Assistant")),
            "brandName": text(body, "brandName", 120, existing.get("brandName", "Customer Support")),
            "systemPrompt": text(body, "systemPrompt", 12000, existing.get("systemPrompt", "Be helpful and accurate.")),
            "welcomeMessage": text(body, "welcomeMessage", 500, existing.get("welcomeMessage", "How can I help?")),
            "handoffMessage": text(body, "handoffMessage", 500, existing.get("handoffMessage", "I’ve recorded your request for human assistance.")),
            "modelId": text(body, "modelId", 200, existing.get("modelId", os.environ["BEDROCK_MODEL_ID"])),
            "knowledgeBaseRef": str(body.get("knowledgeBaseRef", existing.get("knowledgeBaseRef", "")))[:80],
            "toolIds": [valid_id(v) for v in body.get("toolIds", existing.get("toolIds", []))[:30]],
            "enabledSubAgents": body.get("enabledSubAgents", existing.get("enabledSubAgents", ["general", "sales", "billing", "technical", "lead"])),
            "suggestedPrompts": [str(v)[:100] for v in body.get("suggestedPrompts", existing.get("suggestedPrompts", []))[:5]],
            "theme": body.get("theme", existing.get("theme", {"primary": "#075fc6", "accent": "#06a96b"})),
            "temperature": max(0, min(float(body.get("temperature", existing.get("temperature", 0.2))), 1)),
            "maxTokens": max(100, min(int(body.get("maxTokens", existing.get("maxTokens", 700))), 4000)),
            "status": "DRAFT" if existing else "DRAFT", "updatedAt": now, "createdAt": existing.get("createdAt", now)}
    repo.put_agent(item)
    return item


def publish_agent(tenant_id, agent_id):
    item = require_item(repo.get_agent(tenant_id, valid_id(agent_id)))
    selected = [repo.get_tool(tenant_id, tool_id) for tool_id in item.get("toolIds", [])]
    selected = [tool for tool in selected if tool and tool.get("enabled", True)]
    runtime_tools, forms = [], []
    for tool in selected:
        if tool.get("type") == "form": forms.append(tool.get("formSchema", {}))
        else: runtime_tools.append({k: v for k, v in tool.items() if k not in ("tenantId", "toolId", "createdAt", "updatedAt")})
    kb = repo.get_knowledge(tenant_id, item.get("knowledgeBaseRef")) if item.get("knowledgeBaseRef") else None
    item.update({"tools": runtime_tools, "forms": forms, "knowledgeBaseId": (kb or {}).get("bedrockKnowledgeBaseId", ""),
                 "status": "PUBLISHED", "publishedAt": int(time.time())})
    repo.publish_mapping(item["publicAgentKey"], tenant_id, item["agentId"])
    repo.put_agent(item)
    return item


def delete_agent(tenant_id, agent_id):
    item = require_item(repo.get_agent(tenant_id, valid_id(agent_id)))
    if item.get("status") == "PUBLISHED": repo.remove_mapping(item["publicAgentKey"], tenant_id)
    repo.delete_agent(tenant_id, agent_id)
    return {"deleted": True}


def save_kb(tenant_id, body):
    kb_id = valid_id(body.get("kbId") or f"kb-{uuid.uuid4().hex[:10]}")
    bedrock_kb_id = text(body, "bedrockKnowledgeBaseId", 100, "")
    if bedrock_kb_id:
        validate_kb_owner(tenant_id, bedrock_kb_id)
    now = int(time.time())
    item = {"tenantId": tenant_id, "kbId": kb_id, "name": text(body, "name", 120, "Knowledge Base"),
            "description": text(body, "description", 500, ""),
            "bedrockKnowledgeBaseId": bedrock_kb_id,
            "dataSourceId": text(body, "dataSourceId", 100, ""), "s3Prefix": f"{tenant_id}/{kb_id}/",
            "status": "READY", "createdAt": now, "updatedAt": now}
    repo.put_knowledge(item); return item


def upload_url(tenant_id, kb_id, body):
    kb = require_item(repo.get_knowledge(tenant_id, valid_id(kb_id)))
    filename = re.sub(r"[^a-zA-Z0-9._-]", "_", str(body.get("filename", "document")))[:180]
    if not filename.lower().endswith((".pdf", ".docx", ".txt", ".md", ".csv", ".html")):
        raise RequestError("Unsupported knowledge file type")
    key = f"{kb['s3Prefix']}{uuid.uuid4().hex}-{filename}"
    url = s3.generate_presigned_url("put_object", Params={"Bucket": os.environ["KNOWLEDGE_BUCKET"], "Key": key,
        "ContentType": str(body.get("contentType", "application/octet-stream"))[:100]}, ExpiresIn=900)
    return {"uploadUrl": url, "objectKey": key}


def sync_kb(tenant_id, kb_id):
    kb = require_item(repo.get_knowledge(tenant_id, valid_id(kb_id)))
    if not kb.get("bedrockKnowledgeBaseId") or not kb.get("dataSourceId"):
        raise RequestError("Bedrock Knowledge Base ID and Data Source ID are required")
    result = bedrock_agent.start_ingestion_job(knowledgeBaseId=kb["bedrockKnowledgeBaseId"], dataSourceId=kb["dataSourceId"],
                                                description=f"Admin sync for {tenant_id}/{kb_id}")
    return {"status": "SYNCING", "ingestionJob": result.get("ingestionJob", {})}


def save_tool(tenant_id, tool_id, body):
    tool_id = valid_id(tool_id or body.get("toolId") or f"tool-{uuid.uuid4().hex[:10]}")
    existing = repo.get_tool(tenant_id, tool_id) or {}
    tool_type = str(body.get("type", existing.get("type", "api"))).lower()
    if tool_type not in ("api", "mcp", "form"): raise RequestError("Tool type must be api, mcp, or form")
    now = int(time.time())
    secret_id = str(body.get("secretId", existing.get("secretId", "")))[:300]
    if secret_id and f"tenant/{tenant_id}/" not in secret_id:
        raise RequestError(f"Credential secrets must use the tenant/{tenant_id}/ name prefix")
    item = {**existing, "tenantId": tenant_id, "toolId": tool_id, "name": safe_tool_name(body.get("name", existing.get("name", tool_id))),
            "displayName": text(body, "displayName", 120, existing.get("displayName", tool_id)), "type": tool_type,
            "description": text(body, "description", 500, existing.get("description", "")), "enabled": bool(body.get("enabled", True)),
            "inputSchema": body.get("inputSchema", existing.get("inputSchema", {"type": "object", "properties": {}})),
            "endpoint": str(body.get("endpoint", existing.get("endpoint", "")))[:500],
            "method": str(body.get("method", existing.get("method", "POST"))).upper(),
            "gatewayUrl": str(body.get("gatewayUrl", existing.get("gatewayUrl", "")))[:500],
            "targetToolName": str(body.get("targetToolName", existing.get("targetToolName", "")))[:200],
            "secretId": secret_id,
            "formSchema": body.get("formSchema", existing.get("formSchema", {})),
            "createdAt": existing.get("createdAt", now), "updatedAt": now}
    repo.put_tool(item); return item


def create_member(p, body):
    email = normalized_email(body.get("email"))
    name = text(body, "name", 120, "Live Agent")
    role = validate_role(body.get("role") or "LIVE_AGENT")
    now = int(time.time())
    try:
        repo.reserve_seat(p.tenant_id, role, now)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise RequestError("No seats are available for this role. Request additional seats first.", 409)
        raise
    created_username = None
    try:
        result = cognito.admin_create_user(UserPoolId=os.environ["USER_POOL_ID"], Username=email,
            UserAttributes=[{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"},
                            {"Name": "name", "Value": name}, {"Name": "custom:tenant_id", "Value": p.tenant_id},
                            {"Name": "custom:role", "Value": role}], DesiredDeliveryMediums=["EMAIL"])
        created_username = email
        user_id = next((a["Value"] for a in result["User"].get("Attributes", []) if a["Name"] == "sub"), email)
        member = {"tenantId": p.tenant_id, "userId": user_id, "email": email, "name": name, "role": role,
                  "status": "INVITED", "createdAt": now}
        repo.put_member(member)
        if role == "LIVE_AGENT":
            repo.put_live_agent({"tenantId": p.tenant_id, "userId": user_id, "email": email, "name": name,
                "presence": "OFFLINE", "status": "ACTIVE", "createdAt": now})
        repo.put_audit({"tenantId": p.tenant_id, "eventId": f"{now}#{uuid.uuid4().hex}",
            "action": "MEMBER_INVITED", "actorId": p.user_id, "resourceId": user_id, "role": role, "createdAt": now})
        return member
    except Exception:
        if created_username:
            try:
                cognito.admin_delete_user(UserPoolId=os.environ["USER_POOL_ID"], Username=created_username)
            except ClientError:
                log.exception("Could not compensate Cognito member creation")
        repo.release_seat(p.tenant_id, role, now)
        raise


def workspace(tenant_id):
    tenant = require_item(repo.get_tenant(tenant_id))
    return {k: tenant.get(k) for k in ("tenantId", "tenantSlug", "companyName", "status", "plan",
        "adminSeatLimit", "liveAgentSeatLimit", "usedAdminSeats", "usedLiveAgentSeats", "createdAt")}


def team(tenant_id):
    return {"workspace": workspace(tenant_id), "items": repo.list_members(tenant_id),
            "seatRequests": repo.list_seat_requests(tenant_id)}


def request_seats(p, body):
    admin_seats = max(0, min(int(body.get("adminSeats", 0)), 1000))
    live_seats = max(0, min(int(body.get("liveAgentSeats", 0)), 10000))
    if admin_seats + live_seats < 1:
        raise RequestError("Request at least one additional seat")
    now = int(time.time())
    item = {"tenantId": p.tenant_id, "requestId": f"req-{uuid.uuid4().hex[:12]}", "adminSeats": admin_seats,
        "liveAgentSeats": live_seats, "reason": text(body, "reason", 500, ""), "status": "PENDING",
        "requestedBy": p.user_id, "createdAt": now}
    repo.put_seat_request(item)
    repo.put_audit({"tenantId": p.tenant_id, "eventId": f"{now}#{uuid.uuid4().hex}", "action": "SEATS_REQUESTED",
        "actorId": p.user_id, "resourceId": item["requestId"], "createdAt": now})
    return item


def list_chats(tenant_id):
    statuses = ["HANDOFF_REQUESTED", "CLOSED"]
    items = []
    for status in statuses: items.extend(repo.query_sessions(f"{tenant_id}#{status}", 100))
    for live in repo.list_live_agents(tenant_id): items.extend(repo.query_sessions(f"{tenant_id}#ASSIGNED#{live['userId']}", 50))
    return {"items": sorted(items, key=lambda i: int(i.get("updatedAt", 0)), reverse=True)[:200]}


def valid_id(value):
    value = str(value or "")
    if not ID_PATTERN.fullmatch(value): raise RequestError("Invalid identifier")
    return value


def safe_tool_name(value):
    value = str(value or "")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,64}", value): raise RequestError("Tool name may contain only letters, numbers, and underscores")
    return value


def validate_kb_owner(tenant_id, knowledge_base_id):
    try:
        kb = bedrock_agent.get_knowledge_base(knowledgeBaseId=knowledge_base_id).get("knowledgeBase", {})
        tags = bedrock_agent.list_tags_for_resource(resourceArn=kb["knowledgeBaseArn"]).get("tags", {})
    except ClientError:
        raise RequestError("Knowledge Base could not be validated", 400)
    if tags.get("TenantId") != tenant_id:
        raise RequestError("Knowledge Base is not tagged for this company tenant", 403)


def text(body, key, limit, default):
    value = str(body.get(key, default)).strip()
    if not value and default == "": return ""
    if not value: raise RequestError(f"{key} is required")
    return value[:limit]


def require_item(item):
    if not item: raise RequestError("Item not found", 404)
    return item


def response(code, body):
    return {"statusCode": code, "headers": {"Content-Type": "application/json", "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": os.environ.get("ALLOWED_ORIGIN", "*")}, "body": json.dumps(body, default=str)}
