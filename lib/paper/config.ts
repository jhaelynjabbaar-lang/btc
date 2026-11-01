/**
 * Paper-trading configuration. PAPER MONEY, NOT REAL: nothing in lib/paper ever talks to an exchange account.
 * Defaults can be overridden with optional env vars; the values in force are copied into each run (so a run is reproducible)
 * and shown on /paper. Money is handled in integer cents and BTC in integer satoshis to avoid float drift.
 */

export const PAPER_LABEL = "Paper money, not real";

export const PRODUCT = "BTC-USD";
export const GRANULARITY_SECONDS = 3600; // hourly candles
export const GRANULARITY_MS = GRANULARITY_SECONDS * 1000;

export const DATA_SOURCE = "coinbase-exchange-public";
export const DATA_SOURCE_URL = "https://api.exchange.coinbase.com";
export const SATS_PER_BTC = 100_000_000;

export type PaperConfig = {
  /** Starting virtual balance, in cents. */
  startCents: number;
  /** Taker fee in basis points (60 = 0.60%), charged on the notional of every fill. */
  feeBps: number;
  /** Extra adverse price slippage in basis points applied on top of the quoted bid/ask. */
  slippageBps: number;
  /** Fast / slow simple moving average lengths, in hourly candles. */
  fast: number;
  slow: number;
  /** Dead band around the slow SMA in basis points; inside it the bot keeps its current state (fewer whipsaw trades). */
  bandBps: number;
  /** Minimum order notional in cents (Coinbase Exchange BTC-USD min_market_funds is $1). */
  minOrderCents: number;
  /** Minimum order size in satoshis (Coinbase base_increment is 0.00000001 BTC, so 1 sat). */
  minBaseSats: number;
};

export const DEFAULT_CONFIG: PaperConfig = {
  startCents: 500,
  feeBps: 60,
  slippageBps: 5,
  fast: 20,
  slow: 50,
  bandBps: 10,
  minOrderCents: 100,
  minBaseSats: 1,
};

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const inRange = (n: number | null, lo: number, hi: number): n is number => n !== null && n >= lo && n <= hi;

/** Reads optional overrides from the environment. Invalid or out-of-range values are ignored (the default is used). */
export function configFromEnv(env: Record<string, string | undefined> = process.env): PaperConfig {
  const c = { ...DEFAULT_CONFIG };
  const usd = num(env.PAPER_START_USD);
  if (inRange(usd, 1, 100_000)) c.startCents = Math.round(usd * 100);
  const fee = num(env.PAPER_FEE_BPS);
  if (inRange(fee, 0, 500)) c.feeBps = fee;
  const slip = num(env.PAPER_SLIPPAGE_BPS);
  if (inRange(slip, 0, 500)) c.slippageBps = slip;
  const fast = num(env.PAPER_SMA_FAST);
  const slow = num(env.PAPER_SMA_SLOW);
  if (inRange(fast, 2, 100) && inRange(slow, 3, 250) && Number.isInteger(fast) && Number.isInteger(slow) && fast < slow) {
    c.fast = fast;
    c.slow = slow;
  }
  const band = num(env.PAPER_BAND_BPS);
  if (inRange(band, 0, 500)) c.bandBps = band;
  const minUsd = num(env.PAPER_MIN_ORDER_USD);
  if (inRange(minUsd, 0.01, 1000)) c.minOrderCents = Math.round(minUsd * 100);
  return c;
}

export function validateConfig(c: PaperConfig): string | null {
  if (!Number.isInteger(c.startCents) || c.startCents < 100 || c.startCents > 10_000_000) return "starting balance must be between $1 and $100,000";
  if (!(c.feeBps >= 0 && c.feeBps <= 500)) return "fee must be between 0% and 5%";
  if (!(c.slippageBps >= 0 && c.slippageBps <= 500)) return "slippage must be between 0% and 5%";
  if (!Number.isInteger(c.fast) || !Number.isInteger(c.slow) || c.fast < 2 || c.slow > 250 || c.fast >= c.slow) return "SMA lengths must be integers with 2 <= fast < slow <= 250";
  if (!(c.bandBps >= 0 && c.bandBps <= 500)) return "band must be between 0% and 5%";
  if (!Number.isInteger(c.minOrderCents) || c.minOrderCents < 1) return "minimum order must be at least one cent";
  if (!Number.isInteger(c.minBaseSats) || c.minBaseSats < 1) return "minimum size must be at least one satoshi";
  return null;
}

export const usd = (cents: number): string => (cents < 0 ? "-$" : "$") + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const btc = (sats: number): string => (sats / SATS_PER_BTC).toFixed(8);
