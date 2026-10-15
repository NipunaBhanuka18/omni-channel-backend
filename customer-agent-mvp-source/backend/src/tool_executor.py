import json
import os
import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


TOOL_NAME = re.compile(r"^[A-Za-z0-9_]{1,64}$")


class ToolExecutor:
    """Executes only tools present in the trusted, server-side agent configuration."""

    def __init__(self, secrets_client, boto_session):
        self.secrets = secrets_client
        self.session = boto_session

    def bedrock_tool_config(self, agent: dict) -> dict | None:
        specs = []
        for tool in agent.get("tools", []):
            if not tool.get("enabled", True) or tool.get("type") not in ("api", "mcp"):
                continue
            name = str(tool.get("name", ""))
            if not TOOL_NAME.fullmatch(name):
                continue
            specs.append({"toolSpec": {
                "name": name,
                "description": str(tool.get("description", "Approved company tool"))[:500],
                "inputSchema": {"json": tool.get("inputSchema") or {"type": "object", "properties": {}}},
            }})
        return {"tools": specs} if specs else None

    def execute(self, agent: dict, name: str, arguments: dict) -> dict:
        tool = next((item for item in agent.get("tools", [])
                     if item.get("enabled", True) and item.get("name") == name), None)
        if not tool:
            raise ValueError("Tool is not enabled for this agent")
        if tool.get("type") == "api":
            return self._call_api(tool, arguments)
        if tool.get("type") == "mcp":
            return self._call_mcp(tool, arguments)
        raise ValueError("Unsupported tool type")

    def _call_api(self, tool: dict, arguments: dict) -> dict:
        endpoint = _https_url(tool.get("endpoint"))
        method = str(tool.get("method", "POST")).upper()
        if method not in ("POST", "PUT", "PATCH"):
            raise ValueError("Only POST, PUT, and PATCH API tools are supported")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        headers.update(self._secret_headers(tool.get("secretId")))
        return _request_json(endpoint, method, headers, {"input": arguments}, int(tool.get("timeoutSeconds", 12)))

    def _call_mcp(self, tool: dict, arguments: dict) -> dict:
        endpoint = _https_url(tool.get("gatewayUrl"))
        target_tool = str(tool.get("targetToolName") or tool["name"])
        payload = {"jsonrpc": "2.0", "id": "agent-tool-call", "method": "tools/call",
                   "params": {"name": target_tool, "arguments": arguments}}
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if tool.get("secretId"):
            headers.update(self._secret_headers(tool["secretId"]))
        else:
            body = json.dumps(payload).encode("utf-8")
            credentials = self.session.get_credentials().get_frozen_credentials()
            request = AWSRequest(method="POST", url=endpoint, data=body, headers=headers)
            SigV4Auth(credentials, "bedrock-agentcore", os.environ.get("AWS_REGION", "us-east-1")).add_auth(request)
            headers = dict(request.headers.items())
        return _request_json(endpoint, "POST", headers, payload, int(tool.get("timeoutSeconds", 20)))

    def _secret_headers(self, secret_id: str | None) -> dict:
        if not secret_id:
            return {}
        response = self.secrets.get_secret_value(SecretId=secret_id)
        raw = response.get("SecretString", "{}")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Tool credential secret must contain a JSON object of HTTP headers")
        return {str(k): str(v) for k, v in value.items() if k.lower() not in ("host", "content-length")}


def _https_url(value: str) -> str:
    parsed = urlparse(str(value or ""))
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("Tool endpoint must be a valid HTTPS URL without embedded credentials")
    return parsed.geturl()


def _request_json(url: str, method: str, headers: dict, payload: dict, timeout: int) -> dict:
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=max(2, min(timeout, 25))) as response:
            raw = response.read(256_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read(2_000).decode("utf-8", "replace")
        raise RuntimeError(f"Tool returned HTTP {exc.code}: {detail}")
    content = raw.strip()
    if content.startswith("data:"):
        data_lines = [line[5:].strip() for line in content.splitlines() if line.startswith("data:")]
        content = data_lines[-1] if data_lines else "{}"
    value = json.loads(content or "{}")
    if isinstance(value, dict) and "result" in value and value.get("jsonrpc") == "2.0":
        value = value["result"]
    return value if isinstance(value, dict) else {"result": value}

