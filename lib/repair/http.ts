import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { authenticateDevice, type Device } from "./service";
import { supabaseStore } from "./store";
import { supabaseConfigured } from "@/lib/supabase/server";
import { NO_STORE } from "@/lib/workers/guard";

export const jsonNoStore = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export function clientAddress(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/** Reads a size-limited JSON body (bytes) and validates its shape. Never echoes the input back. */
export async function readJson<S extends z.ZodType>(request: Request, schema: S, maxBytes: number): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: jsonNoStore({ error: "payload_too_large" }, 413) };
  const raw = await request.text();
  if (raw.length > maxBytes) return { ok: false, response: jsonNoStore({ error: "payload_too_large" }, 413) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: jsonNoStore({ error: "invalid_request", message: "Body must be JSON." }, 400) };
  }
  const r = schema.safeParse(parsed);
  if (!r.success) return { ok: false, response: jsonNoStore({ error: "invalid_request", message: "Invalid request.", issues: r.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) }, 400) };
  return { ok: true, data: r.data };
}

/** Bearer auth for the public device endpoints. */
export async function deviceGate(request: Request): Promise<{ response: NextResponse; device: null } | { response: null; device: Device }> {
  if (!supabaseConfigured()) return { response: jsonNoStore({ error: "supabase_not_configured" }, 503), device: null };
  const device = await authenticateDevice(supabaseStore, request.headers.get("authorization"));
  if (!device) return { response: jsonNoStore({ error: "unauthorized", message: "Unknown or revoked device token." }, 401), device: null };
  return { response: null, device };
}
