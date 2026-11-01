import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { memeConfigFromEnv } from "@/lib/meme/config";
import { MemeControlBody } from "@/lib/meme/schemas";
import { runMemeTick, setMemePaused, startAccount } from "@/lib/meme/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/meme-paper/control (admin-gated, same-origin) — pause | resume | reset | tick. PAPER MONEY ONLY.
 * `reset` archives the current paper account and starts a fresh one; it needs `confirm: true`.
 * `tick` runs the same idempotent tick as the cron on demand (own one-minute bucket, so it works between cron runs).
 */
export async function POST(request: Request) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  const body = await readBody(request, MemeControlBody);
  if (!body.ok) return body.response;
  const actor = g.actor.login ?? "admin";
  try {
    const b = body.data;
    if (b.action === "pause" || b.action === "resume") {
      const r = await setMemePaused(actor, b.action === "pause");
      return r.ok ? json({ ok: true }) : json({ error: r.reason ?? "failed", message: "No active memecoin paper account." }, 409);
    }
    if (b.action === "tick") {
      const r = await runMemeTick({ actor, autoStart: false, manual: true });
      return json({ ok: true, ...r });
    }
    const cfg = memeConfigFromEnv();
    if (b.starting_usd !== undefined) cfg.startUsd = b.starting_usd;
    const r = await startAccount(actor, cfg, false);
    return r.ok ? json({ ok: true, account_id: r.accountId }) : json({ error: "invalid_request", message: r.reason }, 400);
  } catch {
    return serverError();
  }
}
