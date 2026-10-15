import os


class BedrockService:
    def __init__(self, bedrock_runtime, agent_runtime):
        self.bedrock = bedrock_runtime
        self.agent_runtime = agent_runtime

    def retrieve(self, agent: dict, query: str) -> tuple[str, list[dict]]:
        knowledge_base_id = agent.get("knowledgeBaseId") or os.environ.get("KNOWLEDGE_BASE_ID", "")
        if not knowledge_base_id:
            return "", []
        vector_config = {"numberOfResults": int(agent.get("retrievalResultCount", 5))}
        if agent.get("sharedKnowledgeBase"):
            vector_config["filter"] = {"equals": {"key": "tenant_id", "value": agent["tenantId"]}}
        response = self.agent_runtime.retrieve(
            knowledgeBaseId=knowledge_base_id,
            retrievalQuery={"text": query},
            retrievalConfiguration={"vectorSearchConfiguration": vector_config},
        )
        contexts, citations = [], []
        for index, result in enumerate(response.get("retrievalResults", []), start=1):
            text = (result.get("content") or {}).get("text", "").strip()
            if not text:
                continue
            contexts.append(f"[{index}] {text[:3500]}")
            location = result.get("location") or {}
            title = (result.get("metadata") or {}).get("title") or _location_title(location) or f"Reference {index}"
            citations.append({"title": str(title)[:160], "uri": _location_uri(location)})
        return "\n\n".join(contexts), citations

    def respond(self, agent: dict, system_prompt: str, history: list[dict], user_message: str, tool_executor=None) -> tuple[str, list[dict]]:
        model_id = agent.get("modelId") or os.environ["BEDROCK_MODEL_ID"]
        messages = []
        for item in history[-12:]:
            role = "assistant" if item.get("role") == "assistant" else "user"
            text = str(item.get("text", ""))[:4000]
            if text:
                messages.append({"role": role, "content": [{"text": text}]})
        messages.append({"role": "user", "content": [{"text": user_message}]})
        request = {
            "modelId": model_id,
            "system": [{"text": system_prompt}],
            "messages": messages,
            "inferenceConfig": {"maxTokens": int(agent.get("maxTokens", 700)), "temperature": float(agent.get("temperature", 0.2))},
        }
        guardrail_id = agent.get("guardrailIdentifier") or os.environ.get("GUARDRAIL_ID", "")
        if guardrail_id:
            request["guardrailConfig"] = {"guardrailIdentifier": guardrail_id,
                                          "guardrailVersion": agent.get("guardrailVersion") or os.environ.get("GUARDRAIL_VERSION", "DRAFT")}
        tool_config = tool_executor.bedrock_tool_config(agent) if tool_executor else None
        if tool_config:
            request["toolConfig"] = tool_config

        tool_events = []
        for _ in range(4):
            request["messages"] = messages
            response = self.bedrock.converse(**request)
            output_message = (response.get("output") or {}).get("message", {})
            blocks = output_message.get("content", [])
            if response.get("stopReason") != "tool_use" or not tool_executor:
                text = "\n".join(block.get("text", "") for block in blocks if block.get("text")).strip()
                return text or "I’m sorry, I couldn’t produce a response. Please try again.", tool_events

            messages.append(output_message)
            results = []
            for block in blocks:
                use = block.get("toolUse")
                if not use:
                    continue
                name, tool_use_id = use.get("name", ""), use.get("toolUseId", "")
                try:
                    value = tool_executor.execute(agent, name, use.get("input") or {})
                    results.append({"toolResult": {"toolUseId": tool_use_id, "content": [{"json": value}]}})
                    tool_events.append({"name": name, "status": "success"})
                except Exception as exc:
                    results.append({"toolResult": {"toolUseId": tool_use_id, "status": "error",
                                                    "content": [{"text": f"Tool failed: {str(exc)[:300]}"}]}})
                    tool_events.append({"name": name, "status": "error"})
            if not results:
                break
            messages.append({"role": "user", "content": results})
        return "I couldn’t complete that tool action safely. Please try again or request human assistance.", tool_events


def _location_uri(location: dict) -> str:
    for value in location.values():
        if isinstance(value, dict):
            return value.get("uri") or value.get("url") or ""
    return ""


def _location_title(location: dict) -> str:
    uri = _location_uri(location)
    return uri.rsplit("/", 1)[-1] if uri else ""
