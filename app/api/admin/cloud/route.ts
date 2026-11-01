import { adminGate, json, serverError } from "@/lib/cloud/http";
import { snapshot } from "@/lib/cloud/service";

export const dynamic = "force-dynamic";

/** GET /api/admin/cloud  (admin-gated) — providers, spend limits, resources, kill-switch state and recent cloud audit entries. */
export async function GET(request: Request) {
  const g = await adminGate(request, false);
  if (g.response) return g.response;
  try {
    return json(await snapshot(g.actor));
  } catch {
    return serverError();
  }
}
