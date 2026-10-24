import { fetchWithTimeout, getRagConfig } from "./config";

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

export async function generateGroundedText(systemInstruction: string, userPrompt: string): Promise<string> {
  const config = getRagConfig();
  const endpoint =
    `${config.geminiApiBaseUrl}/models/${encodeURIComponent(config.generationModel)}:generateContent`;

  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.geminiApiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 1200,
        responseMimeType: "text/plain",
      },
    }),
  }, 45_000);

  const payload = await response.json().catch(() => ({})) as GeminiGenerateResponse;
  if (!response.ok) {
    throw new Error(`Gemini generation request failed (${response.status}): ${payload.error?.message ?? "No error details returned."}`);
  }
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned an empty answer.");
  return text;
}
