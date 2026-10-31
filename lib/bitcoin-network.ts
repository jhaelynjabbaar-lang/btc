import "server-only";

/**
 * Bitcoin network status from the public, keyless mempool.space REST API.
 * Fetched server-side only, cached via the Next.js data cache (revalidate: 60s).
 * Every field is individually nullable so one failing endpoint degrades gracefully.
 */

const BASE = "https://mempool.space/api";
const REVALIDATE_SECONDS = 60;
const TIMEOUT_MS = 5000;
const ATTEMPTS = 2; // mempool.space occasionally stalls on a single request; one retry is cheap

export type NetworkStatus = {
  source: "mempool.space";
  /** Value of the HTTP Date header of the freshest response, ISO string (UTC). */
  asOf: string | null;
  tipHeight: number | null;
  latestBlock: { time: number; txCount: number; pool: string | null } | null;
  fees: { fastest: number; halfHour: number; hour: number; economy: number; minimum: number } | null;
  difficulty: {
    current: number | null;
    /** Network hashrate estimate in H/s. */
    hashrate: number | null;
    progressPercent: number;
    remainingBlocks: number;
    estimatedChangePercent: number;
    estimatedRetargetDate: number;
    nextRetargetHeight: number;
  } | null;
  mempool: { count: number; vsize: number } | null;
  /** Names of endpoints that failed (empty when everything succeeded). */
  failed: string[];
};

async function getJson<T>(path: string): Promise<{ data: T; date: string | null }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        next: { revalidate: REVALIDATE_SECONDS },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return { data: (await res.json()) as T, date: res.headers.get("date") };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export async function getNetworkStatus(): Promise<NetworkStatus> {
  const [tip, blocks, fees, diff, hash, pool] = await Promise.allSettled([
    getJson<number>("/blocks/tip/height"),
    getJson<Array<{ timestamp: number; tx_count: number; extras?: { pool?: { name?: string } } }>>("/v1/blocks"),
    getJson<{ fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number; minimumFee: number }>(
      "/v1/fees/recommended",
    ),
    getJson<{
      progressPercent: number;
      difficultyChange: number;
      estimatedRetargetDate: number;
      remainingBlocks: number;
      nextRetargetHeight: number;
    }>("/v1/difficulty-adjustment"),
    getJson<{ currentHashrate: number; currentDifficulty: number }>("/v1/mining/hashrate/3d"),
    getJson<{ count: number; vsize: number }>("/mempool"),
  ]);

  const failed: string[] = [];
  const dates: number[] = [];
  const take = <T,>(name: string, r: PromiseSettledResult<{ data: T; date: string | null }>): T | null => {
    if (r.status === "rejected") {
      failed.push(name);
      return null;
    }
    if (r.value.date) {
      const t = Date.parse(r.value.date);
      if (!Number.isNaN(t)) dates.push(t);
    }
    return r.value.data;
  };

  const tipV = take("block height", tip);
  const blocksV = take("latest block", blocks);
  const feesV = take("fees", fees);
  const diffV = take("difficulty", diff);
  const hashV = take("hashrate", hash);
  const poolV = take("mempool", pool);

  const b0 = Array.isArray(blocksV) ? blocksV[0] : undefined;
  const tipHeight = isNum(tipV) ? tipV : null;

  return {
    source: "mempool.space",
    asOf: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    tipHeight,
    latestBlock:
      b0 && isNum(b0.timestamp) && isNum(b0.tx_count)
        ? { time: b0.timestamp, txCount: b0.tx_count, pool: b0.extras?.pool?.name ?? null }
        : null,
    fees:
      feesV && isNum(feesV.fastestFee)
        ? {
            fastest: feesV.fastestFee,
            halfHour: feesV.halfHourFee,
            hour: feesV.hourFee,
            economy: feesV.economyFee,
            minimum: feesV.minimumFee,
          }
        : null,
    difficulty:
      diffV && isNum(diffV.progressPercent)
        ? {
            current: hashV && isNum(hashV.currentDifficulty) ? hashV.currentDifficulty : null,
            hashrate: hashV && isNum(hashV.currentHashrate) ? hashV.currentHashrate : null,
            progressPercent: diffV.progressPercent,
            remainingBlocks: diffV.remainingBlocks,
            estimatedChangePercent: diffV.difficultyChange,
            estimatedRetargetDate: diffV.estimatedRetargetDate,
            nextRetargetHeight: diffV.nextRetargetHeight,
          }
        : null,
    mempool: poolV && isNum(poolV.count) ? { count: poolV.count, vsize: poolV.vsize } : null,
    failed,
  };
}

export function formatHashrate(hs: number): string {
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let i = 0;
  let v = hs;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDifficulty(d: number): string {
  return `${(d / 1e12).toFixed(2)} T`;
}
