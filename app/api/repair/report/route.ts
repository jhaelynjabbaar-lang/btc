import { deviceGate, jsonNoStore, readJson } from "@/lib/repair/http";
import { submitReport } from "@/lib/repair/service";
import { ReportBody, LIMITS } from "@/lib/repair/schemas";
import { supabaseStore } from "@/lib/repair/store";

export const dynamic = "force-dynamic";

/** POST /api/repair/report (Bearer device token) — diagnostics / action results / errors. Strict, size-limited schema. */
export async function POST(request: Request) {
  const gate = await deviceGate(request);
  if (gate.response) return gate.response;
  const body = await readJson(request, ReportBody, LIMITS.report);
  if (!body.ok) return body.response;
  try {
    const r = await submitReport(supabaseStore, gate.device, body.data);
    if (!r.ok) return jsonNoStore({ error: "rate_limited", message: "Too many reports from this device. Try later." }, 429);
    return jsonNoStore({ ok: true, report_id: r.reportId }, 201);
  } catch {
    return jsonNoStore({ error: "failed" }, 500);
  }
}
