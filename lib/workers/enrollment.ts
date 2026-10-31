import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * One-time worker enrollment codes. Format BTCW-XXXXX-XXXXX-XXXXX-XXXXX (Crockford base32, 100 bits of entropy).
 * Only the SHA-256 of the normalized code is stored; the plaintext is shown to the admin exactly once.
 * The normalize/hash algorithm MUST match cloudflare/ingest-worker/src/protocol.ts (test vector in both suites).
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ENROLL_CODE_PREFIX = "BTCW";
export const ENROLL_CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_ACTIVE_CODES = 10;

export function generateEnrollCode(): string {
  const bytes = randomBytes(20);
  const body = Array.from(bytes, (b) => CROCKFORD[b & 31]).join(""); // 32 symbols → unbiased
  return `${ENROLL_CODE_PREFIX}-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15)}`;
}

export function normalizeEnrollCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!s.startsWith(ENROLL_CODE_PREFIX)) return null;
  const body = s.slice(ENROLL_CODE_PREFIX.length);
  if (body.length !== 20) return null;
  for (const ch of body) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

export function hashEnrollCode(normalized: string): string {
  return createHash("sha256").update("btcnai-enroll-v1:" + normalized).digest("hex");
}
