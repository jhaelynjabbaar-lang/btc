import { z } from "zod";

/**
 * Accept / dismiss. The database function public.ai_decide_recommendation does the work in ONE transaction (status change,
 * the normal worker_commands row for an accepted worker_command suggestion, and audit_log). This wrapper adds the confirm
 * gate BEFORE anything is sent, so an accept without an explicit confirm never reaches the database.
 */

export const DecideBody = z.strictObject({
  decision: z.enum(["accept", "dismiss"]),
  /** Must be literally true for "accept". The UI sets it only after a second, explicit click. */
  confirm: z.boolean().optional(),
});

export type DecideResult =
  | { ok: true; status: "accepted" | "dismissed"; commandId: string | null }
  | { ok: false; status: number; error: string; message: string };

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

const REASONS: Record<string, [number, string]> = {
  confirmation_required: [400, "Accepting needs an explicit confirmation."],
  not_found: [404, "Recommendation not found."],
  already_decided: [409, "This recommendation was already accepted or dismissed."],
  invalid_action: [422, "The suggested action is not valid and cannot be executed."],
  worker_not_found: [404, "The worker no longer exists."],
  worker_revoked: [409, "This worker has been revoked."],
  duplicate_command: [409, "A pending command of that type is already queued for this worker."],
  invalid_decision: [400, "Invalid decision."],
};

const RpcOut = z.looseObject({ ok: z.boolean(), reason: z.string().optional(), status: z.string().optional(), command_id: z.string().nullish() });

export async function decideRecommendation(args: { owner: string; id: string; decision: "accept" | "dismiss"; confirm?: boolean; actor: string }, rpc: Rpc): Promise<DecideResult> {
  if (args.decision === "accept" && args.confirm !== true) {
    return { ok: false, status: 400, error: "confirmation_required", message: REASONS.confirmation_required[1] };
  }
  const { data, error } = await rpc("ai_decide_recommendation", {
    p_owner: args.owner,
    p_id: args.id,
    p_decision: args.decision,
    p_confirm: args.decision === "accept" ? true : false,
    p_actor: args.actor,
  });
  const parsed = RpcOut.safeParse(data);
  if (error || !parsed.success) return { ok: false, status: 500, error: "failed", message: "The decision could not be recorded." };
  if (!parsed.data.ok) {
    const reason = parsed.data.reason ?? "failed";
    const [status, message] = REASONS[reason] ?? [500, "The decision could not be recorded."];
    return { ok: false, status, error: reason, message };
  }
  return { ok: true, status: parsed.data.status === "accepted" ? "accepted" : "dismissed", commandId: parsed.data.command_id ?? null };
}
