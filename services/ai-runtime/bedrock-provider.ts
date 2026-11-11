import { AgentConfig } from "./types";
import { IToolExecutor } from "./tool-executor";

export interface ConverseResponse {
  text: string;
  toolEvents: Array<{ name: string; status: "success" | "error" }>;
  stopReason?: string;
}

export interface IBedrockRuntime {
  converse(
    agent: AgentConfig,
    systemPrompt: string,
    history: Array<{ role: "user" | "assistant"; text: string }>,
    userMessage: string,
    toolExecutor?: IToolExecutor
  ): Promise<ConverseResponse>;
}

/**
 * Real Amazon Bedrock Runtime Adapter using @aws-sdk/client-bedrock-runtime Converse API.
 */
export class AwsBedrockRuntimeAdapter implements IBedrockRuntime {
  private client: any;

  constructor() {
    // Lazily loaded to avoid hard initialization errors in test environments without AWS SDK config
  }

  private async getClient() {
    if (!this.client) {
      const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
      this.client = new BedrockRuntimeClient({
        region: process.env.AWS_REGION || "us-east-1",
      });
    }
    return this.client;
  }

  async converse(
    agent: AgentConfig,
    systemPrompt: string,
    history: Array<{ role: "user" | "assistant"; text: string }>,
    userMessage: string,
    toolExecutor?: IToolExecutor
  ): Promise<ConverseResponse> {
    const modelId = agent.modelId || process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-sonnet-20240229-v1:0";

    const messages: any[] = [];
    // Last 12 history turns for short-term memory
    for (const item of history.slice(-12)) {
      const role = item.role === "assistant" ? "assistant" : "user";
      const text = String(item.text || "").substring(0, 4000);
      if (text) {
        messages.push({
          role,
          content: [{ text }],
        });
      }
    }
    messages.push({
      role: "user",
      content: [{ text: userMessage.substring(0, 4000) }],
    });

    const request: any = {
      modelId,
      system: [{ text: systemPrompt }],
      messages,
      inferenceConfig: {
        maxTokens: Math.max(100, Math.min(Number(agent.maxTokens || 700), 4096)),
        temperature: Math.max(0.0, Math.min(Number(agent.temperature !== undefined ? agent.temperature : 0.2), 1.0)),
      },
    };

    const guardrailId = agent.guardrailIdentifier || process.env.GUARDRAIL_ID;
    if (guardrailId) {
      request.guardrailConfig = {
        guardrailIdentifier: guardrailId,
        guardrailVersion: agent.guardrailVersion || process.env.GUARDRAIL_VERSION || "DRAFT",
      };
    }

    const toolConfig = toolExecutor ? toolExecutor.bedrockToolConfig(agent) : null;
    if (toolConfig) {
      request.toolConfig = toolConfig;
    }

    const toolEvents: Array<{ name: string; status: "success" | "error" }> = [];

    try {
      const client = await this.getClient();
      const { ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");

      // Converse loop: up to 4 iterations (matches supervisor MVP)
      for (let turn = 0; turn < 4; turn++) {
        request.messages = messages;
        const response = await client.send(new ConverseCommand(request));

        const outputMessage = response.output?.message;
        const blocks = outputMessage?.content || [];

        if (response.stopReason !== "tool_use" || !toolExecutor) {
          const text = blocks
            .map((b: any) => b.text || "")
            .filter((t: string) => t.length > 0)
            .join("\n")
            .trim();
          return {
            text: text || "I’m sorry, I couldn’t produce a response. Please try again.",
            toolEvents,
            stopReason: response.stopReason,
          };
        }

        // Handle tool invocation turn
        messages.push(outputMessage);
        const results: any[] = [];

        for (const block of blocks) {
          const toolUse = block.toolUse;
          if (!toolUse) continue;

          const { name, toolUseId, input } = toolUse;
          try {
            const toolResult = await toolExecutor.execute(agent, name, input || {});
            results.push({
              toolResult: {
                toolUseId,
                content: [{ json: toolResult }],
              },
            });
            toolEvents.push({ name, status: "success" });
          } catch (exc: any) {
            results.push({
              toolResult: {
                toolUseId,
                status: "error",
                content: [{ text: `Tool failed: ${String(exc.message || exc).substring(0, 300)}` }],
              },
            });
            toolEvents.push({ name, status: "error" });
          }
        }

        if (results.length === 0) {
          break;
        }

        messages.push({
          role: "user",
          content: results,
        });
      }

      return {
        text: "I couldn’t complete that tool action safely. Please try again or request human assistance.",
        toolEvents,
        stopReason: "max_tool_iterations",
      };
    } catch (err: any) {
      const code = err.name || "BedrockError";
      const message = err.message || "Amazon Bedrock service is unavailable";
      throw new Error(`[Bedrock Invocation Failed - ${code}]: ${message}`);
    }
  }
}

/**
 * Deterministic Mock Bedrock Runtime Adapter for offline testing and local CI/CD.
 * Produces coherent multi-turn conversation replies without calling live AWS.
 */
export class DeterministicMockBedrockAdapter implements IBedrockRuntime {
  async converse(
    agent: AgentConfig,
    systemPrompt: string,
    history: Array<{ role: "user" | "assistant"; text: string }>,
    userMessage: string,
    toolExecutor?: IToolExecutor
  ): Promise<ConverseResponse> {
    const q = userMessage.toLowerCase();
    const toolEvents: Array<{ name: string; status: "success" | "error" }> = [];

    // Simulate tool execution if user asked for balance and agent has a tool
    if (q.includes("balance") && agent.tools && agent.tools.length > 0 && toolExecutor) {
      const balanceTool = agent.tools.find((t) => t.enabled && t.name.includes("balance"));
      if (balanceTool) {
        try {
          const res = await toolExecutor.execute(agent, balanceTool.name, { accountNumber: "SLT-9982-555" });
          toolEvents.push({ name: balanceTool.name, status: "success" });
          return {
            text: `[${agent.displayName}]: Your current balance is LKR 4,500.00 (Due: 2026-09-15). Retrieved using ${balanceTool.name}.`,
            toolEvents,
            stopReason: "end_turn",
          };
        } catch (err: any) {
          toolEvents.push({ name: balanceTool.name, status: "error" });
        }
      }
    }

    // Coherent replies based on intent
    let reply = "";
    if (q.includes("bill") || q.includes("payment") || q.includes("invoice") || q.includes("charged")) {
      reply = `[${agent.displayName} - Billing Specialist]: For billing inquiries, your account shows current active status. You can pay via online portal or direct debit.`;
    } else if (q.includes("router") || q.includes("internet") || q.includes("wifi") || q.includes("los") || q.includes("slow")) {
      reply = `[${agent.displayName} - Technical Specialist]: Please verify your router power LED. If the LOS indicator is blinking red, power-cycle the optical terminal for 30 seconds.`;
    } else if (q.includes("package") || q.includes("plan") || q.includes("price") || q.includes("upgrade")) {
      reply = `[${agent.displayName} - Sales Specialist]: We offer Fiber Unlimited 100Mbps at LKR 4,990/month and 4G Home Broadband at LKR 2,490/month.`;
    } else if (q.includes("lead") || q.includes("interested") || q.includes("contact me") || q.includes("buy")) {
      reply = `[${agent.displayName} - Lead Specialist]: We'd be glad to assist with your new connection! Please provide your preferred package and contact details.`;
    } else {
      reply = `[${agent.displayName}]: Thank you for reaching out to ${agent.brandName || "us"}. How can I assist you with your service today?`;
    }

    return {
      text: reply,
      toolEvents,
      stopReason: "end_turn",
    };
  }
}

/**
 * Bedrock Runtime Provider Factory.
 * Enforces strict fail-closed boundary in production: Mock adapter is forbidden in production!
 */
export function getBedrockRuntime(options?: { forceMock?: boolean }): IBedrockRuntime {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    if (options?.forceMock || process.env.BEDROCK_MOCK_MODE === "true") {
      throw new Error(
        "[Security Violation] DeterministicMockBedrockAdapter is strictly prohibited in production environment."
      );
    }
    return new AwsBedrockRuntimeAdapter();
  }

  // In test or local dev environment:
  if (options?.forceMock || process.env.BEDROCK_MOCK_MODE === "true" || !process.env.AWS_ACCESS_KEY_ID) {
    return new DeterministicMockBedrockAdapter();
  }

  return new AwsBedrockRuntimeAdapter();
}
