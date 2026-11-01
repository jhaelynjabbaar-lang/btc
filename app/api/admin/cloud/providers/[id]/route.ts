import { z } from "zod";
import { adminGate, failResponse, json, readBody, serverError } from "@/lib/cloud/http";
import { ProviderAttestationBody } from "@/lib/cloud/schemas";
import { setProviderAttestation } from "@/lib/cloud/service";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/cloud/providers/:id  (admin-gated) — record the owner's written-permission reference and/or acknowledge a
 * provider's mining conditions. This never changes the provider's mining_policy (that comes only from its official terms).
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return json({ error: "invalid_request", message: "Invalid provider id." }, 400);
  const body = await readBody(request, ProviderAttestationBody);
  if (!body.ok) return body.response;
  try {
    const res = await setProviderAttestation(id, body.data, g.actor);
    return res.ok ? json({ ok: true }) : failResponse(res);
  } catch {
    return serverError();
  }
}
