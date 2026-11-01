import type { Freshness } from "./network";
import type { ConfirmedRow, Financials } from "./math";

/**
 * Read-only summary of the profitability figures for the AI layer. It keeps ESTIMATE and CONFIRMED in separate objects with
 * their labels, never adds them, and says "unavailable" (null) instead of guessing. The model may read this as context only; it can
 * not cite it as evidence and may not write its numbers (see lib/analysis/prompt.ts and schema.ts).
 */
export type ProfitSummary = {
  note: "READ-ONLY CONTEXT. Estimates are expectations from measured hashrate, not earnings. Confirmed is pool/chain verified. Never add them together.";
  network_data: Freshness | "none";
  estimate: {
    label: "Estimate";
    workers_with_estimate: number;
    workers_without_estimate: number;
    fleet_net_btc_per_day: number | null;
    fleet_net_usd_per_day_before_costs: number | null;
    costs_known: boolean;
    fleet_net_usd_per_day_after_costs: number | null;
  };
  confirmed: { label: "Confirmed"; payouts: number; total_sats: number | null };
  pool_api: "connected" | "not_connected";
};

export function buildProfitSummary(args: { financials: Financials; confirmed: { rows: ConfirmedRow[]; totalSats: number | null }; network: Freshness | "none"; poolConnected: boolean }): ProfitSummary {
  const f = args.financials.fleet;
  return {
    note: "READ-ONLY CONTEXT. Estimates are expectations from measured hashrate, not earnings. Confirmed is pool/chain verified. Never add them together.",
    network_data: args.network,
    estimate: {
      label: "Estimate",
      workers_with_estimate: f.workersWithEstimate,
      workers_without_estimate: f.workersWithoutEstimate,
      fleet_net_btc_per_day: f.revenueNetBtcPerDay,
      fleet_net_usd_per_day_before_costs: f.revenueNetUsdPerDay,
      costs_known: f.netUsdPerDay !== null,
      fleet_net_usd_per_day_after_costs: f.netUsdPerDay,
    },
    confirmed: { label: "Confirmed", payouts: args.confirmed.rows.length, total_sats: args.confirmed.totalSats },
    pool_api: args.poolConnected ? "connected" : "not_connected",
  };
}
