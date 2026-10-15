import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

from auth import require_principal
from console_repository import ConsoleRepository
from repository import Repository
from security import RequestError, parse_json_body, validate_message, validate_session_id

log = logging.getLogger()
log.setLevel(logging.INFO)
console = ConsoleRepository(boto3.resource("dynamodb"))
messages_repo = Repository(boto3.resource("dynamodb"))


def lambda_handler(event, _context):
    try:
        p = require_principal(event, ("LIVE_AGENT", "COMPANY_ADMIN"))
        method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
        parts = [x for x in (event.get("rawPath") or "/").split("/") if x][2:]
        body = parse_json_body(event) if method in ("POST", "PUT") else {}
        if parts == ["me"] and method == "GET": return response(200, {"userId": p.user_id, "name": p.name, "email": p.email, "role": p.role})
        if parts == ["presence"] and method == "POST":
            status = body.get("status")
            if status not in ("ONLINE", "OFFLINE"): raise RequestError("Invalid presence status")
            return response(200, console.update_presence(p.tenant_id, p.user_id, status, int(time.time())))
        if parts == ["queue"] and method == "GET":
            return response(200, {"waiting": console.query_sessions(f"{p.tenant_id}#HANDOFF_REQUESTED"),
                                  "assigned": console.query_sessions(f"{p.tenant_id}#ASSIGNED#{p.user_id}")})
        if len(parts) == 3 and parts[0] == "conversations":
            session_id, action = validate_session_id(parts[1]), parts[2]
            if action == "accept" and method == "POST":
                return response(200, console.accept_session(p.tenant_id, session_id, p.user_id, int(time.time())))
            if action == "messages" and method == "GET": return get_messages(p, session_id)
            if action == "messages" and method == "POST": return send_message(p, session_id, body)
            if action == "close" and method == "POST":
                return response(200, console.close_session(p.tenant_id, session_id, p.user_id, int(time.time())))
        raise RequestError("Route not found", 404)
    except RequestError as exc: return response(exc.status_code, {"message": exc.message})
    except ClientError as exc:
        log.exception("Live agent state change failed")
        code = exc.response.get("Error", {}).get("Code", "")
        return response(409 if code == "ConditionalCheckFailedException" else 500,
                        {"message": "This conversation was already taken or is no longer available." if code == "ConditionalCheckFailedException" else "Live chat operation failed."})
    except Exception:
        log.exception("Live agent API failed")
        return response(500, {"message": "The live-agent service is temporarily unavailable."})


def require_assignment(p, session_id):
    session = messages_repo.get_session(session_id)
    if not session or session.get("tenantId") != p.tenant_id: raise RequestError("Conversation not found", 404)
    if session.get("assignedAgentId") != p.user_id and p.role != "COMPANY_ADMIN": raise RequestError("Conversation is assigned to another agent", 403)
    return session


def get_messages(p, session_id):
    session = require_assignment(p, session_id)
    return response(200, {"session": session, "messages": messages_repo.list_messages(session_id, 100)})


def send_message(p, session_id, body):
    session = require_assignment(p, session_id)
    if session.get("status") != "HUMAN_ACTIVE": raise RequestError("Conversation is not active")
    message = validate_message(body.get("message"))
    message_id = str(uuid.uuid4())
    messages_repo.save_message(session, message_id, "live_agent", message, datetime.now(timezone.utc).isoformat(),
                               senderId=p.user_id, senderName=p.name, status="sent")
    return response(201, {"messageId": message_id, "message": message, "createdAt": datetime.now(timezone.utc).isoformat()})


def response(code, body):
    return {"statusCode": code, "headers": {"Content-Type": "application/json", "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": os.environ.get("ALLOWED_ORIGIN", "*")}, "body": json.dumps(body, default=str)}

