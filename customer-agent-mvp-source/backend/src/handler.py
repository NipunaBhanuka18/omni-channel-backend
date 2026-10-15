import json
import logging
import os
import uuid
from datetime import datetime, timezone

import boto3

from bedrock_service import BedrockService
from orchestrator import MainAgentRouter, build_lead_form, build_system_prompt
from repository import Repository
from security import RequestError, parse_json_body, safe_form_values, validate_agent_key, validate_message, validate_session_id
from tool_executor import ToolExecutor

log = logging.getLogger()
log.setLevel(logging.INFO)

dynamodb = boto3.resource("dynamodb")
repository = Repository(dynamodb)
bedrock = BedrockService(boto3.client("bedrock-runtime"), boto3.client("bedrock-agent-runtime"))
tool_executor = ToolExecutor(boto3.client("secretsmanager"), boto3.Session())
router = MainAgentRouter()


def lambda_handler(event, _context):
    try:
        method = event.get("requestContext", {}).get("http", {}).get("method", event.get("httpMethod", "GET"))
        path = event.get("rawPath") or event.get("path") or "/"
        if method == "OPTIONS":
            return response(204, None)
        if method == "GET" and path == "/health":
            return response(200, {"status": "ok"})

        parts = [part for part in path.split("/") if part]
        if len(parts) == 4 and parts[:3] == ["v1", "public", "agents"] and method == "GET":
            return get_public_agent(parts[3])
        if parts == ["v1", "public", "sessions"] and method == "POST":
            return create_session(event)
        if len(parts) == 5 and parts[:3] == ["v1", "public", "sessions"] and parts[4] == "messages":
            if method == "POST":
                return send_message(parts[3], event)
            if method == "GET":
                return list_messages(parts[3])
        if len(parts) == 5 and parts[:3] == ["v1", "public", "sessions"] and parts[4] == "feedback" and method == "POST":
            return save_feedback(parts[3], event)
        raise RequestError("Route not found", 404)
    except RequestError as exc:
        return response(exc.status_code, {"message": exc.message})
    except Exception:
        log.exception("Unhandled public API error")
        return response(500, {"message": "The assistant is temporarily unavailable."})


def get_public_agent(agent_key: str):
    agent = repository.get_agent_by_public_key(validate_agent_key(agent_key))
    if not agent:
        raise RequestError("Assistant not found", 404)
    return response(200, public_agent(agent))


def create_session(event: dict):
    body = parse_json_body(event)
    agent = repository.get_agent_by_public_key(validate_agent_key(body.get("agentKey")))
    if not agent:
        raise RequestError("Assistant not found", 404)
    session_id = str(uuid.uuid4())
    repository.create_session(session_id, agent)
    return response(201, {"sessionId": session_id, "agent": public_agent(agent)})


def send_message(session_id: str, event: dict):
    session_id = validate_session_id(session_id)
    session = require_session(session_id)
    body = parse_json_body(event)
    message = validate_message(body.get("message")) if not body.get("formSubmission") else ""
    if session.get("status") in ("HANDOFF_REQUESTED", "HUMAN_ACTIVE"):
        if body.get("formSubmission"):
            raise RequestError("Forms are unavailable during human assistance")
        timestamp = datetime.now(timezone.utc).isoformat()
        user_message_id = str(uuid.uuid4())
        repository.save_message(session, user_message_id, "user", message, timestamp)
        return response(202, {"messageId": user_message_id, "message": "", "route": "human", "status": "delivered_to_human"})

    agent = repository.get_agent(session["tenantId"], session["agentId"])
    if not agent or agent.get("status") != "PUBLISHED":
        raise RequestError("Assistant is unavailable", 404)
    if body.get("formSubmission"):
        return process_form(session, agent, body["formSubmission"])

    timestamp = datetime.now(timezone.utc).isoformat()
    user_message_id = str(uuid.uuid4())
    repository.save_message(session, user_message_id, "user", message, timestamp)

    decision = router.route(message, agent.get("enabledSubAgents"))
    if decision.handoff:
        repository.mark_handoff(session_id, decision.reason)
        assistant_text = agent.get("handoffMessage", "I’ve recorded your request for human assistance.")
        status, citations, ui_action = "handoff_requested", [], None
    else:
        knowledge, citations = bedrock.retrieve(agent, message)
        history = repository.list_messages(session_id)
        assistant_text, tool_events = bedrock.respond(agent, build_system_prompt(agent, decision.route, knowledge),
                                                      history[:-1], message, tool_executor)
        status = "completed"
        ui_action = build_lead_form(agent, decision.route, message)

    assistant_message_id = str(uuid.uuid4())
    repository.save_message(session, assistant_message_id, "assistant", assistant_text,
                            datetime.now(timezone.utc).isoformat(), route=decision.route, citations=citations, status=status,
                            toolEvents=tool_events if not decision.handoff else [])
    return response(200, {"messageId": assistant_message_id, "message": assistant_text, "route": decision.route,
                          "status": status, "citations": citations, "uiAction": ui_action})


def process_form(session: dict, agent: dict, submission: dict):
    if not isinstance(submission, dict):
        raise RequestError("Invalid form submission")
    form_id = str(submission.get("formId", ""))
    form = next((item for item in agent.get("forms", []) if item.get("formId") == form_id), None)
    if not form:
        raise RequestError("Form is not available")
    values = safe_form_values(submission.get("values"), form.get("fields", []))
    submission_id, message_id = str(uuid.uuid4()), str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    repository.save_form_submission(session, submission_id, form_id, values, now)
    message = form.get("confirmationMessage", "Thank you. Your details have been submitted successfully.")
    repository.save_message(session, message_id, "assistant", message, now, route="lead", status="completed")
    return response(200, {"messageId": message_id, "message": message, "route": "lead", "status": "completed", "submissionId": submission_id})


def list_messages(session_id: str):
    session = require_session(validate_session_id(session_id))
    messages = repository.list_messages(session["sessionId"])
    return response(200, {"sessionStatus": session.get("status"),
                          "messages": [{k: item.get(k) for k in ("messageId", "role", "text", "createdAt", "route", "status", "citations", "senderName")} for item in messages]})


def save_feedback(session_id: str, event: dict):
    session = require_session(validate_session_id(session_id))
    body = parse_json_body(event)
    rating = body.get("rating")
    message_id = str(body.get("messageId", ""))[:80]
    if rating not in ("up", "down") or not message_id:
        raise RequestError("Invalid feedback")
    repository.save_feedback(session, message_id, rating)
    return response(201, {"saved": True})


def require_session(session_id: str) -> dict:
    session = repository.get_session(session_id)
    if not session:
        raise RequestError("Session not found", 404)
    return session


def public_agent(agent: dict) -> dict:
    return {"agentKey": agent["publicAgentKey"], "displayName": agent.get("displayName", "AI Assistant"),
            "brandName": agent.get("brandName", "Customer Support"), "welcomeMessage": agent.get("welcomeMessage", "How can I help?"),
            "suggestedPrompts": agent.get("suggestedPrompts", []), "theme": agent.get("theme", {})}


def response(status_code: int, body):
    headers = {"Access-Control-Allow-Origin": os.environ.get("ALLOWED_ORIGIN", "*"),
               "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
               "Cache-Control": "no-store", "Content-Type": "application/json"}
    return {"statusCode": status_code, "headers": headers, "body": "" if body is None else json.dumps(body, default=str)}
