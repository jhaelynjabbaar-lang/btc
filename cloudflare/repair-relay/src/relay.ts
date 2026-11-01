/**
 * Pure relay logic (no Cloudflare types) so it can be unit tested from the repo root.
 * The relay exists only because Windows 7's TLS stack cannot negotiate with Vercel's edge. It forwards a FIXED set of
 * method+path pairs to the upstream app and nothing else. It holds no secrets and never executes anything.
 */
export const MAX_BODY_BYTES = 16384;

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const ROUTES: { method: string; path: RegExp }[] = [
  { method: "GET", path: /^\/r$/ },
  { method: "GET", path: /^\/api\/repair\/ping$/ },
  { method: "GET", path: /^\/api\/repair\/suggestions$/ },
  { method: "POST", path: /^\/api\/repair\/pair$/ },
  { method: "POST", path: /^\/api\/repair\/report$/ },
  { method: "POST", path: new RegExp(`^/api/repair/suggestions/${UUID}/ack$`) },
];

export type Decision = { ok: true; url: string } | { ok: false; status: number; message: string };

/** Decide whether a request may be forwarded and to which URL. The query string is dropped on purpose. */
export function route(method: string, pathname: string, upstream: string, contentLength: number | null): Decision {
  let base: URL;
  try {
    base = new URL(upstream);
  } catch {
    return { ok: false, status: 500, message: "Relay is not configured." };
  }
  if (base.protocol !== "https:") return { ok: false, status: 500, message: "Relay is not configured." };
  const m = method.toUpperCase();
  const known = ROUTES.filter((r) => r.path.test(pathname));
  if (known.length === 0) return { ok: false, status: 404, message: "Not found." };
  if (!known.some((r) => r.method === m)) return { ok: false, status: 405, message: "Method not allowed." };
  if (m === "POST" && (contentLength === null || contentLength > MAX_BODY_BYTES)) return { ok: false, status: 413, message: "Body too large or missing length." };
  return { ok: true, url: `${base.origin}${pathname}` };
}

const FORWARD = ["content-type", "authorization", "user-agent", "accept"];
const RETURN = ["content-type", "content-disposition", "x-content-sha256", "retry-after"];

export function forwardHeaders(incoming: Headers): Headers {
  const h = new Headers();
  for (const k of FORWARD) {
    const v = incoming.get(k);
    if (v) h.set(k, v);
  }
  return h;
}

export function returnHeaders(upstream: Headers): Headers {
  const h = new Headers();
  for (const k of RETURN) {
    const v = upstream.get(k);
    if (v) h.set(k, v);
  }
  h.set("cache-control", "no-store");
  h.set("x-content-type-options", "nosniff");
  h.set("x-repair-relay", "1");
  return h;
}
