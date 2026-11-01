import { MAX_BODY_BYTES, forwardHeaders, returnHeaders, route } from "./relay";

export interface Env {
  /** https origin of the Vercel app, e.g. https://btc-woad-three.vercel.app */
  UPSTREAM: string;
}

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const len = request.headers.get("content-length");
    const parsedLen = len === null ? null : Number(len);
    const d = route(request.method, url.pathname, env.UPSTREAM, parsedLen !== null && Number.isFinite(parsedLen) ? parsedLen : null);
    if (!d.ok) return new Response(JSON.stringify({ error: d.message }), { status: d.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const post = request.method.toUpperCase() === "POST";
    let body: ArrayBuffer | undefined;
    if (post) {
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return new Response(JSON.stringify({ error: "Body too large." }), { status: 413, headers: { "content-type": "application/json" } });
    }
    try {
      const up = await fetch(d.url, { method: request.method, headers: forwardHeaders(request.headers), body, redirect: "manual" });
      return new Response(up.body, { status: up.status, headers: returnHeaders(up.headers) });
    } catch {
      return new Response(JSON.stringify({ error: "Upstream unreachable." }), { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
  },
};

export default handler;
