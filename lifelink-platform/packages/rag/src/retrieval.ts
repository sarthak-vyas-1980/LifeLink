import { createEmbedding } from "./embeddings";
import { getRagConfig } from "./config";
import type { LifeLinkRole, RetrievedKnowledgeChunk } from "./types";
import { retrieveVectorMatches } from "./vector-store";

export async function retrieveRelevantChunks(
  query: string,
  role: LifeLinkRole,
): Promise<RetrievedKnowledgeChunk[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const config = getRagConfig();
  const queryEmbedding = await createEmbedding(normalized, "query");
  return retrieveVectorMatches(
    queryEmbedding,
    [role],
    config.similarityThreshold,
    config.matchCount,
  );
}

export async function listKnowledgeSourcesForRole(role: LifeLinkRole) {
  const { listIndexedKnowledgeSources } = await import("./vector-store");
  return listIndexedKnowledgeSources(role);
}
