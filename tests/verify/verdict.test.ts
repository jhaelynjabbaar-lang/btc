import { describe, expect, it } from "vitest";
import type { PoolWorker } from "@/lib/profit/braiins";
import { matchPoolWorkers, summarize, unmatchedPoolWorkers, verifyWorker, workerPart, type PoolAvailability } from "@/lib/verify/verdict";

const NOW = new Date("2026-11-01T18:00:00.000Z");
const ts = (minAgo: number) => Math.floor(NOW.getTime() / 1000) - minAgo * 60;
const pw = (name: string, lastShareMinAgo: number | null, extra: Partial<PoolWorker> = {}): PoolWorker => ({
  label: "Pool-reported", name, state: "ok", lastShareTs: lastShareMinAgo === null ? null : ts(lastShareMinAgo), hashRateUnit: "Mh/s", hashRate5m: 1, shares5m: 3, shares60m: 30, shares24h: 700, ...extra,
});
const ok = (...w: PoolWorker[]): PoolAvailability => ({ ok: true, workers: w });
const worker = (name: string, extra = {}) => ({ id: `id-${name}`, name, status: "online", last_seen_at: new Date(NOW.getTime() - 60_000).toISOString(), ...extra });
const run = (name: string, pool: PoolAvailability, agent: { accepted: number; rejected: number; buckets: number } | null = null, extra = {}) =>
  verifyWorker({ worker: worker(name, extra), pool, agent, windowMin: 60, now: NOW });

describe("name matching", () => {
  it("takes the part after the account and compares exactly, case-insensitively", () => {
    expect(workerPart("jhaelyngta.Rig1")).toBe("rig1");
    expect(workerPart("lonely")).toBe("lonely");
    expect(matchPoolWorkers("rig1", [pw("jhaelyngta.RIG1", 1)])).toHaveLength(1);
    expect(matchPoolWorkers("rig", [pw("jhaelyngta.rig1", 1)])).toHaveLength(0); // no fuzzy/prefix matching
    expect(matchPoolWorkers("  ", [pw("jhaelyngta.rig1", 1)])).toHaveLength(0);
  });
});

describe("verifyWorker", () => {
  it("is pool_verified only for a matching worker with a recent accepted share", () => {
    const r = run("rig1", ok(pw("jhaelyngta.rig1", 3)));
    expect(r.verdict).toBe("pool_verified");
    expect(r.lastShareAgeMs).toBe(3 * 60_000);
    expect(r.agentClaimUnconfirmed).toBe(false);
  });
  it("is pool_stale when the last share is older than 15 minutes, or missing", () => {
    expect(run("rig1", ok(pw("jhaelyngta.rig1", 16))).verdict).toBe("pool_stale");
    expect(run("rig1", ok(pw("jhaelyngta.rig1", 15))).verdict).toBe("pool_verified");
    const none = run("rig1", ok(pw("jhaelyngta.rig1", null)));
    expect(none.verdict).toBe("pool_stale");
    expect(none.lastShareAgeMs).toBeNull();
  });
  it("is pool_not_seen when the pool answers without that worker", () => {
    expect(run("rig1", ok(pw("jhaelyngta.other", 1))).verdict).toBe("pool_not_seen");
    expect(run("rig1", ok()).verdict).toBe("pool_not_seen");
  });
  it("is pool_ambiguous when several pool workers match", () => {
    expect(run("rig1", ok(pw("a.rig1", 1), pw("b.rig1", 1))).verdict).toBe("pool_ambiguous");
  });
  it("verifies nothing when the pool is unavailable, whatever the agent says", () => {
    for (const reason of ["not_connected", "token_rejected", "timeout", "network_error", "invalid_response", "http_500"]) {
      const r = run("rig1", { ok: false, reason }, { accepted: 500, rejected: 0, buckets: 60 });
      expect(r.verdict).toBe("pool_unavailable");
      expect(r.agentClaimUnconfirmed).toBe(true);
    }
  });
  it("never promotes agent-reported shares to a verification", () => {
    const r = run("rig1", ok(pw("jhaelyngta.rig1", 120)), { accepted: 999, rejected: 0, buckets: 60 });
    expect(r.verdict).not.toBe("pool_verified");
    expect(r.agentClaimUnconfirmed).toBe(true);
    expect(r.agent).toEqual({ accepted: 999, rejected: 0, buckets: 60, windowMin: 60 });
  });
  it("does not flag a claim when the agent reported no accepted shares", () => {
    expect(run("rig1", ok(), { accepted: 0, rejected: 2, buckets: 5 }).agentClaimUnconfirmed).toBe(false);
    expect(run("rig1", ok(), null).agent).toBeNull();
  });
  it("treats a pool timestamp slightly in the future (clock skew) as fresh, not negative", () => {
    const r = run("rig1", ok(pw("jhaelyngta.rig1", -2)));
    expect(r.verdict).toBe("pool_verified");
    expect(r.lastShareAgeMs).toBe(0);
  });
  it("flags a silent agent only for an online worker without recent telemetry", () => {
    expect(run("rig1", ok(), null, { last_seen_at: new Date(NOW.getTime() - 6 * 60_000).toISOString() }).agentSilent).toBe(true);
    expect(run("rig1", ok(), null, { last_seen_at: null }).agentSilent).toBe(true);
    expect(run("rig1", ok(), null, { status: "paused", last_seen_at: null }).agentSilent).toBe(false);
    expect(run("rig1", ok()).agentSilent).toBe(false);
  });
});

describe("unmatched pool workers and summary", () => {
  it("lists pool workers that match no enrolled worker", () => {
    const pool = [pw("jhaelyngta.rig1", 1), pw("jhaelyngta.win7", 1)];
    expect(unmatchedPoolWorkers([{ name: "rig1" }], pool).map((p) => p.name)).toEqual(["jhaelyngta.win7"]);
  });
  it("counts verified and not-verified separately", () => {
    const rows = [run("a", ok(pw("x.a", 1))), run("b", ok(pw("x.b", 99)), { accepted: 5, rejected: 0, buckets: 5 }), run("c", { ok: false, reason: "not_connected" })];
    expect(summarize(rows)).toEqual({ total: 3, poolVerified: 1, notVerified: 2, agentClaimsUnconfirmed: 1 });
  });
});
