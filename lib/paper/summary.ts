import type { SnapshotRow } from "./service";

/** Percentage change from `start` to `value` (null when start is not positive). */
export const pctChange = (value: number, start: number): number | null => (start > 0 ? ((value - start) / start) * 100 : null);

export type PaperSummary = {
  equity: number;
  benchEquity: number;
  botReturnPct: number | null;
  benchReturnPct: number | null;
  /** Bot minus buy-and-hold, in USD (positive = the bot is ahead). */
  vsHoldUsd: number;
};

export function summarize(startingUsd: number, cashUsd: number, qtyBtc: number, lastPrice: number | null, latest: Pick<SnapshotRow, "equity_usd" | "bench_equity_usd"> | null): PaperSummary {
  // Equity as of the latest snapshot (real recorded price); before the first tick it is just the starting cash.
  const equity = latest ? latest.equity_usd : cashUsd + (lastPrice ? qtyBtc * lastPrice : 0);
  const benchEquity = latest ? latest.bench_equity_usd : startingUsd;
  return { equity, benchEquity, botReturnPct: pctChange(equity, startingUsd), benchReturnPct: pctChange(benchEquity, startingUsd), vsHoldUsd: equity - benchEquity };
}
