import { adminGate, failResponse, json, readBody, serverError } from "@/lib/cloud/http";
import { KillSwitchBody } from "@/lib/cloud/schemas";
import { killAll, rearmKillSwitch } from "@/lib/cloud/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/cloud/kill-switch  (admin-gated) — { action: "engage" | "rearm", confirm: true }.
 * engage = "Stop all cloud resources": rejects pending requests, stops everything active, blocks approve/activate/start until re-armed.
 */
export async function POST(request: Request) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  const body = await readBody(request, KillSwitchBody);
  if (!body.ok) return body.response;
  try {
    if (body.data.action === "rearm") {
      const r = await rearmKillSwitch(g.actor);
      return r.ok ? json({ ok: true, engaged: false }) : failResponse(r);
    }
    const r = await killAll(g.actor);
    if (!r.ok) return failResponse(r);
    return json({ ok: true, engaged: true, rejected_pending: r.rejectedPending, stopped: r.stopped, manual_action_needed: r.manualActionNeeded, adapter_failures: r.adapterFailures });
  } catch {
    return serverError();
  }
}
