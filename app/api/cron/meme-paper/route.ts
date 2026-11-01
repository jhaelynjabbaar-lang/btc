import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runMemeTick } from "@/lib/meme/service";
import { supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "cache-control": "no-store" };
const safeEqual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/**
 * Memecoin paper-trading tick (vercel.json: every 15 minutes). PAPER MONEY ONLY: no wallet, key or real order exists.
 * Same protection as the other cron routes: requires `Authorization: Bearer $CRON_SECRET` and refuses everything when CRON_SECRET
 * is unset. Idempotent per 15-minute bucket.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron_not_configured", message: "CRON_SECRET is not set." }, { status: 503, headers: NO_STORE });
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!supabaseConfigured()) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503, headers: NO_STORE });
  try {
    const result = await runMemeTick({ actor: "cron", autoStart: true });
    return NextResponse.json({ ok: true, paper_money: true, ...result }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 500, headers: NO_STORE });
  }
}
