import { describe, expect, it } from "vitest";
import { decide, sma } from "@/lib/paper/strategy";

describe("sma", () => {
  it("averages the last n values", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([10], 1)).toBe(10);
  });
  it("returns null without enough data or with bad input", () => {
    expect(sma([1, 2], 3)).toBeNull();
    expect(sma([1, Number.NaN, 3], 3)).toBeNull();
    expect(sma([1, 2, 3], 0)).toBeNull();
    expect(sma([1, 2, 3], 1.5)).toBeNull();
  });
});

const ramp = (from: number, to: number, n: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

describe("decide (fast 5 / slow 10, 10 bps band)", () => {
  it("warms up: holds when there are fewer candles than the slow window", () => {
    const s = decide([1, 2, 3], 5, 10, 10);
    expect(s.desired).toBe("hold");
    expect(s.slow).toBeNull();
    expect(s.reason).toMatch(/warm-up/);
  });
  it("goes long in an uptrend (fast above slow)", () => {
    const s = decide(ramp(100, 120, 20), 5, 10, 10);
    expect(s.desired).toBe("long");
    expect(s.fast!).toBeGreaterThan(s.slow!);
  });
  it("goes flat in a downtrend (fast below slow)", () => {
    const s = decide(ramp(120, 100, 20), 5, 10, 10);
    expect(s.desired).toBe("flat");
    expect(s.fast!).toBeLessThan(s.slow!);
  });
  it("keeps the current state inside the dead band", () => {
    const flat = Array.from({ length: 20 }, () => 100);
    expect(decide(flat, 5, 10, 10).desired).toBe("hold");
    // fast exceeds slow by only 0.05% (< 0.10% band)
    const closes = [...Array.from({ length: 15 }, () => 100), 100.05, 100.05, 100.05, 100.05, 100.05];
    const s = decide(closes, 5, 10, 10);
    expect(s.fast!).toBeGreaterThan(s.slow!);
    expect(s.desired).toBe("hold");
  });
  it("the band is symmetric and zero band reacts to any difference", () => {
    const closes = [...Array.from({ length: 15 }, () => 100), 100.05, 100.05, 100.05, 100.05, 100.05];
    expect(decide(closes, 5, 10, 0).desired).toBe("long");
    const down = [...Array.from({ length: 15 }, () => 100), 99.95, 99.95, 99.95, 99.95, 99.95];
    expect(decide(down, 5, 10, 0).desired).toBe("flat");
    expect(decide(down, 5, 10, 10).desired).toBe("hold");
  });
  it("is a pure function of the closes (state-based, repeatable)", () => {
    const c = ramp(100, 130, 30);
    expect(decide(c, 5, 10, 10)).toEqual(decide(c, 5, 10, 10));
  });
});
