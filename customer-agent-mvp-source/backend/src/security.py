import json
import re

AGENT_KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
SESSION_ID_PATTERN = re.compile(r"^[0-9a-f-]{36}$")


class RequestError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def parse_json_body(event: dict) -> dict:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64
        raw = base64.b64decode(raw).decode("utf-8")
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise RequestError("Request body must be valid JSON")
    if not isinstance(value, dict):
        raise RequestError("Request body must be an object")
    return value


def validate_agent_key(value: str) -> str:
    value = (value or "").strip().lower()
    if not AGENT_KEY_PATTERN.fullmatch(value):
        raise RequestError("Invalid agent key")
    return value


def validate_session_id(value: str) -> str:
    value = (value or "").strip().lower()
    if not SESSION_ID_PATTERN.fullmatch(value):
        raise RequestError("Invalid session ID")
    return value


def validate_message(value: str) -> str:
    if not isinstance(value, str):
        raise RequestError("Message must be text")
    value = value.strip()
    if not value:
        raise RequestError("Message cannot be empty")
    if len(value) > 4000:
        raise RequestError("Message is too long")
    return value


def safe_form_values(values: dict, allowed_fields: list[dict]) -> dict:
    if not isinstance(values, dict):
        raise RequestError("Invalid form values")
    allowed = {field["name"]: field for field in allowed_fields}
    clean = {}
    for name, spec in allowed.items():
        value = str(values.get(name, "")).strip()
        if spec.get("required", True) and not value:
            raise RequestError(f"{spec.get('label', name)} is required")
        if len(value) > int(spec.get("maxLength", 200)):
            raise RequestError(f"{spec.get('label', name)} is too long")
        clean[name] = value
    return clean

