import { z } from "zod";
import { adminGate, failResponse, json, readBody, serverError } from "@/lib/cloud/http";
import { ResourceActionBody } from "@/lib/cloud/schemas";
import { actOnResource } from "@/lib/cloud/service";

export const dynamic = "force-dynamic";

/** POST /api/admin/cloud/resources/:id  (admin-gated) — { action: approve|reject|activate|start|stop|destroy, confirm: true }. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return json({ error: "invalid_request", message: "Invalid resource id." }, 400);
  const body = await readBody(request, ResourceActionBody);
  if (!body.ok) return body.response;
  try {
    const res = await actOnResource({ id, action: body.data.action, note: body.data.note }, g.actor);
    if (!res.ok) return failResponse(res);
    return json({ ok: true, from: res.from, to: res.to, adapter_message: res.adapterMessage ?? null, warning: res.warning ?? null });
  } catch {
    return serverError();
  }
}
