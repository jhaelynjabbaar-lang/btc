import { describe, expect, it } from "vitest";
import { classifySnapshot, fetchNetworkData, hasAnyNetworkData, networkInputsFrom, ENDPOINTS, type FetchLike, type SnapshotRow } from "@/lib/profit/network";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const GOOD: Record<string, () => Response> = {
  [ENDPOINTS.hashrate]: () => json({ hashrates: [], difficulty: [], currentHashrate: 1.07e21, currentDifficulty: 148364561003867.4 }),
  [ENDPOINTS.tip]: () => new Response("974141", { status: 200 }),
  [ENDPOINTS.rewardStats]: () => json({ startBlock: 973998, endBlock: 974141, totalReward: "45212594134", totalFee: "212594134", totalTx: "690934" }),
  [ENDPOINTS.prices]: () => json({ time: 1793547303, USD: 77962, EUR: 69870 }),
  [ENDPOINTS.coingecko]: () => json({ bitcoin: { usd: 77988, last_updated_at: 1793547570 } }),
};
const fakeFetch = (over: Record<string, () => Response | Promise<Response>> = {}): FetchLike => async (url) => {
  const h = over[url] ?? GOOD[url];
  if (!h) throw new Error(`unexpected url ${url}`);
  return h();
};

describe("fetchNetworkData", () => {
  it("derives every field from the public endpoints and records source and time", async () => {
    const f = await fetchNetworkData(fakeFetch(), NOW);
    expect(f.fetched_at).toBe(NOW.toISOString());
    expect(f.source).toBe("mempool.space");
    expect(f.difficulty).toBe(148364561003867.4);
    expect(f.network_hashrate_hs).toBe(1.07e21);
    expect(f.block_height).toBe(974141);
    expect(f.subsidy_sats).toBe(312_500_000); // 50 BTC halved four times
    expect(f.fee_window_blocks).toBe(144);
    expect(f.avg_fee_sats).toBeCloseTo(212594134 / 144, 6);
    expect(f.btc_price_usd).toBe(77962);
    expect(f.price_source).toBe("mempool.space");
    expect(f.price_time).toBe(new Date(1793547303 * 1000).toISOString());
    expect(f.field_errors).toEqual({});
    expect(hasAnyNetworkData(f)).toBe(true);
  });

  it("a failing endpoint makes only its fields unavailable (null + code); nothing is invented or carried over", async () => {
    const f = await fetchNetworkData(fakeFetch({ [ENDPOINTS.hashrate]: () => json({ error: "x" }, 503) }), NOW);
    expect(f.difficulty).toBeNull();
    expect(f.network_hashrate_hs).toBeNull();
    expect(f.field_errors).toMatchObject({ difficulty: "http_503", network_hashrate: "http_503" });
    expect(f.subsidy_sats).toBe(312_500_000);
    expect(f.btc_price_usd).toBe(77962);
    expect(hasAnyNetworkData(f)).toBe(true);
  });

  it("tip failure leaves the subsidy unavailable too (it is derived from the height)", async () => {
    const f = await fetchNetworkData(fakeFetch({ [ENDPOINTS.tip]: () => new Response("<html>oops</html>", { status: 200 }) }), NOW);
    expect(f.block_height).toBeNull();
    expect(f.subsidy_sats).toBeNull();
    expect(f.field_errors.subsidy).toBe("invalid_response");
  });

  it("price falls back to CoinGecko only when mempool.space fails, and says so", async () => {
    const f = await fetchNetworkData(fakeFetch({ [ENDPOINTS.prices]: () => json({}, 500) }), NOW);
    expect(f.btc_price_usd).toBe(77988);
    expect(f.price_source).toBe("coingecko.com");
    expect(f.field_errors.price_fallback).toBe("mempool.space:http_500");
    expect(f.field_errors.price).toBeUndefined();
  });

  it("both price sources failing => price unavailable", async () => {
    const f = await fetchNetworkData(fakeFetch({ [ENDPOINTS.prices]: () => json({}, 500), [ENDPOINTS.coingecko]: () => json({}, 429) }), NOW);
    expect(f.btc_price_usd).toBeNull();
    expect(f.price_source).toBeNull();
    expect(f.field_errors.price).toBe("http_500; coingecko:http_429");
  });

  it("rejects out-of-shape, zero and negative values", async () => {
    const f = await fetchNetworkData(
      fakeFetch({
        [ENDPOINTS.hashrate]: () => json({ currentHashrate: 0, currentDifficulty: 1 }),
        [ENDPOINTS.prices]: () => json({ time: 1, USD: -5 }),
        [ENDPOINTS.coingecko]: () => json({ bitcoin: { usd: "x" } }),
        [ENDPOINTS.rewardStats]: () => json({ startBlock: 10, endBlock: 5, totalFee: "1" }),
      }),
      NOW,
    );
    expect(f.network_hashrate_hs).toBeNull();
    expect(f.btc_price_usd).toBeNull();
    expect(f.avg_fee_sats).toBeNull();
    expect(f.field_errors).toMatchObject({ network_hashrate: "invalid_response", avg_fee: "invalid_response" });
  });

  it("network errors and timeouts are reported as codes, not messages", async () => {
    const timeout = () => {
      throw Object.assign(new Error("secret internal text"), { name: "TimeoutError" });
    };
    const f = await fetchNetworkData(fakeFetch({ [ENDPOINTS.hashrate]: timeout, [ENDPOINTS.rewardStats]: () => Promise.reject(new TypeError("fetch failed")) }), NOW);
    expect(f.field_errors.difficulty).toBe("timeout");
    expect(f.field_errors.avg_fee).toBe("network_error");
    expect(JSON.stringify(f.field_errors)).not.toContain("secret internal text");
  });

  it("total API failure => nothing usable (a row is not stored)", async () => {
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const f = await fetchNetworkData(down, NOW);
    expect(hasAnyNetworkData(f)).toBe(false);
    expect(f.difficulty).toBeNull();
    expect(f.btc_price_usd).toBeNull();
    expect(Object.keys(f.field_errors).length).toBeGreaterThanOrEqual(5);
  });

  it("never follows redirects and always sets a timeout signal", async () => {
    const seen: Array<{ redirect?: string; hasSignal: boolean }> = [];
    const spy: FetchLike = async (url, init) => {
      seen.push({ redirect: init?.redirect, hasSignal: !!init?.signal });
      return GOOD[url]();
    };
    await fetchNetworkData(spy, NOW);
    expect(seen.length).toBe(4);
    for (const s of seen) expect(s).toEqual({ redirect: "error", hasSignal: true });
  });
});

describe("cached snapshots are labelled by age and never silently reused", () => {
  const snap = (ageMin: number): SnapshotRow => ({
    id: "s", trigger: "cron", source: "mempool.space", fetched_at: new Date(NOW.getTime() - ageMin * 60_000).toISOString(),
    block_height: 974141, difficulty: 1, network_hashrate_hs: 1e21, subsidy_sats: 312_500_000, avg_fee_sats: 1_000_000, fee_window_blocks: 144,
    btc_price_usd: 80_000, price_source: "mempool.space", price_time: null, field_errors: {}, raw: {},
  });
  it("classifies fresh / stale / unusable / none", () => {
    expect(classifySnapshot(snap(5), NOW)).toBe("fresh");
    expect(classifySnapshot(snap(60), NOW)).toBe("fresh");
    expect(classifySnapshot(snap(61), NOW)).toBe("stale");
    expect(classifySnapshot(snap(24 * 60), NOW)).toBe("stale");
    expect(classifySnapshot(snap(24 * 60 + 1), NOW)).toBe("unusable");
    expect(classifySnapshot(null, NOW)).toBe("none");
  });
  it("math inputs: usable snapshot passes values; none or older than 24 h gives all-null (=> no estimate)", () => {
    expect(networkInputsFrom(snap(30), NOW)).toEqual({ networkHashrateHs: 1e21, subsidySats: 312_500_000, avgFeeSats: 1_000_000, btcPriceUsd: 80_000 });
    expect(networkInputsFrom(snap(120), NOW).networkHashrateHs).toBe(1e21); // stale: used, but the page labels it STALE
    const dead = { networkHashrateHs: null, subsidySats: null, avgFeeSats: null, btcPriceUsd: null };
    expect(networkInputsFrom(snap(25 * 60), NOW)).toEqual(dead);
    expect(networkInputsFrom(null, NOW)).toEqual(dead);
  });
});
