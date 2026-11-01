import type { MemeConfig } from "./config";

/**
 * Cost model for simulated swaps. Nothing is free and nothing is rounded in the bot's favour:
 *  - DEX fee:       dexFeeBps of the traded value (pool fee).
 *  - Solana fee:    txFeeSol x the SOL/USD price fetched in the same tick (base fee + priority fee, per transaction).
 *  - Slippage:      adverse move vs the quoted price = slippageFloorBps (latency / MEV / spread) + priceImpactMultiplier x constant-product
 *                   impact, approximated as trade value / (liquidity / 2). Entries above maxSlippageBps are refused; exits never are
 *                   (a stop-loss must be able to fire), but exit slippage is capped at MAX_EXIT_SLIPPAGE_BPS.
 * Buys fill ABOVE the quoted price, sells BELOW it. USD amounts are rounded to 1e-6.
 */

export const MAX_EXIT_SLIPPAGE_BPS = 5000;
export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function slippageBps(tradeUsd: number, liquidityUsd: number | null, cfg: MemeConfig): number {
  if (liquidityUsd === null || liquidityUsd <= 0) return Number.POSITIVE_INFINITY;
  const impactBps = (tradeUsd / (liquidityUsd / 2)) * 10_000;
  return cfg.slippageFloorBps + cfg.priceImpactMultiplier * impactBps;
}

export const txFeeUsd = (solPriceUsd: number, cfg: MemeConfig) => round6(cfg.txFeeSol * solPriceUsd);

export type BuyFill = {
  spendUsd: number; // cash leaving the account (all-in)
  dexFeeUsd: number;
  txFeeUsd: number;
  slippageBps: number;
  slippageUsd: number;
  refPrice: number; // quoted price at tick time
  fillPrice: number; // refPrice x (1 + slippage)
  qty: number; // tokens received
};

/** Spend `spendUsd` all-in. Returns null when the modelled costs are refused (slippage above the cap, or fees eat the whole order). */
export function buyFill(spendUsd: number, refPrice: number, liquidityUsd: number | null, solPriceUsd: number, cfg: MemeConfig): BuyFill | null {
  if (!(spendUsd > 0) || !(refPrice > 0)) return null;
  const slip = slippageBps(spendUsd, liquidityUsd, cfg);
  if (!Number.isFinite(slip) || slip > cfg.maxSlippageBps) return null;
  const dexFee = round6((spendUsd * cfg.dexFeeBps) / 10_000);
  const tx = txFeeUsd(solPriceUsd, cfg);
  const net = spendUsd - dexFee - tx;
  if (net <= 0) return null;
  const fillPrice = refPrice * (1 + slip / 10_000);
  const qty = net / fillPrice;
  return { spendUsd: round6(spendUsd), dexFeeUsd: dexFee, txFeeUsd: tx, slippageBps: slip, slippageUsd: round6(qty * (fillPrice - refPrice)), refPrice, fillPrice, qty };
}

export type SellFill = {
  qty: number;
  grossAtQuoteUsd: number; // qty x quoted price
  dexFeeUsd: number;
  txFeeUsd: number;
  slippageBps: number;
  slippageUsd: number;
  refPrice: number;
  fillPrice: number; // refPrice x (1 - slippage)
  proceedsUsd: number; // cash received, never negative
};

export function sellFill(qty: number, refPrice: number, liquidityUsd: number | null, solPriceUsd: number, cfg: MemeConfig): SellFill {
  const gross = qty * refPrice;
  const raw = slippageBps(gross, liquidityUsd, cfg);
  const slip = Math.min(Number.isFinite(raw) ? raw : MAX_EXIT_SLIPPAGE_BPS, MAX_EXIT_SLIPPAGE_BPS);
  const fillPrice = refPrice * (1 - slip / 10_000);
  const afterSlip = qty * fillPrice;
  const dexFee = round6((afterSlip * cfg.dexFeeBps) / 10_000);
  const tx = txFeeUsd(solPriceUsd, cfg);
  return {
    qty,
    grossAtQuoteUsd: round6(gross),
    dexFeeUsd: dexFee,
    txFeeUsd: tx,
    slippageBps: slip,
    slippageUsd: round6(gross - afterSlip),
    refPrice,
    fillPrice,
    proceedsUsd: Math.max(0, round6(afterSlip - dexFee - tx)),
  };
}

/** Estimated cost of an immediate round trip (buy then sell at the same quote) as a % of the amount spent. Used to refuse tiny, fee-dominated entries. */
export function roundTripCostPct(spendUsd: number, liquidityUsd: number | null, solPriceUsd: number, cfg: MemeConfig): number | null {
  const buy = buyFill(spendUsd, 1, liquidityUsd, solPriceUsd, cfg);
  if (!buy) return null;
  const sell = sellFill(buy.qty, 1, liquidityUsd, solPriceUsd, cfg);
  return ((spendUsd - sell.proceedsUsd) / spendUsd) * 100;
}
