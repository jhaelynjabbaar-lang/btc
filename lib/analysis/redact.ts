/**
 * Strip anything secret-like from data before it can reach the model, and from anything we log.
 * Defense in depth: the context builder only selects non-secret columns, and this runs over the final object anyway.
 */

const SECRET_KEY_NAME = /(?:secret|token|password|passwd|api[_-]?key|private|credential|authorization|cookie|bearer|seed|mnemonic|xprv|wif|signature|public_key)|(?:^|_)(?:hash|code|key)(?:_|$)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-or-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /sk-[A-Za-z0-9_-]{20,}/g,
  /sb_secret_[A-Za-z0-9_-]+/g, // Supabase
  /sb_publishable_[A-Za-z0-9_-]+/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\b(?:x|y|z)?(?:prv|pub)[1-9A-HJ-NP-Za-km-z]{100,}\b/g, // extended keys
  /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, // WIF private key
  /\b[0-9a-fA-F]{40,}\b/g, // long hex (hashes, keys)
  /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}/g, // long opaque tokens (mixed case + digit; snake_case metric/signal names are not)
  /(?<![A-Za-z0-9+/_-])(?=(?:[A-Za-z_+/-]*\d){8})[A-Za-z0-9+/_-]{40,}={0,2}/g, // long strings with many digits
  /postgres(?:ql)?:\/\/[^\s"']+/g, // connection strings
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

export const REDACTED = "[redacted]";

export function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Deep copy with secret-named keys dropped and secret-looking strings replaced. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_NAME.test(k)) continue;
      out[k] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}

/** True when the text still contains something that looks like a credential (used as a final tripwire and in tests). */
export function looksSecret(text: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
