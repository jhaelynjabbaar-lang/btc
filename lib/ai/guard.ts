import "server-only";

/**
 * Temporary access guard for AI routes until real authentication lands (Stage 4+).
 *
 * The chat route spends money, so it is OFF by default and only answers when one of these holds:
 *  1. AI_PUBLIC_ENABLED=true  — explicit owner opt-in (e.g. once auth/rate limiting is trusted).
 *  2. The request arrived on a Vercel-generated *.vercel.app host of a PREVIEW deployment (behind
 *     Vercel Deployment Protection / SSO, so only signed-in team members reach the function).
 *     Production deployments are excluded: their aliases are publicly reachable.
 *     Custom domains are NOT covered by that protection, so they stay disabled. NOTE: this check
 *     assumes SSO protection stays enabled for the project; if it is turned off, set no env and
 *     the route is still reachable on *.vercel.app — re-check before disabling protection.
 *  3. Local development/`next start` on a loopback host (VERCEL is not set).
 */
export function aiAccessAllowed(request: Request): boolean {
  if (process.env.AI_PUBLIC_ENABLED === "true") return true;

  const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];
  if (process.env.VERCEL === "1") {
    // Production aliases (*.vercel.app) are public under Vercel's default "standard" protection, so they are NOT
    // treated as protected. Only preview deployments (behind SSO) pass here; production needs real auth
    // (AUTH_*) or the explicit AI_PUBLIC_ENABLED opt-in.
    return process.env.VERCEL_ENV !== "production" && host.endsWith(".vercel.app");
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
