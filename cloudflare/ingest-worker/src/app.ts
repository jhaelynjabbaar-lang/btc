import {
  NONCE_RE,
  UUID_RE,
  canonicalMessage,
  checkTimestamp,
  hashEnrollCode,
  sha256Hex,
  verifyEd25519,
} from "./protocol";
import { DbError, type Db } from "./supabase";
import { MAX_ACK_BODY, MAX_ENROLL_BODY, MAX_TELEMETRY_BODY, parseAck, parseEnroll, parseTelemetry } from "./validate";

/** Everything the handler needs, injected so it can be unit-tested without Cloudflare bindings. */
export type Deps = {
  db: Db;
  limiters: { ip: Limiter; enroll: Limiter; worker: Limiter };
  /** True the first time (workerId, nonce) is seen, false on replay. */
  claimNonce: (workerId: string, nonce: string) => Promise<boolean>;
  now: () => number;
  /** Local development / tests only. */
  allowInsecureHttp?: boolean;
  log?: (event: Record<string, unknown>) => void;
};
export type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> };

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};
// NOTE: no access-control-* headers anywhere — CORS is closed. Browsers cannot call this API cross-origin;
// the only legitimate clients are native agents.

function json(status: number, body: unknown, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...extra } });
}
const E = {
  badRequest: () => json(400, { error: "invalid_request" }),
  unauthorized: () => json(401, { error: "unauthorized" }),
  notFound: () => json(404, { error: "not_found" }),
  tooLarge: () => json(413, { error: "payload_too_large" }),
  unsupported: () => json(415, { error: "unsupported_media_type" }),
  limited: () => json(429, { error: "rate_limited" }, { "retry-after": "30" }),
  server: () => json(500, { error: "server_error" }),
  unavailable: () => json(503, { error: "unavailable" }, { "retry-after": "30" }),
  method: (allow: string) => json(405, { error: "method_not_allowed" }, { allow }),
  https: () => json(403, { error: "https_required" }),
};

type Bytes = Uint8Array<ArrayBuffer>;

/** Read at most `max` bytes. Returns null when the body is larger. */
async function readBodyCapped(request: Request, max: number): Promise<Bytes | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function parseJson(bytes: Bytes): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}

async function allowed(l: Limiter, key: string, deps: Deps): Promise<boolean> {
  try {
    return (await l.limit({ key })).success;
  } catch {
    // Fail open on a limiter outage (availability), but leave a trace. Auth is still enforced for every request.
    deps.log?.({ event: "ratelimit_error" });
    return true;
  }
}

type AuthOk = { ok: true; workerId: string; body: Bytes };
type AuthFail = { ok: false; response: Response };

/**
 * Verify a signed worker request: header shape → timestamp window → worker lookup (revoked/unknown → same 401)
 * → Ed25519 signature → per-worker rate limit → nonce replay claim. Order matters: replay state is only touched
 * by requests that already carry a valid signature.
 */
async function authenticate(request: Request, url: URL, deps: Deps, maxBody: number): Promise<AuthOk | AuthFail> {
  const fail = (response: Response): AuthFail => ({ ok: false, response });
  const h = request.headers;
  const workerId = h.get("x-btc-worker");
  const nonce = h.get("x-btc-nonce");
  const signature = h.get("x-btc-signature");
  if (!workerId || !UUID_RE.test(workerId) || !nonce || !NONCE_RE.test(nonce) || !signature || signature.length > 128) return fail(E.unauthorized());
  const ts = checkTimestamp(h.get("x-btc-timestamp"), deps.now());
  if (!ts.ok) return fail(E.unauthorized());

  const body = await readBodyCapped(request, maxBody);
  if (body === null) return fail(E.tooLarge());

  const worker = await deps.db.getWorkerAuth(workerId);
  if (!worker || worker.status === "revoked" || worker.keys.length === 0) return fail(E.unauthorized());

  const message = canonicalMessage({
    method: request.method,
    path: url.pathname,
    timestamp: String(ts.ts),
    nonce,
    bodySha256Hex: await sha256Hex(body),
  });
  let valid = false;
  for (const key of worker.keys) {
    if (await verifyEd25519(key, signature, message)) valid = true; // evaluate all keys: no early-exit timing signal
  }
  if (!valid) return fail(E.unauthorized());

  if (!(await allowed(deps.limiters.worker, workerId, deps))) return fail(E.limited());
  if (!(await deps.claimNonce(workerId, nonce))) return fail(E.unauthorized()); // replay
  return { ok: true, workerId, body };
}

function requireJson(request: Request): boolean {
  const ct = request.headers.get("content-type") ?? "";
  return /^application\/json(\s*;\s*charset=utf-8)?$/i.test(ct.trim());
}

// ---------------------------------------------------------------- handlers
async function enroll(request: Request, url: URL, deps: Deps): Promise<Response> {
  if (!requireJson(request)) return E.unsupported();
  const body = await readBodyCapped(request, MAX_ENROLL_BODY);
  if (body === null) return E.tooLarge();

  const parsed = parseEnroll(parseJson(body));
  if (!parsed.ok) return E.badRequest();
  const req = parsed.value;

  // Proof of possession: the agent signs the request with the private half of the public key it is registering.
  const nonce = request.headers.get("x-btc-nonce");
  const signature = request.headers.get("x-btc-signature");
  const ts = checkTimestamp(request.headers.get("x-btc-timestamp"), deps.now());
  if (!nonce || !NONCE_RE.test(nonce) || !signature || signature.length > 128 || !ts.ok) return E.unauthorized();
  const message = canonicalMessage({ method: request.method, path: url.pathname, timestamp: String(ts.ts), nonce, bodySha256Hex: await sha256Hex(body) });
  if (!(await verifyEd25519(req.public_key, signature, message))) return E.unauthorized();

  const codeHash = await hashEnrollCode(req.code);
  const keyHash = (await sha256Hex(req.public_key)).slice(0, 8);
  const result = await deps.db.rpc<{ ok: boolean; worker_id?: string; name?: string }>("enroll_worker", {
    p_code_hash: codeHash,
    p_public_key: req.public_key,
    p_name: req.name ?? `worker-${keyHash}`,
    p_hardware_type: req.hardware_type,
    p_os: req.os,
    p_software_version: req.software_version,
    p_hardware: req.hardware,
  });
  if (!result.ok || !result.worker_id) return E.unauthorized(); // unknown / used / expired code: indistinguishable
  deps.log?.({ event: "enrolled", worker_id: result.worker_id });
  return json(201, { worker_id: result.worker_id, name: result.name });
}

async function telemetry(request: Request, url: URL, deps: Deps): Promise<Response> {
  if (!requireJson(request)) return E.unsupported();
  const auth = await authenticate(request, url, deps, MAX_TELEMETRY_BODY);
  if (!auth.ok) return auth.response;
  const parsed = parseTelemetry(parseJson(auth.body), deps.now());
  if (!parsed.ok) return E.badRequest();
  const { rows, uptime_s, software_version } = parsed.value;
  await deps.db.rpc("ingest_telemetry", { p_worker_id: auth.workerId, p_rows: rows, p_uptime_s: uptime_s, p_software_version: software_version });
  return json(200, { ok: true, accepted: rows.length });
}

async function commands(request: Request, url: URL, deps: Deps): Promise<Response> {
  const auth = await authenticate(request, url, deps, 0);
  if (!auth.ok) return auth.response;
  const list = await deps.db.rpc<unknown[]>("claim_worker_commands", { p_worker_id: auth.workerId, p_limit: 10 });
  return json(200, { commands: list });
}

async function ack(request: Request, url: URL, deps: Deps): Promise<Response> {
  if (!requireJson(request)) return E.unsupported();
  const auth = await authenticate(request, url, deps, MAX_ACK_BODY);
  if (!auth.ok) return auth.response;
  const parsed = parseAck(parseJson(auth.body));
  if (!parsed.ok) return E.badRequest();
  const res = await deps.db.rpc<{ acked: number }>("ack_worker_commands", { p_worker_id: auth.workerId, p_ids: parsed.value.ids });
  return json(200, { ok: true, acked: res.acked });
}

// ------------------------------------------------------------------ router
export async function handle(request: Request, deps: Deps): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && !deps.allowInsecureHttp) return E.https();

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await allowed(deps.limiters.ip, ip, deps))) return E.limited();

    const path = url.pathname;
    const method = request.method;

    if (path === "/healthz") {
      if (method !== "GET" && method !== "HEAD") return E.method("GET, HEAD");
      return json(200, { ok: true, supabase: await deps.db.ping() });
    }

    const routes: Record<string, { method: "GET" | "POST"; run: (r: Request, u: URL, d: Deps) => Promise<Response> }> = {
      "/v1/enroll": { method: "POST", run: enroll },
      "/v1/telemetry": { method: "POST", run: telemetry },
      "/v1/commands": { method: "GET", run: commands },
      "/v1/commands/ack": { method: "POST", run: ack },
    };
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (!route) return E.notFound();
    if (method !== route.method) return E.method(route.method);
    if (url.search) return E.badRequest(); // the query string is not covered by the signature, so none is accepted
    if (path === "/v1/enroll" && !(await allowed(deps.limiters.enroll, ip, deps))) return E.limited();
    return await route.run(request, url, deps);
  } catch (err) {
    deps.log?.({ event: "error", kind: err instanceof DbError ? "db" : "internal", status: err instanceof DbError ? err.status : undefined });
    return E.server();
  }
}

