import { describe, expect, it } from "vitest";
import { exitDecision, sizePosition, type OpenPosition } from "@/lib/meme/strategy";
import { cfg, HOUR, NOW } from "./fixtures";

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({ id: "p1", tokenAddress: "T", entryFillPrice: 1, peakPrice: 1, openedAtMs: NOW - HOUR, entryLiquidityUsd: 100_000, missingTicks: 0, ...over });
const mark = (price: number, liquidityUsd: number | null = 100_000) => ({ price, liquidityUsd });
const reason = (d: ReturnType<typeof exitDecision>) => (d.exit ? d.reason : "hold");

describe("sizing", () => {
  it("uses 30% of equity per position, never more than the cash on hand", () => {
    expect(sizePosition(5, 5, 0, cfg)).toBe(1.5);
    expect(sizePosition(3.2, 5, 1, cfg)).toBe(1.5);
    expect(sizePosition(1.0, 5, 2, cfg)).toBe(1.0); // cash is the limit
    expect(sizePosition(10, 20, 0, cfg)).toBe(6);
  });
  it("enforces the max open positions and the minimum position size", () => {
    expect(sizePosition(5, 5, 3, cfg)).toBeNull();
    expect(sizePosition(0.49, 5, 2, cfg)).toBeNull();
    expect(sizePosition(0.5, 5, 2, cfg)).toBe(0.5);
    expect(sizePosition(5, 1, 0, cfg)).toBeNull(); // 30% of $1 = $0.30 < $0.50
  });
});

describe("exit rules", () => {
  it("holds inside the bands", () => {
    expect(reason(exitDecision(pos(), mark(1.1), NOW, cfg))).toBe("hold");
    expect(reason(exitDecision(pos(), mark(0.85), NOW, cfg))).toBe("hold");
  });

  it("stop-loss at -20% of the entry fill (inclusive), including a gap far below it", () => {
    expect(reason(exitDecision(pos(), mark(0.81), NOW, cfg))).toBe("hold");
    expect(reason(exitDecision(pos(), mark(0.8), NOW, cfg))).toBe("stop_loss");
    expect(reason(exitDecision(pos(), mark(0.3), NOW, cfg))).toBe("stop_loss");
  });

  it("take-profit at +40% of the entry fill (inclusive)", () => {
    expect(reason(exitDecision(pos({ peakPrice: 1.39 }), mark(1.39), NOW, cfg))).toBe("hold");
    expect(reason(exitDecision(pos({ peakPrice: 1.4 }), mark(1.4), NOW, cfg))).toBe("take_profit");
    expect(reason(exitDecision(pos({ peakPrice: 1.4 }), mark(2), NOW, cfg))).toBe("take_profit");
  });

  it("trailing stop arms at +20% over entry and exits 15% below the peak", () => {
    // peak only +10%: trail not armed, a -15% pullback from the peak is just a hold
    expect(reason(exitDecision(pos({ peakPrice: 1.1 }), mark(0.94), NOW, cfg))).toBe("hold");
    // peak +30% (armed): exit when mark <= 1.3 x 0.85 = 1.105
    expect(reason(exitDecision(pos({ peakPrice: 1.3 }), mark(1.11), NOW, cfg))).toBe("hold");
    expect(reason(exitDecision(pos({ peakPrice: 1.3 }), mark(1.105), NOW, cfg))).toBe("trailing_stop");
    // the current mark counts toward the peak: a new high never triggers the trail
    expect(reason(exitDecision(pos({ peakPrice: 1.0 }), mark(1.3), NOW, cfg))).toBe("hold");
  });

  it("exits when liquidity collapses more than 40% below the entry liquidity, or disappears", () => {
    expect(reason(exitDecision(pos(), mark(1.05, 60_001), NOW, cfg))).toBe("hold");
    expect(reason(exitDecision(pos(), mark(1.05, 59_999), NOW, cfg))).toBe("liquidity_collapse");
    expect(reason(exitDecision(pos(), mark(1.05, null), NOW, cfg))).toBe("liquidity_collapse");
    expect(reason(exitDecision(pos(), mark(1.05, 0), NOW, cfg))).toBe("liquidity_collapse");
  });

  it("exits after the max hold time", () => {
    expect(reason(exitDecision(pos({ openedAtMs: NOW - 11.9 * HOUR }), mark(1.05), NOW, cfg))).toBe("hold");
    expect(reason(exitDecision(pos({ openedAtMs: NOW - 12 * HOUR }), mark(1.05), NOW, cfg))).toBe("max_hold");
  });

  it("priority: liquidity collapse beats stop-loss beats take-profit beats max-hold", () => {
    const old = pos({ openedAtMs: NOW - 20 * HOUR, peakPrice: 1.5 });
    expect(reason(exitDecision(old, mark(0.5, 1000), NOW, cfg))).toBe("liquidity_collapse");
    expect(reason(exitDecision(old, mark(0.5), NOW, cfg))).toBe("stop_loss");
    expect(reason(exitDecision(old, mark(1.5), NOW, cfg))).toBe("take_profit");
    expect(reason(exitDecision(old, mark(1.1), NOW, { ...cfg, trailActivatePct: 500 }))).toBe("max_hold");
  });

  it("a pool missing from successful responses is held for a while, then written off at $0", () => {
    expect(reason(exitDecision(pos({ missingTicks: 1 }), null, NOW, cfg))).toBe("hold");
    expect(reason(exitDecision(pos({ missingTicks: 2 }), null, NOW, cfg))).toBe("hold");
    const d = exitDecision(pos({ missingTicks: 3 }), null, NOW, cfg);
    expect(d).toMatchObject({ exit: true, reason: "written_off_pair_gone", writeOff: true });
  });
});
