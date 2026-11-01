import { describe, expect, it } from "vitest";
import {
  blockSubsidySats,
  cloudCostPerDay,
  computeFinancials,
  confirmedFromLedger,
  electricityUsdPerDay,
  estimateRevenue,
  type CostSettings,
  type FinancialsInput,
  type HashrateMeasure,
  type LedgerRow,
  type NetworkInputs,
} from "@/lib/profit/math";
import { fmtSats, fmtUsd } from "@/lib/profit/format";

// Known, round inputs so every expected value can be checked by hand.
const NET: NetworkInputs = { networkHashrateHs: 1e21, subsidySats: 312_500_000, avgFeeSats: 12_500_000, btcPriceUsd: 100_000 };
// 1 TH/s => share 1e-9 ; gross = 1e-9 x 144 x 325,000,000 = 46.8 sats/day ; fee 2.5% = 1.17 ; net 45.63 sats ; USD = 45.63e-8 x 100,000 = 0.04563
const TH = 1e12;
const BLANK: CostSettings = { electricityUsdPerKwh: null, defaultWattsPerWorker: null, workerWatts: {}, poolFeePctOverride: null };

const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const worker = (id: string, name: string, hardware_type = "cpu") => ({ id, name, hardware_type, status: "online" });
const measure = (avgHs: number, buckets = 1440): HashrateMeasure => ({ avgHs, buckets, lastBucket: "2026-11-01T12:00:00.000Z" });
const input = (o: Partial<FinancialsInput>): FinancialsInput => ({
  workers: [worker(W1, "rig-1")],
  hashrates: new Map([[W1, measure(TH)]]),
  network: NET,
  settings: BLANK,
  cloudResources: [],
  poolFeePct: 2.5,
  ...o,
});

describe("block subsidy (consensus rule)", () => {
  it("halves every 210,000 blocks", () => {
    expect(blockSubsidySats(0)).toBe(5_000_000_000);
    expect(blockSubsidySats(209_999)).toBe(5_000_000_000);
    expect(blockSubsidySats(210_000)).toBe(2_500_000_000);
    expect(blockSubsidySats(840_000)).toBe(312_500_000);
    expect(blockSubsidySats(974_141)).toBe(312_500_000);
    expect(blockSubsidySats(1_050_000)).toBe(156_250_000);
    expect(blockSubsidySats(6_930_000)).toBe(0);
  });
  it("rejects invalid heights", () => {
    expect(() => blockSubsidySats(-1)).toThrow();
    expect(() => blockSubsidySats(1.5)).toThrow();
  });
});

describe("estimate math with known inputs", () => {
  it("(worker / network) x 144 x (subsidy + fees), minus the pool fee", () => {
    const r = estimateRevenue(TH, NET, 2.5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.estimate.label).toBe("Estimate");
    expect(r.estimate.grossSatsPerDay).toBeCloseTo(46.8, 9);
    expect(r.estimate.poolFeeSatsPerDay).toBeCloseTo(1.17, 9);
    expect(r.estimate.netSatsPerDay).toBeCloseTo(45.63, 9);
    expect(r.estimate.netBtcPerDay).toBeCloseTo(45.63e-8, 15);
    expect(r.estimate.netUsdPerDay).toBeCloseTo(0.04563, 9);
  });
  it("a fee override changes the result and 0% means no fee", () => {
    const r0 = estimateRevenue(TH, NET, 0);
    const r10 = estimateRevenue(TH, NET, 10);
    if (!r0.ok || !r10.ok) throw new Error("expected estimates");
    expect(r0.estimate.netSatsPerDay).toBeCloseTo(46.8, 9);
    expect(r10.estimate.netSatsPerDay).toBeCloseTo(42.12, 9);
  });
  it("a measured hashrate of exactly 0 gives an estimate of exactly 0 (measured, not missing)", () => {
    const r = estimateRevenue(0, NET, 2.5);
    expect(r.ok && r.estimate.netSatsPerDay).toBe(0);
  });
  it("BTC is still estimated when the price is unavailable; USD is then null, not 0", () => {
    const r = estimateRevenue(TH, { ...NET, btcPriceUsd: null }, 2.5);
    expect(r.ok && r.estimate.netUsdPerDay).toBe(null);
    expect(r.ok && r.estimate.netSatsPerDay).toBeCloseTo(45.63, 9);
  });
  it("a tiny CPU result is kept exactly: never rounded to zero when displayed", () => {
    const r = estimateRevenue(5e6, NET, 2.5); // 5 MH/s CPU
    if (!r.ok) throw new Error("expected estimate");
    expect(r.estimate.netSatsPerDay).toBeGreaterThan(0);
    expect(r.estimate.netSatsPerDay).toBeLessThan(1e-3);
    expect(fmtSats(r.estimate.netSatsPerDay)).not.toMatch(/^0 sats$|^0\.0* sats$/);
    expect(fmtUsd(r.estimate.netUsdPerDay as number)).not.toBe("$0.00");
    expect(fmtUsd(r.estimate.netUsdPerDay as number)).toMatch(/^\$0\.0000\d+/);
  });
});

describe("missing inputs: no estimate at all", () => {
  it("no telemetry => no estimate, with a reason and no number", () => {
    expect(estimateRevenue(null, NET, 2.5)).toEqual({ ok: false, reason: "no_telemetry" });
    expect(estimateRevenue(Number.NaN, NET, 2.5)).toEqual({ ok: false, reason: "no_telemetry" });
    expect(estimateRevenue(-1, NET, 2.5)).toEqual({ ok: false, reason: "no_telemetry" });
  });
  it("any missing network field => no estimate", () => {
    for (const k of ["networkHashrateHs", "subsidySats", "avgFeeSats"] as const) {
      expect(estimateRevenue(TH, { ...NET, [k]: null }, 2.5)).toEqual({ ok: false, reason: "network_unavailable" });
    }
    expect(estimateRevenue(TH, { ...NET, networkHashrateHs: 0 }, 2.5)).toEqual({ ok: false, reason: "network_unavailable" });
  });
  it("an invalid fee is refused", () => {
    expect(estimateRevenue(TH, NET, -1)).toEqual({ ok: false, reason: "invalid_fee" });
    expect(estimateRevenue(TH, NET, 101)).toEqual({ ok: false, reason: "invalid_fee" });
  });
  it("a worker without telemetry gets no estimate and the fleet has none when no worker has one", () => {
    const f = computeFinancials(input({ hashrates: new Map() }));
    expect(f.workers[0].revenue).toEqual({ ok: false, reason: "no_telemetry" });
    expect(f.workers[0].netUsdPerDay).toBeNull();
    expect(f.fleet.workersWithEstimate).toBe(0);
    expect(f.fleet.revenueNetSatsPerDay).toBeNull();
    expect(f.fleet.revenueNetUsdPerDay).toBeNull();
    expect(f.fleet.netUsdPerDay).toBeNull();
  });
  it("no workers at all => no estimate", () => {
    const f = computeFinancials(input({ workers: [], hashrates: new Map() }));
    expect(f.fleet.workersWithEstimate).toBe(0);
    expect(f.fleet.netUsdPerDay).toBeNull();
  });
});

describe("costs", () => {
  it("electricity = watts / 1000 x 24 x $/kWh, unknown when either input is blank", () => {
    expect(electricityUsdPerDay(100, 0.1)).toBeCloseTo(0.24, 12);
    expect(electricityUsdPerDay(null, 0.1)).toBeNull();
    expect(electricityUsdPerDay(100, null)).toBeNull();
    expect(electricityUsdPerDay(0, 0.1)).toBe(0); // an entered 0 W is a known 0, a blank is unknown
  });
  it("cloud: projection of hourly x 24; unknown price => unknown; none rented => known 0", () => {
    expect(cloudCostPerDay([{ hourly_price_usd: 0.5, cost_known: true }, { hourly_price_usd: 0.25, cost_known: true }])).toMatchObject({ label: "Projection", usdPerDay: 18, resourceCount: 2, unknownCount: 0 });
    expect(cloudCostPerDay([{ hourly_price_usd: 0, cost_known: false }]).usdPerDay).toBeNull();
    expect(cloudCostPerDay([{ hourly_price_usd: 0.5, cost_known: true }, { hourly_price_usd: 0, cost_known: false }]).usdPerDay).toBeNull();
    expect(cloudCostPerDay([]).usdPerDay).toBe(0);
  });
});

describe("net = estimated revenue - costs, only when every input is known", () => {
  it("blank cost inputs (the default) => cost and net are UNKNOWN, revenue still shown", () => {
    const f = computeFinancials(input({}));
    const w = f.workers[0];
    expect(w.revenue.ok).toBe(true);
    expect(w.electricity).toMatchObject({ applies: true, usdPerDay: null });
    expect(w.electricity.missing).toEqual(["electricity price ($/kWh)", "watts for this worker"]);
    expect(w.netUsdPerDay).toBeNull();
    expect(w.netMissing).toEqual(expect.arrayContaining(["electricity price ($/kWh)", "watts for this worker"]));
    expect(f.fleet.revenueNetUsdPerDay).toBeCloseTo(0.04563, 9);
    expect(f.fleet.electricityUsdPerDay).toBeNull();
    expect(f.fleet.netUsdPerDay).toBeNull();
  });
  it("price entered but watts blank => still unknown (and says which input is missing)", () => {
    const f = computeFinancials(input({ settings: { ...BLANK, electricityUsdPerKwh: 0.1 } }));
    expect(f.workers[0].netUsdPerDay).toBeNull();
    expect(f.workers[0].netMissing).toEqual(["watts for this worker"]);
  });
  it("NEGATIVE net is reported exactly, not clamped or rounded to zero", () => {
    // 100 W at $0.10/kWh = $0.24/day against $0.04563/day of estimated revenue
    const f = computeFinancials(input({ settings: { ...BLANK, electricityUsdPerKwh: 0.1, defaultWattsPerWorker: 100 } }));
    expect(f.workers[0].netUsdPerDay).toBeCloseTo(0.04563 - 0.24, 9);
    expect(f.workers[0].netUsdPerDay as number).toBeLessThan(0);
    expect(f.fleet.netUsdPerDay).toBeCloseTo(-0.19437, 9);
    expect(fmtUsd(f.fleet.netUsdPerDay as number)).toBe("-$0.19");
  });
  it("a tiny negative net (free power is not assumed) keeps its sign and digits", () => {
    const f = computeFinancials(input({ hashrates: new Map([[W1, measure(5e6)]]), settings: { ...BLANK, electricityUsdPerKwh: 0.0001, defaultWattsPerWorker: 1 } }));
    const net = f.workers[0].netUsdPerDay as number;
    expect(net).toBeLessThan(0);
    expect(fmtUsd(net)).toMatch(/^-\$0\.0000\d+/);
    expect(fmtUsd(net)).not.toMatch(/^-?\$0\.00$/);
  });
  it("per-worker watts override the default", () => {
    const f = computeFinancials(input({ settings: { ...BLANK, electricityUsdPerKwh: 0.1, defaultWattsPerWorker: 100, workerWatts: { [W1]: 10 } } }));
    expect(f.workers[0].electricity.usdPerDay).toBeCloseTo(0.024, 12);
  });
  it("fleet sums revenue over workers that have an estimate; a worker without telemetry adds no revenue and no electricity", () => {
    const f = computeFinancials(
      input({
        workers: [worker(W1, "rig-1"), worker(W2, "rig-2")],
        hashrates: new Map([[W1, measure(TH)]]),
        settings: { ...BLANK, electricityUsdPerKwh: 0.1, defaultWattsPerWorker: 100 },
      }),
    );
    expect(f.fleet).toMatchObject({ workersWithEstimate: 1, workersWithoutEstimate: 1 });
    expect(f.fleet.revenueNetSatsPerDay).toBeCloseTo(45.63, 9);
    expect(f.fleet.electricityUsdPerDay).toBeCloseTo(0.24, 12);
    expect(f.fleet.netUsdPerDay).toBeCloseTo(0.04563 - 0.24, 9);
  });
  it("a cloud-linked worker is costed from the cloud projection (no electricity line); net is known when the price is known", () => {
    const f = computeFinancials(input({ cloudResources: [{ id: "r1", worker_id: W1, label: "box", hourly_price_usd: 0.01, cost_known: true }] }));
    expect(f.workers[0].electricity.applies).toBe(false);
    expect(f.workers[0].cloud.usdPerDay).toBeCloseTo(0.24, 12);
    expect(f.workers[0].netUsdPerDay).toBeCloseTo(0.04563 - 0.24, 9);
    expect(f.fleet.netUsdPerDay).toBeCloseTo(0.04563 - 0.24, 9);
  });
  it("a cloud resource with an unknown price makes net unknown, never free", () => {
    const f = computeFinancials(input({ cloudResources: [{ id: "r1", worker_id: W1, label: "box", hourly_price_usd: 0, cost_known: false }] }));
    expect(f.workers[0].netUsdPerDay).toBeNull();
    expect(f.fleet.netUsdPerDay).toBeNull();
    expect(f.fleet.netMissing).toContain("cloud price (unknown hourly price)");
  });
  it("a running cloud resource not linked to an estimated worker still counts against the fleet", () => {
    const f = computeFinancials(
      input({
        settings: { ...BLANK, electricityUsdPerKwh: 0.1, defaultWattsPerWorker: 100 },
        cloudResources: [{ id: "r1", worker_id: null, label: "idle box", hourly_price_usd: 0.1, cost_known: true }],
      }),
    );
    expect(f.fleet.cloud.usdPerDay).toBeCloseTo(2.4, 12);
    expect(f.fleet.netUsdPerDay).toBeCloseTo(0.04563 - 0.24 - 2.4, 9);
  });
  it("without a BTC price the USD figures and net are unknown, but BTC revenue is still shown", () => {
    const f = computeFinancials(input({ network: { ...NET, btcPriceUsd: null }, settings: { ...BLANK, electricityUsdPerKwh: 0.1, defaultWattsPerWorker: 100 } }));
    expect(f.fleet.revenueNetBtcPerDay).toBeCloseTo(45.63e-8, 15);
    expect(f.fleet.revenueNetUsdPerDay).toBeNull();
    expect(f.fleet.netUsdPerDay).toBeNull();
    expect(f.fleet.netMissing).toContain("BTC price");
  });
  it("can be positive when the inputs really say so (no bias towards loss)", () => {
    const f = computeFinancials(input({ hashrates: new Map([[W1, measure(1e15)]]), settings: { ...BLANK, electricityUsdPerKwh: 0.05, defaultWattsPerWorker: 3000 } }));
    // 1 PH/s => 45,630 sats/day = 0.0004563 BTC = $45.63 ; electricity 72 kWh x 0.05 = $3.60
    expect(f.fleet.netUsdPerDay).toBeCloseTo(45.63 - 3.6, 6);
  });
  it("reports hashrate coverage from the number of minute buckets", () => {
    const f = computeFinancials(input({ hashrates: new Map([[W1, measure(TH, 720)]]) }));
    expect(f.workers[0].hashrate?.coveragePct).toBeCloseTo(50, 9);
  });
});

describe("estimate / confirmed separation", () => {
  const row = (o: Partial<LedgerRow>): LedgerRow => ({ id: Math.random().toString(36), kind: "confirmed_payout", source: "pool", ref: "tx1", amount_sats: 1000, occurred_at: "2026-10-31T09:00:00Z", note: null, ...o });
  it("confirmed totals come only from confirmed_payout rows from pool/chain with a reference", () => {
    const c = confirmedFromLedger([
      row({ id: "a", amount_sats: 1000, ref: "txid-a" }),
      row({ id: "b", amount_sats: 2500, source: "chain", ref: "txid-b" }),
      row({ id: "c", kind: "estimated_reward", source: "estimate", ref: "e1", amount_sats: 999_999 }),
      row({ id: "d", source: "manual", ref: "m1", amount_sats: 5000 }),
      row({ id: "e", ref: null, amount_sats: 7000 }),
      row({ id: "f", ref: "   ", amount_sats: 8000 }),
      row({ id: "g", kind: "expense_other", source: "manual", ref: "x", amount_sats: null }),
    ]);
    expect(c.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(c.totalSats).toBe(3500);
  });
  it("no confirmed rows => total is null (not 0)", () => {
    expect(confirmedFromLedger([])).toEqual({ rows: [], totalSats: null });
    expect(confirmedFromLedger([row({ kind: "estimated_reward", source: "estimate", ref: "e" })]).totalSats).toBeNull();
  });
  it("the estimate engine takes no ledger/confirmed input and its output carries none", () => {
    const f = computeFinancials(input({}));
    expect(JSON.stringify(f).toLowerCase()).not.toContain("confirmed");
    const confirmed = confirmedFromLedger([row({ amount_sats: 123_456_789, ref: "big" })]);
    const f2 = computeFinancials(input({}));
    expect(f2.fleet.revenueNetSatsPerDay).toBe(f.fleet.revenueNetSatsPerDay); // confirmed money cannot move an estimate
    expect(confirmed.totalSats).toBe(123_456_789);
    expect(Object.keys(f2.fleet)).not.toContain("totalSats");
  });
});
