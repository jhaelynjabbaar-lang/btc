import { z } from "zod";
import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { RevokeBody } from "@/lib/repair/schemas";
import { ownerOf, revokeDevice } from "@/lib/repair/admin";

export const dynamic = "force-dynamic";

/** POST /api/admin/repair/devices/:id { revoke: true } — the device token stops working immediately. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await adminGate(request, true);
  if (gate.response) return gate.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return json({ error: "invalid_request" }, 400);
  const body = await readBody(request, RevokeBody);
  if (!body.ok) return body.response;
  try {
    return (await revokeDevice(ownerOf(gate.actor.login), id)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
  } catch {
    return serverError();
  }
}
