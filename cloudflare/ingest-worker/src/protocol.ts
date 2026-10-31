/**
 * Wire protocol shared by the agent and the ingest Worker.
 *
 * Every authenticated request carries four headers:
 *   x-btc-worker     worker UUID (omitted on /v1/enroll, where the key is in the body)
 *   x-btc-timestamp  unix seconds
 *   x-btc-nonce      16–64 chars of [A-Za-z0-9_-], unique per request
 *   x-btc-signature  base64url Ed25519 signature over the canonical message below
 *
 * canonical = "BTCNAI1\n" + METHOD + "\n" + PATH + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body)
 *
 * METHOD and PATH are bound into the signature so a signature for one endpoint can never be replayed on another.
 * For GET the body is empty (sha256 of the empty string).
 */

export const PROTOCOL_VERSION = "BTCNAI1";
export const MAX_PAST_SKEW_S = 300; // reject requests older than 5 minutes
export const MAX_FUTURE_SKEW_S = 60; // tolerate a little clock drift in the other direction
export const NONCE_TTL_S = MAX_PAST_SKEW_S + MAX_FUTURE_SKEW_S + 60; // longer than any timestamp can stay valid

const enc = new TextEncoder();

export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Strict unpadded base64url decode. Returns null on any malformed input. */
export function b64urlDecode(input: string): Uint8Array | null {
  if (!B64URL_RE.test(input) || input.length % 4 === 1) return null;
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

export function canonicalMessage(p: { method: string; path: string; timestamp: string; nonce: string; bodySha256Hex: string }): string {
  return [PROTOCOL_VERSION, p.method.toUpperCase(), p.path, p.timestamp, p.nonce, p.bodySha256Hex].join("\n");
}

/** True when a base64url string is exactly a 32-byte Ed25519 public key. */
export function isValidPublicKey(b64: string): boolean {
  const raw = b64urlDecode(b64);
  return raw !== null && raw.length === 32;
}

/** Ed25519 verify. Never throws; any malformed input is simply "not valid". */
export async function verifyEd25519(publicKeyB64u: string, signatureB64u: string, message: string): Promise<boolean> {
  const key = b64urlDecode(publicKeyB64u);
  const sig = b64urlDecode(signatureB64u);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sig as BufferSource, enc.encode(message));
  } catch {
    return false;
  }
}

export type TimestampCheck = { ok: true; ts: number } | { ok: false };

/** Accept only integer unix-second timestamps in [now-5min, now+60s]. */
export function checkTimestamp(raw: string | null, nowMs: number): TimestampCheck {
  if (!raw || !/^\d{1,12}$/.test(raw)) return { ok: false };
  const ts = Number(raw);
  const now = Math.floor(nowMs / 1000);
  if (ts < now - MAX_PAST_SKEW_S || ts > now + MAX_FUTURE_SKEW_S) return { ok: false };
  return { ok: true, ts };
}

// --------------------------------------------------------- enrollment codes
// Format: BTCW-XXXXX-XXXXX-XXXXX-XXXXX (Crockford base32, 100 bits). Only the SHA-256 of the normalized code is stored.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ENROLL_CODE_PREFIX = "BTCW";

/** Normalize user-typed code (case, dashes, spaces, Crockford look-alikes). Returns null if it is not a well-formed code. */
export function normalizeEnrollCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!s.startsWith(ENROLL_CODE_PREFIX)) return null;
  const body = s.slice(ENROLL_CODE_PREFIX.length);
  if (body.length !== 20) return null;
  for (const ch of body) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

export async function hashEnrollCode(normalized: string): Promise<string> {
  return sha256Hex("btcnai-enroll-v1:" + normalized);
}
