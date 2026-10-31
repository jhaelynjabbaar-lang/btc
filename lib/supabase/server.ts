import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/**
 * Server-only Supabase client for BTC Network AI.
 *
 * Uses SUPABASE_URL + SUPABASE_SECRET_KEY (new `sb_secret_...` key, or the legacy service_role JWT stored under the same
 * name). The secret key bypasses RLS, so this module must never be imported from client code ("server-only" enforces it)
 * and the key must never use a NEXT_PUBLIC_ prefix. Neon/Drizzle remains the store for the existing features.
 */

export type SupabaseServer = SupabaseClient<Database>;

export function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SECRET_KEY?.trim());
}

/** Refuse keys that are obviously not privileged server keys (publishable/anon), without ever logging the key. */
function assertServerKey(key: string): void {
  if (key.startsWith("sb_publishable_")) throw new Error("SUPABASE_SECRET_KEY holds a publishable key; expected an sb_secret_ key.");
  if (key.startsWith("sb_secret_")) return;
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const role = (JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: string }).role;
      if (role && role !== "service_role") throw new Error(`SUPABASE_SECRET_KEY holds a '${role}' key; expected service_role or sb_secret_.`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("SUPABASE_SECRET_KEY")) throw e;
    }
  }
}

let cached: SupabaseServer | null = null;

/** Lazily created singleton. Throws a generic error (no secrets) when not configured. */
export function getSupabaseServer(): SupabaseServer {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) throw new Error("Supabase is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY).");
  assertServerKey(key);
  cached = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "btc-network-ai-server" } },
  });
  return cached;
}
