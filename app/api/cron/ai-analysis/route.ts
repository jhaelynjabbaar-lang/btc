import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { adminLogins } from "@/lib/auth/config";
import { getAiConfig } from "@/lib/ai/config";
import { JOB_TYPES } from "@/lib/analysis/config";
import { runAnalysisServer } from "@/lib/analysis/server";
import { supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const NO_STORE = { "cache-control": "no-store" };
const safeEqual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/**
 * Daily analysis (vercel.json). Same protection as /api/cron/ingest: requires `Authorization: Bearer $CRON_SECRET`
 * (Vercel adds it when the variable is set) and refuses everything when CRON_SECRET is unset. When there is no data or no
 * threshold crossed, the model is not called, so a quiet day costs nothing. It only proposes recommendations.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron_not_configured", message: "CRON_SECRET is not set." }, { status: 503, headers: NO_STORE });
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!supabaseConfigured()) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503, headers: NO_STORE });
  if (!getAiConfig().configured) return NextResponse.json({ error: "ai_not_configured" }, { status: 503, headers: NO_STORE });
  try {
    const owner = adminLogins()[0];
    const out = await runAnalysisServer(JOB_TYPES, { login: owner }, { enforceCooldown: true, auditActor: "cron" });
    if (out.ok) return NextResponse.json({ ok: true, model_called: out.modelCalled, created: out.created, discarded: out.discarded.length, note: out.note }, { headers: NO_STORE });
    const status = out.reason === "rate_limited" ? 429 : 502;
    return NextResponse.json({ error: out.reason }, { status, headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 500, headers: NO_STORE });
  }
}
