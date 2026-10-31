import { NextResponse } from "next/server";
import { gateRoute } from "@/lib/auth/access";
import { getDb } from "@/lib/db/client";
import { runIngest } from "@/lib/monitor/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { "cache-control": "no-store" };

/** Manual "Run ingest now": signed-in allow-listed admin (or, without auth configured, the SSO/loopback fallback). */
export async function POST(request: Request) {
  const gate = await gateRoute(request);
  if (gate.response) return gate.response;
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "database_not_configured", message: "Database not configured (awaiting Neon)." }, { status: 503, headers: NO_STORE });
  }
  try {
    const summary = await runIngest(db, "manual");
    return NextResponse.json({ ok: true, ...summary }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "ingest_failed", message: "Ingest failed." }, { status: 500, headers: NO_STORE });
  }
}
