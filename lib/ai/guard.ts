import "server-only";

/**
 * Temporary access guard for AI routes until real authentication lands (Stage 4+).
 *
 * The chat route spends money, so it is OFF by default and only answers when one of these holds:
 *  1. AI_PUBLIC_ENABLED=true  — explicit owner opt-in (e.g. once auth/rate limiting is trusted).
 *  2. The request arrived on a Vercel-generated *.vercel.app host. On this project those hosts are
 *     behind Vercel Deployment Protection (SSO), so only signed-in team members reach the function.
 *     Custom domains are NOT covered by that protection, so they stay disabled. NOTE: this check
 *     assumes SSO protection stays enabled for the project; if it is turned off, set no env and
 *     the route is still reachable on *.vercel.app — re-check before disabling protection.
 *  3. Local development/`next start` on a loopback host (VERCEL is not set).
 */
export function aiAccessAllowed(request: Request): boolean {
  if (process.env.AI_PUBLIC_ENABLED === "true") return true;

  const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];
  if (process.env.VERCEL === "1") return host.endsWith(".vercel.app");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
