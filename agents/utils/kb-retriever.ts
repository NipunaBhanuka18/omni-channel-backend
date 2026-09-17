import { fetchKbDocument } from "./s3-client";

/**
 * Mock Vector Index / RAG Retriever.
 * In production, this would convert the query into an embedding and query a Vector DB (like OpenSearch).
 * For local development, we fetch the doc and do a simple keyword match.
 */
export const searchKnowledgeBase = async (query: string): Promise<string> => {
  try {
    const fullDocument = await fetchKbDocument(
      "router-troubleshooting-guide.txt",
    );

    // Split the document into sections based on the "Issue:" keyword
    const sections = fullDocument
      .split("Issue:")
      .filter((s) => s.trim().length > 0);

    // Very basic keyword matcher (simulating vector similarity search)
    const queryLower = query.toLowerCase();
    let bestMatch = sections[0]; // default to first section

    for (const section of sections) {
      if (section.toLowerCase().includes(queryLower)) {
        bestMatch = section;
        break; // Found a match, stop looking
      }
    }

    // If no exact match, just return the whole doc (or in a real app, the top N chunks)
    if (!bestMatch) bestMatch = fullDocument;

    return `Issue: ${bestMatch.trim()}`;
  } catch (error) {
    console.error("[KB Retriever] Search failed:", error);
    throw new Error("Failed to search knowledge base.");
  }
};
