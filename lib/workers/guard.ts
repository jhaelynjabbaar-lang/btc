import "server-only";
import { NextResponse } from "next/server";

export const NO_STORE = { "cache-control": "no-store" };

/** Defense in depth for cookie-authenticated POSTs: refuse a cross-origin Origin header. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser client; still needs the session cookie / fallback gate
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const forbiddenOrigin = () => NextResponse.json({ error: "forbidden", message: "Cross-origin request refused." }, { status: 403, headers: NO_STORE });
