import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { QueueBody } from "@/lib/repair/schemas";
import { adminQueueSuggestion } from "@/lib/repair/service";
import { ownerOf } from "@/lib/repair/admin";
import { supabaseStore } from "@/lib/repair/store";

export const dynamic = "force-dynamic";

/** POST /api/admin/repair/suggestions — the admin suggests one allowlisted action for a paired device. The PC still asks Y/N. */
export async function POST(request: Request) {
  const gate = await adminGate(request, true);
  if (gate.response) return gate.response;
  const body = await readBody(request, QueueBody);
  if (!body.ok) return body.response;
  try {
    const r = await adminQueueSuggestion(supabaseStore, ownerOf(gate.actor.login), gate.actor.login ?? "owner", body.data);
    if (r.ok) return json({ ok: true, id: r.id }, 201);
    return json({ error: r.reason, message: r.reason === "needs_device" ? "Pick a paired device." : "Not an allowlisted action." }, 400);
  } catch {
    return serverError();
  }
}
