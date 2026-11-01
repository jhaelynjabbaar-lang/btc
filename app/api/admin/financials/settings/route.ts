import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { SettingsBody } from "@/lib/profit/schemas";
import { saveSettings } from "@/lib/profit/service";

export const dynamic = "force-dynamic";

/** PUT /api/admin/financials/settings  (admin-gated) — save the cost inputs. Blank = not entered. Audited in the same transaction. */
export async function PUT(request: Request) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  const body = await readBody(request, SettingsBody);
  if (!body.ok) return body.response;
  try {
    const r = await saveSettings(body.data, g.actor);
    if (!r.ok) return json({ error: r.reason, message: "The settings were not saved." }, 400);
    return json({ ok: true });
  } catch {
    return serverError();
  }
}
