import "server-only";

/**
 * AI provider configuration. Provider: OpenRouter (OpenAI-compatible), model: NVIDIA Nemotron 3 Ultra.
 * Everything here is read on the server only. Nothing in this folder may be imported from a client
 * component, and no variable below may ever carry a NEXT_PUBLIC_ prefix.
 */

/** Exact OpenRouter id for NVIDIA Nemotron 3 Ultra (paid endpoint, 262k context). */
export const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export function getAiConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  return {
    apiKey,
    configured: apiKey !== null,
    model: process.env.AI_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
  };
}
