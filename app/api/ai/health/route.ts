import { NextResponse } from "next/server";
import { gateRoute } from "@/lib/auth/access";
import { checkRateLimit, clientIp } from "@/lib/ai/rate-limit";
import { getAiStatus } from "@/lib/ai/status";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/ai/health          -> free metadata check (key accepted + model listed)
 * GET /api/ai/health?probe=1  -> also one tiny real completion (costs a fraction of a cent; rate limited)
 * Never returns the API key, credit balance or provider error bodies.
 */
export async function GET(request: Request) {
  const gate = await gateRoute(request);
  if (gate.response) return gate.response;
  const probe = new URL(request.url).searchParams.get("probe") === "1";
  if (probe) {
    const rl = checkRateLimit(`health:${clientIp(request)}`);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many requests." },
        { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } },
      );
    }
  }
  const status = await getAiStatus({ probe });
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
