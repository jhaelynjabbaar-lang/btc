import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { configFromEnv } from "@/lib/paper/config";
import { ControlBody } from "@/lib/paper/schemas";
import { runPaperTick, setPaused, startRun } from "@/lib/paper/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/admin/paper/control (admin-gated, same-origin) — pause | resume | reset | tick. PAPER MONEY ONLY.
 * `reset` archives the current paper run and starts a fresh one; it needs `confirm: true`.
 * `tick` runs the same idempotent hourly tick as the cron (a no-op if this hour's candle was already processed).
 */
export async function POST(request: Request) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  const body = await readBody(request, ControlBody);
  if (!body.ok) return body.response;
  const actor = g.actor.login ?? "admin";
  try {
    const b = body.data;
    if (b.action === "pause" || b.action === "resume") {
      const r = await setPaused(actor, b.action === "pause");
      return r.ok ? json({ ok: true }) : json({ error: r.reason ?? "failed", message: "No active paper run." }, 409);
    }
    if (b.action === "tick") {
      const r = await runPaperTick({ actor, autoStart: false });
      return json({ ok: true, ...r });
    }
    const cfg = configFromEnv();
    if (b.starting_usd !== undefined) cfg.startCents = Math.round(b.starting_usd * 100);
    if (b.fee_pct !== undefined) cfg.feeBps = Math.round(b.fee_pct * 100);
    if (b.slippage_pct !== undefined) cfg.slippageBps = Math.round(b.slippage_pct * 100);
    const r = await startRun(actor, cfg, false);
    return r.ok ? json({ ok: true, run_id: r.runId }) : json({ error: "invalid_request", message: r.reason }, 400);
  } catch {
    return serverError();
  }
}
