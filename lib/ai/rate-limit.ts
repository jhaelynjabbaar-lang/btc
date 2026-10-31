import "server-only";

/**
 * Minimal in-memory sliding-window rate limiter, keyed by client IP.
 * Best effort only: state is per server instance and resets on cold start, so on serverless it
 * limits bursts, not total volume. Replace with a shared store (e.g. Upstash/Neon) in the DB stage.
 */
type Rule = { limit: number; windowMs: number };
const RULES: Rule[] = [
  { limit: 6, windowMs: 60_000 },
  { limit: 40, windowMs: 3_600_000 },
];
const MAX_KEYS = 5000;
const hits = new Map<string, number[]>();

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || request.headers.get("x-real-ip") || "unknown";
}

export function checkRateLimit(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
  const longest = Math.max(...RULES.map((r) => r.windowMs));
  const stamps = (hits.get(key) ?? []).filter((t) => now - t < longest);
  for (const r of RULES) {
    const inWindow = stamps.filter((t) => now - t < r.windowMs);
    if (inWindow.length >= r.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((inWindow[0] + r.windowMs - now) / 1000));
      hits.set(key, stamps);
      return { ok: false, retryAfterSec };
    }
  }
  stamps.push(now);
  hits.set(key, stamps);
  if (hits.size > MAX_KEYS) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= longest)) hits.delete(k);
    if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value as string);
  }
  return { ok: true };
}
