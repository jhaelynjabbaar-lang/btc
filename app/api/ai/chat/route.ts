import { NextResponse } from "next/server";
import { z } from "zod";
import { getAiConfig } from "@/lib/ai/config";
import { aiAccessAllowed } from "@/lib/ai/guard";
import { AiError, chatCompletion } from "@/lib/ai/openrouter";
import { SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { checkRateLimit, clientIp } from "@/lib/ai/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 32_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TOTAL_CHARS = 12_000;

const inputSchema = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
        }),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .refine((v) => v.messages.reduce((n, m) => n + m.content.length, 0) <= MAX_TOTAL_CHARS, {
    message: `Total message length must be <= ${MAX_TOTAL_CHARS} characters.`,
  })
  .refine((v) => v.messages[v.messages.length - 1].role === "user", {
    message: "The last message must be from the user.",
  });

const outputSchema = z.object({
  summary: z.string(),
  claims: z
    .array(
      z.object({
        text: z.string(),
        label: z.enum(["VERIFIED", "SPECULATION"]),
        sources: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  refused: z.boolean().default(false),
  followUps: z.array(z.string()).default([]),
});

/** Pull a JSON object out of a model reply (tolerates code fences / stray prose). */
function parseModelJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

function err(status: number, error: string, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ error, message }, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** POST /api/ai/chat  { messages: [{role, content}, ...] } */
export async function POST(request: Request) {
  if (!aiAccessAllowed(request)) {
    return err(503, "disabled", "AI chat is disabled for this host until authentication is built.");
  }
  if (!getAiConfig().configured) {
    return err(503, "not_configured", "The AI provider is not configured on this deployment.");
  }

  const rl = checkRateLimit(`chat:${clientIp(request)}`);
  if (!rl.ok) {
    return err(429, "rate_limited", "Too many requests. Slow down.", { "retry-after": String(rl.retryAfterSec) });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return err(413, "too_large", "Request body too large.");
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) return err(413, "too_large", "Request body too large.");

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return err(400, "invalid_json", "Body must be valid JSON.");
  }
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "Invalid request.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const result = await chatCompletion({
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...parsed.data.messages],
      maxTokens: 6000, // Nemotron is a reasoning model: reasoning tokens count against this budget
      temperature: 0.2,
      timeoutMs: 55_000,
    });

    const structured = outputSchema.safeParse(parseModelJson(result.content));
    return NextResponse.json(
      {
        model: result.model,
        structured: structured.success,
        // If the model did not return valid JSON, fall back to its raw text rather than failing.
        answer: structured.success
          ? structured.data
          : { summary: result.content, claims: [], refused: false, followUps: [] },
        usage: result.usage,
        finishReason: result.finishReason,
        notice:
          "Model output. Source citations are provided by the model, are not machine-verified, and may be wrong. Check them before relying on them.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof AiError) return err(e.httpStatus, e.code, e.message);
    return err(500, "internal_error", "Unexpected error.");
  }
}
