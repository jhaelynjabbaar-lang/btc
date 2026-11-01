import { z } from "zod";
import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { getAiConfig } from "@/lib/ai/config";
import { JOB_TYPES } from "@/lib/analysis/config";
import { runAnalysisServer } from "@/lib/analysis/server";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const Body = z.strictObject({ jobs: z.array(z.enum(JOB_TYPES)).min(1).max(3).optional() });

/**
 * POST /api/admin/ai/analyze  (admin-gated, same-origin)
 * Runs the analysis jobs once. Rate limited to one run per minute (durable, from audit_log). The model only proposes rows in
 * ai_recommendations; nothing is executed. The API key stays on the server.
 */
export async function POST(request: Request) {
  const gate = await adminGate(request, true);
  if (gate.response) return gate.response;
  if (!getAiConfig().configured) return json({ error: "ai_not_configured", message: "The AI provider is not configured on this deployment." }, 503);

  const raw = await request.text();
  let body: z.infer<typeof Body> = {};
  if (raw.trim()) {
    const p = await readBody(new Request(request.url, { method: "POST", body: raw }), Body);
    if (!p.ok) return p.response;
    body = p.data;
  }
  try {
    const out = await runAnalysisServer(body.jobs ?? JOB_TYPES, gate.actor, { enforceCooldown: true });
    if (out.ok) {
      return json({
        ok: true,
        run_id: out.runId,
        model_called: out.modelCalled,
        model: out.model,
        created: out.created,
        skipped_duplicates: out.skippedDuplicates,
        discarded: out.discarded.length,
        signals: out.signals,
        note: out.note,
      });
    }
    if (out.reason === "rate_limited") {
      const res = json({ error: "rate_limited", message: `Manual analysis is limited to one run per minute. Try again in ${out.retryAfterSec}s.`, retry_after: out.retryAfterSec }, 429);
      res.headers.set("retry-after", String(out.retryAfterSec));
      return res;
    }
    return json({ error: out.reason, message: out.message, run_id: out.runId }, out.reason === "model_error" ? 502 : 500);
  } catch {
    return serverError();
  }
}
