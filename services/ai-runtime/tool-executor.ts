import { AgentConfig, ToolDefinition } from "./types";
import { URL } from "url";
import https from "https";

const TOOL_NAME_REGEX = /^[A-Za-z0-9_]{1,64}$/;

export interface IToolExecutor {
  bedrockToolConfig(agent: AgentConfig): any | null;
  execute(agent: AgentConfig, name: string, input: Record<string, any>): Promise<any>;
}

export class ToolExecutor implements IToolExecutor {
  bedrockToolConfig(agent: AgentConfig): any | null {
    if (!agent.tools || !Array.isArray(agent.tools)) return null;

    const specs: any[] = [];
    for (const tool of agent.tools) {
      if (!tool.enabled || (tool.type !== "api" && tool.type !== "mcp")) {
        continue;
      }
      if (!TOOL_NAME_REGEX.test(tool.name)) {
        continue;
      }

      specs.push({
        toolSpec: {
          name: tool.name,
          description: (tool.description || "Approved company tool").substring(0, 500),
          inputSchema: {
            json: tool.inputSchema || { type: "object", properties: {} },
          },
        },
      });
    }

    return specs.length > 0 ? { tools: specs } : null;
  }

  async execute(agent: AgentConfig, name: string, input: Record<string, any>): Promise<any> {
    if (!name || typeof name !== "string") {
      throw new Error("Invalid tool name");
    }

    // 1. Tool allowlist check against trusted agent configuration
    const tool = agent.tools?.find((t) => t.enabled && t.name === name);
    if (!tool) {
      throw new Error(`Tool '${name}' is not enabled for this agent`);
    }

    // 2. Input validation - reject prototype pollution and non-object inputs
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Tool input must be a valid JSON object");
    }
    for (const key of Object.keys(input)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error("Malicious prototype pollution key detected in tool arguments");
      }
    }

    // 3. Dispatch tool based on type
    if (tool.type === "api") {
      return await this.callApi(tool, input);
    } else if (tool.type === "mcp") {
      return await this.callMcp(tool, input);
    }

    throw new Error(`Unsupported tool type: ${tool.type}`);
  }

  private async callApi(tool: ToolDefinition, input: Record<string, any>): Promise<any> {
    const endpoint = this.validateHttpsUrl(tool.endpoint || "");
    const method = (tool.method || "POST").toUpperCase();
    if (!["POST", "PUT", "PATCH"].includes(method)) {
      throw new Error("Only POST, PUT, and PATCH API tools are supported");
    }

    const timeout = Math.max(2, Math.min(tool.timeoutSeconds || 12, 25)) * 1000;
    const bodyData = JSON.stringify({ input });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    // Return mock response for test mock endpoints or execute actual request
    if (endpoint.includes("mock.internal") || process.env.NODE_ENV === "test") {
      return {
        success: true,
        tool: tool.name,
        result: `Executed ${tool.name} with parameters: ${JSON.stringify(input)}`,
      };
    }

    return await this.httpJsonRequest(endpoint, method, headers, bodyData, timeout);
  }

  private async callMcp(tool: ToolDefinition, input: Record<string, any>): Promise<any> {
    const endpoint = this.validateHttpsUrl(tool.gatewayUrl || "");
    const targetTool = tool.targetToolName || tool.name;
    const payload = {
      jsonrpc: "2.0",
      id: "agent-tool-call",
      method: "tools/call",
      params: { name: targetTool, arguments: input },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };

    const timeout = Math.max(2, Math.min(tool.timeoutSeconds || 20, 25)) * 1000;
    const bodyData = JSON.stringify(payload);

    if (endpoint.includes("mock.internal") || process.env.NODE_ENV === "test") {
      return {
        tool: targetTool,
        result: `Executed MCP tool ${targetTool} with arguments: ${JSON.stringify(input)}`,
      };
    }

    return await this.httpJsonRequest(endpoint, "POST", headers, bodyData, timeout);
  }

  private validateHttpsUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Tool endpoint must be a valid URL");
    }

    if (parsed.protocol !== "https:") {
      throw new Error("Tool endpoint must use HTTPS protocol");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Tool endpoint must not contain embedded basic auth credentials");
    }
    return parsed.toString();
  }

  private httpJsonRequest(
    urlStr: string,
    method: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const req = https.request(
        url,
        {
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            if (data.length + chunk.length > 256000) {
              req.destroy();
              reject(new Error("Tool response exceeded maximum size limit of 256KB"));
              return;
            }
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Tool returned HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
              return;
            }
            try {
              const parsed = JSON.parse(data || "{}");
              if (parsed && parsed.jsonrpc === "2.0" && parsed.result !== undefined) {
                resolve(parsed.result);
              } else {
                resolve(parsed);
              }
            } catch {
              resolve({ raw: data });
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Tool request timed out after ${timeoutMs}ms`));
      });

      req.on("error", (err) => {
        reject(new Error(`Tool connection failed: ${err.message}`));
      });

      req.write(body);
      req.end();
    });
  }
}

export const toolExecutor = new ToolExecutor();
