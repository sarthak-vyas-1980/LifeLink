export interface RagConfig {
  geminiApiKey: string;
  geminiApiBaseUrl: string;
  embeddingModel: string;
  generationModel: string;
  embeddingDimensions: number;
  supabaseUrl: string;
  supabaseSecretKey: string;
  sourceTable: string;
  chunkTable: string;
  matchFunction: string;
  matchCount: number;
  similarityThreshold: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured. Set it in the server-side .env file.`);
  }
  return value;
}

function boundedNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }
  return parsed;
}

function safeSqlIdentifier(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`${name} must be a simple SQL identifier.`);
  }
  return value;
}

export function getRagConfig(): RagConfig {
  const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(supabaseUrl)) {
    throw new Error("SUPABASE_URL must be the HTTPS URL of your Supabase project.");
  }
  const dimensions = boundedNumber("RAG_EMBEDDING_DIMENSIONS", 768, 128, 3072);
  if (dimensions !== 768) {
    throw new Error("RAG_EMBEDDING_DIMENSIONS must be 768 for the supplied Supabase vector schema. Change the SQL vector column and index together before changing this value.");
  }

  return {
    geminiApiKey: required("GEMINI_API_KEY"),
    geminiApiBaseUrl: process.env.GEMINI_API_BASE_URL?.replace(/\/+$/, "")
      || "https://generativelanguage.googleapis.com/v1beta",
    embeddingModel: process.env.RAG_EMBEDDING_MODEL?.trim() || "gemini-embedding-2",
    generationModel: process.env.RAG_GENERATION_MODEL?.trim() || "gemini-3.1-flash-lite",
    embeddingDimensions: dimensions,
    supabaseUrl,
    supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
    sourceTable: safeSqlIdentifier("RAG_SOURCE_TABLE", "lifelink_rag_sources"),
    chunkTable: safeSqlIdentifier("RAG_CHUNK_TABLE", "lifelink_rag_chunks"),
    matchFunction: safeSqlIdentifier("RAG_MATCH_FUNCTION", "match_lifelink_rag_chunks"),
    matchCount: boundedNumber("RAG_MATCH_COUNT", 6, 1, 12),
    similarityThreshold: boundedNumber("RAG_SIMILARITY_THRESHOLD", 0.34, 0, 1),
  };
}

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
