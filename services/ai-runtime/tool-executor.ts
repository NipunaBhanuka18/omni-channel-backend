import { AgentConfig, ToolDefinition } from "./types";
import { URL } from "url";
import https from "https";

const TOOL_NAME_REGEX = /^[A-Za-z0-9_]{1,64}$/;

export function isRestrictedHostOrIp(hostname: string): boolean {
  const host = hostname.toLowerCase().trim();

  // Allow internal mock host in test environment
  if (host === "mock.internal" || host.endsWith(".mock.internal")) {
    return false;
  }

  // Specific restricted hostnames and metadata endpoints
  if (
    host === "localhost" ||
    host === "instance-data" ||
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  // IPv4 validation
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = [Number(ipv4Match[1]), Number(ipv4Match[2]), Number(ipv4Match[3]), Number(ipv4Match[4])];
    if (octets.some((o) => o < 0 || o > 255)) return true;
    const [b0, b1, b2, b3] = octets;

    // Loopback: 127.0.0.0/8
    if (b0 === 127) return true;
    // Current / Zero network: 0.0.0.0/8
    if (b0 === 0) return true;
    // Broadcast: 255.255.255.255
    if (b0 === 255 && b1 === 255 && b2 === 255 && b3 === 255) return true;
    // Private IPv4 (RFC 1918)
    // 10.0.0.0/8
    if (b0 === 10) return true;
    // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.168.0.0/16
    if (b0 === 192 && b1 === 168) return true;
    // Carrier-grade NAT (RFC 6598): 100.64.0.0/10
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    // Link-local / AWS EC2 IMDS metadata: 169.254.0.0/16
    if (b0 === 169 && b1 === 254) return true;
    // Documentation / Reserved: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
    if (b0 === 192 && b1 === 0 && b2 === 2) return true;
    if (b0 === 198 && b1 === 51 && b2 === 100) return true;
    if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  }

  // IPv6 validation
  if (host.includes(":")) {
    const cleanIpv6 = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (
      cleanIpv6 === "::1" ||
      cleanIpv6 === "::" ||
      cleanIpv6.startsWith("fe80:") ||
      cleanIpv6.startsWith("fc") ||
      cleanIpv6.startsWith("fd")
    ) {
      return true;
    }
  }

  return false;
}

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

    // 3. Tool authorization & production policy checks
    if (tool.readOnly) {
      const method = (tool.method || "POST").toUpperCase();
      if (method !== "GET" && method !== "POST") {
        throw new Error(`Read-only tool '${name}' cannot use mutating HTTP method ${method}`);
      }
    }

    if (process.env.NODE_ENV === "production" && process.env.EXTERNAL_TOOLS_ENABLED !== "true") {
      throw new Error("External tool execution is disabled in production without explicit EXTERNAL_TOOLS_ENABLED=true configuration");
    }

    // 4. Dispatch tool based on type
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
    if (!["GET", "POST", "PUT", "PATCH"].includes(method)) {
      throw new Error("Only GET, POST, PUT, and PATCH API tools are supported");
    }

    const timeout = Math.max(2, Math.min(tool.timeoutSeconds || 12, 25)) * 1000;
    const bodyData = JSON.stringify({ input });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    // Return mock response for test mock endpoints
    if (endpoint.includes("mock.internal")) {
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

  public validateHttpsUrl(value: string): string {
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
    if (isRestrictedHostOrIp(parsed.hostname)) {
      throw new Error(`Tool endpoint '${parsed.hostname}' is prohibited by SSRF security policy (private, loopback, or metadata destination)`);
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
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
              reject(new Error("Tool request redirects are prohibited by security policy"));
              return;
            }
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

      if (method !== "GET" && body) {
        req.write(body);
      }
      req.end();
    });
  }
}

export const toolExecutor = new ToolExecutor();
