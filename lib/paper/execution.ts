import { SATS_PER_BTC, type PaperConfig } from "./config";

/**
 * Simulated order execution with exchange-style costs. Pure functions, integer cents / satoshis.
 *  - Buys fill at the quoted ASK plus slippage (rounded up to the cent); sells fill at the quoted BID minus slippage (rounded down).
 *  - A taker fee is charged on the fill notional and rounded UP to the cent, like an exchange would.
 *  - Orders below the minimum notional / size are refused, never silently rounded up. Positions too small to sell stay open.
 */

export type FillFail = { ok: false; reason: "below_min_order" | "below_min_size" | "no_funds" | "bad_price" };

export type BuyFill = {
  ok: true;
  side: "buy";
  refPriceCents: number;
  fillPriceCents: number;
  qtySats: number;
  notionalCents: number;
  feeCents: number;
  /** Cash that leaves the account: notional + fee. */
  totalCents: number;
  slippageCents: number;
};

export type SellFill = {
  ok: true;
  side: "sell";
  refPriceCents: number;
  fillPriceCents: number;
  qtySats: number;
  notionalCents: number;
  feeCents: number;
  /** Cash that enters the account: notional - fee. */
  totalCents: number;
  slippageCents: number;
};

export const feeFor = (notionalCents: number, feeBps: number): number => Math.max(0, Math.ceil((notionalCents * feeBps) / 10_000 - 1e-9));

/** Integer price in cents from a USD float (quotes come with at most 2 decimals; rounding guards against float noise). */
export const toCents = (usd: number): number => Math.round(usd * 100);

export function simulateBuy(cashCents: number, askUsd: number, cfg: Pick<PaperConfig, "feeBps" | "slippageBps" | "minOrderCents" | "minBaseSats">): BuyFill | FillFail {
  const askCents = toCents(askUsd);
  if (!(askCents > 0) || !Number.isFinite(askCents)) return { ok: false, reason: "bad_price" };
  if (!(cashCents > 0)) return { ok: false, reason: "no_funds" };
  const fillPriceCents = Math.ceil((askCents * (10_000 + cfg.slippageBps)) / 10_000 - 1e-9);
  // Largest notional N such that N + fee(N) <= cash.
  let n = Math.floor((cashCents * 10_000) / (10_000 + cfg.feeBps));
  while (n > 0 && n + feeFor(n, cfg.feeBps) > cashCents) n--;
  if (n < cfg.minOrderCents) return { ok: false, reason: "below_min_order" };
  const qtySats = Math.floor((n * SATS_PER_BTC) / fillPriceCents);
  if (qtySats < cfg.minBaseSats) return { ok: false, reason: "below_min_size" };
  // Actual notional for the (floored) quantity actually bought.
  const notionalCents = Math.min(n, Math.ceil((qtySats * fillPriceCents) / SATS_PER_BTC));
  if (notionalCents < cfg.minOrderCents) return { ok: false, reason: "below_min_order" };
  const feeCents = feeFor(notionalCents, cfg.feeBps);
  return {
    ok: true,
    side: "buy",
    refPriceCents: askCents,
    fillPriceCents,
    qtySats,
    notionalCents,
    feeCents,
    totalCents: notionalCents + feeCents,
    slippageCents: Math.round(((fillPriceCents - askCents) * qtySats) / SATS_PER_BTC),
  };
}

export function simulateSell(qtySats: number, bidUsd: number, cfg: Pick<PaperConfig, "feeBps" | "slippageBps" | "minOrderCents" | "minBaseSats">): SellFill | FillFail {
  const bidCents = toCents(bidUsd);
  if (!(bidCents > 0) || !Number.isFinite(bidCents)) return { ok: false, reason: "bad_price" };
  if (!(qtySats > 0)) return { ok: false, reason: "no_funds" };
  const fillPriceCents = Math.floor((bidCents * (10_000 - cfg.slippageBps)) / 10_000 + 1e-9);
  if (fillPriceCents <= 0) return { ok: false, reason: "bad_price" };
  if (qtySats < cfg.minBaseSats) return { ok: false, reason: "below_min_size" };
  const notionalCents = Math.floor((qtySats * fillPriceCents) / SATS_PER_BTC);
  if (notionalCents < cfg.minOrderCents) return { ok: false, reason: "below_min_order" };
  const feeCents = Math.min(notionalCents, feeFor(notionalCents, cfg.feeBps));
  return {
    ok: true,
    side: "sell",
    refPriceCents: bidCents,
    fillPriceCents,
    qtySats,
    notionalCents,
    feeCents,
    totalCents: notionalCents - feeCents,
    slippageCents: Math.round(((bidCents - fillPriceCents) * qtySats) / SATS_PER_BTC),
  };
}

/** Mark-to-market value of a BTC holding in cents (floor; no exit costs applied, same convention for bot and benchmark). */
export const markCents = (qtySats: number, priceUsd: number): number => Math.floor((qtySats * toCents(priceUsd)) / SATS_PER_BTC);
