import { adminGate, json, serverError } from "@/lib/cloud/http";
import { importBraiinsPayouts } from "@/lib/profit/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MESSAGES: Record<string, [number, string]> = {
  not_connected: [409, "Not connected: BRAIINS_POOL_TOKEN is not set. See the instructions on the Financials page."],
  token_rejected: [502, "Braiins rejected the token. Check that the access profile allows web APIs and that the token is current."],
  invalid_response: [502, "Braiins returned a response in an unexpected shape. Nothing was imported."],
  timeout: [504, "Braiins did not answer in time. Nothing was imported."],
};

/** POST /api/admin/financials/braiins  (admin-gated) — import CONFIRMED pool payouts (last 90 days) into the ledger. Needs BRAIINS_POOL_TOKEN. */
export async function POST(request: Request) {
  const g = await adminGate(request, true);
  if (g.response) return g.response;
  try {
    const r = await importBraiinsPayouts(g.actor);
    if (!r.ok) {
      const [status, message] = MESSAGES[r.error] ?? [502, "The Braiins request failed. Nothing was imported."];
      return json({ error: r.error, message }, status);
    }
    return json(r);
  } catch {
    return serverError();
  }
}
