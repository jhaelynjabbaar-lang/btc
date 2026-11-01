import { BLOCKS_PER_DAY, HOURS_PER_DAY, MINUTES_PER_DAY, SATS_PER_BTC } from "./config";

/**
 * The profitability math. Pure and deterministic: no I/O, no clock, no randomness, no defaults for missing inputs.
 *
 * Rules enforced here (see docs/profitability.md):
 *  - A revenue ESTIMATE exists only when there is a MEASURED hashrate and complete network data. Otherwise: no estimate (a reason, never a number).
 *  - A cost is UNKNOWN (null) until every input it needs was entered; unknown is never treated as zero.
 *  - NET exists only when revenue (in USD) and every cost are known. A tiny or negative net is returned exactly, never rounded to zero.
 *  - Estimates and confirmed amounts are different types and are never added together.
 */

// ------------------------------------------------------------------------------------------------ consensus
const HALVING_INTERVAL = 210_000;
const INITIAL_SUBSIDY_SATS = 50 * SATS_PER_BTC;

/** Block subsidy in sats at a height (Bitcoin consensus rule: 50 BTC halved every 210,000 blocks). */
export function blockSubsidySats(height: number): number {
  if (!Number.isInteger(height) || height < 0) throw new RangeError("height must be a non-negative integer");
  const halvings = Math.floor(height / HALVING_INTERVAL);
  return halvings >= 33 ? 0 : Math.floor(INITIAL_SUBSIDY_SATS / 2 ** halvings);
}

// ------------------------------------------------------------------------------------------------ inputs
export type NetworkInputs = {
  /** Network hashrate, H/s. null = unavailable. */
  networkHashrateHs: number | null;
  subsidySats: number | null;
  /** Average fees per block, sats. null = unavailable. */
  avgFeeSats: number | null;
  /** BTC price in USD. null = unavailable (BTC estimates still work; USD values do not). */
  btcPriceUsd: number | null;
};

const pos = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const nonNeg = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export type RevenueEstimate = {
  label: "Estimate";
  /** Before the pool fee. */
  grossSatsPerDay: number;
  poolFeeSatsPerDay: number;
  /** After the pool fee. This is the expected-value ESTIMATE, not an earning. */
  netSatsPerDay: number;
  netBtcPerDay: number;
  /** null when the BTC price is unavailable. */
  netUsdPerDay: number | null;
};
export type RevenueResult = { ok: true; estimate: RevenueEstimate } | { ok: false; reason: "no_telemetry" | "network_unavailable" | "invalid_fee" };

/**
 * Expected BTC per day = (worker hashrate / network hashrate) x blocks per day x (subsidy + average fees), minus the pool fee.
 * `hashrateHs` must be a MEASURED value (telemetry), or null when there is none.
 */
export function estimateRevenue(hashrateHs: number | null, net: NetworkInputs, poolFeePct: number, blocksPerDay: number = BLOCKS_PER_DAY): RevenueResult {
  if (!nonNeg(hashrateHs)) return { ok: false, reason: "no_telemetry" };
  if (!nonNeg(poolFeePct) || poolFeePct > 100) return { ok: false, reason: "invalid_fee" };
  if (!pos(net.networkHashrateHs) || !nonNeg(net.subsidySats) || !nonNeg(net.avgFeeSats) || !pos(blocksPerDay)) return { ok: false, reason: "network_unavailable" };
  const share = hashrateHs / net.networkHashrateHs;
  const grossSatsPerDay = share * blocksPerDay * (net.subsidySats + net.avgFeeSats);
  const poolFeeSatsPerDay = grossSatsPerDay * (poolFeePct / 100);
  const netSatsPerDay = grossSatsPerDay - poolFeeSatsPerDay;
  const netBtcPerDay = netSatsPerDay / SATS_PER_BTC;
  return {
    ok: true,
    estimate: { label: "Estimate", grossSatsPerDay, poolFeeSatsPerDay, netSatsPerDay, netBtcPerDay, netUsdPerDay: pos(net.btcPriceUsd) ? netBtcPerDay * net.btcPriceUsd : null },
  };
}

// ------------------------------------------------------------------------------------------------ costs
/** Electricity per day (USD) = watts / 1000 x 24 h x $/kWh. null (UNKNOWN) when either input has not been entered. */
export function electricityUsdPerDay(watts: number | null, usdPerKwh: number | null): number | null {
  if (!nonNeg(watts) || !nonNeg(usdPerKwh)) return null;
  return (watts / 1000) * HOURS_PER_DAY * usdPerKwh;
}

export type CloudCostInput = { hourly_price_usd: number; cost_known: boolean };
export type CloudCost = {
  label: "Projection";
  /** null when any listed resource has an unknown price. 0 when there are no resources (nothing is being rented). */
  usdPerDay: number | null;
  resourceCount: number;
  unknownCount: number;
};
/** Projection from declared hourly prices x 24 h. It is not metered billing; the provider's invoice is the source of truth. */
export function cloudCostPerDay(resources: readonly CloudCostInput[]): CloudCost {
  const unknownCount = resources.filter((r) => !r.cost_known || !nonNeg(r.hourly_price_usd)).length;
  const usdPerDay = unknownCount > 0 ? null : resources.reduce((s, r) => s + r.hourly_price_usd * HOURS_PER_DAY, 0);
  return { label: "Projection", usdPerDay, resourceCount: resources.length, unknownCount };
}

// ------------------------------------------------------------------------------------------------ per worker + fleet
export type WorkerInput = { id: string; name: string; hardware_type: string; status: string };
export type HashrateMeasure = { avgHs: number; buckets: number; lastBucket: string | null };
export type CostSettings = {
  electricityUsdPerKwh: number | null;
  defaultWattsPerWorker: number | null;
  workerWatts: Record<string, number>;
  poolFeePctOverride: number | null;
};
export type CloudResourceInput = { id: string; worker_id: string | null; label: string | null; hourly_price_usd: number; cost_known: boolean };

export type WorkerFinancial = {
  id: string;
  name: string;
  hardware_type: string;
  status: string;
  hashrate: (HashrateMeasure & { coveragePct: number }) | null;
  revenue: RevenueResult;
  electricity: { applies: boolean; usdPerDay: number | null; missing: string[] };
  cloud: CloudCost;
  /** Estimate net (USD/day) = estimated revenue - costs. null unless every input is known. */
  netUsdPerDay: number | null;
  netMissing: string[];
};

export type FleetFinancial = {
  workersWithEstimate: number;
  workersWithoutEstimate: number;
  /** null when no worker has an estimate. */
  revenueNetSatsPerDay: number | null;
  revenueNetBtcPerDay: number | null;
  revenueNetUsdPerDay: number | null;
  /** Electricity of the workers that contribute an estimate; null if any needed input is missing. */
  electricityUsdPerDay: number | null;
  /** ALL running/provisioning cloud resources, linked to a worker or not. */
  cloud: CloudCost;
  netUsdPerDay: number | null;
  netMissing: string[];
};

export type FinancialsInput = {
  workers: readonly WorkerInput[];
  hashrates: ReadonlyMap<string, HashrateMeasure>;
  network: NetworkInputs;
  settings: CostSettings;
  /** Cloud resources that are running or provisioning (i.e. accruing cost). */
  cloudResources: readonly CloudResourceInput[];
  poolFeePct: number;
};

export type Financials = { workers: WorkerFinancial[]; fleet: FleetFinancial; poolFeePct: number };

const MISSING_TEXT = {
  electricity_price: "electricity price ($/kWh)",
  watts: "watts for this worker",
  btc_price: "BTC price",
  cloud_price: "cloud price (unknown hourly price)",
  cloud_link: "cloud resource not linked to this worker",
  no_estimate: "no revenue estimate (no measured hashrate or network data)",
} as const;
export const missingText = (code: keyof typeof MISSING_TEXT): string => MISSING_TEXT[code];

export function computeFinancials(input: FinancialsInput): Financials {
  const { network, settings, poolFeePct } = input;
  const workers: WorkerFinancial[] = input.workers.map((w) => {
    const m = input.hashrates.get(w.id) ?? null;
    const revenue = estimateRevenue(m ? m.avgHs : null, network, poolFeePct);
    const linked = input.cloudResources.filter((r) => r.worker_id === w.id);
    const cloud = cloudCostPerDay(linked);
    const isCloud = linked.length > 0;
    const missing: string[] = [];
    let electricity: WorkerFinancial["electricity"];
    if (isCloud) {
      // The rented machine's price covers its power, so no separate electricity line applies to it.
      electricity = { applies: false, usdPerDay: null, missing: [] };
      if (cloud.unknownCount > 0) missing.push(MISSING_TEXT.cloud_price);
    } else if (w.hardware_type === "cloud") {
      electricity = { applies: false, usdPerDay: null, missing: [] };
      missing.push(MISSING_TEXT.cloud_link);
    } else {
      const watts = settings.workerWatts[w.id] ?? settings.defaultWattsPerWorker;
      const em: string[] = [];
      if (!nonNeg(settings.electricityUsdPerKwh)) em.push(MISSING_TEXT.electricity_price);
      if (!nonNeg(watts)) em.push(MISSING_TEXT.watts);
      electricity = { applies: true, usdPerDay: electricityUsdPerDay(watts ?? null, settings.electricityUsdPerKwh), missing: em };
      missing.push(...em);
    }
    if (!revenue.ok) missing.unshift(MISSING_TEXT.no_estimate);
    else if (revenue.estimate.netUsdPerDay === null) missing.push(MISSING_TEXT.btc_price);

    let netUsdPerDay: number | null = null;
    if (missing.length === 0 && revenue.ok && revenue.estimate.netUsdPerDay !== null) {
      const cost = isCloud ? cloud.usdPerDay : electricity.usdPerDay;
      if (cost !== null) netUsdPerDay = revenue.estimate.netUsdPerDay - cost;
    }
    return {
      id: w.id,
      name: w.name,
      hardware_type: w.hardware_type,
      status: w.status,
      hashrate: m ? { ...m, coveragePct: Math.min(100, (m.buckets / MINUTES_PER_DAY) * 100) } : null,
      revenue,
      electricity,
      cloud,
      netUsdPerDay,
      netMissing: netUsdPerDay === null ? missing : [],
    };
  });

  const withEstimate = workers.filter((w): w is WorkerFinancial & { revenue: { ok: true; estimate: RevenueEstimate } } => w.revenue.ok);
  const cloudAll = cloudCostPerDay(input.cloudResources);
  const fleetMissing: string[] = [];
  let fleet: FleetFinancial;
  if (withEstimate.length === 0) {
    fleet = {
      workersWithEstimate: 0,
      workersWithoutEstimate: workers.length,
      revenueNetSatsPerDay: null,
      revenueNetBtcPerDay: null,
      revenueNetUsdPerDay: null,
      electricityUsdPerDay: null,
      cloud: cloudAll,
      netUsdPerDay: null,
      netMissing: [MISSING_TEXT.no_estimate],
    };
  } else {
    const sats = withEstimate.reduce((s, w) => s + w.revenue.estimate.netSatsPerDay, 0);
    const usdKnown = withEstimate.every((w) => w.revenue.estimate.netUsdPerDay !== null);
    const usd = usdKnown ? withEstimate.reduce((s, w) => s + (w.revenue.estimate.netUsdPerDay as number), 0) : null;
    const elecWorkers = withEstimate.filter((w) => w.electricity.applies);
    const elecKnown = elecWorkers.every((w) => w.electricity.usdPerDay !== null);
    const elec = elecKnown ? elecWorkers.reduce((s, w) => s + (w.electricity.usdPerDay as number), 0) : null;
    if (!usdKnown) fleetMissing.push(MISSING_TEXT.btc_price);
    if (!elecKnown) {
      if (!nonNeg(settings.electricityUsdPerKwh)) fleetMissing.push(MISSING_TEXT.electricity_price);
      if (elecWorkers.some((w) => w.electricity.missing.includes(MISSING_TEXT.watts))) fleetMissing.push(MISSING_TEXT.watts);
    }
    if (cloudAll.usdPerDay === null) fleetMissing.push(MISSING_TEXT.cloud_price);
    if (withEstimate.some((w) => w.hardware_type === "cloud" && w.cloud.resourceCount === 0)) fleetMissing.push(MISSING_TEXT.cloud_link);
    const net = fleetMissing.length === 0 && usd !== null && elec !== null && cloudAll.usdPerDay !== null ? usd - elec - cloudAll.usdPerDay : null;
    fleet = {
      workersWithEstimate: withEstimate.length,
      workersWithoutEstimate: workers.length - withEstimate.length,
      revenueNetSatsPerDay: sats,
      revenueNetBtcPerDay: sats / SATS_PER_BTC,
      revenueNetUsdPerDay: usd,
      electricityUsdPerDay: elec,
      cloud: cloudAll,
      netUsdPerDay: net,
      netMissing: net === null ? [...new Set(fleetMissing)] : [],
    };
  }
  return { workers, fleet, poolFeePct };
}

// ------------------------------------------------------------------------------------------------ confirmed (separate type)
export type LedgerRow = { id: string; kind: string; source: string; ref: string | null; amount_sats: number | null; occurred_at: string; note: string | null };
export type ConfirmedRow = { id: string; source: "pool" | "chain"; ref: string; amountSats: number; occurredAt: string; note: string | null };

/** CONFIRMED earnings: only ledger rows of kind confirmed_payout that come from the pool or the chain AND carry a reference. */
export function confirmedFromLedger(rows: readonly LedgerRow[]): { rows: ConfirmedRow[]; totalSats: number | null } {
  const out: ConfirmedRow[] = [];
  for (const r of rows) {
    if (r.kind !== "confirmed_payout") continue;
    if (r.source !== "pool" && r.source !== "chain") continue;
    if (!r.ref || r.ref.trim().length === 0) continue;
    if (typeof r.amount_sats !== "number" || !Number.isFinite(r.amount_sats) || r.amount_sats < 0) continue;
    out.push({ id: r.id, source: r.source, ref: r.ref, amountSats: r.amount_sats, occurredAt: r.occurred_at, note: r.note });
  }
  return { rows: out, totalSats: out.length ? out.reduce((s, r) => s + r.amountSats, 0) : null };
}
