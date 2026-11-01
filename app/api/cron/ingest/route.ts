import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { runIngest } from "@/lib/monitor/ingest";
import { refreshSnapshot } from "@/lib/profit/service";
import { supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { "cache-control": "no-store" };

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET` (Vercel adds the header automatically
 * when the CRON_SECRET env var is set). Never open: with no CRON_SECRET configured the route refuses.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "cron_not_configured", message: "CRON_SECRET is not set." }, { status: 503, headers: NO_STORE });
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  // Phase 8: refresh the public network data cache (4 small keyless GETs). Best effort and independent of the Neon ingest below.
  let networkSnapshot: "stored" | "unavailable" | "skipped" | "failed" = "skipped";
  if (supabaseConfigured()) {
    try {
      networkSnapshot = (await refreshSnapshot("cron")).ok ? "stored" : "unavailable";
    } catch {
      networkSnapshot = "failed";
    }
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: "database_not_configured", message: "Database not configured (awaiting Neon). Nothing was ingested.", network_snapshot: networkSnapshot },
      { status: 503, headers: NO_STORE },
    );
  }
  try {
    const summary = await runIngest(db, "cron");
    return NextResponse.json({ ok: true, ...summary, network_snapshot: networkSnapshot }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "ingest_failed", message: "Ingest failed; see source statuses on /monitoring." }, { status: 500, headers: NO_STORE });
  }
}
