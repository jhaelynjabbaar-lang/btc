import { NextResponse } from "next/server";
import { gateRoute } from "@/lib/auth/access";
import { getSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type TableName = keyof Database["public"]["Tables"];

const TABLES = [
  "workers",
  "worker_credentials",
  "worker_enrollment_codes",
  "telemetry_1m",
  "pools",
  "pool_stats",
  "ledger",
  "payout_addresses",
  "cloud_providers",
  "cloud_resources",
  "spend_limits",
  "ai_recommendations",
  "audit_log",
] as const satisfies readonly TableName[];

const HEADERS = { "cache-control": "no-store" };

/**
 * GET /api/mining/health  (admin-gated)
 * Reports whether Supabase is configured and reachable, plus the real row count of every mining table.
 * Never returns keys, URLs or raw database error text.
 */
export async function GET(request: Request) {
  const gate = await gateRoute(request);
  if (gate.response) return gate.response;

  if (!supabaseConfigured()) {
    return NextResponse.json(
      { ok: false, configured: false, reachable: false, message: "Supabase is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)." },
      { status: 200, headers: HEADERS },
    );
  }

  let db;
  try {
    db = getSupabaseServer();
  } catch (e) {
    return NextResponse.json(
      { ok: false, configured: true, reachable: false, message: e instanceof Error ? e.message : "Supabase client error." },
      { status: 200, headers: HEADERS },
    );
  }

  const results = await Promise.all(
    TABLES.map(async (table) => {
      try {
        const { count, error } = await db
          .from(table)
          .select("*", { count: "exact", head: true })
          .abortSignal(AbortSignal.timeout(10_000));
        if (error) return { table, count: null as number | null, error: error.code ? `error ${error.code}` : "query failed" };
        return { table, count: count ?? 0, error: null as string | null };
      } catch {
        return { table, count: null as number | null, error: "unreachable" };
      }
    }),
  );

  const counts: Record<string, number | null> = {};
  const errors: Record<string, string> = {};
  for (const r of results) {
    counts[r.table] = r.count;
    if (r.error) errors[r.table] = r.error;
  }
  const failed = results.filter((r) => r.error).length;
  const reachable = failed < results.length;
  return NextResponse.json(
    {
      ok: failed === 0,
      configured: true,
      reachable,
      checked_by: gate.actor.login ?? "fallback",
      tables: counts,
      ...(failed ? { errors } : {}),
    },
    { status: failed === 0 ? 200 : 503, headers: HEADERS },
  );
}
