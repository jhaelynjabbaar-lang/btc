import { adminGate, failResponse, json, readBody, serverError } from "@/lib/cloud/http";
import { SpendLimitBody } from "@/lib/cloud/schemas";
import { setSpendLimit } from "@/lib/cloud/service";

export const dynamic = "force-dynamic";

/** PUT /api/admin/cloud/limits  (admin-gated) — set one cap. All caps default to 0 (nothing can be spent). Audited. */
export async function PUT(request: Request) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  const body = await readBody(request, SpendLimitBody);
  if (!body.ok) return body.response;
  try {
    const { scope, provider_id, period, limit_usd } = body.data;
    const res = await setSpendLimit({ scope, provider_id, period, limit_usd }, g.actor);
    if (!res.ok) return failResponse(res);
    return json({ ok: true, old_usd: res.oldUsd, new_usd: res.newUsd });
  } catch {
    return serverError();
  }
}
