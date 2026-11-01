import { describe, expect, it } from "vitest";
import { BRAIINS_WORKERS_URL, fetchPoolWorkers } from "@/lib/profit/braiins";
import type { FetchLike } from "@/lib/profit/network";

const TOKEN = "test-token-DO-NOT-LEAK-0123456789";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
// Shape from Braiins' documentation sample (academy.braiins.com Worker API).
const SAMPLE = { btc: { workers: { "username.worker1": { state: "ok", last_share: 1542103204, hash_rate_unit: "Gh/s", hash_rate_scoring: 15342, hash_rate_5m: 14977, hash_rate_60m: 15302, hash_rate_24h: 15351, shares_5m: 90304, shares_60m: 1125762, shares_24h: 20945364 } } } };

describe("fetchPoolWorkers", () => {
  it("sends the token only as a header to the documented URL, with redirects refused, and labels results Pool-reported", async () => {
    let seen: { url: string; headers?: Record<string, string>; redirect?: string } | null = null;
    const f: FetchLike = async (url, init) => {
      seen = { url, headers: init?.headers, redirect: init?.redirect };
      return json(SAMPLE);
    };
    const r = await fetchPoolWorkers(f, TOKEN);
    expect(seen).toMatchObject({ url: BRAIINS_WORKERS_URL, redirect: "error" });
    expect(seen!.url).not.toContain(TOKEN);
    expect(seen!.headers!["Pool-Auth-Token"]).toBe(TOKEN);
    expect(r).toMatchObject({ ok: true, data: [{ label: "Pool-reported", name: "username.worker1", state: "ok", lastShareTs: 1542103204, shares60m: 1125762 }] });
  });
  it("accepts a worker without last_share (null) and returns an empty list for no workers", async () => {
    const a = await fetchPoolWorkers(async () => json({ btc: { workers: { "u.w": { state: "off", last_share: null } } } }), TOKEN);
    expect(a).toMatchObject({ ok: true, data: [{ name: "u.w", lastShareTs: null, shares5m: null }] });
    const b = await fetchPoolWorkers(async () => json({ btc: { workers: {} } }), TOKEN);
    expect(b).toEqual({ ok: true, data: [] });
  });
  it("maps failures to codes and never leaks the token", async () => {
    expect(await fetchPoolWorkers(async () => json({}, 401), TOKEN)).toEqual({ ok: false, error: "token_rejected" });
    expect(await fetchPoolWorkers(async () => json({}, 500), TOKEN)).toEqual({ ok: false, error: "http_500" });
    expect(await fetchPoolWorkers(async () => json({ unexpected: true }), TOKEN)).toEqual({ ok: false, error: "invalid_response" });
    expect(await fetchPoolWorkers(async () => { throw new Error(`boom ${TOKEN}`); }, TOKEN)).toEqual({ ok: false, error: "network_error" });
  });
});
