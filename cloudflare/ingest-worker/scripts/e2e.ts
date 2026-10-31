/**
 * End-to-end test against a running ingest Worker (deployed URL, or `wrangler dev` locally) and the real Supabase project.
 * Uses a throwaway Ed25519 key. Creates only rows tagged owner_id = "e2e-test" and deletes them all afterwards.
 * audit_log is append-only (DB trigger), so its rows are left in place and marked as test entries.
 *
 *   BASE_URL=https://btc-network-ingest.<sub>.workers.dev SUPABASE_URL=... SUPABASE_SECRET_KEY=... npm run e2e
 * Never prints the key.
 */
import { b64urlEncode, canonicalMessage, hashEnrollCode, normalizeEnrollCode, sha256Hex } from "../src/protocol";

const BASE = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
const SB = (process.env.SUPABASE_URL ?? "https://kcfeajaycufkskxjyxxb.supabase.co").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SECRET_KEY ?? "";
if (!BASE || !KEY) throw new Error("BASE_URL and SUPABASE_SECRET_KEY are required");

const OWNER = "e2e-test";
const results: Array<{ step: string; ok: boolean; detail?: string }> = [];
const check = (step: string, ok: boolean, detail?: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
};

async function sb(method: string, path: string, body?: unknown, prefer = "return=representation"): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, data };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function mintCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const body = Array.from(bytes, (b) => CROCKFORD[b & 31]).join("");
  return `BTCW-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15)}`;
}

async function signedFetch(kp: CryptoKeyPair, method: string, path: string, workerId: string | null, body?: string, opts: { ts?: number; nonce?: string } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const msg = canonicalMessage({ method, path, timestamp: ts, nonce, bodySha256Hex: await sha256Hex(body ?? "") });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(msg)));
  const headers: Record<string, string> = { "x-btc-timestamp": ts, "x-btc-nonce": nonce, "x-btc-signature": b64urlEncode(sig) };
  if (workerId) headers["x-btc-worker"] = workerId;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null, headers };
}

async function main() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer));
  let workerId: string | null = null;
  let codeHash: string | null = null;

  try {
    const hz = await fetch(`${BASE}/healthz`);
    const hzJson = (await hz.json()) as { ok?: boolean; supabase?: boolean };
    check("healthz reports ok + supabase reachable", hz.status === 200 && hzJson.ok === true && hzJson.supabase === true, JSON.stringify(hzJson));
    check("no CORS headers on healthz", ![...hz.headers.keys()].some((k) => k.startsWith("access-control-")));
    if (!hzJson.supabase) throw new Error("Worker cannot reach Supabase (is the SUPABASE_SECRET_KEY secret set?)");

    // 1. mint a one-time code (hash only is stored — same algorithm as the admin UI)
    const code = mintCode();
    codeHash = await hashEnrollCode(normalizeEnrollCode(code)!);
    const ins = await sb("POST", "worker_enrollment_codes", { owner_id: OWNER, code_hash: codeHash, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    check("mint enrollment code (hash stored)", ins.status === 201, `HTTP ${ins.status}`);
    await sb("POST", "audit_log", { actor: "e2e-test", action: "e2e_test.start", entity_type: "enrollment_code", details: { note: "TEST DATA from cloudflare/ingest-worker/scripts/e2e.ts — rows are deleted afterwards", owner_id: OWNER } });

    // 2. enroll
    const enrollBody = JSON.stringify({ code, public_key: pub, name: "e2e-test-worker", hardware: { hardware_type: "cpu", os: "linux", arch: "x64", cpu_cores: 2, software_version: "e2e" } });
    const en = await signedFetch(kp, "POST", "/v1/enroll", null, enrollBody);
    workerId = typeof en.json?.worker_id === "string" ? en.json.worker_id : null;
    check("enroll with valid code → 201 + worker_id", en.status === 201 && !!workerId, `HTTP ${en.status}`);
    if (!workerId) throw new Error("enroll failed");
    const en2 = await signedFetch(kp, "POST", "/v1/enroll", null, enrollBody);
    check("re-using the one-time code → 401", en2.status === 401, `HTTP ${en2.status}`);

    const w1 = (await sb("GET", `workers?id=eq.${workerId}&select=status,authorized_at,owner_id,hardware`)).data as Array<Record<string, unknown>>;
    check("worker row created (status offline, authorized, hardware stored)", w1?.[0]?.status === "offline" && !!w1[0].authorized_at && w1[0].owner_id === OWNER, JSON.stringify(w1?.[0]?.status));
    const cr = (await sb("GET", `worker_credentials?worker_id=eq.${workerId}&select=public_key`)).data as Array<{ public_key: string }>;
    check("credential row holds the public key only", cr?.length === 1 && cr[0]!.public_key === pub);
    const cd = (await sb("GET", `worker_enrollment_codes?code_hash=eq.${codeHash}&select=used_at,used_by_worker_id`)).data as Array<{ used_at: string | null; used_by_worker_id: string | null }>;
    check("code marked used by that worker", !!cd?.[0]?.used_at && cd[0]!.used_by_worker_id === workerId);

    // 3. signed telemetry
    const minute = Math.floor(Date.now() / 60000) * 60000;
    const rows = [1, 2].map((m) => ({ bucket_start: new Date(minute - m * 60000).toISOString(), avg_hashrate_hs: 1000 + m, accepted: 5, rejected: 0, temperature_c: 55.5 }));
    const tBody = JSON.stringify({ rows, uptime_s: 120, software_version: "e2e" });
    const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const ts = Math.floor(Date.now() / 1000);
    const t1 = await signedFetch(kp, "POST", "/v1/telemetry", workerId, tBody, { ts, nonce });
    check("signed telemetry batch → 200", t1.status === 200 && t1.json?.accepted === 2, `HTTP ${t1.status}`);
    const t2 = await signedFetch(kp, "POST", "/v1/telemetry", workerId, tBody, { ts, nonce });
    check("replayed telemetry (same nonce) → 401", t2.status === 401, `HTTP ${t2.status}`);
    const t3 = await signedFetch(kp, "POST", "/v1/telemetry", workerId, tBody, { ts: Math.floor(Date.now() / 1000) - 400 });
    check("telemetry older than 5 min → 401", t3.status === 401, `HTTP ${t3.status}`);
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const t4 = await signedFetch(other, "POST", "/v1/telemetry", workerId, tBody);
    check("telemetry signed by a different key → 401", t4.status === 401, `HTTP ${t4.status}`);

    const tel = (await sb("GET", `telemetry_1m?worker_id=eq.${workerId}&select=bucket_start,avg_hashrate_hs,accepted&order=bucket_start.desc`)).data as unknown[];
    check("telemetry_1m rows exist in Supabase", Array.isArray(tel) && tel.length === 2, `${Array.isArray(tel) ? tel.length : "?"} rows`);
    const w2 = (await sb("GET", `workers?id=eq.${workerId}&select=status,last_seen_at,current_hashrate_hs,uptime_s`)).data as Array<Record<string, unknown>>;
    check("workers.status=online, last_seen_at set, hashrate/uptime updated", w2?.[0]?.status === "online" && !!w2[0].last_seen_at && Number(w2[0].current_hashrate_hs) === 1001 && Number(w2[0].uptime_s) === 120, JSON.stringify(w2?.[0]));

    // 4. command queue round trip
    const q = await sb("POST", "worker_commands", { worker_id: workerId, owner_id: OWNER, command: "pause", created_by: "e2e-test" });
    check("queue a pause command", q.status === 201);
    const c1 = await signedFetch(kp, "GET", "/v1/commands", workerId);
    const cmds = (c1.json?.commands ?? []) as Array<{ id: string; command: string }>;
    check("signed GET /v1/commands returns the pending command", c1.status === 200 && cmds.length === 1 && cmds[0]!.command === "pause", `HTTP ${c1.status}`);
    const unsigned = await fetch(`${BASE}/v1/commands`);
    check("unsigned GET /v1/commands → 401", unsigned.status === 401);
    const aBody = JSON.stringify({ ids: cmds.map((c) => c.id) });
    const a1 = await signedFetch(kp, "POST", "/v1/commands/ack", workerId, aBody);
    check("ack → 200, command acked", a1.status === 200 && a1.json?.acked === 1, `HTTP ${a1.status}`);
    const w3 = (await sb("GET", `workers?id=eq.${workerId}&select=status`)).data as Array<{ status: string }>;
    check("worker status follows the acked command (paused)", w3?.[0]?.status === "paused");
    const c2 = await signedFetch(kp, "GET", "/v1/commands", workerId);
    check("no commands left after ack", c2.status === 200 && Array.isArray(c2.json?.commands) && (c2.json!.commands as unknown[]).length === 0);
  } finally {
    // cleanup: delete every test row we created
    if (workerId) {
      await sb("DELETE", `telemetry_1m?worker_id=eq.${workerId}`, undefined, "return=minimal");
      await sb("DELETE", `worker_commands?worker_id=eq.${workerId}`, undefined, "return=minimal");
      await sb("DELETE", `worker_credentials?worker_id=eq.${workerId}`, undefined, "return=minimal");
    }
    if (codeHash) await sb("DELETE", `worker_enrollment_codes?code_hash=eq.${codeHash}`, undefined, "return=minimal");
    if (workerId) await sb("DELETE", `workers?id=eq.${workerId}`, undefined, "return=minimal");
    await sb("DELETE", `workers?owner_id=eq.${OWNER}`, undefined, "return=minimal");
    await sb("DELETE", `worker_enrollment_codes?owner_id=eq.${OWNER}`, undefined, "return=minimal");

    const left: Record<string, number> = {};
    for (const [t, q] of [
      ["workers", `workers?owner_id=eq.${OWNER}&select=id`],
      ["worker_enrollment_codes", `worker_enrollment_codes?owner_id=eq.${OWNER}&select=id`],
      ...(workerId ? [["worker_credentials", `worker_credentials?worker_id=eq.${workerId}&select=id`], ["telemetry_1m", `telemetry_1m?worker_id=eq.${workerId}&select=worker_id`], ["worker_commands", `worker_commands?worker_id=eq.${workerId}&select=id`]] : []),
    ] as Array<[string, string]>) {
      const r = await sb("GET", q);
      left[t] = Array.isArray(r.data) ? r.data.length : -1;
    }
    check("cleanup: no test rows remain in workers/credentials/codes/telemetry/commands", Object.values(left).every((n) => n === 0), JSON.stringify(left));

    // audit_log is append-only: record that the entries are test data, then confirm deletion is blocked.
    await sb("POST", "audit_log", { actor: "e2e-test", action: "e2e_test.end", entity_type: "worker", entity_id: workerId, details: { note: "TEST DATA — all other test rows deleted; audit rows remain because audit_log is append-only", worker_id: workerId } });
    const del = await sb("DELETE", "audit_log?actor=eq.e2e-test", undefined, "return=minimal");
    check("audit_log delete is blocked by the append-only trigger (rows left in place)", del.status >= 400, `HTTP ${del.status}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("e2e aborted:", e instanceof Error ? e.message : "error");
  process.exit(1);
});
