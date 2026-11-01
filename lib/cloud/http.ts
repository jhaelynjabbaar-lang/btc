import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { gateRoute } from "@/lib/auth/access";
import { supabaseConfigured } from "@/lib/supabase/server";
import { NO_STORE, forbiddenOrigin, sameOrigin } from "@/lib/workers/guard";
import type { CloudActor, Fail } from "./service";

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
export const failResponse = (f: Fail) => json({ error: f.error, message: f.message, ...(f.detail ? { detail: f.detail } : {}) }, f.status);

type Gate = { response: NextResponse; actor: null } | { response: null; actor: CloudActor };

/** Admin gate shared by every /api/admin/cloud route: signed-in allowlisted admin, same-origin for writes, Supabase configured. */
export async function adminGate(request: Request, write: boolean): Promise<Gate> {
  const gate = await gateRoute(request);
  if (gate.response) return { response: gate.response, actor: null };
  if (write && !sameOrigin(request)) return { response: forbiddenOrigin(), actor: null };
  if (!supabaseConfigured()) return { response: json({ error: "supabase_not_configured", message: "Supabase is not configured." }, 503), actor: null };
  return { response: null, actor: { login: gate.actor.login } };
}

/** Reads a small JSON body (<= 4 KB) and validates it with a zod schema. */
export async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  const raw = await request.text();
  if (raw.length > 4096) return { ok: false, response: json({ error: "payload_too_large", message: "Request body too large." }, 413) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: json({ error: "invalid_request", message: "Body must be JSON." }, 400) };
  }
  const r = schema.safeParse(parsed);
  if (!r.success)
    return { ok: false, response: json({ error: "invalid_request", message: "Invalid request.", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400) };
  return { ok: true, data: r.data };
}

export const serverError = () => json({ error: "failed", message: "The request could not be completed." }, 500);
