import { z } from "zod";
import { FETCH_TIMEOUT_MS, NETWORK_SOURCE, PRICE_FALLBACK_SOURCE, SNAPSHOT_FRESH_MS, SNAPSHOT_USABLE_MS } from "./config";
import { blockSubsidySats, type NetworkInputs } from "./math";

/**
 * Public network data, keyless APIs only (mempool.space; CoinGecko only as a price fallback, and then labelled as such).
 * Every field is fetched independently: a field that fails is `null` with a short error code in `field_errors`. It is NEVER filled
 * from an older fetch here. The network/DB layer stores the result as one row; anything older is shown only with its own timestamp.
 */

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "follow" | "error" | "manual" }) => Promise<Response>;

export type NetworkFetch = {
  fetched_at: string;
  source: typeof NETWORK_SOURCE;
  block_height: number | null;
  difficulty: number | null;
  network_hashrate_hs: number | null;
  subsidy_sats: number | null;
  avg_fee_sats: number | null;
  fee_window_blocks: number | null;
  btc_price_usd: number | null;
  price_source: string | null;
  price_time: string | null;
  field_errors: Record<string, string>;
  raw: Record<string, unknown>;
};

const BASE = "https://mempool.space";
export const ENDPOINTS = {
  hashrate: `${BASE}/api/v1/mining/hashrate/3d`,
  tip: `${BASE}/api/blocks/tip/height`,
  rewardStats: `${BASE}/api/v1/mining/reward-stats/144`,
  prices: `${BASE}/api/v1/prices`,
  coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true",
} as const;

const posNum = z.number().finite().positive();
const HashrateResp = z.object({ currentHashrate: posNum, currentDifficulty: posNum });
const RewardStatsResp = z.object({
  startBlock: z.number().int().nonnegative(),
  endBlock: z.number().int().nonnegative(),
  totalFee: z.union([z.string(), z.number()]).transform((v) => Number(v)).pipe(z.number().finite().nonnegative()),
});
const PricesResp = z.object({ time: z.number().int().positive(), USD: posNum });
const CoinGeckoResp = z.object({ bitcoin: z.object({ usd: posNum, last_updated_at: z.number().int().positive() }) });

type Fetched<T> = { ok: true; data: T } | { ok: false; error: string };

async function getJson<T>(fetchImpl: FetchLike, url: string, schema: z.ZodType<T>, timeoutMs: number): Promise<Fetched<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" }, redirect: "error" });
  } catch (e) {
    return { ok: false, error: e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network_error" };
  }
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "invalid_response" };
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: "invalid_response" };
}

async function getHeight(fetchImpl: FetchLike, timeoutMs: number): Promise<Fetched<number>> {
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINTS.tip, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch (e) {
    return { ok: false, error: e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network_error" };
  }
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  const text = (await res.text().catch(() => "")).trim();
  const n = Number(text);
  return /^\d{1,8}$/.test(text) && Number.isInteger(n) ? { ok: true, data: n } : { ok: false, error: "invalid_response" };
}

export async function fetchNetworkData(fetchImpl: FetchLike, now: Date = new Date(), timeoutMs: number = FETCH_TIMEOUT_MS): Promise<NetworkFetch> {
  const [hr, tip, rs, pr] = await Promise.all([
    getJson(fetchImpl, ENDPOINTS.hashrate, HashrateResp, timeoutMs),
    getHeight(fetchImpl, timeoutMs),
    getJson(fetchImpl, ENDPOINTS.rewardStats, RewardStatsResp, timeoutMs),
    getJson(fetchImpl, ENDPOINTS.prices, PricesResp, timeoutMs),
  ]);
  const errors: Record<string, string> = {};
  const raw: Record<string, unknown> = {};

  let difficulty: number | null = null;
  let hashrate: number | null = null;
  if (hr.ok) {
    difficulty = hr.data.currentDifficulty;
    hashrate = hr.data.currentHashrate;
    raw.hashrate = { currentHashrate: hr.data.currentHashrate, currentDifficulty: hr.data.currentDifficulty, endpoint: ENDPOINTS.hashrate };
  } else {
    errors.difficulty = hr.error;
    errors.network_hashrate = hr.error;
  }

  let height: number | null = null;
  let subsidy: number | null = null;
  if (tip.ok) {
    height = tip.data;
    subsidy = blockSubsidySats(tip.data);
    raw.tip = { height: tip.data, endpoint: ENDPOINTS.tip, subsidy_rule: "50 BTC halved every 210000 blocks" };
  } else {
    errors.block_height = tip.error;
    errors.subsidy = tip.error;
  }

  let avgFee: number | null = null;
  let feeWindow: number | null = null;
  if (rs.ok) {
    const blocks = rs.data.endBlock - rs.data.startBlock + 1;
    if (blocks > 0) {
      feeWindow = blocks;
      avgFee = rs.data.totalFee / blocks;
      raw.reward_stats = { startBlock: rs.data.startBlock, endBlock: rs.data.endBlock, totalFee: rs.data.totalFee, endpoint: ENDPOINTS.rewardStats };
    } else errors.avg_fee = "invalid_response";
  } else errors.avg_fee = rs.error;

  let price: number | null = null;
  let priceSource: string | null = null;
  let priceTime: string | null = null;
  if (pr.ok) {
    price = pr.data.USD;
    priceSource = NETWORK_SOURCE;
    priceTime = new Date(pr.data.time * 1000).toISOString();
    raw.prices = { USD: pr.data.USD, time: pr.data.time, endpoint: ENDPOINTS.prices };
  } else {
    errors.price = pr.error;
    const cg = await getJson(fetchImpl, ENDPOINTS.coingecko, CoinGeckoResp, timeoutMs);
    if (cg.ok) {
      price = cg.data.bitcoin.usd;
      priceSource = PRICE_FALLBACK_SOURCE;
      priceTime = new Date(cg.data.bitcoin.last_updated_at * 1000).toISOString();
      raw.prices = { usd: cg.data.bitcoin.usd, last_updated_at: cg.data.bitcoin.last_updated_at, endpoint: "coingecko simple/price", note: `${NETWORK_SOURCE} price failed (${pr.error}); CoinGecko used` };
      errors.price_fallback = `${NETWORK_SOURCE}:${pr.error}`;
      delete errors.price;
    } else errors.price = `${pr.error}; coingecko:${cg.error}`;
  }

  return {
    fetched_at: now.toISOString(),
    source: NETWORK_SOURCE,
    block_height: height,
    difficulty,
    network_hashrate_hs: hashrate,
    subsidy_sats: subsidy,
    avg_fee_sats: avgFee,
    fee_window_blocks: feeWindow,
    btc_price_usd: price,
    price_source: priceSource,
    price_time: priceTime,
    field_errors: errors,
    raw,
  };
}

/** True when at least one field was fetched (a row is only stored then; a total failure stores nothing). */
export const hasAnyNetworkData = (f: NetworkFetch): boolean =>
  [f.block_height, f.difficulty, f.network_hashrate_hs, f.avg_fee_sats, f.btc_price_usd].some((v) => v !== null);

// ------------------------------------------------------------------------------------------------ cached snapshots
export type SnapshotRow = Omit<NetworkFetch, "source"> & { id: string; source: string; trigger: string };
export type Freshness = "fresh" | "stale" | "unusable";

export function snapshotAgeMs(s: Pick<SnapshotRow, "fetched_at">, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(s.fetched_at));
}

/** fresh <= 1 h; stale <= 24 h (usable, but the UI says STALE); older: unusable (estimates are withheld; the row is shown only as "last known"). */
export function classifySnapshot(s: Pick<SnapshotRow, "fetched_at"> | null, now: Date): Freshness | "none" {
  if (!s) return "none";
  const age = snapshotAgeMs(s, now);
  if (!Number.isFinite(age)) return "unusable";
  return age <= SNAPSHOT_FRESH_MS ? "fresh" : age <= SNAPSHOT_USABLE_MS ? "stale" : "unusable";
}

/** Inputs for the math. No snapshot, or an unusable (older than 24 h) one, gives all-null inputs, i.e. no estimate. */
export function networkInputsFrom(s: SnapshotRow | null, now: Date): NetworkInputs {
  const f = classifySnapshot(s, now);
  if (!s || f === "none" || f === "unusable") return { networkHashrateHs: null, subsidySats: null, avgFeeSats: null, btcPriceUsd: null };
  return { networkHashrateHs: s.network_hashrate_hs, subsidySats: s.subsidy_sats, avgFeeSats: s.avg_fee_sats, btcPriceUsd: s.btc_price_usd };
}
