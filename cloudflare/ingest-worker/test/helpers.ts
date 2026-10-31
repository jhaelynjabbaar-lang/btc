import { vi } from "vitest";
import { handle, type Deps, type Limiter } from "../src/app";
import { b64urlEncode, canonicalMessage, sha256Hex } from "../src/protocol";
import type { Db, WorkerAuth } from "../src/supabase";

export const WORKER_ID = "11111111-2222-4333-8444-555555555555";
export const NOW = Date.UTC(2026, 9, 31, 20, 0, 0); // fixed clock
export const BASE = "https://btc-network-ingest.example.workers.dev";

export async function newKeyPair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  return { privateKey: kp.privateKey, publicKeyB64u: b64urlEncode(raw) };
}
export type KeyPair = Awaited<ReturnType<typeof newKeyPair>>;

export async function signRequest(
  kp: KeyPair,
  o: { method: string; path: string; body?: string; ts?: number; nonce?: string; workerId?: string | null },
): Promise<Record<string, string>> {
  const ts = String(o.ts ?? Math.floor(NOW / 1000));
  const nonce = o.nonce ?? b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const msg = canonicalMessage({ method: o.method, path: o.path, timestamp: ts, nonce, bodySha256Hex: await sha256Hex(o.body ?? "") });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(msg)));
  const h: Record<string, string> = { "x-btc-timestamp": ts, "x-btc-nonce": nonce, "x-btc-signature": b64urlEncode(sig) };
  if (o.workerId !== null) h["x-btc-worker"] = o.workerId ?? WORKER_ID;
  if (o.body !== undefined) h["content-type"] = "application/json";
  return h;
}

export function makeDeps(opts: { worker?: WorkerAuth | null; rpc?: (fn: string, args: Record<string, unknown>) => unknown; limited?: Partial<Record<"ip" | "enroll" | "worker", boolean>> } = {}) {
  const seen = new Set<string>();
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => (opts.rpc ? opts.rpc(fn, args) : { ok: true }));
  const db: Db = {
    rpc: rpc as unknown as Db["rpc"],
    getWorkerAuth: vi.fn(async () => opts.worker ?? null),
    ping: vi.fn(async () => true),
  };
  const lim = (blocked?: boolean): Limiter => ({ limit: vi.fn(async () => ({ success: !blocked })) });
  const deps: Deps = {
    db,
    limiters: { ip: lim(opts.limited?.ip), enroll: lim(opts.limited?.enroll), worker: lim(opts.limited?.worker) },
    claimNonce: vi.fn(async (w: string, n: string) => {
      const k = `${w}:${n}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    now: () => NOW,
  };
  return { deps, rpc, db };
}

export function call(deps: Deps, method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  return handle(new Request(BASE + path, { method, headers: init.headers, body: init.body }), deps);
}

export function bucket(minutesAgo: number): string {
  return new Date(Math.floor(NOW / 60000) * 60000 - minutesAgo * 60000).toISOString();
}
export function row(minutesAgo: number, extra: Record<string, unknown> = {}) {
  return { bucket_start: bucket(minutesAgo), avg_hashrate_hs: 1234.5, accepted: 10, rejected: 1, ...extra };
}
