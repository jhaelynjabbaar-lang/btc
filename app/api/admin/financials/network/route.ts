import { adminGate, json, serverError } from "@/lib/cloud/http";
import { refreshSnapshot } from "@/lib/profit/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** POST /api/admin/financials/network  (admin-gated) — fetch the public network data now and cache it (source + time recorded). */
export async function POST(request: Request) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  try {
    const r = await refreshSnapshot("on_demand", { actor: g.actor.login ?? "owner" });
    if (!r.ok) return json({ error: "unavailable", message: "The public network APIs could not be reached. Network data is unavailable; nothing was stored.", field_errors: r.fetch.field_errors }, 502);
    return json({ ok: true, fetched_at: r.fetch.fetched_at, source: r.fetch.source, field_errors: r.fetch.field_errors });
  } catch {
    return serverError();
  }
}
