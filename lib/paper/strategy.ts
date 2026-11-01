/**
 * Strategy: long-only SMA trend filter on hourly BTC-USD closes.
 *   fast SMA > slow SMA * (1 + band)  -> be LONG (hold BTC)
 *   fast SMA < slow SMA * (1 - band)  -> be FLAT (hold USD)
 *   anything in between               -> keep the current state
 * The decision is a desired STATE (not a one-off cross event), so a missed cron run self-corrects on the next candle.
 * It only ever looks at CLOSED candles. No shorting, no leverage.
 */

export type Signal = {
  desired: "long" | "flat" | "hold";
  fast: number | null;
  slow: number | null;
  reason: string;
};

export function sma(values: number[], n: number): number | null {
  if (!Number.isInteger(n) || n < 1 || values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / n;
}

export function decide(closes: number[], fast: number, slow: number, bandBps: number): Signal {
  const f = sma(closes, fast);
  const s = sma(closes, slow);
  if (f === null || s === null) return { desired: "hold", fast: f, slow: s, reason: `warm-up: need ${slow} closed candles, have ${closes.length}` };
  const upper = s * (1 + bandBps / 10_000);
  const lower = s * (1 - bandBps / 10_000);
  if (f > upper) return { desired: "long", fast: f, slow: s, reason: `fast SMA(${fast}) ${f.toFixed(2)} > slow SMA(${slow}) ${s.toFixed(2)} + ${bandBps / 100}% band` };
  if (f < lower) return { desired: "flat", fast: f, slow: s, reason: `fast SMA(${fast}) ${f.toFixed(2)} < slow SMA(${slow}) ${s.toFixed(2)} - ${bandBps / 100}% band` };
  return { desired: "hold", fast: f, slow: s, reason: `fast SMA(${fast}) ${f.toFixed(2)} inside the ${bandBps / 100}% band around slow SMA(${slow}) ${s.toFixed(2)}: no change` };
}
