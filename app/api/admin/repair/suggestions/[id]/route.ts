import { z } from "zod";
import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { DecideBody } from "@/lib/repair/schemas";
import { adminDecide } from "@/lib/repair/service";
import { ownerOf } from "@/lib/repair/admin";
import { supabaseStore } from "@/lib/repair/store";

export const dynamic = "force-dynamic";

/** POST /api/admin/repair/suggestions/:id { decision: "queue" | "dismiss" } — queue an AI proposal for the PC, or dismiss it. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await adminGate(request, true);
  if (gate.response) return gate.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return json({ error: "invalid_request" }, 400);
  const body = await readBody(request, DecideBody);
  if (!body.ok) return body.response;
  try {
    const r = await adminDecide(supabaseStore, id, ownerOf(gate.actor.login), body.data.decision);
    if (r.ok) return json({ ok: true });
    return json({ error: r.reason, message: r.reason === "needs_device" ? "This suggestion came from an offline report; type the action on the PC instead." : "Cannot change this suggestion." }, r.reason === "not_found" ? 404 : 409);
  } catch {
    return serverError();
  }
}
