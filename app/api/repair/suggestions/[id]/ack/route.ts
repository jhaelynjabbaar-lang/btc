import { z } from "zod";
import { deviceGate, jsonNoStore, readJson } from "@/lib/repair/http";
import { ackSuggestion } from "@/lib/repair/service";
import { AckBody, LIMITS } from "@/lib/repair/schemas";
import { supabaseStore } from "@/lib/repair/store";

export const dynamic = "force-dynamic";

/** POST /api/repair/suggestions/:id/ack (Bearer) — the PC reports what the person at the PC decided / what happened. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await deviceGate(request);
  if (gate.response) return gate.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return jsonNoStore({ error: "invalid_request" }, 400);
  const body = await readJson(request, AckBody, LIMITS.ack);
  if (!body.ok) return body.response;
  try {
    const r = await ackSuggestion(supabaseStore, gate.device, id, body.data);
    if (r.ok) return jsonNoStore({ ok: true });
    return jsonNoStore({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  } catch {
    return jsonNoStore({ error: "failed" }, 500);
  }
}
