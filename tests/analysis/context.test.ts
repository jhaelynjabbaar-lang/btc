import { describe, expect, it } from "vitest";
import { buildContext, hasAnyData, renderContext, scaleHashrate, totalSignals } from "@/lib/analysis/context";
import { JOB_TYPES, BUDGET } from "@/lib/analysis/config";
import { looksSecret } from "@/lib/analysis/redact";
import { EMPTY, FULL, NOW, W1, W2, W3, W4 } from "./fixtures";

const factsOf = (ctx: ReturnType<typeof buildContext>, section: "worker_health" | "efficiency" | "cloud_spend") => ctx.sections[section]!.facts;
const metric = (ctx: ReturnType<typeof buildContext>, section: "worker_health" | "efficiency" | "cloud_spend", name: string) => factsOf(ctx, section).filter((f) => f.metric === name);

describe("context builder: empty database", () => {
  const ctx = buildContext(EMPTY, JOB_TYPES, NOW);
  it("marks every data-dependent section as NO DATA with no facts and no signals", () => {
    expect(hasAnyData(ctx)).toBe(false);
    expect(totalSignals(ctx)).toBe(0);
    for (const j of ["worker_health", "efficiency", "cloud_spend"] as const) {
      expect(ctx.sections[j]!.data).toBe(false);
      expect(ctx.sections[j]!.note).toMatch(/^NO DATA/);
      expect(ctx.sections[j]!.facts).toEqual([]);
    }
  });
  it("cloud with only seeded provider rows (no resources, no limits) is still NO DATA", () => {
    const c = buildContext({ ...EMPTY, providers: FULL.providers }, ["cloud_spend"], NOW);
    expect(c.sections.cloud_spend!.data).toBe(false);
  });
});

describe("context builder: real-looking data", () => {
  const ctx = buildContext(FULL, JOB_TYPES, NOW);

  it("worker_health flags exactly the anomalous workers and numbers come from the rows", () => {
    const sec = ctx.sections.worker_health!;
    expect(sec.data).toBe(true);
    const names = sec.entities.filter((e) => e.kind === "worker").map((e) => e.name);
    expect(names.sort()).toEqual(["test-rig-1", "test-rig-3"]); // rig-2 healthy, rig-4 is an efficiency case only
    const w1 = sec.entities.find((e) => e.stable_id === W1)!;
    const rr = metric(ctx, "worker_health", "recent_reject_rate_pct").find((f) => f.ref === w1.ref)!;
    expect(rr.value).toBe(20); // 20 / (80 + 20)
    const chg = metric(ctx, "worker_health", "hashrate_change_vs_own_baseline_pct").find((f) => f.ref === w1.ref)!;
    expect(chg.value).toBe(-60);
    const w3 = sec.entities.find((e) => e.stable_id === W3)!;
    expect(metric(ctx, "worker_health", "minutes_since_last_heartbeat").find((f) => f.ref === w3.ref)!.value).toBe(45);
    expect(metric(ctx, "worker_health", "signals").find((f) => f.ref === w3.ref)!.value).toBe("stale_heartbeat");
  });

  it("efficiency flags a worker below its OWN baseline, not a healthy one", () => {
    const sec = ctx.sections.efficiency!;
    expect(sec.entities.filter((e) => e.kind === "worker").map((e) => e.stable_id)).toEqual([W4]);
    expect(sec.entities.some((e) => e.stable_id === W2)).toBe(false);
    expect(metric(ctx, "efficiency", "hashrate_change_vs_own_baseline_pct")[0].value).toBe(-20);
  });

  it("cloud_spend reports spend vs caps from declared prices and flags a conditional policy that is not satisfied", () => {
    const sec = ctx.sections.cloud_spend!;
    expect(sec.data).toBe(true);
    expect(metric(ctx, "cloud_spend", "projected_monthly_committed_usd_known_prices_only")[0].value).toBe(73); // 0.1 * 730
    expect(metric(ctx, "cloud_spend", "global_cap_utilization_pct")[0].value).toBe(91.25);
    expect(metric(ctx, "cloud_spend", "signal").map((f) => f.value)).toContain("global_monthly_cap_near");
    const sig = metric(ctx, "cloud_spend", "signals").map((f) => String(f.value)).join(" ");
    expect(sig).toContain("conditional_policy_not_satisfied");
    expect(metric(ctx, "cloud_spend", "recorded_cloud_expenses_last_30d_usd")[0].value).toMatch(/^NO DATA/);
  });

  it("fact ids are unique and the section never mentions earnings, profit or revenue", () => {
    const ids = Object.values(ctx.sections).flatMap((s) => s!.facts.map((f) => f.id));
    for (const j of ["worker_health", "efficiency", "cloud_spend"] as const) {
      const sids = factsOf(ctx, j).map((f) => f.id);
      expect(new Set(sids).size).toBe(sids.length);
    }
    expect(ids.length).toBeGreaterThan(10);
    expect(renderContext(ctx)).not.toMatch(/earning|profit|revenue|payout|sats|reward/i);
  });

  it("respects the size budget even with many flagged workers", () => {
    const many = {
      ...FULL,
      workers: Array.from({ length: 60 }, (_, i) => ({ ...FULL.workers[2], id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `test-worker-with-a-long-name-${i}` })),
    };
    const c = buildContext(many, ["worker_health"], NOW);
    expect(renderContext(c).length).toBeLessThanOrEqual(BUDGET.maxContextChars);
    expect(() => JSON.parse(renderContext(c))).not.toThrow();
  });

  it("strips secret-like strings and secret-named keys from anything that reaches the context", () => {
    const dirty = { ...FULL, workers: [{ ...FULL.workers[2], name: "rig sk-or-v1-abcdef0123456789abcdef0123456789" }] };
    const text = renderContext(buildContext(dirty, JOB_TYPES, NOW));
    expect(text).not.toContain("sk-or-");
    expect(looksSecret(text)).toBe(false);
    expect(text).toContain("[redacted]");
  });
});

describe("hashrate scaling", () => {
  it("picks a readable unit", () => {
    expect(scaleHashrate(950)).toEqual({ value: 950, unit: "H/s" });
    expect(scaleHashrate(1_500_000)).toEqual({ value: 1.5, unit: "MH/s" });
    expect(scaleHashrate(0)).toEqual({ value: 0, unit: "H/s" });
  });
});
