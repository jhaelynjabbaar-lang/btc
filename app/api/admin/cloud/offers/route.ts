import { adminGate, failResponse, json, serverError } from "@/lib/cloud/http";
import { OffersQuery } from "@/lib/cloud/schemas";
import { listOffers } from "@/lib/cloud/service";

export const dynamic = "force-dynamic";

/** GET /api/admin/cloud/offers?provider=rentgpupower  (admin-gated) — read-only public catalogue (no key). Never buys anything. */
export async function GET(request: Request) {
  const g = await adminGate(request, false);
  if (g.response) return g.response;
  const q = OffersQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!q.success) return json({ error: "invalid_request", message: "Invalid query." }, 400);
  try {
    const res = await listOffers(q.data.provider, {
      gpuModel: q.data.gpu_model,
      minVramGb: q.data.min_vram_gb,
      region: q.data.region,
      maxHourlyUsd: q.data.max_hourly_usd,
      includeCpu: q.data.include_cpu === "1",
    });
    return res.ok ? json({ ok: true, adapter: res.adapter, offers: res.offers }) : failResponse(res);
  } catch {
    return serverError();
  }
}
