import "server-only";
import { getAiConfig } from "./config";

export type AiErrorCode =
  | "not_configured"
  | "provider_auth"
  | "provider_credits"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "bad_response";

/** Safe, client-presentable error. Never carries provider response bodies or credentials. */
export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    public httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

const MESSAGES: Record<AiErrorCode, string> = {
  not_configured: "The AI provider is not configured on this deployment.",
  provider_auth: "The AI provider rejected the server's credentials.",
  provider_credits: "The AI provider account has no remaining credit or quota.",
  provider_rate_limited: "The AI provider is rate limiting requests. Try again shortly.",
  provider_unavailable: "The AI provider is currently unavailable.",
  timeout: "The AI provider did not answer in time.",
  bad_response: "The AI provider returned an unexpected response.",
};

function mapStatus(status: number): AiError {
  if (status === 401 || status === 403) return new AiError("provider_auth", 502, MESSAGES.provider_auth);
  if (status === 402) return new AiError("provider_credits", 502, MESSAGES.provider_credits);
  if (status === 429) return new AiError("provider_rate_limited", 429, MESSAGES.provider_rate_limited);
  return new AiError("provider_unavailable", 502, MESSAGES.provider_unavailable);
}

async function call(path: string, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const { apiKey, baseUrl } = getAiConfig();
  if (!apiKey) throw new AiError("not_configured", 503, MESSAGES.not_configured);
  const { timeoutMs, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...rest,
      headers: {
        ...(rest.headers as Record<string, string> | undefined),
        authorization: `Bearer ${apiKey}`,
        "x-title": "BTC Security Intelligence",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new AiError("timeout", 504, MESSAGES.timeout);
    }
    throw new AiError("provider_unavailable", 502, MESSAGES.provider_unavailable);
  }
  if (!res.ok) throw mapStatus(res.status);
  return res;
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatResult = {
  content: string;
  model: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
};

/** One OpenAI-compatible chat completion. Server-side only. */
export async function chatCompletion(opts: {
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<ChatResult> {
  const { model } = getAiConfig();
  const res = await call("/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    timeoutMs: opts.timeoutMs ?? 50_000,
    body: JSON.stringify({
      model,
      messages: opts.messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.2,
      // Ask routed providers not to retain/train on prompts.
      provider: { data_collection: "deny" },
    }),
  });

  let json: {
    model?: string;
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  try {
    json = await res.json();
  } catch {
    throw new AiError("bad_response", 502, MESSAGES.bad_response);
  }
  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new AiError("bad_response", 502, MESSAGES.bad_response);
  }
  return {
    content,
    model: json.model ?? model,
    finishReason: choice?.finish_reason ?? null,
    usage: json.usage
      ? {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
          totalTokens: json.usage.total_tokens ?? 0,
        }
      : null,
  };
}

/** Free credential check: GET /key. Returns true if OpenRouter accepts the server's key. */
export async function checkKey(): Promise<boolean> {
  try {
    await call("/key", { method: "GET", next: { revalidate: 300 }, timeoutMs: 6000 });
    return true;
  } catch (err) {
    if (err instanceof AiError && (err.code === "provider_auth" || err.code === "not_configured")) return false;
    throw err;
  }
}

/** Free model check: does OpenRouter list live endpoints for the configured model? */
export async function checkModelListed(): Promise<boolean> {
  const { model } = getAiConfig();
  try {
    const res = await call(`/models/${model}/endpoints`, { method: "GET", next: { revalidate: 300 }, timeoutMs: 6000 });
    const json = (await res.json()) as { data?: { endpoints?: unknown[] } };
    return Array.isArray(json.data?.endpoints) && json.data.endpoints.length > 0;
  } catch (err) {
    if (err instanceof AiError && err.code === "provider_unavailable") return false; // 404 etc.
    throw err;
  }
}
