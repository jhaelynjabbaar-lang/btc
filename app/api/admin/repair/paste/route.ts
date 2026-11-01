import { adminGate, json, serverError } from "@/lib/cloud/http";
import { readJson } from "@/lib/repair/http";
import { LIMITS, ReportBody } from "@/lib/repair/schemas";
import { ownerOf, savePastedReport } from "@/lib/repair/admin";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/repair/paste  <report JSON>  (admin-gated, same-origin)
 * Browser fallback for a PC that cannot reach the server by itself: open /repair in Firefox on the PC (or any device), paste the
 * compact report the script copied to the clipboard. Validated with the same strict schema as the device endpoint.
 */
export async function POST(request: Request) {
  const gate = await adminGate(request, true);
  if (gate.response) return gate.response;
  const body = await readJson(request, ReportBody, LIMITS.report);
  if (!body.ok) return body.response;
  try {
    const id = await savePastedReport(ownerOf(gate.actor.login), gate.actor.login ?? "owner", body.data);
    return json({ ok: true, report_id: id }, 201);
  } catch {
    return serverError();
  }
}
