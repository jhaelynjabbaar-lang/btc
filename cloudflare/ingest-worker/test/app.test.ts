import { describe, expect, it } from "vitest";
import { NOW, WORKER_ID, call, makeDeps, newKeyPair, row, signRequest, type KeyPair } from "./helpers";

async function setup(over: Parameters<typeof makeDeps>[0] = {}) {
  const kp = await newKeyPair();
  const ctx = makeDeps({ worker: { id: WORKER_ID, status: "online", keys: [kp.publicKeyB64u] }, ...over });
  return { kp, ...ctx };
}
async function postTelemetry(deps: ReturnType<typeof makeDeps>["deps"], kp: KeyPair, payload: unknown, sign: Parameters<typeof signRequest>[1] extends infer T ? Partial<T> : never = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = await signRequest(kp, { method: "POST", path: "/v1/telemetry", body, ...sign });
  return call(deps, "POST", "/v1/telemetry", { headers, body });
}
const good = { rows: [row(1), row(2)], uptime_s: 60 };

describe("POST /v1/telemetry", () => {
  it("accepts a signed batch and upserts via RPC", async () => {
    const { kp, deps, rpc } = await setup();
    const res = await postTelemetry(deps, kp, good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2 });
    expect(rpc).toHaveBeenCalledWith("ingest_telemetry", expect.objectContaining({ p_worker_id: WORKER_ID, p_uptime_s: 60 }));
    expect((rpc.mock.calls[0]![1] as { p_rows: unknown[] }).p_rows).toHaveLength(2);
  });

  it("rejects a replayed request (same nonce) with the generic 401", async () => {
    const { kp, deps, rpc } = await setup();
    const body = JSON.stringify(good);
    const headers = await signRequest(kp, { method: "POST", path: "/v1/telemetry", body });
    const first = await call(deps, "POST", "/v1/telemetry", { headers, body });
    const second = await call(deps, "POST", "/v1/telemetry", { headers, body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ error: "unauthorized" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("allows the same nonce for different workers (nonce store is per worker)", async () => {
    const { kp, deps } = await setup();
    const a = await postTelemetry(deps, kp, good, { nonce: "n".repeat(20) });
    expect(a.status).toBe(200);
    const replay = await postTelemetry(deps, kp, good, { nonce: "n".repeat(20) });
    expect(replay.status).toBe(401);
  });

  it("rejects requests older than 5 minutes, and far-future ones", async () => {
    const { kp, deps, rpc } = await setup();
    const sec = Math.floor(NOW / 1000);
    expect((await postTelemetry(deps, kp, good, { ts: sec - 301 })).status).toBe(401);
    expect((await postTelemetry(deps, kp, good, { ts: sec + 120 })).status).toBe(401);
    expect((await postTelemetry(deps, kp, good, { ts: sec - 200 })).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects a bad signature, a modified body, a wrong path/method and a wrong key", async () => {
    const { kp, deps, rpc } = await setup();
    const body = JSON.stringify(good);
    const headers = await signRequest(kp, { method: "POST", path: "/v1/telemetry", body });
    expect((await call(deps, "POST", "/v1/telemetry", { headers, body: JSON.stringify({ rows: [row(1, { avg_hashrate_hs: 9e9 })] }) })).status).toBe(401);
    const other = await signRequest(kp, { method: "POST", path: "/v1/commands/ack", body });
    expect((await call(deps, "POST", "/v1/telemetry", { headers: other, body })).status).toBe(401);
    const stranger = await newKeyPair();
    expect((await postTelemetry(deps, stranger, good)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects missing / malformed auth headers", async () => {
    const { kp, deps } = await setup();
    const body = JSON.stringify(good);
    const h = await signRequest(kp, { method: "POST", path: "/v1/telemetry", body });
    for (const drop of ["x-btc-worker", "x-btc-timestamp", "x-btc-nonce", "x-btc-signature"]) {
      const { [drop]: _removed, ...rest } = h;
      void _removed;
      expect((await call(deps, "POST", "/v1/telemetry", { headers: rest, body })).status).toBe(401);
    }
    expect((await call(deps, "POST", "/v1/telemetry", { headers: { ...h, "x-btc-nonce": "short" }, body })).status).toBe(401);
    expect((await call(deps, "POST", "/v1/telemetry", { headers: { ...h, "x-btc-worker": "not-a-uuid" }, body })).status).toBe(401);
  });

  it("treats unknown, revoked and key-less workers identically (401)", async () => {
    const kp = await newKeyPair();
    for (const worker of [null, { id: WORKER_ID, status: "revoked", keys: [kp.publicKeyB64u] }, { id: WORKER_ID, status: "online", keys: [] }]) {
      const { deps } = makeDeps({ worker });
      const res = await postTelemetry(deps, kp, good);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("validates input only after authentication (400) and never upserts invalid data", async () => {
    const { kp, deps, rpc } = await setup();
    expect((await postTelemetry(deps, kp, { rows: [] })).status).toBe(400);
    expect((await postTelemetry(deps, kp, { rows: [row(1, { accepted: -1 })] })).status).toBe(400);
    expect((await postTelemetry(deps, kp, "{not json")).status).toBe(400);
    expect((await postTelemetry(deps, kp, { rows: Array.from({ length: 121 }, (_, i) => row(i + 1)) })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("caps body size (413) before doing any work", async () => {
    const { kp, deps, db } = await setup();
    const big = JSON.stringify({ rows: [row(1)], software_version: "x".repeat(40_000) });
    const res = await postTelemetry(deps, kp, big);
    expect(res.status).toBe(413);
    expect(db.getWorkerAuth).not.toHaveBeenCalled();
  });

  it("requires application/json", async () => {
    const { kp, deps } = await setup();
    const body = JSON.stringify(good);
    const headers = { ...(await signRequest(kp, { method: "POST", path: "/v1/telemetry", body })), "content-type": "text/plain" };
    expect((await call(deps, "POST", "/v1/telemetry", { headers, body })).status).toBe(415);
  });

  it("rate limits per IP and per worker (429)", async () => {
    const a = await setup({ limited: { ip: true } });
    expect((await postTelemetry(a.deps, a.kp, good)).status).toBe(429);
    const b = await setup({ limited: { worker: true } });
    expect((await postTelemetry(b.deps, b.kp, good)).status).toBe(429);
    expect(b.rpc).not.toHaveBeenCalled();
  });

  it("returns a generic 500 (no internals) when the database fails", async () => {
    const { kp, deps } = await setup({ rpc: () => { throw new Error("password=hunter2 stack trace"); } });
    const res = await postTelemetry(deps, kp, good);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"server_error"}');
  });
});

describe("GET /v1/commands and POST /v1/commands/ack", () => {
  it("returns this worker's pending commands for a signed GET", async () => {
    const cmds = [{ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", command: "pause", created_at: "x", expires_at: "y" }];
    const { kp, deps, rpc } = await setup({ rpc: () => cmds });
    const headers = await signRequest(kp, { method: "GET", path: "/v1/commands" });
    const res = await call(deps, "GET", "/v1/commands", { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commands: cmds });
    expect(rpc).toHaveBeenCalledWith("claim_worker_commands", { p_worker_id: WORKER_ID, p_limit: 10 });
  });
  it("rejects an unsigned or replayed poll", async () => {
    const { kp, deps } = await setup({ rpc: () => [] });
    expect((await call(deps, "GET", "/v1/commands")).status).toBe(401);
    const headers = await signRequest(kp, { method: "GET", path: "/v1/commands" });
    expect((await call(deps, "GET", "/v1/commands", { headers })).status).toBe(200);
    expect((await call(deps, "GET", "/v1/commands", { headers })).status).toBe(401);
  });
  it("rejects a query string (not covered by the signature)", async () => {
    const { kp, deps } = await setup({ rpc: () => [] });
    const headers = await signRequest(kp, { method: "GET", path: "/v1/commands" });
    expect((await call(deps, "GET", "/v1/commands?worker=other", { headers })).status).toBe(400);
  });
  it("acks commands for the authenticated worker only", async () => {
    const { kp, deps, rpc } = await setup({ rpc: () => ({ ok: true, acked: 1 }) });
    const body = JSON.stringify({ ids: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"] });
    const headers = await signRequest(kp, { method: "POST", path: "/v1/commands/ack", body });
    const res = await call(deps, "POST", "/v1/commands/ack", { headers, body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, acked: 1 });
    expect(rpc).toHaveBeenCalledWith("ack_worker_commands", { p_worker_id: WORKER_ID, p_ids: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"] });
  });
});

describe("POST /v1/enroll", () => {
  const code = "BTCW-ABCDE-FGHJK-MNPQR-STVWX";
  async function enrollReq(kp: KeyPair, over: Record<string, unknown> = {}, signKp: KeyPair = kp) {
    const body = JSON.stringify({ code, public_key: kp.publicKeyB64u, name: "rig-01", hardware: { hardware_type: "cpu", os: "linux" }, ...over });
    const headers = await signRequest(signKp, { method: "POST", path: "/v1/enroll", body, workerId: null });
    return { headers, body };
  }
  it("enrolls with a valid code and proof of key possession", async () => {
    const kp = await newKeyPair();
    const { deps, rpc } = makeDeps({ rpc: () => ({ ok: true, worker_id: WORKER_ID, name: "rig-01" }) });
    const res = await call(deps, "POST", "/v1/enroll", await enrollReq(kp));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ worker_id: WORKER_ID, name: "rig-01" });
    const args = rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(args.p_code_hash).toMatch(/^[0-9a-f]{64}$/); // only the hash leaves the Worker
    expect(JSON.stringify(args)).not.toContain("ABCDE");
    expect(args.p_public_key).toBe(kp.publicKeyB64u);
  });
  it("gives one generic 401 for unknown / used / expired codes", async () => {
    const kp = await newKeyPair();
    const { deps } = makeDeps({ rpc: () => ({ ok: false, reason: "invalid_code" }) });
    const res = await call(deps, "POST", "/v1/enroll", await enrollReq(kp));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
  it("rejects enrollment when the request is not signed by the key being registered", async () => {
    const kp = await newKeyPair();
    const attacker = await newKeyPair();
    const { deps, rpc } = makeDeps();
    expect((await call(deps, "POST", "/v1/enroll", await enrollReq(kp, {}, attacker))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects stale enrollment requests and bad input", async () => {
    const kp = await newKeyPair();
    const { deps, rpc } = makeDeps();
    const body = JSON.stringify({ code, public_key: kp.publicKeyB64u, hardware: { hardware_type: "cpu" } });
    const stale = await signRequest(kp, { method: "POST", path: "/v1/enroll", body, workerId: null, ts: Math.floor(NOW / 1000) - 400 });
    expect((await call(deps, "POST", "/v1/enroll", { headers: stale, body })).status).toBe(401);
    expect((await call(deps, "POST", "/v1/enroll", await enrollReq(kp, { code: "garbage" }))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rate limits enrollment attempts per IP", async () => {
    const kp = await newKeyPair();
    const { deps } = makeDeps({ limited: { enroll: true } });
    expect((await call(deps, "POST", "/v1/enroll", await enrollReq(kp))).status).toBe(429);
  });
});

describe("transport, routing and CORS", () => {
  it("serves /healthz with a boolean Supabase check only", async () => {
    const { deps } = makeDeps();
    const res = await call(deps, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, supabase: true });
  });
  it("refuses plain HTTP", async () => {
    const { deps } = makeDeps();
    const res = await (await import("../src/app")).handle(new Request("http://x.example/healthz"), deps);
    expect(res.status).toBe(403);
  });
  it("never emits CORS headers and answers OPTIONS with 405", async () => {
    const { deps } = makeDeps();
    const pre = await call(deps, "OPTIONS", "/v1/telemetry", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(405);
    for (const res of [pre, await call(deps, "GET", "/healthz", { headers: { origin: "https://evil.example" } })]) {
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
  it("404s unknown paths (including prototype keys) and 405s wrong methods", async () => {
    const { deps } = makeDeps();
    expect((await call(deps, "GET", "/nope")).status).toBe(404);
    expect((await call(deps, "GET", "/__proto__")).status).toBe(404);
    expect((await call(deps, "GET", "/constructor")).status).toBe(404);
    expect((await call(deps, "GET", "/v1/telemetry")).status).toBe(405);
    expect((await call(deps, "POST", "/healthz")).status).toBe(405);
  });
});
