import { supabaseConfigured } from "@/lib/supabase/server";
import { clientAddress, jsonNoStore, readJson } from "@/lib/repair/http";
import { pairDevice } from "@/lib/repair/service";
import { PairBody, LIMITS } from "@/lib/repair/schemas";
import { supabaseStore } from "@/lib/repair/store";

export const dynamic = "force-dynamic";

/** POST /api/repair/pair { code } — exchanges a one-time pairing code for a per-device bearer token (shown once, only its hash is stored). */
export async function POST(request: Request) {
  if (!supabaseConfigured()) return jsonNoStore({ error: "supabase_not_configured" }, 503);
  const body = await readJson(request, PairBody, LIMITS.pair);
  if (!body.ok) return body.response;
  try {
    const r = await pairDevice(supabaseStore, { code: body.data.code, agentVersion: body.data.agent_version }, clientAddress(request));
    if (r.ok) return jsonNoStore({ device_id: r.deviceId, token: r.token }, 201);
    if (r.reason === "rate_limited") {
      const res = jsonNoStore({ error: "rate_limited", message: "Too many attempts. Wait and try again." }, 429);
      res.headers.set("retry-after", String(r.retryAfterSec ?? 60));
      return res;
    }
    return jsonNoStore({ error: "invalid_code", message: "That pairing code is wrong, used or expired." }, 400);
  } catch {
    return jsonNoStore({ error: "failed" }, 500);
  }
}
