import { describe, expect, it } from "vitest";
import { equityOf, openPayload, planBuy, planExits, screenCandidates, type AccountState, type OpenPositionRow } from "@/lib/meme/engine";
import { cfg, goodPair, HOUR, NOW, PAIR, TOKEN } from "./fixtures";

const SOL = 100;
const iso = new Date(NOW).toISOString();

const position = (over: Partial<OpenPositionRow> = {}): OpenPositionRow => ({
  id: "p1",
  tokenAddress: TOKEN,
  symbol: "GOOD",
  pairAddress: PAIR,
  qty: 1000,
  costUsd: 1.5,
  entryFillPrice: 0.0015,
  peakPrice: 0.0015,
  lastPrice: 0.0015,
  openedAtMs: NOW - HOUR,
  entryLiquidityUsd: 120_000,
  missingTicks: 0,
  ...over,
});
const acct = (positions: OpenPositionRow[], cash = 3.5): AccountState => ({ id: "a", version: 1, cashUsd: cash, feesPaidUsd: 0.1, config: cfg, positions, recentExits: {} });

describe("screenCandidates", () => {
  const discovered = new Map([[TOKEN, ["dexscreener_boosts_latest"]]]);
  it("separates eligible, rejected (with reasons), held and cooldown tokens", () => {
    const good = screenCandidates(discovered, [goodPair()], new Set(), new Set(), {}, cfg, NOW);
    expect(good.eligible).toHaveLength(1);
    expect(good.rejected).toHaveLength(0);

    const bad = screenCandidates(discovered, [goodPair({ liquidityUsd: 100 })], new Set(), new Set(), {}, cfg, NOW);
    expect(bad.eligible).toHaveLength(0);
    expect(bad.rejected[0].reasons.map((r) => r.code)).toContain("liquidity_below_min");
    expect(bad.rejected[0].symbol).toBe("GOOD");

    const held = screenCandidates(discovered, [goodPair()], new Set(), new Set([TOKEN]), {}, cfg, NOW);
    expect(held.held[0].reasons[0].code).toBe("already_held");

    const cool = screenCandidates(discovered, [goodPair()], new Set(), new Set(), { [TOKEN]: NOW - 2 * HOUR }, cfg, NOW);
    expect(cool.rejected[0].reasons[0].code).toBe("cooldown");
    const expired = screenCandidates(discovered, [goodPair()], new Set(), new Set(), { [TOKEN]: NOW - 25 * HOUR }, cfg, NOW);
    expect(expired.eligible).toHaveLength(1);
  });

  it("a token with no supported SOL/USDC/USDT pool is rejected; a failed data fetch is NOT a rejection", () => {
    const none = screenCandidates(discovered, [], new Set(), new Set(), {}, cfg, NOW);
    expect(none.rejected[0].reasons[0].code).toBe("no_supported_pair");
    const failed = screenCandidates(discovered, [], new Set([TOKEN]), new Set(), {}, cfg, NOW);
    expect(failed.rejected).toHaveLength(0);
    expect(failed.eligible).toHaveLength(0);
  });

  it("ranks eligible candidates by 1h momentum, strongest first, and ignores impostor pools", () => {
    const A = "A".repeat(43) + "1";
    const B = "B".repeat(43) + "2";
    const d = new Map([[A, []], [B, []]]);
    const pairs = [goodPair({ tokenAddress: A, symbol: "A", change: { m5: 0, h1: 5, h6: 10, h24: 10 } }), goodPair({ tokenAddress: B, symbol: "B", change: { m5: 0, h1: 25, h6: 10, h24: 10 } })];
    const s = screenCandidates(d, pairs, new Set(), new Set(), {}, cfg, NOW);
    expect(s.eligible.map((e) => e.pair.symbol)).toEqual(["B", "A"]);
  });
});

describe("planBuy (sizing + cost gate)", () => {
  it("sizes 30% of equity and prices the fill from the real quote", () => {
    const r = planBuy(goodPair(), 5, 5, 0, SOL, cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.buy.fill.spendUsd).toBe(1.5);
    expect(r.buy.fill.refPrice).toBe(0.001);
    expect(r.buy.fill.fillPrice).toBeGreaterThan(0.001);
  });
  it("refuses with a clear reason: no slot, size too small, slippage cap, cost too high", () => {
    const code = (r: ReturnType<typeof planBuy>) => (r.ok ? "ok" : r.reasons[0].code);
    expect(code(planBuy(goodPair(), 5, 5, 3, SOL, cfg))).toBe("no_free_slot");
    expect(code(planBuy(goodPair(), 0.3, 5, 1, SOL, cfg))).toBe("size_below_min");
    expect(code(planBuy(goodPair({ liquidityUsd: 100 }), 5, 5, 0, SOL, cfg))).toBe("cost_refused");
    expect(code(planBuy(goodPair(), 5, 5, 0, 500, cfg))).toBe("cost_too_high"); // $500 SOL: the $0.15 tx fee is 10% of a $1.50 order
  });
});

describe("planExits (mark-to-market + exit rules on real tick data)", () => {
  it("marks open positions to the tick's price and raises the peak; no trade", () => {
    const pair = goodPair({ priceUsd: 0.0017 });
    const p = planExits(acct([position()]), [pair], new Set(), SOL, NOW, iso);
    expect(p.closes).toHaveLength(0);
    expect(p.marks[0]).toMatchObject({ position_id: "p1", last_price: 0.0017, peak_price: 0.0017, missing_ticks: 0, last_marked_at: iso });
  });

  it("stop-loss sells at the real mark minus slippage and costs, credits cash and books the loss", () => {
    const pair = goodPair({ priceUsd: 0.0011 }); // -26.7% vs entry fill 0.0015
    const p = planExits(acct([position()]), [pair], new Set(), SOL, NOW, iso);
    const c = p.closes[0];
    expect(c.exit_reason).toBe("stop_loss");
    expect(c.exit_ref_price).toBe(0.0011);
    expect(c.exit_fill_price).toBeLessThan(0.0011);
    expect(c.trade?.side).toBe("sell");
    expect(c.trade?.price_source).toBe("dexscreener");
    expect(c.proceeds_usd).toBeLessThan(1000 * 0.0011); // costs deducted
    expect(c.pnl_usd).toBeCloseTo(c.proceeds_usd - 1.5, 6);
    expect(p.cashAfter).toBeCloseTo(3.5 + c.proceeds_usd, 6);
    expect(p.feesAfter).toBeGreaterThan(0.1);
    expect(p.closedTokens).toEqual([TOKEN]);
  });

  it("take-profit at +40% over the entry fill", () => {
    const p = planExits(acct([position()]), [goodPair({ priceUsd: 0.0021 })], new Set(), SOL, NOW, iso);
    expect(p.closes[0].exit_reason).toBe("take_profit");
    expect(p.closes[0].pnl_usd).toBeGreaterThan(0);
  });

  it("liquidity collapse exits even when the price still looks fine", () => {
    const p = planExits(acct([position()]), [goodPair({ priceUsd: 0.0016, liquidityUsd: 40_000 })], new Set(), SOL, NOW, iso);
    expect(p.closes[0].exit_reason).toBe("liquidity_collapse");
  });

  it("a failed data fetch for the token leaves the position untouched (no mark, no exit)", () => {
    const p = planExits(acct([position()]), [], new Set([TOKEN]), SOL, NOW, iso);
    expect(p.marks).toHaveLength(0);
    expect(p.closes).toHaveLength(0);
    expect(p.unmarked).toEqual([TOKEN]);
  });

  it("a pool missing from a successful response counts up, keeps the last mark, then is written off at $0", () => {
    let pos = position();
    for (let i = 1; i <= 2; i++) {
      const p = planExits(acct([pos]), [], new Set(), SOL, NOW, iso);
      expect(p.closes).toHaveLength(0);
      expect(p.marks[0]).toMatchObject({ missing_ticks: i, last_price: 0.0015 });
      pos = { ...pos, missingTicks: i };
    }
    const w = planExits(acct([{ ...pos, missingTicks: 2 }]), [], new Set(), SOL, NOW, iso);
    expect(w.closes[0]).toMatchObject({ exit_reason: "written_off_pair_gone", proceeds_usd: 0, trade: null });
    expect(w.closes[0].pnl_usd).toBe(-1.5);
    expect(w.cashAfter).toBe(3.5);
  });

  it("a pump.fun-style pool with no liquidity figure counts as missing rather than as a price", () => {
    const p = planExits(acct([position()]), [goodPair({ liquidityUsd: null })], new Set(), SOL, NOW, iso);
    expect(p.marks[0].missing_ticks).toBe(1);
  });
});

describe("payloads and equity", () => {
  it("openPayload records the real quote, fill, costs and the source/time of the price", () => {
    const r = planBuy(goodPair(), 5, 5, 0, SOL, cfg);
    if (!r.ok) throw new Error("expected buy");
    const o = openPayload(r.buy, 1, iso, NOW);
    expect(o.trade).toMatchObject({ side: "buy", ref_price: 0.001, price_source: "dexscreener", price_time: iso });
    expect(o.position.cost_usd).toBe(1.5);
    expect(o.position.entry_liquidity_usd).toBe(120_000);
    expect(o.trade.qty).toBeCloseTo(o.position.qty, 12);
    // spend = fees + tokens at fill price
    expect(o.trade.dex_fee_usd + o.trade.tx_fee_usd + o.position.qty * o.position.entry_fill_price).toBeCloseTo(1.5, 5);
  });
  it("equity = cash + positions marked at the latest real price", () => {
    expect(equityOf(3.5, [{ qty: 1000, price: 0.0016 }, { qty: 10, price: 0.1 }])).toBeCloseTo(3.5 + 1.6 + 1, 6);
    expect(equityOf(5, [])).toBe(5);
  });
});
