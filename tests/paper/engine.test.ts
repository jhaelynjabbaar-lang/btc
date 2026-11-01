import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, GRANULARITY_MS } from "@/lib/paper/config";
import { expectedCandleStartMs, planTick, type Market, type RunState } from "@/lib/paper/engine";
import type { Candle } from "@/lib/paper/market";

const HOUR = GRANULARITY_MS;
// 2026-11-01T20:05:00Z
const NOW = Date.UTC(2026, 10, 1, 20, 5, 0);
const LAST_CLOSED = NOW - (NOW % HOUR) - HOUR; // 19:00Z candle

function candles(closes: number[], lastStartMs = LAST_CLOSED, includeOpen = true): Candle[] {
  const out: Candle[] = closes.map((close, i) => {
    const start = lastStartMs - (closes.length - 1 - i) * HOUR;
    return { startSec: start / 1000, low: close - 5, high: close + 5, open: close, close, volume: 1 };
  });
  if (includeOpen) {
    const last = closes[closes.length - 1];
    out.push({ startSec: (lastStartMs + HOUR) / 1000, low: last - 5, high: last + 5, open: last, close: last, volume: 0.1 }); // still-open candle
  }
  return out;
}

const up = Array.from({ length: 80 }, (_, i) => 70_000 + i * 100); // steady uptrend
const down = Array.from({ length: 80 }, (_, i) => 78_000 - i * 100);

const market = (cs: Candle[], price = cs[cs.length - 1].close, over: Partial<Market["ticker"]> = {}): Market => ({
  candles: cs,
  ticker: { price, bid: price - 0.5, ask: price + 0.5, time: new Date(NOW - 20_000).toISOString(), ...over },
  candlesFetchedAt: new Date(NOW - 1000).toISOString(),
  tickerFetchedAt: new Date(NOW - 900).toISOString(),
});

const fresh = (over: Partial<RunState> = {}): RunState => ({
  id: "run-1",
  config: DEFAULT_CONFIG,
  cashCents: 500,
  qtySats: 0,
  feesCents: 0,
  benchEntered: false,
  benchCashCents: 0,
  benchQtySats: 0,
  lastCandleAt: null,
  ...over,
});

describe("expectedCandleStartMs", () => {
  it("is the start of the latest closed hourly candle", () => {
    expect(new Date(expectedCandleStartMs(NOW)).toISOString()).toBe("2026-11-01T19:00:00.000Z");
    expect(new Date(expectedCandleStartMs(Date.UTC(2026, 10, 1, 20, 0, 0))).toISOString()).toBe("2026-11-01T19:00:00.000Z");
    expect(new Date(expectedCandleStartMs(Date.UTC(2026, 10, 1, 19, 59, 59))).toISOString()).toBe("2026-11-01T18:00:00.000Z");
  });
});

describe("planTick: entering and exiting", () => {
  it("buys with the full balance on an uptrend signal and records source/time of the price used", () => {
    const m = market(candles(up));
    const p = planTick(fresh(), m, NOW);
    expect(p.kind).toBe("apply");
    if (p.kind !== "apply") return;
    const x = p.payload;
    expect(x.action).toBe("buy");
    expect(x.signal).toBe("long");
    expect(x.candle_start).toBe("2026-11-01T19:00:00.000Z");
    expect(x.price_source).toBe("coinbase-exchange-public");
    expect(x.price_time).toBe(m.ticker.time);
    expect(x.trade?.side).toBe("buy");
    expect(x.trade!.ref_price).toBe(m.ticker.ask); // buys at the ask
    expect(x.trade!.fill_price).toBeGreaterThan(m.ticker.ask);
    expect(x.cash_usd).toBeLessThan(0.02); // fully invested apart from rounding dust
    expect(x.qty_btc).toBeGreaterThan(0);
    expect(x.fees_paid_usd).toBe(0.03);
    expect(x.cash_usd + x.trade!.notional_usd + x.trade!.fee_usd).toBeCloseTo(5, 8);
    // benchmark entered at the same tick with the same costs
    expect(x.bench).not.toBeNull();
    expect(x.bench!.qty_btc).toBe(x.qty_btc);
    // equity is marked at the last price and is below $5 only by costs
    expect(x.equity_usd).toBeLessThan(5);
    expect(x.equity_usd).toBeGreaterThan(4.9);
  });

  it("stays in cash in a downtrend", () => {
    const p = planTick(fresh(), market(candles(down)), NOW);
    if (p.kind !== "apply") throw new Error("expected apply");
    expect(p.payload.action).toBe("hold");
    expect(p.payload.signal).toBe("flat");
    expect(p.payload.trade).toBeNull();
    expect(p.payload.cash_usd).toBe(5);
    expect(p.payload.fees_paid_usd).toBe(0);
  });

  it("sells the whole position on a downtrend signal and deducts the fee", () => {
    const held = fresh({ cashCents: 2, qtySats: 6_400, benchEntered: true, benchCashCents: 2, benchQtySats: 6_400 });
    // price high enough that 6,400 sats is above the $1 minimum
    const high = down.map((c) => c + 800_000); // ~$720k+ BTC: 0.000064 BTC ≈ $46 (test only)
    const p = planTick(held, market(candles(high)), NOW);
    if (p.kind !== "apply") throw new Error("expected apply");
    expect(p.payload.action).toBe("sell");
    expect(p.payload.qty_btc).toBe(0);
    expect(p.payload.trade!.side).toBe("sell");
    expect(p.payload.trade!.fill_price).toBeLessThan(p.payload.trade!.ref_price);
    expect(p.payload.fees_paid_usd).toBeGreaterThan(0);
    expect(p.payload.cash_usd).toBeCloseTo(0.02 + p.payload.trade!.notional_usd - p.payload.trade!.fee_usd, 8);
  });

  it("does not buy again when already long, nor sell when already flat", () => {
    const longRun = fresh({ cashCents: 2, qtySats: 6_400, benchEntered: true, benchCashCents: 2, benchQtySats: 6_400 });
    const p = planTick(longRun, market(candles(up)), NOW);
    if (p.kind !== "apply") throw new Error("expected apply");
    expect(p.payload.action).toBe("hold");
    expect(p.payload.trade).toBeNull();
    expect(p.payload.bench).toBeNull(); // benchmark already entered: not re-entered
  });

  it("a position too small to sell stays open (minimum order) and is logged as skipped", () => {
    const dust = fresh({ cashCents: 2, qtySats: 500, benchEntered: true, benchCashCents: 2, benchQtySats: 500 }); // ~$0.39
    const p = planTick(dust, market(candles(down)), NOW);
    if (p.kind !== "apply") throw new Error("expected apply");
    expect(p.payload.action).toBe("skipped_below_min_order");
    expect(p.payload.trade).toBeNull();
    expect(p.payload.qty_btc).toBe(0.000005);
  });

  it("does not buy when the balance is below the exchange minimum", () => {
    const broke = fresh({ cashCents: 90, benchEntered: true });
    const p = planTick(broke, market(candles(up)), NOW);
    if (p.kind !== "apply") throw new Error("expected apply");
    expect(p.payload.action).toBe("skipped_below_min_order");
    expect(p.payload.cash_usd).toBe(0.9);
  });

  it("is deterministic: the same inputs give the identical plan (replay is a no-op for the database key)", () => {
    const a = planTick(fresh(), market(candles(up)), NOW);
    const b = planTick(fresh(), market(candles(up)), NOW);
    expect(a).toEqual(b);
    // a later call within the same hour targets the SAME candle key
    const laterNow = NOW + 30 * 60_000;
    const later = planTick(fresh(), market(candles(up), undefined, { time: new Date(laterNow - 5_000).toISOString() }), laterNow);
    if (a.kind !== "apply" || later.kind !== "apply") throw new Error("expected apply");
    expect(later.payload.candle_start).toBe(a.payload.candle_start);
  });
});

describe("planTick: refuses bad or stale data instead of guessing", () => {
  it("skips when the latest closed candle is not the expected one (missed/late data)", () => {
    const p = planTick(fresh(), market(candles(up, LAST_CLOSED - HOUR, false)), NOW);
    expect(p).toMatchObject({ kind: "skip", reason: "stale_candles" });
  });
  it("skips when there are too few candles for the slow SMA", () => {
    const p = planTick(fresh(), market(candles(up.slice(-30))), NOW);
    expect(p).toMatchObject({ kind: "skip", reason: "insufficient_candles" });
  });
  it("skips when the candle window has a gap (never interpolates)", () => {
    const cs = candles(up);
    cs.splice(40, 1);
    expect(planTick(fresh(), market(cs), NOW)).toMatchObject({ kind: "skip", reason: "candle_gap" });
  });
  it("skips on a stale ticker", () => {
    const m = market(candles(up), undefined, { time: new Date(NOW - 10 * 60_000).toISOString() });
    expect(planTick(fresh(), m, NOW)).toMatchObject({ kind: "skip", reason: "stale_ticker" });
  });
  it("skips when the ticker disagrees wildly with the last close", () => {
    const m = market(candles(up), up[up.length - 1] * 1.2);
    expect(planTick(fresh(), m, NOW)).toMatchObject({ kind: "skip", reason: "price_mismatch" });
  });
  it("ignores the still-open candle when computing the signal", () => {
    const closedOnly = planTick(fresh(), market(candles(up, LAST_CLOSED, false)), NOW);
    const withOpen = planTick(fresh(), market(candles(up, LAST_CLOSED, true)), NOW);
    expect(closedOnly).toEqual(withOpen);
  });
});
