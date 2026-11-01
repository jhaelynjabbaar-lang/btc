import { adminGate, failResponse, json, readBody, serverError } from "@/lib/cloud/http";
import { RequestResourceBody } from "@/lib/cloud/schemas";
import { requestResource } from "@/lib/cloud/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/cloud/resources  (admin-gated) — request a machine. ALWAYS creates a row in state `pending_approval`;
 * nothing is bought, provisioned or activated until an admin approves it (POST /api/admin/cloud/resources/:id).
 */
export async function POST(request: Request) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  const body = await readBody(request, RequestResourceBody);
  if (!body.ok) return body.response;
  try {
    const res = await requestResource(body.data, g.actor);
    if (!res.ok) return failResponse(res);
    return json({ ok: true, id: res.id, state: "pending_approval", cost_known: res.costKnown }, 201);
  } catch {
    return serverError();
  }
}
