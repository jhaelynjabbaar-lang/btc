import { createHash, randomBytes } from "node:crypto";

/**
 * Pairing codes and device tokens for the repair helper. Pure functions (no I/O).
 *  - Pairing code: RP-XXXXX-XXXXX (Crockford base32, 50 bits). One-time, expires in 15 minutes, stored only as SHA-256.
 *    Short on purpose: it is typed by hand on the PC. Brute force is blocked by the per-address rate limit and the short expiry.
 *  - Device token: rdt_ + 43 base64url chars (256 bits). Shown to the PC exactly once, stored only as SHA-256.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_PREFIX = "RP";
export const PAIR_TTL_MS = 15 * 60 * 1000;
export const MAX_ACTIVE_PAIR_CODES = 5;
export const TOKEN_PREFIX = "rdt_";
export const TOKEN_RE = /^rdt_[A-Za-z0-9_-]{43}$/;

export function generatePairCode(): string {
  const bytes = randomBytes(10);
  const body = Array.from(bytes, (b) => CROCKFORD[b & 31]).join("");
  return `${PAIR_PREFIX}-${body.slice(0, 5)}-${body.slice(5)}`;
}

export function normalizePairCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!s.startsWith(PAIR_PREFIX)) return null;
  const body = s.slice(PAIR_PREFIX.length);
  if (body.length !== 10) return null;
  for (const ch of body) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

export function hashPairCode(normalized: string): string {
  return createHash("sha256").update("btcrepair-pair-v1:" + normalized).digest("hex");
}

export function generateDeviceToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update("btcrepair-token-v1:" + token).digest("hex");
}

export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer (\S+)$/.exec(header);
  return m && TOKEN_RE.test(m[1]) ? m[1] : null;
}

export function hashClient(address: string, salt = "btcrepair-rl-v1"): string {
  return createHash("sha256").update(`${salt}:${address}`).digest("hex");
}
