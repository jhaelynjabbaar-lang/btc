import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { OfflineBody } from "@/lib/repair/schemas";
import { ownerOf, saveOfflineReport } from "@/lib/repair/admin";

export const dynamic = "force-dynamic";

/** POST /api/admin/repair/offline { code } — decode the short code printed by the PC script when it could not reach the server. */
export async function POST(request: Request) {
  const gate = await adminGate(request, true);
  if (gate.response) return gate.response;
  const body = await readBody(request, OfflineBody);
  if (!body.ok) return body.response;
  try {
    const r = await saveOfflineReport(ownerOf(gate.actor.login), gate.actor.login ?? "owner", body.data.code);
    if (r.ok) return json({ ok: true, report_id: r.id }, 201);
    return json({ error: r.reason, message: r.reason === "checksum" ? "That code has a typo (check digit does not match)." : "Not a valid offline code (expected W7-XXXX-XXXX-XXXX-C)." }, 400);
  } catch {
    return serverError();
  }
}
