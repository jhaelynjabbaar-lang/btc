import { NextResponse } from "next/server";
import { gateRoute } from "@/lib/auth/access";
import { supabaseConfigured } from "@/lib/supabase/server";
import { ENROLL_CODE_TTL_MS } from "@/lib/workers/enrollment";
import { ingestUrl } from "@/lib/workers/config";
import { mintEnrollmentCode } from "@/lib/workers/admin";
import { NO_STORE, forbiddenOrigin, sameOrigin } from "@/lib/workers/guard";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/workers/enrollment-codes  (admin-gated)
 * Mints a one-time enrollment code. The plaintext code is returned in this response ONLY; the database keeps its hash.
 */
export async function POST(request: Request) {
  const gate = await gateRoute(request);
  if (gate.response) return gate.response;
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "supabase_not_configured", message: "Supabase is not configured." }, { status: 503, headers: NO_STORE });
  }
  const login = gate.actor.login ?? "owner";
  try {
    const res = await mintEnrollmentCode(login.toLowerCase(), login);
    if (!res.ok) {
      if (res.reason === "too_many_active")
        return NextResponse.json({ error: "too_many_active", message: "Too many unused codes are active. Use or wait for them to expire." }, { status: 429, headers: NO_STORE });
      return NextResponse.json({ error: "mint_failed", message: "Could not create a code." }, { status: 500, headers: NO_STORE });
    }
    return NextResponse.json(
      { code: res.code, expires_at: res.expiresAt, ttl_seconds: ENROLL_CODE_TTL_MS / 1000, ingest_url: ingestUrl() },
      { status: 201, headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ error: "mint_failed", message: "Could not create a code." }, { status: 500, headers: NO_STORE });
  }
}
