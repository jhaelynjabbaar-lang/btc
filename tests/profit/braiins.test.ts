import { describe, expect, it } from "vitest";
import { braiinsToken, fetchPoolPayouts, fetchPoolProfile, payoutsToLedgerRows, BRAIINS_PROFILE_URL } from "@/lib/profit/braiins";
import type { FetchLike } from "@/lib/profit/network";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const TOKEN = "test-token-DO-NOT-LEAK-0123456789";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const PROFILE = { username: "jhaelyngta", btc: { all_time_reward: "0.00100000", hash_rate_unit: "Gh/s", hash_rate_5m: 1, hash_rate_60m: 1, hash_rate_24h: 2.5, current_balance: "0.00040000", today_reward: "0.000001", shares_5m: 12, shares_24h: 3400, ok_workers: 1 } };
const PAYOUTS = {
  onchain: [
    { status: "confirmed", amount_sats: 50000, fee_sats: 1000, requested_at_ts: 1721997284, resolved_at_ts: 1721999584, tx_id: "a5f3e1f0a8e7f2d8c0c4f9b2b7b0b1a0987654321" },
    { status: "queued", amount_sats: 1000000, fee_sats: 0, requested_at_ts: 1722997284, resolved_at_ts: 1722999584, tx_id: null },
    { status: "confirmed", amount_sats: 777, fee_sats: 0, requested_at_ts: 1722997285, resolved_at_ts: 1722999585, tx_id: null },
  ],
  lightning: [
    { status: "confirmed", amount_sats: 441348, fee_sats: 0, requested_at_ts: 1712846879, resolved_at_ts: 1712846885, preimage: "93a0049b3963b7bd8d9d3e97cff2975745f83fa94562b4a0db208fe8cddcb3e5" },
    { status: "failed", amount_sats: 527, fee_sats: 0, requested_at_ts: 1712856879, resolved_at_ts: 1712856885, preimage: null },
  ],
};

describe("Braiins token", () => {
  it("is 'not connected' (null) when BRAIINS_POOL_TOKEN is unset or blank", () => {
    expect(braiinsToken({})).toBeNull();
    expect(braiinsToken({ BRAIINS_POOL_TOKEN: "   " })).toBeNull();
    expect(braiinsToken({ BRAIINS_POOL_TOKEN: " abc " })).toBe("abc");
  });
});

describe("pool-reported profile", () => {
  it("sends the token only as the Pool-Auth-Token header to the documented URL and labels the result Pool-reported", async () => {
    let seen: { url: string; headers?: Record<string, string>; redirect?: string } | null = null;
    const f: FetchLike = async (url, init) => {
      seen = { url, headers: init?.headers, redirect: init?.redirect };
      return json(PROFILE);
    };
    const r = await fetchPoolProfile(f, TOKEN, NOW);
    expect(seen).toMatchObject({ url: BRAIINS_PROFILE_URL, redirect: "error" });
    expect(seen!.headers!["Pool-Auth-Token"]).toBe(TOKEN);
    expect(seen!.url).not.toContain(TOKEN);
    expect(r).toMatchObject({ ok: true, data: { label: "Pool-reported", username: "jhaelyngta", currentBalanceBtc: 0.0004, shares24h: 3400, hashRateUnit: "Gh/s" } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it("a rejected token, an HTTP error, a bad shape and a network failure all produce codes that never contain the token", async () => {
    const cases: Array<[FetchLike, string]> = [
      [async () => json({}, 401), "token_rejected"],
      [async () => json({}, 403), "token_rejected"],
      [async () => json({}, 502), "http_502"],
      [async () => json({ btc: { nope: 1 } }), "invalid_response"],
      [async () => new Response("<html>", { status: 200 }), "invalid_response"],
      [async () => { throw new TypeError(`fetch failed for ${TOKEN}`); }, "network_error"],
    ];
    for (const [f, code] of cases) {
      const r = await fetchPoolProfile(f, TOKEN, NOW);
      expect(r).toEqual({ ok: false, error: code });
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });
});

describe("pool payouts -> ledger", () => {
  it("only CONFIRMED payouts with a reference become confirmed_payout rows from the pool", async () => {
    const r = await fetchPoolPayouts(async () => json(PAYOUTS), TOKEN, "2026-08-01", "2026-11-01");
    if (!r.ok) throw new Error("expected payouts");
    expect(r.data).toHaveLength(5);
    expect(r.data.every((p) => p.label === "Pool-reported")).toBe(true);
    const { rows, skipped } = payoutsToLedgerRows(r.data);
    expect(skipped).toEqual({ queued: 1, failed: 1, noReference: 1 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "confirmed_payout", source: "pool", ref: "a5f3e1f0a8e7f2d8c0c4f9b2b7b0b1a0987654321", amount_sats: 50000, occurred_at: new Date(1721999584 * 1000).toISOString() });
    expect(rows[1]).toMatchObject({ source: "pool", ref: "ln:93a0049b3963b7bd8d9d3e97cff2975745f83fa94562b4a0db208fe8cddcb3e5", amount_sats: 441348 });
    for (const row of rows) {
      expect(row.ref.trim().length).toBeGreaterThan(0); // satisfies ledger_confirmed_payout_provenance
      expect(row.note).toMatch(/Pool-reported/);
    }
  });
  it("the request URL carries the date range and the token only in the header", async () => {
    let url = "";
    let hdr: Record<string, string> | undefined;
    await fetchPoolPayouts(async (u, init) => { url = u; hdr = init?.headers; return json({ onchain: [], lightning: [] }); }, TOKEN, "2026-08-01", "2026-11-01");
    expect(url).toBe("https://pool.braiins.com/accounts/payouts/json/btc?from=2026-08-01&to=2026-11-01");
    expect(hdr?.["Pool-Auth-Token"]).toBe(TOKEN);
  });
  it("an empty payout list imports nothing", () => {
    expect(payoutsToLedgerRows([])).toEqual({ rows: [], skipped: { queued: 0, failed: 0, noReference: 0 } });
  });
});
