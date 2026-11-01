import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { AnalyzeBody } from "@/lib/repair/schemas";
import { analysisRateLimited, analyzeStoredReport, ownerOf } from "@/lib/repair/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * POST /api/admin/repair/analyze { report_id } — optional NVIDIA Nemotron analysis (server-side key). The output is filtered against
 * the action allowlist and the report's own findings; it can only create PROPOSED suggestions that the admin must queue.
 */
export async function POST(request: Request) {
  const gate = await adminGate(request, true);
  if (gate.response) return gate.response;
  const body = await readBody(request, AnalyzeBody);
  if (!body.ok) return body.response;
  const owner = ownerOf(gate.actor.login);
  try {
    if (await analysisRateLimited(owner)) return json({ error: "rate_limited", message: "Analysis is limited to one run per 20 seconds." }, 429);
    const r = await analyzeStoredReport(owner, gate.actor.login ?? "owner", body.data.report_id);
    if (r.ok) return json({ ok: true, created: r.created, model_called: r.modelCalled, discarded: r.discarded.length, note: r.note });
    if (r.reason === "not_configured") return json({ error: "ai_not_configured", message: "The AI provider is not configured on this deployment." }, 503);
    if (r.reason === "not_found") return json({ error: "not_found", message: "Report not found." }, 404);
    return json({ error: r.reason, message: r.reason === "model_error" ? "The AI provider could not complete the analysis." : "The model's answer was not valid and was discarded." }, r.reason === "model_error" ? 502 : 500);
  } catch {
    return serverError();
  }
}
