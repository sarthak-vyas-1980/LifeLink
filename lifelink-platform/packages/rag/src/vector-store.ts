import { fetchWithTimeout, getRagConfig } from "./config";
import type { KnowledgeSourceDefinition, KnowledgeSourceStatus, RetrievedKnowledgeChunk } from "./types";

export interface RagSourceRecord {
  id: string;
  source_key: string;
  title: string;
  source_type: string;
  relative_path: string;
  content_sha256: string;
  visibility_roles: string[];
  status: "PENDING" | "INDEXING" | "INDEXED" | "FAILED";
  chunk_count: number;
  indexed_at?: string | null;
  updated_at?: string;
}

export interface RagChunkRecord {
  id?: string;
  source_id: string;
  chunk_index: number;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export interface RagChunkSearchResult {
  id: string;
  source_key: string;
  title: string;
  source_type: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

function headers(extra: Record<string, string> = {}) {
  const config = getRagConfig();
  return {
    apikey: config.supabaseSecretKey,
    Authorization: `Bearer ${config.supabaseSecretKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function restUrl(tableOrFunction: string, query = "") {
  const config = getRagConfig();
  return `${config.supabaseUrl}/rest/v1/${tableOrFunction}${query ? `?${query}` : ""}`;
}

async function supabaseRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: headers(init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    // Avoid echoing request headers or environment values into logs/errors.
    throw new Error(`Supabase RAG store request failed (${response.status}): ${text.slice(0, 300)}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Supabase RAG store returned an unreadable response.");
  }
}

export async function getKnowledgeSource(sourceKey: string): Promise<RagSourceRecord | null> {
  const config = getRagConfig();
  const url = restUrl(
    config.sourceTable,
    `select=id,source_key,title,source_type,relative_path,content_sha256,visibility_roles,status,chunk_count,indexed_at,updated_at&source_key=eq.${encodeURIComponent(sourceKey)}&limit=1`,
  );
  const rows = await supabaseRequest<RagSourceRecord[]>(url, { method: "GET" });
  return rows[0] ?? null;
}

export async function upsertKnowledgeSource(
  definition: KnowledgeSourceDefinition,
  checksum: string,
  status: RagSourceRecord["status"],
  chunkCount = 0,
): Promise<RagSourceRecord> {
  const config = getRagConfig();
  const now = new Date().toISOString();
  const row = {
    source_key: definition.sourceKey,
    title: definition.title,
    source_type: definition.sourceType,
    relative_path: definition.relativePath,
    content_sha256: checksum,
    visibility_roles: definition.visibilityRoles,
    status,
    chunk_count: chunkCount,
    updated_at: now,
    indexed_at: status === "INDEXED" ? now : null,
  };
  const rows = await supabaseRequest<RagSourceRecord[]>(
    restUrl(config.sourceTable, "on_conflict=source_key"),
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    },
  );
  const source = rows[0];
  if (!source?.id) throw new Error(`Supabase did not return the source record for ${definition.sourceKey}.`);
  return source;
}

export async function upsertKnowledgeChunks(rows: RagChunkRecord[]): Promise<void> {
  if (!rows.length) return;
  const config = getRagConfig();
  const batchSize = 20;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    await supabaseRequest<unknown>(
      restUrl(config.chunkTable, "on_conflict=source_id,chunk_index"),
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(batch),
      },
    );
  }
}

export async function deleteChunksFromIndex(sourceId: string, firstIndex: number): Promise<void> {
  const config = getRagConfig();
  await supabaseRequest<unknown>(
    restUrl(config.chunkTable, `source_id=eq.${encodeURIComponent(sourceId)}&chunk_index=gte.${firstIndex}`),
    { method: "DELETE", headers: { Prefer: "return=minimal" } },
  );
}

export async function deleteKnowledgeChunks(sourceId: string): Promise<void> {
  const config = getRagConfig();
  await supabaseRequest<unknown>(
    restUrl(config.chunkTable, `source_id=eq.${encodeURIComponent(sourceId)}`),
    { method: "DELETE", headers: { Prefer: "return=minimal" } },
  );
}

export async function retrieveVectorMatches(
  queryEmbedding: number[],
  roles: string[],
  threshold?: number,
  limit?: number,
): Promise<RetrievedKnowledgeChunk[]> {
  const config = getRagConfig();
  const rows = await supabaseRequest<RagChunkSearchResult[]>(
    restUrl(`rpc/${config.matchFunction}`),
    {
      method: "POST",
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_threshold: threshold ?? config.similarityThreshold,
        match_count: limit ?? config.matchCount,
        allowed_roles: roles,
      }),
    },
  );
  return (rows ?? []).map((row) => ({
    id: row.id,
    sourceKey: row.source_key,
    title: row.title,
    sourceType: row.source_type,
    content: row.content,
    similarity: Number(row.similarity),
    metadata: row.metadata,
  }));
}

export async function listIndexedKnowledgeSources(role: string): Promise<KnowledgeSourceStatus[]> {
  const config = getRagConfig();
  const rows = await supabaseRequest<RagSourceRecord[]>(
    restUrl(
      config.sourceTable,
      "select=source_key,title,source_type,visibility_roles,status,chunk_count,indexed_at&status=eq.INDEXED&order=title.asc",
    ),
    { method: "GET" },
  );
  return (rows ?? [])
    .filter((row) => row.visibility_roles?.includes(role))
    .map((row) => ({
      sourceKey: row.source_key,
      title: row.title,
      sourceType: row.source_type,
      status: row.status,
      chunkCount: row.chunk_count,
      indexedAt: row.indexed_at,
    }));
}
