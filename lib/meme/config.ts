/**
 * Memecoin paper-trading configuration. PAPER MONEY, NOT REAL: nothing in lib/meme ever talks to a wallet, a DEX router or a
 * private key; it only reads public market data and writes simulated fills to the database.
 *
 * Every number the strategy, rug checks and cost model depend on lives here, in one place, and is documented in
 * docs/meme-paper-trading.md. The values in force are copied into each account (`meme_paper_accounts.config`) so a run is
 * reproducible, and shown on /paper/meme.
 */

export const MEME_LABEL = "Paper money only";
export const MEME_WARNING =
  "PAPER MONEY ONLY. Memecoins are extremely risky (most go to zero, many are scams). Everything here is a simulation with fake money on real public prices. Past or simulated paper results do not predict real results, and nothing here is financial advice.";

/** Public, keyless data sources. The DexScreener price/liquidity numbers are what every simulated fill and mark uses. */
export const DEXSCREENER_URL = "https://api.dexscreener.com";
export const GECKOTERMINAL_URL = "https://api.geckoterminal.com/api/v2";
export const RUGCHECK_URL = "https://api.rugcheck.xyz/v1";
export const PRICE_SOURCE = "dexscreener";

/** Solana mints we accept as the quote side of a pool. Pairs quoted in other tokens (WBTC, HYPE, random memecoins...) are ignored. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const QUOTE_MINTS: readonly string[] = [WSOL_MINT, USDC_MINT, USDT_MINT];

export type MemeConfig = {
  // ---- account
  startUsd: number;
  // ---- rug checks / entry filters (all must pass; every failure is logged)
  minLiquidityUsd: number;
  minPairAgeHours: number;
  maxPairAgeHours: number;
  minVolume24hUsd: number;
  minTxns1h: number;
  minBuyRatio1h: number; // buys / (buys + sells) over the last hour
  minBuyRatio24h: number;
  // momentum window: last-hour price change must be inside [min, max]; "not absurd" caps stop us buying the top of a vertical pump
  minChange1hPct: number;
  maxChange1hPct: number;
  minChange6hPct: number;
  maxChange6hPct: number;
  maxChange24hPct: number;
  minChange5mPct: number; // do not buy while the last 5 minutes are dumping
  // RugCheck.xyz (public report API). When it is unreachable nothing is bought (fail closed).
  requireRugcheck: boolean;
  maxRugcheckScore: number; // score_normalised, 0 = safest, 100 = riskiest
  maxTopHolderPct: number; // largest single non-pool holder
  maxTop10HolderPct: number; // sum of the 10 largest non-pool holders
  // ---- sizing / risk limits
  maxOpenPositions: number;
  positionPct: number; // of current equity, per position
  minPositionUsd: number; // below this a trade is refused (costs would dominate)
  maxCostPct: number; // refuse an entry whose modelled round-trip cost exceeds this % of the position
  stopLossPct: number; // exit when mark <= entry fill x (1 - this)
  takeProfitPct: number; // exit when mark >= entry fill x (1 + this)
  trailActivatePct: number; // trailing stop arms once the peak is this far above entry
  trailPct: number; // ...and exits when the mark falls this far below the peak
  maxHoldHours: number;
  liquidityCollapsePct: number; // exit when liquidity falls this % below the entry liquidity
  writeOffAfterMissingTicks: number; // pair vanished from a successful API response for this many ticks in a row: written off at $0
  cooldownHours: number; // do not re-buy a token we exited within this window
  // ---- cost model
  dexFeeBps: number; // pool swap fee (Raydium / PumpSwap are ~0.25-0.30%)
  slippageFloorBps: number; // minimum adverse fill vs the quoted price (latency, MEV, spread)
  priceImpactMultiplier: number; // x constant-product impact estimate (trade / half the pool)
  maxSlippageBps: number; // cap; above this the trade is refused
  txFeeSol: number; // Solana base fee + priority fee per transaction
};

export const DEFAULT_MEME_CONFIG: MemeConfig = {
  startUsd: 5,

  minLiquidityUsd: 50_000,
  minPairAgeHours: 6,
  maxPairAgeHours: 168, // 7 days: "new", not ancient
  minVolume24hUsd: 100_000,
  minTxns1h: 100,
  minBuyRatio1h: 0.52,
  minBuyRatio24h: 0.45,
  minChange1hPct: 3,
  maxChange1hPct: 40,
  minChange6hPct: 0,
  maxChange6hPct: 150,
  maxChange24hPct: 400,
  minChange5mPct: -1,

  requireRugcheck: true,
  maxRugcheckScore: 40,
  maxTopHolderPct: 10,
  maxTop10HolderPct: 35,

  maxOpenPositions: 3,
  positionPct: 0.3,
  minPositionUsd: 0.5,
  maxCostPct: 10,
  stopLossPct: 20,
  takeProfitPct: 40,
  trailActivatePct: 20,
  trailPct: 15,
  maxHoldHours: 12,
  liquidityCollapsePct: 40,
  writeOffAfterMissingTicks: 3,
  cooldownHours: 24,

  dexFeeBps: 30,
  slippageFloorBps: 100,
  priceImpactMultiplier: 2,
  maxSlippageBps: 300,
  txFeeSol: 0.0003,
};

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Optional env overrides (all keys prefixed MEME_PAPER_). Invalid values are ignored. Only a few headline knobs are exposed. */
export function memeConfigFromEnv(env: Record<string, string | undefined> = process.env): MemeConfig {
  const c = { ...DEFAULT_MEME_CONFIG };
  const start = num(env.MEME_PAPER_START_USD);
  if (start !== null && start >= 1 && start <= 100_000) c.startUsd = start;
  const liq = num(env.MEME_PAPER_MIN_LIQUIDITY_USD);
  if (liq !== null && liq >= 1_000 && liq <= 10_000_000) c.minLiquidityUsd = liq;
  const open = num(env.MEME_PAPER_MAX_OPEN);
  if (open !== null && Number.isInteger(open) && open >= 1 && open <= 10) c.maxOpenPositions = open;
  return c;
}

/** Returns an error message when the config is unusable, otherwise null. */
export function validateMemeConfig(c: MemeConfig): string | null {
  const pos = (n: number) => Number.isFinite(n) && n > 0;
  const nonNeg = (n: number) => Number.isFinite(n) && n >= 0;
  if (!pos(c.startUsd) || c.startUsd > 100_000) return "starting balance out of range";
  if (!pos(c.minLiquidityUsd)) return "min liquidity must be positive";
  if (!(c.minPairAgeHours >= 0 && c.maxPairAgeHours > c.minPairAgeHours)) return "pair age window invalid";
  if (!Number.isInteger(c.maxOpenPositions) || c.maxOpenPositions < 1 || c.maxOpenPositions > 10) return "max open positions must be 1-10";
  if (!(c.positionPct > 0 && c.positionPct <= 1)) return "position size must be within (0, 100%]";
  if (!(c.stopLossPct > 0 && c.stopLossPct < 100)) return "stop loss must be within (0, 100)";
  if (!pos(c.takeProfitPct)) return "take profit must be positive";
  if (!pos(c.maxHoldHours)) return "max hold must be positive";
  if (!nonNeg(c.dexFeeBps) || !nonNeg(c.slippageFloorBps) || !nonNeg(c.txFeeSol)) return "costs must be non-negative";
  if (!pos(c.maxSlippageBps) || c.maxSlippageBps < c.slippageFloorBps) return "max slippage below slippage floor";
  return null;
}

/** Tick cadence: Vercel cron `*\/15 * * * *`. Buckets are 15 minutes wide; one applied tick per bucket per account. */
export const TICK_MINUTES = 15;
export const TICK_MS = TICK_MINUTES * 60_000;
export const bucketStartMs = (nowMs: number) => nowMs - (nowMs % TICK_MS);
