import { deviceGate, jsonNoStore } from "@/lib/repair/http";
import { pollSuggestions } from "@/lib/repair/service";
import { supabaseStore } from "@/lib/repair/store";

export const dynamic = "force-dynamic";

/** GET /api/repair/suggestions (Bearer) — queued SUGGESTIONS (allowlisted action ids + a plain explanation). Never a command. */
export async function GET(request: Request) {
  const gate = await deviceGate(request);
  if (gate.response) return gate.response;
  try {
    return jsonNoStore({ suggestions: await pollSuggestions(supabaseStore, gate.device) });
  } catch {
    return jsonNoStore({ error: "failed" }, 500);
  }
}
