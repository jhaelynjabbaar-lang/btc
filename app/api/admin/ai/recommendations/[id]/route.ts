import { z } from "zod";
import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { DecideBody } from "@/lib/analysis/decide";
import { decideServer } from "@/lib/analysis/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/ai/recommendations/:id  { decision: "accept" | "dismiss", confirm?: true }
 * The only way a recommendation changes. "accept" needs confirm: true (sent by the UI after a second click); for a worker_command
 * suggestion it queues a normal worker command in the same transaction. Every decision is written to audit_log.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await adminGate(request, true);
  if (gate.response) return gate.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return json({ error: "invalid_request", message: "Invalid recommendation id." }, 400);
  const body = await readBody(request, DecideBody);
  if (!body.ok) return body.response;
  try {
    const r = await decideServer({ id, ...body.data }, gate.actor);
    if (!r.ok) return json({ error: r.error, message: r.message }, r.status);
    return json({ ok: true, status: r.status, command_id: r.commandId });
  } catch {
    return serverError();
  }
}
