import "server-only";
import { getSupabaseServer } from "@/lib/supabase/server";
import { braiinsToken, fetchPoolWorkers, type BraiinsResult, type PoolWorker } from "@/lib/profit/braiins";
import { summarize, unmatchedPoolWorkers, verifyWorker, type AgentCounts, type PoolAvailability, type VerificationSummary, type WorkerVerification } from "./verdict";

/** Server-only wiring for Phase 9. Read-only: it writes nothing (no ledger, no audit rows, no commands). */

export const AGENT_WINDOW_MIN = 60;
const TELEMETRY_ROW_CAP = 1000; // PostgREST returns at most this many rows per request; we say so when we hit it.
const POOL_MEMO_MS = 60_000; // the pool allows about one request per 5 s

let memo: { at: number; value: BraiinsResult<PoolWorker[]> } | null = null;

async function loadPool(now: number): Promise<PoolAvailability> {
  const token = braiinsToken();
  if (!token) return { ok: false, reason: "not_connected" };
  if (!memo || now - memo.at > POOL_MEMO_MS) memo = { at: now, value: await fetchPoolWorkers(fetch, token) };
  return memo.value.ok ? { ok: true, workers: memo.value.data } : { ok: false, reason: memo.value.error };
}

export type VerificationView = {
  now: string;
  pool: { connected: boolean; ok: boolean; error: string | null; workerCount: number | null };
  summary: VerificationSummary;
  rows: WorkerVerification[];
  unmatchedPool: PoolWorker[];
  telemetryTruncated: boolean;
  agentWindowMin: number;
};

export async function loadVerification(): Promise<VerificationView> {
  const nowDate = new Date();
  const db = getSupabaseServer();
  const since = new Date(nowDate.getTime() - AGENT_WINDOW_MIN * 60_000).toISOString();
  const [workers, telemetry, pool] = await Promise.all([
    db.from("workers").select("id, name, status, last_seen_at").neq("status", "revoked").order("created_at", { ascending: true }).limit(200),
    db.from("telemetry_1m").select("worker_id, accepted, rejected").gte("bucket_start", since).limit(TELEMETRY_ROW_CAP),
    loadPool(nowDate.getTime()),
  ]);
  if (workers.error || telemetry.error) throw new Error("verification query failed");

  const counts = new Map<string, AgentCounts>();
  for (const t of telemetry.data ?? []) {
    const c = counts.get(t.worker_id) ?? { accepted: 0, rejected: 0, buckets: 0 };
    c.accepted += Number(t.accepted);
    c.rejected += Number(t.rejected);
    c.buckets += 1;
    counts.set(t.worker_id, c);
  }
  const rows = (workers.data ?? []).map((w) => verifyWorker({ worker: w, pool, agent: counts.get(w.id) ?? null, windowMin: AGENT_WINDOW_MIN, now: nowDate }));
  return {
    now: nowDate.toISOString(),
    pool: { connected: !(!pool.ok && pool.reason === "not_connected"), ok: pool.ok, error: pool.ok ? null : pool.reason, workerCount: pool.ok ? pool.workers.length : null },
    summary: summarize(rows),
    rows,
    unmatchedPool: pool.ok ? unmatchedPoolWorkers(workers.data ?? [], pool.workers) : [],
    telemetryTruncated: (telemetry.data ?? []).length >= TELEMETRY_ROW_CAP,
    agentWindowMin: AGENT_WINDOW_MIN,
  };
}
