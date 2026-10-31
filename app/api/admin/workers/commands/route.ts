import { NextResponse } from "next/server";
import { z } from "zod";
import { gateRoute } from "@/lib/auth/access";
import { supabaseConfigured } from "@/lib/supabase/server";
import { WORKER_COMMANDS } from "@/lib/workers/config";
import { queueWorkerCommand } from "@/lib/workers/admin";
import { NO_STORE, forbiddenOrigin, sameOrigin } from "@/lib/workers/guard";

export const dynamic = "force-dynamic";

const Body = z.strictObject({ worker_id: z.uuid(), command: z.enum(WORKER_COMMANDS) });

/** POST /api/admin/workers/commands  (admin-gated) — queue start/pause/stop for a worker. */
export async function POST(request: Request) {
  const gate = await gateRoute(request);
  if (gate.response) return gate.response;
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: "supabase_not_configured", message: "Supabase is not configured." }, { status: 503, headers: NO_STORE });
  }
  const raw = await request.text();
  if (raw.length > 1024) return NextResponse.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Expected { worker_id: uuid, command: start|pause|stop }." }, { status: 400, headers: NO_STORE });
  }
  try {
    const res = await queueWorkerCommand(parsed.worker_id, parsed.command, gate.actor.login ?? "owner");
    if (res.ok) return NextResponse.json({ ok: true, id: res.id, expires_at: res.expiresAt }, { status: 201, headers: NO_STORE });
    const map = {
      not_found: [404, "Worker not found."],
      revoked: [409, "This worker has been revoked."],
      duplicate: [409, `A pending '${parsed.command}' command is already queued for this worker.`],
      failed: [500, "Could not queue the command."],
    } as const;
    const [status, message] = map[res.reason];
    return NextResponse.json({ error: res.reason, message }, { status, headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "failed", message: "Could not queue the command." }, { status: 500, headers: NO_STORE });
  }
}
