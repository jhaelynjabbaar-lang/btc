import type { MemeConfig } from "./config";
import type { DexPair, RugReport } from "./market";

/**
 * Rug / quality checks run before any simulated buy. Pure functions: data in, list of rejection reasons out (empty = passed).
 * Every reason has a stable machine code and a human detail with the actual number vs the limit, and all reasons that apply are
 * returned (not just the first) so the rejection log shows everything that was wrong with a candidate.
 * These checks reduce, but cannot remove, the chance of buying a scam: new memecoins can still be dumped on by insiders.
 */

export type Reason = { code: string; detail: string };
const r = (code: string, detail: string): Reason => ({ code, detail });
const fmt = (n: number, d = 1) => n.toLocaleString("en-US", { maximumFractionDigits: d });
const usd = (n: number) => "$" + fmt(n, 0);

export const pairAgeHours = (pair: DexPair, nowMs: number): number | null => (pair.pairCreatedAtMs === null ? null : (nowMs - pair.pairCreatedAtMs) / 3_600_000);

export const buyRatio = (t: { buys: number; sells: number }): number | null => (t.buys + t.sells > 0 ? t.buys / (t.buys + t.sells) : null);

/** Stage 1: checks that only need the DexScreener pair (cheap, no extra request). */
export function checkPair(pair: DexPair, cfg: MemeConfig, nowMs: number): Reason[] {
  const out: Reason[] = [];
  if (pair.liquidityUsd === null) out.push(r("no_liquidity_data", `${pair.dexId} pool reports no liquidity figure (e.g. bonding curve); cannot size or exit realistically`));
  else if (pair.liquidityUsd < cfg.minLiquidityUsd) out.push(r("liquidity_below_min", `liquidity ${usd(pair.liquidityUsd)} < ${usd(cfg.minLiquidityUsd)}`));

  const age = pairAgeHours(pair, nowMs);
  if (age === null) out.push(r("pair_age_unknown", "pool creation time not reported"));
  else if (age < cfg.minPairAgeHours) out.push(r("pair_too_new", `pool age ${fmt(age)}h < ${cfg.minPairAgeHours}h (most rugs happen in the first hours)`));
  else if (age > cfg.maxPairAgeHours) out.push(r("pair_too_old", `pool age ${fmt(age, 0)}h > ${cfg.maxPairAgeHours}h (not a new token)`));

  if (pair.volume24h < cfg.minVolume24hUsd) out.push(r("volume_24h_below_min", `24h volume ${usd(pair.volume24h)} < ${usd(cfg.minVolume24hUsd)}`));

  const t1 = pair.txns.h1;
  if (t1.buys + t1.sells < cfg.minTxns1h) out.push(r("too_few_txns_1h", `${t1.buys + t1.sells} txns in 1h < ${cfg.minTxns1h}`));
  const br1 = buyRatio(t1);
  if (br1 !== null && br1 < cfg.minBuyRatio1h) out.push(r("buy_ratio_1h_low", `1h buys/(buys+sells) ${fmt(br1 * 100)}% < ${fmt(cfg.minBuyRatio1h * 100, 0)}% (${t1.buys} buys, ${t1.sells} sells)`));
  const br24 = buyRatio(pair.txns.h24);
  if (br24 !== null && br24 < cfg.minBuyRatio24h) out.push(r("buy_ratio_24h_low", `24h buys/(buys+sells) ${fmt(br24 * 100)}% < ${fmt(cfg.minBuyRatio24h * 100, 0)}%`));

  const { m5, h1, h6, h24 } = pair.change;
  if (h1 === null || h6 === null || m5 === null) out.push(r("price_change_missing", "1h/6h/5m price change not reported"));
  else {
    if (h1 < cfg.minChange1hPct) out.push(r("no_momentum_1h", `1h change ${fmt(h1)}% < +${cfg.minChange1hPct}%`));
    if (h1 > cfg.maxChange1hPct) out.push(r("absurd_change_1h", `1h change +${fmt(h1)}% > +${cfg.maxChange1hPct}% (vertical pump: chasing the top)`));
    if (h6 < cfg.minChange6hPct) out.push(r("no_momentum_6h", `6h change ${fmt(h6)}% < ${cfg.minChange6hPct}%`));
    if (h6 > cfg.maxChange6hPct) out.push(r("absurd_change_6h", `6h change +${fmt(h6)}% > +${cfg.maxChange6hPct}%`));
    if (m5 < cfg.minChange5mPct) out.push(r("dumping_5m", `5m change ${fmt(m5)}% < ${cfg.minChange5mPct}% (falling right now)`));
  }
  if (h24 !== null && h24 > cfg.maxChange24hPct) out.push(r("absurd_change_24h", `24h change +${fmt(h24, 0)}% > +${cfg.maxChange24hPct}%`));
  return out;
}

/** Wallets that hold supply but are not insiders: burn addresses. Pool accounts come from the RugCheck report itself. */
const NON_INSIDER = new Set(["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"]);

/** Holders excluding liquidity pools and burn addresses, largest first. */
export function nonPoolHolders(rep: RugReport) {
  const pools = new Set(rep.poolAccounts);
  const owners = new Set(rep.poolOwners);
  return rep.holders
    .filter((h) => !pools.has(h.address) && !(h.owner && (owners.has(h.owner) || NON_INSIDER.has(h.owner))) && !NON_INSIDER.has(h.address))
    .sort((a, b) => b.pct - a.pct);
}

/** Stage 2: RugCheck report. `rep === null` means RugCheck could not be reached / parsed. */
export function checkRug(rep: RugReport | null, cfg: MemeConfig, unavailableError = "unavailable"): Reason[] {
  if (rep === null) return cfg.requireRugcheck ? [r("rugcheck_unavailable", `RugCheck report ${unavailableError}; nothing is bought without a rug check`)] : [];
  const out: Reason[] = [];
  if (rep.rugged) out.push(r("rugcheck_rugged", "RugCheck flags this token as rugged"));
  if (rep.mintAuthorityEnabled) out.push(r("mint_authority_enabled", "mint authority not renounced (supply can be inflated)"));
  if (rep.freezeAuthorityEnabled) out.push(r("freeze_authority_enabled", "freeze authority not renounced (wallets can be frozen)"));
  if (rep.transferFeePct > 0) out.push(r("transfer_fee", `token charges a ${fmt(rep.transferFeePct)}% transfer fee`));
  if (rep.scoreNormalised === null) out.push(r("rugcheck_score_missing", "no RugCheck score"));
  else if (rep.scoreNormalised > cfg.maxRugcheckScore) out.push(r("rugcheck_score_high", `RugCheck risk score ${fmt(rep.scoreNormalised)} > ${cfg.maxRugcheckScore} (0 safest, 100 riskiest)`));
  for (const name of rep.dangerRisks) out.push(r("rugcheck_danger_risk", name));
  const h = nonPoolHolders(rep);
  if (h.length === 0) out.push(r("holders_unknown", "RugCheck reported no holder data"));
  else {
    const top1 = h[0].pct;
    const top10 = h.slice(0, 10).reduce((a, x) => a + x.pct, 0);
    if (top1 > cfg.maxTopHolderPct) out.push(r("top_holder_concentration", `largest non-pool holder owns ${fmt(top1)}% > ${cfg.maxTopHolderPct}%`));
    if (top10 > cfg.maxTop10HolderPct) out.push(r("top10_concentration", `top 10 non-pool holders own ${fmt(top10)}% > ${cfg.maxTop10HolderPct}%`));
  }
  return out;
}

/** Compact metrics saved with every candidate row. */
export function pairMetrics(pair: DexPair, nowMs: number) {
  return {
    dex: pair.dexId,
    quote: pair.quoteSymbol,
    price_usd: pair.priceUsd,
    liquidity_usd: pair.liquidityUsd,
    volume_24h_usd: pair.volume24h,
    age_hours: pairAgeHours(pair, nowMs) === null ? null : Math.round((pairAgeHours(pair, nowMs) as number) * 10) / 10,
    txns_1h: pair.txns.h1,
    txns_24h: pair.txns.h24,
    change_pct: pair.change,
    fdv: pair.fdv,
  };
}
