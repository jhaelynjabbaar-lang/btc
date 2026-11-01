import type { MemeConfig } from "./config";
import { PRICE_SOURCE } from "./config";
import { buyFill, round6, roundTripCostPct, sellFill, type BuyFill, type SellFill } from "./costs";
import { checkPair, pairMetrics, type Reason } from "./filters";
import { pickBestPair, type DexPair } from "./market";
import { exitDecision, sizePosition, type ExitReason, type Mark, type OpenPosition } from "./strategy";

/**
 * Pure tick planner (no I/O): given the account, the real market data fetched this tick and (lazily) rug reports, it produces the
 * exact database changes for the tick. The service wires fetching and persistence around it; `meme_paper_apply_tick` applies the
 * result atomically and idempotently.
 */

export type OpenPositionRow = OpenPosition & {
  symbol: string;
  pairAddress: string;
  qty: number;
  costUsd: number;
  lastPrice: number | null;
};

export type AccountState = {
  id: string;
  version: number;
  cashUsd: number;
  feesPaidUsd: number;
  config: MemeConfig;
  positions: OpenPositionRow[];
  /** token address -> ms when we last exited it (cooldown). */
  recentExits: Record<string, number>;
};

export type CandidateDecision = "rejected" | "bought" | "skipped" | "held";
export type CandidateLog = {
  token_address: string;
  symbol: string;
  pair_address: string | null;
  sources: string[];
  decision: CandidateDecision;
  reasons: Reason[];
  metrics: Record<string, unknown>;
};

export type TradePayload = {
  side: "buy" | "sell";
  token_address: string;
  symbol: string;
  pair_address: string;
  qty: number;
  ref_price: number;
  fill_price: number;
  notional_usd: number;
  dex_fee_usd: number;
  tx_fee_usd: number;
  slippage_bps: number;
  slippage_usd: number;
  price_source: string;
  price_time: string;
  reason: string;
};

export type MarkUpdate = { position_id: string; last_price: number; last_liquidity_usd: number | null; peak_price: number; missing_ticks: number; last_marked_at: string };
export type ClosePayload = { position_id: string; exit_reason: ExitReason; exit_ref_price: number | null; exit_fill_price: number | null; proceeds_usd: number; pnl_usd: number; trade: TradePayload | null; detail: string };
export type OpenPayload = {
  position: {
    token_address: string;
    symbol: string;
    name: string;
    pair_address: string;
    dex_id: string;
    qty: number;
    entry_ref_price: number;
    entry_fill_price: number;
    cost_usd: number;
    entry_liquidity_usd: number;
    peak_price: number;
    last_price: number;
    last_liquidity_usd: number;
    rugcheck_score: number | null;
    entry_context: Record<string, unknown>;
  };
  trade: TradePayload;
};

export type PlannedBuy = { pair: DexPair; fill: BuyFill };

export type Screened = {
  rejected: CandidateLog[];
  held: CandidateLog[];
  /** Passed every DexScreener-only check; still need the RugCheck stage. Strongest 1h momentum first. */
  eligible: { pair: DexPair; sources: string[] }[];
};

/** Stage 1 for every discovered token (positions' own tokens excluded from buying). */
export function screenCandidates(
  discovered: Map<string, string[]>,
  pairs: DexPair[],
  failedAddresses: Set<string>,
  heldTokens: Set<string>,
  recentExits: Record<string, number>,
  cfg: MemeConfig,
  nowMs: number,
): Screened {
  const out: Screened = { rejected: [], held: [], eligible: [] };
  for (const [addr, sources] of discovered) {
    if (failedAddresses.has(addr)) continue; // data fetch for this token failed: not seen this tick, not a rejection
    const pair = pickBestPair(pairs, addr);
    if (!pair) {
      out.rejected.push({ token_address: addr, symbol: "?", pair_address: null, sources, decision: "rejected", reasons: [{ code: "no_supported_pair", detail: "no SOL/USDC/USDT-quoted pool with a price found on DexScreener" }], metrics: {} });
      continue;
    }
    const base = { token_address: addr, symbol: pair.symbol, pair_address: pair.pairAddress, sources, metrics: pairMetrics(pair, nowMs) };
    if (heldTokens.has(addr)) {
      out.held.push({ ...base, decision: "held", reasons: [{ code: "already_held", detail: "open paper position in this token" }] });
      continue;
    }
    const exitedAt = recentExits[addr];
    if (exitedAt !== undefined && nowMs - exitedAt < cfg.cooldownHours * 3_600_000) {
      out.rejected.push({ ...base, decision: "rejected", reasons: [{ code: "cooldown", detail: `exited ${((nowMs - exitedAt) / 3_600_000).toFixed(1)}h ago; cooldown ${cfg.cooldownHours}h` }] });
      continue;
    }
    const reasons = checkPair(pair, cfg, nowMs);
    if (reasons.length) out.rejected.push({ ...base, decision: "rejected", reasons });
    else out.eligible.push({ pair, sources });
  }
  out.eligible.sort((a, b) => (b.pair.change.h1 ?? 0) - (a.pair.change.h1 ?? 0));
  return out;
}

export type ExitPlan = { marks: MarkUpdate[]; closes: ClosePayload[]; cashAfter: number; feesAfter: number; closedTokens: string[]; unmarked: string[] };

/** Marks every open position on this tick's real data and applies the exit rules. */
export function planExits(acct: AccountState, pairs: DexPair[], failedAddresses: Set<string>, solPriceUsd: number, nowMs: number, fetchedAtIso: string): ExitPlan {
  const cfg = acct.config;
  const plan: ExitPlan = { marks: [], closes: [], cashAfter: acct.cashUsd, feesAfter: acct.feesPaidUsd, closedTokens: [], unmarked: [] };
  for (const p of acct.positions) {
    if (failedAddresses.has(p.tokenAddress)) {
      plan.unmarked.push(p.tokenAddress); // data fetch failed: keep the last mark, change nothing
      continue;
    }
    // Mark on the pool we entered if it is still present, otherwise the deepest supported pool for that token.
    const same = pairs.find((x) => x.pairAddress === p.pairAddress && x.tokenAddress === p.tokenAddress);
    const pair = same ?? pickBestPair(pairs, p.tokenAddress);
    const usable = pair && pair.liquidityUsd !== null ? pair : null;
    const missing = usable ? 0 : p.missingTicks + 1;
    const mark: Mark | null = usable ? { price: usable.priceUsd, liquidityUsd: usable.liquidityUsd } : null;
    const peak = mark ? Math.max(p.peakPrice, mark.price) : p.peakPrice;
    const d = exitDecision({ ...p, missingTicks: missing }, mark, nowMs, cfg);
    if (!d.exit) {
      if (mark) plan.marks.push({ position_id: p.id, last_price: mark.price, last_liquidity_usd: mark.liquidityUsd, peak_price: peak, missing_ticks: 0, last_marked_at: fetchedAtIso });
      else plan.marks.push({ position_id: p.id, last_price: p.lastPrice ?? p.entryFillPrice, last_liquidity_usd: null, peak_price: peak, missing_ticks: missing, last_marked_at: fetchedAtIso });
      continue;
    }
    if (d.writeOff || !mark) {
      plan.closes.push({ position_id: p.id, exit_reason: d.reason, exit_ref_price: null, exit_fill_price: null, proceeds_usd: 0, pnl_usd: round6(-p.costUsd), trade: null, detail: d.detail });
    } else {
      const s: SellFill = sellFill(p.qty, mark.price, mark.liquidityUsd, solPriceUsd, cfg);
      plan.cashAfter = round6(plan.cashAfter + s.proceedsUsd);
      plan.feesAfter = round6(plan.feesAfter + s.dexFeeUsd + s.txFeeUsd);
      plan.closes.push({
        position_id: p.id,
        exit_reason: d.reason,
        exit_ref_price: mark.price,
        exit_fill_price: s.fillPrice,
        proceeds_usd: s.proceedsUsd,
        pnl_usd: round6(s.proceedsUsd - p.costUsd),
        detail: d.detail,
        trade: {
          side: "sell",
          token_address: p.tokenAddress,
          symbol: p.symbol,
          pair_address: p.pairAddress,
          qty: p.qty,
          ref_price: mark.price,
          fill_price: s.fillPrice,
          notional_usd: s.grossAtQuoteUsd,
          dex_fee_usd: s.dexFeeUsd,
          tx_fee_usd: s.txFeeUsd,
          slippage_bps: round6(s.slippageBps),
          slippage_usd: s.slippageUsd,
          price_source: PRICE_SOURCE,
          price_time: fetchedAtIso,
          reason: `${d.reason}: ${d.detail}`,
        },
      });
    }
    plan.closedTokens.push(p.tokenAddress);
  }
  return plan;
}

export type BuyOutcome = { ok: true; buy: PlannedBuy } | { ok: false; reasons: Reason[] };

/** Sizing + cost gate for one candidate. */
export function planBuy(pair: DexPair, cashUsd: number, equityUsd: number, openCount: number, solPriceUsd: number, cfg: MemeConfig): BuyOutcome {
  const size = sizePosition(cashUsd, equityUsd, openCount, cfg);
  if (size === null) {
    if (openCount >= cfg.maxOpenPositions) return { ok: false, reasons: [{ code: "no_free_slot", detail: `${openCount}/${cfg.maxOpenPositions} positions open` }] };
    return { ok: false, reasons: [{ code: "size_below_min", detail: `position size min($${cashUsd.toFixed(2)} cash, ${(cfg.positionPct * 100).toFixed(0)}% of $${equityUsd.toFixed(2)} equity) < $${cfg.minPositionUsd.toFixed(2)}` }] };
  }
  const fill = buyFill(size, pair.priceUsd, pair.liquidityUsd, solPriceUsd, cfg);
  if (!fill) return { ok: false, reasons: [{ code: "cost_refused", detail: "modelled slippage above the cap or fees exceed the order" }] };
  const rt = roundTripCostPct(size, pair.liquidityUsd, solPriceUsd, cfg);
  if (rt === null || rt > cfg.maxCostPct) return { ok: false, reasons: [{ code: "cost_too_high", detail: `modelled round-trip cost ${rt === null ? "n/a" : rt.toFixed(1) + "%"} of $${size.toFixed(2)} > ${cfg.maxCostPct}%` }] };
  return { ok: true, buy: { pair, fill } };
}

export function openPayload(b: PlannedBuy, rugScore: number | null, fetchedAtIso: string, nowMs: number): OpenPayload {
  const { pair, fill } = b;
  return {
    position: {
      token_address: pair.tokenAddress,
      symbol: pair.symbol,
      name: pair.name,
      pair_address: pair.pairAddress,
      dex_id: pair.dexId,
      qty: fill.qty,
      entry_ref_price: fill.refPrice,
      entry_fill_price: fill.fillPrice,
      cost_usd: fill.spendUsd,
      entry_liquidity_usd: pair.liquidityUsd as number,
      peak_price: fill.refPrice,
      last_price: fill.refPrice,
      last_liquidity_usd: pair.liquidityUsd as number,
      rugcheck_score: rugScore,
      entry_context: pairMetrics(pair, nowMs),
    },
    trade: {
      side: "buy",
      token_address: pair.tokenAddress,
      symbol: pair.symbol,
      pair_address: pair.pairAddress,
      qty: fill.qty,
      ref_price: fill.refPrice,
      fill_price: fill.fillPrice,
      notional_usd: fill.spendUsd,
      dex_fee_usd: fill.dexFeeUsd,
      tx_fee_usd: fill.txFeeUsd,
      slippage_bps: round6(fill.slippageBps),
      slippage_usd: fill.slippageUsd,
      price_source: PRICE_SOURCE,
      price_time: fetchedAtIso,
      reason: `momentum entry: 1h ${pair.change.h1}%, 6h ${pair.change.h6}%, liquidity $${Math.round(pair.liquidityUsd ?? 0)}`,
    },
  };
}

/** Equity = cash + open positions marked at the latest real price (no exit costs applied). */
export function equityOf(cashUsd: number, positions: { qty: number; price: number }[]): number {
  return round6(cashUsd + positions.reduce((a, p) => a + p.qty * p.price, 0));
}
