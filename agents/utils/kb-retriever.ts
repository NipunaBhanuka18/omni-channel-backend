import { fetchKbDocument } from "./s3-client";
import { TenantContext } from "../../shared/types/tenant-context";

export const searchKnowledgeBase = async (
  query: string,
  context: TenantContext,
  documentName: string = "router-troubleshooting-guide.txt"
): Promise<string> => {
  try {
    if (!context || !context.tenantId) {
      throw new Error(
        "[KB Isolation Violation] Attempted to query Knowledge Base without an authenticated TenantContext."
      );
    }

    // Pass 'context' first, then 'documentName' into fetchKbDocument
    const fullDocument = await fetchKbDocument(context, documentName);

    const sections = fullDocument
      .split("Issue:")
      .filter((s) => s.trim().length > 0);

    const queryLower = query.toLowerCase();
    let bestMatch: string | null = null;

    for (const section of sections) {
      if (section.toLowerCase().includes(queryLower)) {
        bestMatch = section;
        break;
      }
    }

    if (!bestMatch) {
      bestMatch = sections[0] || fullDocument;
    }

    return `[Tenant: ${context.tenantId}] Issue: ${bestMatch.trim()}`;
  } catch (error) {
    console.error(
      `[KB Retriever Error] Search failed for Tenant '${context?.tenantId}':`,
      error
    );
    throw new Error(
      `Failed to search knowledge base for tenant scope: ${(error as Error).message}`
    );
  }
};