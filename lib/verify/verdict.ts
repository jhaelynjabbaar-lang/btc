import type { PoolWorker } from "@/lib/profit/braiins";

/**
 * Phase 9: mining verification. The ONLY thing that can make a worker "Pool-verified" is the pool's own Worker API reporting a
 * recent accepted share for a worker whose name matches. Agent telemetry is shown next to it as "agent-reported" and is never
 * promoted to a mining claim. Pure functions, no I/O, no secrets.
 */

/** A pool worker whose last accepted share is at most this old counts as currently verified. */
export const VERIFY_FRESH_MS = 15 * 60 * 1000;
/** An enrolled worker whose last telemetry is older than this is "silent". */
export const AGENT_SILENT_MS = 5 * 60 * 1000;

export type Verdict =
  | "pool_verified" //   pool lists the worker and its last accepted share is recent
  | "pool_stale" //      pool lists the worker but its last accepted share is old or missing
  | "pool_not_seen" //   pool answered, no worker with this name
  | "pool_ambiguous" //  pool answered, several workers match this name: cannot attribute shares
  | "pool_unavailable"; // no token, or the pool request failed: nothing is verified

export type PoolAvailability = { ok: true; workers: readonly PoolWorker[] } | { ok: false; reason: "not_connected" | "token_rejected" | "timeout" | "network_error" | "invalid_response" | string };

export type EnrolledWorker = { id: string; name: string; status: string; last_seen_at: string | null };
export type AgentCounts = { accepted: number; rejected: number; buckets: number };

export type WorkerVerification = {
  workerId: string;
  name: string;
  verdict: Verdict;
  /** Short plain-English reason, always shown with the verdict. */
  reason: string;
  poolWorker: PoolWorker | null;
  lastShareAgeMs: number | null;
  agent: { accepted: number; rejected: number; buckets: number; windowMin: number } | null;
  agentSilent: boolean;
  /** Agent reports accepted shares in the window but the pool does not confirm them: show as a warning, never as success. */
  agentClaimUnconfirmed: boolean;
};

/** The part of a pool worker name after the account: "jhaelyngta.rig1" -> "rig1". A name without a dot is its own worker part. */
export const workerPart = (poolName: string): string => {
  const i = poolName.indexOf(".");
  return (i === -1 ? poolName : poolName.slice(i + 1)).trim().toLowerCase();
};

/** Exact (case-insensitive) match of the enrolled worker's name against the worker part, or the full pool name. No fuzzy matching. */
export function matchPoolWorkers(name: string, pool: readonly PoolWorker[]): PoolWorker[] {
  const n = name.trim().toLowerCase();
  if (!n) return [];
  return pool.filter((p) => workerPart(p.name) === n || p.name.trim().toLowerCase() === n);
}

const UNAVAILABLE_TEXT: Record<string, string> = {
  not_connected: "Pool not connected (BRAIINS_POOL_TOKEN is not set), so nothing can be pool-verified.",
  token_rejected: "The pool rejected the token, so nothing can be pool-verified.",
  timeout: "The pool did not answer in time, so nothing can be pool-verified.",
  network_error: "The pool could not be reached, so nothing can be pool-verified.",
  invalid_response: "The pool answered in an unexpected shape, so nothing can be pool-verified.",
};

export function verifyWorker(args: { worker: EnrolledWorker; pool: PoolAvailability; agent: AgentCounts | null; windowMin: number; now: Date }): WorkerVerification {
  const { worker, pool, agent, windowMin, now } = args;
  const lastSeen = worker.last_seen_at ? Date.parse(worker.last_seen_at) : NaN;
  const agentSilent = worker.status === "online" && (!Number.isFinite(lastSeen) || now.getTime() - lastSeen > AGENT_SILENT_MS);
  const agentView = agent ? { accepted: agent.accepted, rejected: agent.rejected, buckets: agent.buckets, windowMin } : null;
  const base = { workerId: worker.id, name: worker.name, agent: agentView, agentSilent, poolWorker: null as PoolWorker | null, lastShareAgeMs: null as number | null };
  const agentClaims = (agent?.accepted ?? 0) > 0;

  if (!pool.ok) {
    return { ...base, verdict: "pool_unavailable", reason: UNAVAILABLE_TEXT[pool.reason] ?? "The pool request failed, so nothing can be pool-verified.", agentClaimUnconfirmed: agentClaims };
  }
  const matches = matchPoolWorkers(worker.name, pool.workers);
  if (matches.length === 0) {
    return {
      ...base,
      verdict: "pool_not_seen",
      reason: `The pool lists no worker named "${worker.name}". Either it has not submitted a share, or the agent's pool worker name differs from this enrolled name.`,
      agentClaimUnconfirmed: agentClaims,
    };
  }
  if (matches.length > 1) {
    return { ...base, verdict: "pool_ambiguous", reason: `${matches.length} pool workers match "${worker.name}"; shares cannot be attributed to one machine.`, agentClaimUnconfirmed: agentClaims };
  }
  const pw = matches[0];
  const age = pw.lastShareTs === null ? null : Math.max(0, now.getTime() - pw.lastShareTs * 1000);
  const fresh = age !== null && age <= VERIFY_FRESH_MS;
  if (fresh) {
    return { ...base, poolWorker: pw, lastShareAgeMs: age, verdict: "pool_verified", reason: "The pool reports an accepted share from this worker within the last 15 minutes.", agentClaimUnconfirmed: false };
  }
  return {
    ...base,
    poolWorker: pw,
    lastShareAgeMs: age,
    verdict: "pool_stale",
    reason: age === null ? "The pool lists this worker but reports no accepted share." : "The pool's last accepted share from this worker is older than 15 minutes.",
    agentClaimUnconfirmed: agentClaims,
  };
}

/** Pool workers (of the whole account) that match no enrolled worker: shown so a name mismatch is visible instead of hidden. */
export function unmatchedPoolWorkers(enrolled: readonly { name: string }[], pool: readonly PoolWorker[]): PoolWorker[] {
  const claimed = new Set<string>();
  for (const e of enrolled) for (const m of matchPoolWorkers(e.name, pool)) claimed.add(m.name);
  return pool.filter((p) => !claimed.has(p.name));
}

export type VerificationSummary = { total: number; poolVerified: number; notVerified: number; agentClaimsUnconfirmed: number };
export function summarize(rows: readonly WorkerVerification[]): VerificationSummary {
  return {
    total: rows.length,
    poolVerified: rows.filter((r) => r.verdict === "pool_verified").length,
    notVerified: rows.filter((r) => r.verdict !== "pool_verified").length,
    agentClaimsUnconfirmed: rows.filter((r) => r.agentClaimUnconfirmed).length,
  };
}
