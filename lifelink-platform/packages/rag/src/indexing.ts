import { createEmbedding } from "./embeddings";
import { getRagConfig } from "./config";
import { buildChunkInputs, findProjectRoot, loadApprovedKnowledgeSources, type LoadedKnowledgeSource } from "./knowledge-sources";
import type { KnowledgeSourceDefinition } from "./types";
import {
  deleteChunksFromIndex,
  getKnowledgeSource,
  upsertKnowledgeChunks,
  upsertKnowledgeSource,
  type RagChunkRecord,
} from "./vector-store";

async function embedWithSmallConcurrency<T, R>(
  input: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(input.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(concurrency, input.length));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= input.length) return;
      output[index] = await worker(input[index], index);
    }
  }));
  return output;
}

export async function indexKnowledgeSource(source: LoadedKnowledgeSource) {
  const chunks = buildChunkInputs(source);
  if (!chunks.length) throw new Error(`No usable text chunks were generated for ${source.definition.sourceKey}.`);

  const record = await upsertKnowledgeSource(source.definition, source.checksum, "INDEXING", chunks.length);
  try {
    const config = getRagConfig();
    const rows = await embedWithSmallConcurrency(chunks, 2, async (chunk): Promise<RagChunkRecord> => {
      const embeddingText = `title: ${chunk.title} | text: ${chunk.content}`;
      const embedding = await createEmbedding(embeddingText, "document");
      if (embedding.length !== config.embeddingDimensions) {
        throw new Error(`Embedding dimensions changed while indexing ${chunk.sourceKey}.`);
      }
      return {
        source_id: record.id,
        chunk_index: chunk.chunkIndex,
        content: chunk.content,
        embedding,
        metadata: {
          sourceKey: chunk.sourceKey,
          title: chunk.title,
          sourceType: chunk.sourceType,
          relativePath: chunk.relativePath,
          heading: chunk.heading ?? null,
          pageNumbers: chunk.pageNumbers ?? null,
          version: chunk.version,
        },
      };
    });

    await upsertKnowledgeChunks(rows);
    await deleteChunksFromIndex(record.id, rows.length);
    const indexed = await upsertKnowledgeSource(source.definition, source.checksum, "INDEXED", rows.length);
    return {
      sourceKey: indexed.source_key,
      status: indexed.status,
      chunkCount: indexed.chunk_count,
      checksum: indexed.content_sha256,
      indexedAt: indexed.indexed_at,
    };
  } catch (error) {
    try {
      await upsertKnowledgeSource(source.definition, source.checksum, "FAILED", 0);
    } catch {
      // Preserve the original indexing error; status-update failure is secondary.
    }
    throw error;
  }
}

export function isKnowledgeSourceUnchanged(
  existing: { content_sha256: string; status: string } | null,
  checksum: string,
): boolean {
  return existing?.content_sha256 === checksum && existing.status === "INDEXED";
}

export async function queueKnowledgeSourceProcessing(sourceKey?: string) {
  const sources = await loadApprovedKnowledgeSources(findProjectRoot());
  const selected = sourceKey
    ? sources.filter((source) => source.definition.sourceKey === sourceKey)
    : sources;
  if (sourceKey && selected.length === 0) {
    throw new Error("The requested source is not in the approved source allow-list.");
  }

  const results = [];
  for (const source of selected) {
    const existing = await getKnowledgeSource(source.definition.sourceKey);
    if (existing && isKnowledgeSourceUnchanged(existing, source.checksum)) {
      results.push({
        sourceKey: source.definition.sourceKey,
        status: "UNCHANGED",
        chunkCount: existing.chunk_count,
        checksum: existing.content_sha256,
      });
      continue;
    }
    results.push(await indexKnowledgeSource(source));
  }
  return results;
}

export async function listApprovedSourceDefinitions(): Promise<Array<{
  sourceKey: string;
  title: string;
  sourceType: string;
  description: string;
  visibilityRoles: string[];
}>> {
  const sources = await loadApprovedKnowledgeSources(findProjectRoot());
  return sources.map(({ definition }) => ({
    sourceKey: definition.sourceKey,
    title: definition.title,
    sourceType: definition.sourceType,
    description: definition.description,
    visibilityRoles: definition.visibilityRoles,
  }));
}

export type { KnowledgeSourceDefinition };
