import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@/lib/paper/config";
import { feeFor, markCents, simulateBuy, simulateSell } from "@/lib/paper/execution";

const cfg = DEFAULT_CONFIG; // 0.60% fee, 0.05% slippage, $1 minimum

describe("fees", () => {
  it("rounds the fee UP to the cent", () => {
    expect(feeFor(497, 60)).toBe(3); // 2.982 -> 3
    expect(feeFor(100, 60)).toBe(1); // 0.6 -> 1
    expect(feeFor(1000, 60)).toBe(6); // exactly 6.0
    expect(feeFor(1000, 0)).toBe(0);
  });
});

describe("simulateBuy with the $5.00 default", () => {
  const ask = 77_657.42;
  const f = simulateBuy(500, ask, cfg);
  it("fills at the ask plus slippage, rounded up to the cent", () => {
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.refPriceCents).toBe(7_765_742);
    expect(f.fillPriceCents).toBe(Math.ceil(7_765_742 * 1.0005)); // 7769625
    expect(f.fillPriceCents).toBeGreaterThan(f.refPriceCents);
  });
  it("never spends more than the cash and charges the fee on the notional", () => {
    if (!f.ok) throw new Error("expected fill");
    expect(f.totalCents).toBeLessThanOrEqual(500);
    expect(f.totalCents).toBe(f.notionalCents + f.feeCents);
    expect(f.feeCents).toBe(feeFor(f.notionalCents, 60));
    // $5.00 -> $4.97 notional + $0.03 fee
    expect(f.notionalCents).toBe(497);
    expect(f.feeCents).toBe(3);
  });
  it("buys a floored whole number of satoshis", () => {
    if (!f.ok) throw new Error("expected fill");
    expect(Number.isInteger(f.qtySats)).toBe(true);
    expect(f.qtySats).toBe(Math.floor((497 * 1e8) / f.fillPriceCents));
  });
  it("reports slippage cost in cents", () => {
    if (!f.ok) throw new Error("expected fill");
    expect(f.slippageCents).toBeGreaterThanOrEqual(0);
    expect(f.slippageCents).toBeLessThanOrEqual(1); // $4.97 * 0.05% ≈ 0.25 cent
  });
});

describe("minimum order handling", () => {
  it("refuses a buy below the minimum notional (never rounds it up)", () => {
    const r = simulateBuy(100, 50_000, cfg); // $1.00 cash -> $0.99 notional after the fee, below $1
    expect(r).toEqual({ ok: false, reason: "below_min_order" });
    expect(simulateBuy(50, 50_000, cfg)).toEqual({ ok: false, reason: "below_min_order" });
  });
  it("accepts a buy that is exactly at the minimum after fees", () => {
    const r = simulateBuy(101, 50_000, cfg); // 101 -> notional 100 + fee 1
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notionalCents).toBe(100);
  });
  it("refuses a sell whose proceeds are below the minimum and leaves the position open", () => {
    const r = simulateSell(1000, 77_000, cfg); // 0.00001 BTC ≈ $0.77
    expect(r).toEqual({ ok: false, reason: "below_min_order" });
  });
  it("honours a minimum base size", () => {
    expect(simulateBuy(500, 77_000, { ...cfg, minBaseSats: 10_000 })).toEqual({ ok: false, reason: "below_min_size" });
    expect(simulateSell(5, 77_000, { ...cfg, minBaseSats: 10 })).toEqual({ ok: false, reason: "below_min_size" });
  });
  it("rejects zero cash, zero quantity and bad prices", () => {
    expect(simulateBuy(0, 50_000, cfg)).toEqual({ ok: false, reason: "no_funds" });
    expect(simulateSell(0, 50_000, cfg)).toEqual({ ok: false, reason: "no_funds" });
    expect(simulateBuy(500, 0, cfg)).toEqual({ ok: false, reason: "bad_price" });
    expect(simulateBuy(500, Number.NaN, cfg)).toEqual({ ok: false, reason: "bad_price" });
    expect(simulateSell(1000, -1, cfg)).toEqual({ ok: false, reason: "bad_price" });
  });
});

describe("simulateSell", () => {
  it("fills at the bid minus slippage (rounded down) and charges the fee on the notional", () => {
    const r = simulateSell(6_400, 78_000, cfg); // 0.000064 BTC
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fillPriceCents).toBe(Math.floor(7_800_000 * 0.9995));
    expect(r.fillPriceCents).toBeLessThan(r.refPriceCents);
    expect(r.notionalCents).toBe(Math.floor((6_400 * r.fillPriceCents) / 1e8));
    expect(r.feeCents).toBe(feeFor(r.notionalCents, 60));
    expect(r.totalCents).toBe(r.notionalCents - r.feeCents);
  });
});

describe("round trip cost honesty", () => {
  it("a flat-price round trip with $5 loses roughly 1.3% to fees and slippage", () => {
    const price = 80_000;
    const buy = simulateBuy(500, price, cfg);
    if (!buy.ok) throw new Error("buy");
    const sell = simulateSell(buy.qtySats, price, cfg);
    if (!sell.ok) throw new Error("sell");
    const cash = 500 - buy.totalCents + sell.totalCents;
    const lossPct = ((500 - cash) / 500) * 100;
    expect(cash).toBeLessThan(500);
    expect(lossPct).toBeGreaterThan(1.0);
    expect(lossPct).toBeLessThan(2.5);
  });
  it("with zero costs a flat-price round trip returns (almost) everything", () => {
    const free = { ...cfg, feeBps: 0, slippageBps: 0 };
    const buy = simulateBuy(500, 80_000, free);
    if (!buy.ok) throw new Error("buy");
    const sell = simulateSell(buy.qtySats, 80_000, free);
    if (!sell.ok) throw new Error("sell");
    expect(500 - buy.totalCents + sell.totalCents).toBeGreaterThanOrEqual(499);
  });
});

describe("markCents", () => {
  it("values holdings at the quoted price", () => {
    expect(markCents(100_000_000, 80_000)).toBe(8_000_000);
    expect(markCents(0, 80_000)).toBe(0);
  });
});
