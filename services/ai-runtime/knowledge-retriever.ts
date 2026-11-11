import { AgentConfig } from "./types";
import { searchKnowledgeBase } from "../../agents/utils/kb-retriever";

export interface KnowledgeRetrievalResult {
  context: string;
  citations: Array<{ title: string; uri: string }>;
}

export class KnowledgeRetriever {
  /**
   * Retrieves knowledge scoped strictly to the authenticated tenant.
   * Enforces explicit empty-KB behavior when no KB is configured or when the tenant has no documents.
   */
  async retrieve(agent: AgentConfig, query: string): Promise<KnowledgeRetrievalResult> {
    if (!agent || !agent.tenantId) {
      throw new Error("[Knowledge Isolation] Cannot retrieve knowledge without authenticated tenant context.");
    }

    const cleanQuery = String(query || "").trim();
    if (!cleanQuery) {
      return { context: "", citations: [] };
    }

    // 1. Bedrock Knowledge Base configuration check
    // If agent has no knowledge base configured, enforce explicit empty KB behavior
    const kbId = agent.knowledgeBaseId;
    if (!kbId) {
      return { context: "", citations: [] };
    }

    if (process.env.BEDROCK_AGENT_RUNTIME_ENABLED === "true") {
      return await this.retrieveFromBedrockAgentRuntime(agent, kbId, cleanQuery);
    }

    // Local / offline mode: check for tenant-scoped simulated knowledge
    const simulated = this.simulateTenantKnowledge(agent, cleanQuery);
    if (simulated.context) {
      return simulated;
    }

    // 2. S3 Document-based fallback (if tenant has uploaded guides into tenants/{tenantId}/)
    try {
      const mockTenantContext = {
        tenantId: agent.tenantId,
        sessionId: `kb-query-${Date.now()}`,
        userId: "customer",
        channel: "web" as const,
        role: "staff" as const,
        permissions: ["read:kb"],
        conversationId: `conv-${agent.tenantId}`,
      };

      const docMatch = await searchKnowledgeBase(cleanQuery, mockTenantContext);
      if (docMatch && docMatch.length > 0 && !docMatch.includes("Issue: undefined")) {
        return {
          context: `[1] ${docMatch.substring(0, 3500)}`,
          citations: [
            {
              title: `${agent.displayName || "Company"} Knowledge Guide`,
              uri: `s3://omni-channel-kb/tenants/${agent.tenantId}/router-troubleshooting-guide.txt`,
            },
          ],
        };
      }
    } catch {
      // If S3 fetch fails or is offline, do NOT leak other tenant data. Return empty!
    }

    // Explicit empty KB: no matching knowledge for this tenant
    return { context: "", citations: [] };
  }

  private async retrieveFromBedrockAgentRuntime(
    agent: AgentConfig,
    kbId: string,
    query: string
  ): Promise<KnowledgeRetrievalResult> {
    try {
      const { BedrockAgentRuntimeClient, RetrieveCommand } = await import(
        "@aws-sdk/client-bedrock-agent-runtime"
      );
      const client = new BedrockAgentRuntimeClient({
        region: process.env.AWS_REGION || "us-east-1",
      });

      const vectorConfig: any = {
        numberOfResults: Number(agent.retrievalResultCount || 5),
      };

      // Tenant isolation: if shared knowledge base, filter strictly on tenant_id
      if (agent.sharedKnowledgeBase) {
        vectorConfig.filter = {
          equals: { key: "tenant_id", value: agent.tenantId },
        };
      }

      const response = await client.send(
        new RetrieveCommand({
          knowledgeBaseId: kbId,
          retrievalQuery: { text: query },
          retrievalConfiguration: {
            vectorSearchConfiguration: vectorConfig,
          },
        })
      );

      const contexts: string[] = [];
      const citations: Array<{ title: string; uri: string }> = [];

      let index = 1;
      for (const result of response.retrievalResults || []) {
        const text = result.content?.text?.trim();
        if (!text) continue;

        contexts.push(`[${index}] ${text.substring(0, 3500)}`);
        const location: any = result.location || {};
        const uri = location.s3Location?.uri || location.webLocation?.url || "";
        const title =
          (result.metadata as any)?.title ||
          (uri ? uri.split("/").pop() : `Reference ${index}`) ||
          `Reference ${index}`;

        citations.push({
          title: String(title).substring(0, 160),
          uri: String(uri),
        });
        index++;
      }

      return {
        context: contexts.join("\n\n"),
        citations,
      };
    } catch (err: any) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(`Bedrock Knowledge Base retrieval failed: ${err.message}`);
      }
      return { context: "", citations: [] };
    }
  }

  private simulateTenantKnowledge(agent: AgentConfig, query: string): KnowledgeRetrievalResult {
    const q = query.toLowerCase();
    if (q.includes("router") || q.includes("internet") || q.includes("wifi") || q.includes("slow") || q.includes("los")) {
      return {
        context: `[1] [Tenant: ${agent.tenantId}] Router self-troubleshooting: Verify that power LED is solid green. For optical red LOS light, inspect fiber connector without bending cable sharply, and restart the terminal.`,
        citations: [
          {
            title: "Fiber Router Troubleshooting Guide",
            uri: `s3://omni-channel-kb/tenants/${agent.tenantId}/fiber-router-guide.pdf`,
          },
        ],
      };
    } else if (q.includes("package") || q.includes("plan") || q.includes("pricing") || q.includes("offer")) {
      return {
        context: `[1] [Tenant: ${agent.tenantId}] Packages and Plans: Fiber Unlimited 100Mbps at LKR 4,990/mo with free installation. 4G Home Broadband at LKR 2,490/mo for 100GB.`,
        citations: [
          {
            title: "Broadband Packages 2026",
            uri: `s3://omni-channel-kb/tenants/${agent.tenantId}/broadband-packages.pdf`,
          },
        ],
      };
    }

    return { context: "", citations: [] };
  }
}

export const knowledgeRetriever = new KnowledgeRetriever();
