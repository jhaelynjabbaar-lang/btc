import { describe, expect, it } from "vitest";
import { buyFill, MAX_EXIT_SLIPPAGE_BPS, roundTripCostPct, sellFill, slippageBps, txFeeUsd } from "@/lib/meme/costs";
import { cfg } from "./fixtures";

const SOL = 100; // $/SOL for the test

describe("cost model", () => {
  it("slippage = floor + multiplier x constant-product impact (trade / half the pool)", () => {
    // $1.5 into a $50k pool: impact = 1.5 / 25_000 = 0.006% = 0.6 bps, x2 = 1.2 bps on top of the 100 bps floor
    expect(slippageBps(1.5, 50_000, cfg)).toBeCloseTo(101.2, 6);
    // a big trade in a thin pool is much worse
    expect(slippageBps(5_000, 50_000, cfg)).toBeCloseTo(100 + 2 * 2000, 6);
    expect(slippageBps(1, null, cfg)).toBe(Infinity);
    expect(slippageBps(1, 0, cfg)).toBe(Infinity);
  });

  it("Solana fee is txFeeSol x the SOL price from the same tick", () => {
    expect(txFeeUsd(94.38, cfg)).toBeCloseTo(0.0003 * 94.38, 6);
  });

  it("buys fill ABOVE the quote and every cost is deducted from the order", () => {
    const f = buyFill(1.5, 0.001, 120_000, SOL, cfg)!;
    expect(f.fillPrice).toBeGreaterThan(0.001);
    expect(f.fillPrice).toBeCloseTo(0.001 * (1 + f.slippageBps / 10_000), 12);
    expect(f.dexFeeUsd).toBeCloseTo(1.5 * 0.003, 6); // 0.30%
    expect(f.txFeeUsd).toBeCloseTo(0.03, 6);
    // tokens received are paid for with (spend - fees) at the fill price
    expect(f.qty).toBeCloseTo((1.5 - f.dexFeeUsd - f.txFeeUsd) / f.fillPrice, 9);
    // the position is worth LESS than what was spent at the quote price: costs are real
    expect(f.qty * 0.001).toBeLessThan(1.5);
    expect(f.slippageBps).toBeGreaterThanOrEqual(100); // at least 1%
  });

  it("sells fill BELOW the quote, pay both fees, and never return negative proceeds", () => {
    const s = sellFill(1_000_000, 0.001, 120_000, SOL, cfg);
    expect(s.fillPrice).toBeLessThan(0.001);
    expect(s.proceedsUsd).toBeLessThan(1_000_000 * 0.001);
    expect(s.proceedsUsd).toBeCloseTo(1_000_000 * s.fillPrice - s.dexFeeUsd - s.txFeeUsd, 5);
    const dust = sellFill(1, 0.0001, 120_000, SOL, cfg); // $0.0001 position: the tx fee exceeds the value
    expect(dust.proceedsUsd).toBe(0);
  });

  it("exit slippage is capped (a stop must still fire in a drained pool) but entries above the cap are refused", () => {
    expect(sellFill(1_000_000, 0.001, 10, SOL, cfg).slippageBps).toBe(MAX_EXIT_SLIPPAGE_BPS);
    expect(sellFill(1_000_000, 0.001, null, SOL, cfg).slippageBps).toBe(MAX_EXIT_SLIPPAGE_BPS);
    expect(buyFill(1.5, 0.001, 100, SOL, cfg)).toBeNull(); // slippage far above the 3% cap
    expect(buyFill(1.5, 0.001, null, SOL, cfg)).toBeNull();
  });

  it("refuses an order that the fees would eat entirely", () => {
    expect(buyFill(0.02, 1, 120_000, SOL, cfg)).toBeNull(); // $0.03 tx fee > $0.02
    expect(buyFill(0, 1, 120_000, SOL, cfg)).toBeNull();
  });

  it("a flat-price round trip on $1.50 costs several percent (honest about small-account fees)", () => {
    const rt = roundTripCostPct(1.5, 120_000, SOL, cfg)!;
    // 2 x 0.30% fee + 2 x ~1.0% slippage + 2 x $0.03 tx fee on $1.50 = ~6.6%
    expect(rt).toBeGreaterThan(5);
    expect(rt).toBeLessThan(9);
    expect(roundTripCostPct(1.5, 100, SOL, cfg)).toBeNull();
  });
});
