import { adminGate, json, readBody, serverError } from "@/lib/cloud/http";
import { MintBody } from "@/lib/repair/schemas";
import { mintPairingCode } from "@/lib/repair/service";
import { ownerOf } from "@/lib/repair/admin";
import { PAIR_TTL_MS } from "@/lib/repair/pairing";
import { supabaseStore } from "@/lib/repair/store";

export const dynamic = "force-dynamic";

/** POST /api/admin/repair/pairing-codes { label } (admin-gated, same-origin) — one-time code, shown once, 15 min, only its hash is stored. */
export async function POST(request: Request) {
  const gate = await adminGate(request, true);
  if (gate.response) return gate.response;
  const body = await readBody(request, MintBody);
  if (!body.ok) return body.response;
  try {
    const login = gate.actor.login ?? "owner";
    const r = await mintPairingCode(supabaseStore, ownerOf(gate.actor.login), body.data.label, login);
    if (!r.ok) return json({ error: "too_many_active", message: "Too many unused codes are active. Use or wait for them to expire." }, 429);
    return json({ code: r.code, expires_at: r.expiresAt, ttl_seconds: PAIR_TTL_MS / 1000 }, 201);
  } catch {
    return serverError();
  }
}
