import "server-only";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { aiAccessAllowed } from "@/lib/ai/guard";
import { auth } from "./index";
import { authConfigured, isAdminLogin } from "./config";

export type Actor =
  | { allowed: true; mode: "auth"; login: string }
  | { allowed: true; mode: "fallback"; login: null }
  | { allowed: false; mode: "auth"; reason: "unauthenticated" | "forbidden" }
  | { allowed: false; mode: "fallback"; reason: "disabled" };

async function sessionLogin(): Promise<string | null> {
  const s = await auth();
  const login = (s?.user as { login?: string } | undefined)?.login;
  return login ?? null;
}

/**
 * Who may use protected features?
 *  - AUTH_* configured  -> only a signed-in GitHub user on the ADMIN_GITHUB_LOGINS allowlist.
 *  - not configured     -> the Stage 3 fallback (AI_PUBLIC_ENABLED, *.vercel.app host behind Vercel SSO, or loopback).
 */
export async function actorForRequest(request: Request): Promise<Actor> {
  if (authConfigured()) {
    const login = await sessionLogin();
    if (!login) return { allowed: false, mode: "auth", reason: "unauthenticated" };
    if (!isAdminLogin(login)) return { allowed: false, mode: "auth", reason: "forbidden" };
    return { allowed: true, mode: "auth", login };
  }
  return aiAccessAllowed(request)
    ? { allowed: true, mode: "fallback", login: null }
    : { allowed: false, mode: "fallback", reason: "disabled" };
}

/** For route handlers: returns an error response when blocked, otherwise null (and the actor). */
export async function gateRoute(
  request: Request,
): Promise<{ response: NextResponse; actor: null } | { response: null; actor: Extract<Actor, { allowed: true }> }> {
  const actor = await actorForRequest(request);
  if (actor.allowed) return { response: null, actor };
  const h = { "cache-control": "no-store" };
  if (actor.reason === "unauthenticated")
    return { response: NextResponse.json({ error: "unauthenticated", message: "Sign in required — open /signin." }, { status: 401, headers: h }), actor: null };
  if (actor.reason === "forbidden")
    return { response: NextResponse.json({ error: "forbidden", message: "This GitHub account is not on the allowlist." }, { status: 403, headers: h }), actor: null };
  return {
    response: NextResponse.json({ error: "disabled", message: "This feature is disabled for this host until authentication is configured." }, { status: 503, headers: h }),
    actor: null,
  };
}

/** Same decision for server components (uses the incoming Host header for the fallback). */
export async function actorForPage(): Promise<Actor> {
  const h = await headers();
  const host = h.get("host") ?? "";
  const synthetic = new Request(`http://${host || "localhost"}/`, { headers: { host } });
  return actorForRequest(synthetic);
}

/**
 * Page guard. Auth configured: redirect to /signin when there is no allowed session.
 * Fallback mode on a non-protected host: returns a notice reason instead of content.
 * Returns the actor when allowed, or { blocked: "disabled" } for the caller to render a notice.
 */
export async function requirePageAccess(nextPath: string): Promise<{ actor: Extract<Actor, { allowed: true }> } | { blocked: "disabled" }> {
  const actor = await actorForPage();
  if (actor.allowed) return { actor };
  if (actor.reason === "disabled") return { blocked: "disabled" };
  redirect(`/signin?next=${encodeURIComponent(nextPath)}${actor.reason === "forbidden" ? "&error=AccessDenied" : ""}`);
}
