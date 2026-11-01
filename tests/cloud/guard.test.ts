import { describe, expect, it } from "vitest";
import { evaluateSpend, HOURS_PER_MONTH, type LimitRow } from "@/lib/cloud/guard";

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const lim = (scope: "global" | "provider", period: "hour" | "month", limit_usd: number, provider_id: string | null = null, enabled = true): LimitRow => ({ scope, provider_id, period, limit_usd, enabled });
const cand = (hourly: number, extra: Partial<{ id: string; provider_id: string; cost_known: boolean }> = {}) => ({ provider_id: P1, hourly_price_usd: hourly, cost_known: true, ...extra });

describe("spend guard", () => {
  it("defaults to 0: with no limits even a $0.01/h resource is rejected", () => {
    expect(evaluateSpend([], [], cand(0.01))).toMatchObject({ ok: false, reason: "hourly_cap_exceeded", capUsd: 0 });
  });
  it("a disabled limit counts as 0", () => {
    const limits = [lim("global", "hour", 5, null, false), lim("global", "month", 5000, null, false)];
    expect(evaluateSpend(limits, [], cand(1)).ok).toBe(false);
  });
  it("rejects an unknown cost whatever the caps are", () => {
    const limits = [lim("global", "hour", 1000), lim("global", "month", 1e6), lim("provider", "month", 1e6, P1)];
    expect(evaluateSpend(limits, [], { provider_id: P1, hourly_price_usd: 0, cost_known: false })).toEqual({ ok: false, reason: "cost_unknown" });
  });
  it("enforces the per-resource hourly cap (smallest applicable cap wins)", () => {
    const limits = [lim("global", "hour", 2), lim("provider", "hour", 0.5, P1), lim("global", "month", 1e6), lim("provider", "month", 1e6, P1)];
    expect(evaluateSpend(limits, [], cand(0.5)).ok).toBe(true);
    expect(evaluateSpend(limits, [], cand(0.51))).toMatchObject({ ok: false, reason: "hourly_cap_exceeded", capUsd: 0.5 });
    expect(evaluateSpend(limits, [], cand(1.5, { provider_id: P2 })).ok).toBe(false); // P2 has no monthly cap (default 0)
  });
  it("projects monthly spend as hourly x 730 and compares with the global cap", () => {
    const limits = [lim("global", "hour", 1), lim("global", "month", 730), lim("provider", "month", 730, P1)];
    expect(HOURS_PER_MONTH).toBe(730);
    expect(evaluateSpend(limits, [], cand(1)).ok).toBe(true); // exactly at the cap passes
    expect(evaluateSpend(limits, [], cand(1.0001))).toMatchObject({ ok: false });
    expect(evaluateSpend([lim("global", "hour", 1), lim("global", "month", 729.99), lim("provider", "month", 1e6, P1)], [], cand(1))).toMatchObject({ ok: false, reason: "global_monthly_cap_exceeded" });
  });
  it("adds already committed resources, but not the candidate itself", () => {
    const limits = [lim("global", "hour", 1), lim("global", "month", 1000), lim("provider", "month", 1000, P1)];
    const committed = [{ id: "a", provider_id: P1, hourly_price_usd: 1 }];
    expect(evaluateSpend(limits, committed, cand(0.5, { id: "b" }))).toMatchObject({ ok: false, reason: "global_monthly_cap_exceeded", committedUsd: 730, requestedUsd: 365 });
    expect(evaluateSpend(limits, committed, cand(1, { id: "a" })).ok).toBe(true); // re-checking itself (e.g. start) does not double count
  });
  it("enforces the provider monthly cap separately from the global cap", () => {
    const limits = [lim("global", "hour", 1), lim("global", "month", 1e6), lim("provider", "month", 100, P1)];
    expect(evaluateSpend(limits, [], cand(0.2))).toMatchObject({ ok: false, reason: "provider_monthly_cap_exceeded", capUsd: 100 });
    expect(evaluateSpend(limits, [{ id: "x", provider_id: P2, hourly_price_usd: 1 }], cand(0.1)).ok).toBe(true); // other provider's spend does not count here
  });
  it("is not fooled by float drift", () => {
    const limits = [lim("global", "hour", 0.1), lim("global", "month", 73), lim("provider", "month", 73, P1)];
    expect(evaluateSpend(limits, [], cand(0.1)).ok).toBe(true);
  });
});
