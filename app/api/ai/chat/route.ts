import { NextResponse } from "next/server";
import { z } from "zod";
import { getAiConfig } from "@/lib/ai/config";
import { gateRoute } from "@/lib/auth/access";
import { getDb } from "@/lib/db/client";
import { saveResearch } from "@/lib/db/repo";
import { AiError } from "@/lib/ai/openrouter";
import { checkRateLimit, clientIp } from "@/lib/ai/rate-limit";
import { runResearch } from "@/lib/ai/research";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
    /** "chat" = grounded Q&A; "report" = detailed sectioned report. */
    mode: z.enum(["chat", "report"]).default("chat"),
    /** Optional CVE/GHSA id to force into the retrieved context (used by "Explain impact & remediation"). */
    focus: z
      .string()
      .trim()
      .regex(/^(CVE-\d{4}-\d{4,}|GHSA(-[a-z0-9]{4}){3})$/i)
      .optional(),
  })
  .strict()
  .refine((v) => v.messages.reduce((n, m) => n + m.content.length, 0) <= MAX_TOTAL_CHARS, {
    message: `Total message length must be <= ${MAX_TOTAL_CHARS} characters.`,
  })
  .refine((v) => v.messages[v.messages.length - 1].role === "user", {
    message: "The last message must be from the user.",
  });

function err(status: number, error: string, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ error, message }, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** POST /api/ai/chat  { messages, mode?, focus? } -> grounded research answer or report */
export async function POST(request: Request) {
  const gate = await gateRoute(request);
  if (gate.response) return gate.response;
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
      {
        error: "invalid_input",
        message: "Invalid request.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const result = await runResearch({
      messages: parsed.data.messages,
      mode: parsed.data.mode,
      focusId: parsed.data.focus,
    });

    // Persist when a database is configured. A storage failure never fails the answer.
    let persistence: "saved" | "not_configured" | "failed" = "not_configured";
    let savedId: string | null = null;
    const db = getDb();
    if (db) {
      try {
        const lastUser = [...parsed.data.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        savedId = await saveResearch(db, {
          userLogin: gate.actor.login,
          question: lastUser,
          mode: result.mode,
          title: result.report?.title ?? null,
          summary: result.answer.summary,
          claims: result.answer.claims,
          sources: result.retrieval.sources,
          markdown: result.report?.markdown ?? null,
          model: result.model,
          meta: {
            followUps: result.answer.followUps,
            refused: result.answer.refused,
            errors: result.retrieval.errors,
            retrievedAt: result.retrieval.retrievedAt,
            stats: result.stats,
            usage: result.usage,
            structured: result.structured,
          },
        });
        persistence = "saved";
      } catch {
        persistence = "failed";
      }
    }
    return NextResponse.json({ ...result, persistence, savedId }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof AiError) return err(e.httpStatus, e.code, e.message);
    return err(500, "internal_error", "Unexpected error.");
  }
}
