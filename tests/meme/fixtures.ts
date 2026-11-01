import { DEFAULT_MEME_CONFIG, USDC_MINT, WSOL_MINT, type MemeConfig } from "@/lib/meme/config";
import type { DexPair, RugReport } from "@/lib/meme/market";

export const NOW = Date.UTC(2026, 10, 1, 21, 0, 0);
export const HOUR = 3_600_000;
export const cfg: MemeConfig = { ...DEFAULT_MEME_CONFIG };

export const TOKEN = "EaxAUcXxNnVwcqm2BBocbows7D1XVY2Q63V38NEypump";
export const PAIR = "9KgSWjrKCzS3EbUkvBKbgdwj8BwTdWzzqXKufDHAPS2a";

/** A pair that passes every DexScreener-stage check with the default config. */
export function goodPair(over: Partial<DexPair> = {}): DexPair {
  return {
    tokenAddress: TOKEN,
    symbol: "GOOD",
    name: "Good Coin",
    pairAddress: PAIR,
    dexId: "raydium",
    quoteAddress: WSOL_MINT,
    quoteSymbol: "SOL",
    priceUsd: 0.001,
    priceNative: 0.001 / 94,
    liquidityUsd: 120_000,
    volume24h: 400_000,
    volume1h: 40_000,
    txns: { m5: { buys: 10, sells: 8 }, h1: { buys: 300, sells: 200 }, h6: { buys: 1500, sells: 1200 }, h24: { buys: 5000, sells: 4500 } },
    change: { m5: 0.5, h1: 12, h6: 30, h24: 80 },
    pairCreatedAtMs: NOW - 30 * HOUR,
    fdv: 1_000_000,
    ...over,
  };
}

export function goodRug(over: Partial<RugReport> = {}): RugReport {
  return {
    mint: TOKEN,
    mintAuthorityEnabled: false,
    freezeAuthorityEnabled: false,
    rugged: false,
    scoreNormalised: 1,
    transferFeePct: 0,
    dangerRisks: [],
    warnRisks: [],
    holders: [
      { address: "POOL1", owner: "POOLOWNER", pct: 60 }, // liquidity pool: must be ignored
      { address: "H1", owner: "W1", pct: 4 },
      { address: "H2", owner: "W2", pct: 3 },
      { address: "H3", owner: "W3", pct: 2 },
    ],
    poolAccounts: ["POOL1"],
    poolOwners: ["POOLOWNER"],
    ...over,
  };
}

export { USDC_MINT, WSOL_MINT };
