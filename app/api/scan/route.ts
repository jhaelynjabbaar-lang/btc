import { NextResponse } from "next/server";
import { z } from "zod";
import { getAiConfig } from "@/lib/ai/config";
import { aiAccessAllowed } from "@/lib/ai/guard";
import { AiError } from "@/lib/ai/openrouter";
import { checkRateLimit, clientIp } from "@/lib/ai/rate-limit";
import { runScan } from "@/lib/ai/scan";
import { MAX_CODE_BYTES } from "@/lib/scan/limits";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const MAX_LINES = 3000;

const schema = z
  .object({
    code: z.string().min(1).max(MAX_CODE_BYTES),
    filename: z
      .string()
      .trim()
      .max(120)
      .regex(/^[\w .@()+\-/]*$/, "Unsupported characters in filename")
      .optional(),
    authorized: z.literal(true, { message: "You must confirm you are authorized to analyze this code." }),
  })
  .strict()
  .refine((v) => Buffer.byteLength(v.code, "utf8") <= MAX_CODE_BYTES, { message: "Code exceeds 100 KB.", path: ["code"] })
  .refine((v) => !v.code.includes("\u0000"), { message: "Binary content is not supported.", path: ["code"] })
  .refine((v) => v.code.split("\n").length <= MAX_LINES, { message: `Code exceeds ${MAX_LINES} lines.`, path: ["code"] });

function err(status: number, error: string, message: string, headers?: Record<string, string>) {
  return NextResponse.json({ error, message }, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** POST /api/scan { code, filename?, authorized: true } — static, text-only analysis. Never executes code. */
export async function POST(request: Request) {
  if (!aiAccessAllowed(request)) {
    return err(503, "disabled", "The code scanner is disabled for this host until authentication is built.");
  }
  if (!getAiConfig().configured) {
    return err(503, "not_configured", "The AI provider is not configured on this deployment.");
  }
  const rl = checkRateLimit(`scan:${clientIp(request)}`);
  if (!rl.ok) {
    return err(429, "rate_limited", "Too many requests. Slow down.", { "retry-after": String(rl.retryAfterSec) });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_CODE_BYTES * 2 + 2000) return err(413, "too_large", "Request body too large.");
  const rawBody = await request.text();
  if (rawBody.length > MAX_CODE_BYTES * 2 + 2000) return err(413, "too_large", "Request body too large.");

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return err(400, "invalid_json", "Body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_input",
        message: parsed.error.issues[0]?.message ?? "Invalid request.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const result = await runScan({ code: parsed.data.code, filename: parsed.data.filename });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof AiError) return err(e.httpStatus, e.code, e.message);
    return err(500, "internal_error", "Unexpected error.");
  }
}
