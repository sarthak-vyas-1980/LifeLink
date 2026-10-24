import { fetchWithTimeout, getRagConfig } from "./config";

interface GeminiEmbeddingResponse {
  embedding?: { values?: number[] };
  error?: { message?: string };
}

/**
 * Gemini Embedding 2 uses task prefixes for asymmetric retrieval.
 * For documents, pass text formatted as: "title: ... | text: ...".
 */
export async function createEmbedding(
  text: string,
  mode: "query" | "document" = "query",
): Promise<number[]> {
  const normalized = text.trim();
  if (!normalized) throw new Error("Cannot create an embedding for empty text.");

  const config = getRagConfig();
  const input = mode === "query"
    ? `task: question answering | query: ${normalized}`
    : normalized;
  const endpoint =
    `${config.geminiApiBaseUrl}/models/${encodeURIComponent(config.embeddingModel)}:embedContent`;

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.geminiApiKey,
    },
    body: JSON.stringify({
      model: `models/${config.embeddingModel}`,
      content: { parts: [{ text: input }] },
      output_dimensionality: config.embeddingDimensions,
    }),
  });

  const payload = await response.json().catch(() => ({})) as GeminiEmbeddingResponse;
  if (!response.ok) {
    throw new Error(`Gemini embedding request failed (${response.status}): ${payload.error?.message ?? "No error details returned."}`);
  }

  const values = payload.embedding?.values;
  if (!Array.isArray(values) || values.length !== config.embeddingDimensions ||
      values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("Gemini returned an embedding with an unexpected shape.");
  }
  return values;
}
