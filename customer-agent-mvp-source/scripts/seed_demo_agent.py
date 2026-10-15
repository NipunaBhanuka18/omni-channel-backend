#!/usr/bin/env python3
import argparse
import boto3


def main():
    parser = argparse.ArgumentParser(description="Seed the public demo agent")
    parser.add_argument("--region", required=True)
    parser.add_argument("--mappings-table", required=True)
    parser.add_argument("--agents-table", required=True)
    parser.add_argument("--model-id", default="amazon.nova-lite-v1:0")
    parser.add_argument("--knowledge-base-id", default="")
    args = parser.parse_args()

    dynamodb = boto3.resource("dynamodb", region_name=args.region)
    tenant_id, agent_id, public_key = "tenant-demo", "agent-customer-care", "demo-support"
    dynamodb.Table(args.mappings_table).put_item(Item={
        "publicAgentKey": public_key, "tenantId": tenant_id, "agentId": agent_id, "status": "PUBLISHED"
    })
    dynamodb.Table(args.agents_table).put_item(Item={
        "tenantId": tenant_id, "agentId": agent_id, "publicAgentKey": public_key, "status": "PUBLISHED",
        "displayName": "Connect AI Assistant", "brandName": "Connect AI",
        "welcomeMessage": "Hi! I’m your AI assistant. How can I help you today?",
        "handoffMessage": "Of course. I’ve recorded your request to speak with a person.",
        "suggestedPrompts": ["Explore packages", "Check my bill", "Get technical help", "Talk to a person"],
        "theme": {"primary": "#075fc6", "accent": "#06a96b"},
        "systemPrompt": "Help customers using approved company information. Ask concise follow-up questions and never invent product details.",
        "modelId": args.model_id, "knowledgeBaseId": args.knowledge_base_id,
        "enabledSubAgents": ["general", "sales", "billing", "technical", "lead"],
        "temperature": 0.2, "maxTokens": 700,
        "forms": [{
            "formId": "sales_interest", "title": "Tell us what you need",
            "description": "Only the essentials—we’ll use these details to assist you.", "submitLabel": "Submit details",
            "confirmationMessage": "Thank you. Your request has been recorded for follow-up.",
            "fields": [
                {"name": "name", "label": "Your name", "type": "text", "required": True, "maxLength": 100},
                {"name": "contact", "label": "Mobile or email", "type": "text", "required": True, "maxLength": 120},
                {"name": "need", "label": "What do you need?", "type": "text", "required": True, "maxLength": 240},
            ],
        }],
    })
    print(f"Seeded https://YOUR_CHAT_DOMAIN/chat.html?agent={public_key}")


if __name__ == "__main__":
    main()
