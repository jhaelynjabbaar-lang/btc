import { DATA_SOURCE, GRANULARITY_MS, SATS_PER_BTC, type PaperConfig } from "./config";
import { markCents, simulateBuy, simulateSell } from "./execution";
import type { Candle, Ticker } from "./market";
import { decide } from "./strategy";

/**
 * Pure planning of ONE tick. Given the stored run state and freshly fetched public market data it returns either a reason to
 * skip (bad/stale data: nothing is recorded as a decision) or the exact payload to apply atomically in Postgres.
 * Idempotency: a tick is keyed by the start time of the latest CLOSED hourly candle; the database applies each key once.
 */

export const MAX_TICKER_AGE_MS = 5 * 60_000;
export const MAX_PRICE_DEVIATION = 0.02; // ticker vs last closed candle

export type RunState = {
  id: string;
  config: PaperConfig;
  cashCents: number;
  qtySats: number;
  feesCents: number;
  benchEntered: boolean;
  benchCashCents: number;
  benchQtySats: number;
  lastCandleAt: string | null;
};

export type Market = {
  candles: Candle[];
  ticker: Ticker;
  candlesFetchedAt: string;
  tickerFetchedAt: string;
};

export type SkipReason = "stale_candles" | "insufficient_candles" | "candle_gap" | "stale_ticker" | "price_mismatch";
export type Plan = { kind: "skip"; reason: SkipReason; detail: string } | { kind: "apply"; payload: TickPayload };

export type TickPayload = {
  run_id: string;
  candle_start: string;
  expected_cash: number;
  expected_qty: number;
  price: number;
  price_source: string;
  price_time: string;
  candles_fetched_at: string;
  candle_close: number;
  sma_fast: number | null;
  sma_slow: number | null;
  signal: string;
  action: string;
  reason: string;
  cash_usd: number;
  qty_btc: number;
  fees_paid_usd: number;
  equity_usd: number;
  bench_equity_usd: number;
  trade: null | {
    side: "buy" | "sell";
    qty_btc: number;
    ref_price: number;
    fill_price: number;
    notional_usd: number;
    fee_usd: number;
    slippage_usd: number;
  };
  bench: null | { qty_btc: number; cash_usd: number; entry_price: number };
};

export const expectedCandleStartMs = (nowMs: number): number => Math.floor(nowMs / GRANULARITY_MS) * GRANULARITY_MS - GRANULARITY_MS;

const d = (cents: number) => cents / 100;
const b = (sats: number) => sats / SATS_PER_BTC;

export function planTick(run: RunState, market: Market, nowMs: number): Plan {
  const cfg = run.config;
  const closed = market.candles.filter((c) => c.startSec * 1000 + GRANULARITY_MS <= nowMs);
  const expected = expectedCandleStartMs(nowMs);
  const last = closed[closed.length - 1];
  if (!last || last.startSec * 1000 !== expected) {
    return { kind: "skip", reason: "stale_candles", detail: `latest closed candle is ${last ? new Date(last.startSec * 1000).toISOString() : "missing"}, expected ${new Date(expected).toISOString()}` };
  }
  if (closed.length < cfg.slow) return { kind: "skip", reason: "insufficient_candles", detail: `have ${closed.length} closed candles, need ${cfg.slow}` };
  const window = closed.slice(-cfg.slow);
  for (let i = 1; i < window.length; i++) {
    if ((window[i].startSec - window[i - 1].startSec) * 1000 !== GRANULARITY_MS) {
      return { kind: "skip", reason: "candle_gap", detail: `missing candle(s) before ${new Date(window[i].startSec * 1000).toISOString()}` };
    }
  }
  const t = market.ticker;
  const ageMs = Math.abs(nowMs - new Date(t.time).getTime());
  if (!(ageMs <= MAX_TICKER_AGE_MS)) return { kind: "skip", reason: "stale_ticker", detail: `ticker time ${t.time} is ${Math.round(ageMs / 1000)}s from now` };
  if (Math.abs(t.price - last.close) / last.close > MAX_PRICE_DEVIATION || t.ask < t.bid || Math.abs(t.ask - t.price) / t.price > MAX_PRICE_DEVIATION || Math.abs(t.bid - t.price) / t.price > MAX_PRICE_DEVIATION) {
    return { kind: "skip", reason: "price_mismatch", detail: `ticker ${t.price} vs last close ${last.close}, bid ${t.bid}, ask ${t.ask}` };
  }

  const sig = decide(
    closed.map((c) => c.close),
    cfg.fast,
    cfg.slow,
    cfg.bandBps,
  );
  const long = run.qtySats > 0;
  let cash = run.cashCents;
  let qty = run.qtySats;
  let fees = run.feesCents;
  let action = "hold";
  let reason = sig.reason;
  let trade: TickPayload["trade"] = null;

  if (sig.desired === "long" && !long) {
    const f = simulateBuy(cash, t.ask, cfg);
    if (f.ok) {
      cash -= f.totalCents;
      qty += f.qtySats;
      fees += f.feeCents;
      action = "buy";
      trade = { side: "buy", qty_btc: b(f.qtySats), ref_price: d(f.refPriceCents), fill_price: d(f.fillPriceCents), notional_usd: d(f.notionalCents), fee_usd: d(f.feeCents), slippage_usd: d(f.slippageCents) };
    } else {
      action = `skipped_${f.reason}`;
      reason = `${sig.reason}; buy not placed (${f.reason})`;
    }
  } else if (sig.desired === "flat" && long) {
    const f = simulateSell(qty, t.bid, cfg);
    if (f.ok) {
      cash += f.totalCents;
      qty -= f.qtySats;
      fees += f.feeCents;
      action = "sell";
      trade = { side: "sell", qty_btc: b(f.qtySats), ref_price: d(f.refPriceCents), fill_price: d(f.fillPriceCents), notional_usd: d(f.notionalCents), fee_usd: d(f.feeCents), slippage_usd: d(f.slippageCents) };
    } else {
      action = `skipped_${f.reason}`;
      reason = `${sig.reason}; sell not placed (${f.reason})`;
    }
  }

  // Buy-and-hold benchmark: spends the same starting cash at the first tick of the run, with the same fee, slippage and minimums.
  let benchCash = run.benchCashCents;
  let benchQty = run.benchQtySats;
  let bench: TickPayload["bench"] = null;
  if (!run.benchEntered) {
    const bf = simulateBuy(cfg.startCents, t.ask, cfg);
    benchQty = bf.ok ? bf.qtySats : 0;
    benchCash = bf.ok ? cfg.startCents - bf.totalCents : cfg.startCents;
    bench = { qty_btc: b(benchQty), cash_usd: d(benchCash), entry_price: t.ask };
  }

  const equity = cash + markCents(qty, t.price);
  const benchEquity = benchCash + markCents(benchQty, t.price);

  return {
    kind: "apply",
    payload: {
      run_id: run.id,
      candle_start: new Date(expected).toISOString(),
      expected_cash: d(run.cashCents),
      expected_qty: b(run.qtySats),
      price: t.price,
      price_source: DATA_SOURCE,
      price_time: t.time,
      candles_fetched_at: market.candlesFetchedAt,
      candle_close: last.close,
      sma_fast: sig.fast,
      sma_slow: sig.slow,
      signal: sig.desired,
      action,
      reason,
      cash_usd: d(cash),
      qty_btc: b(qty),
      fees_paid_usd: d(fees),
      equity_usd: d(equity),
      bench_equity_usd: d(benchEquity),
      trade,
      bench,
    },
  };
}
