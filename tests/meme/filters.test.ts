import { describe, expect, it } from "vitest";
import { checkPair, checkRug, nonPoolHolders, pairAgeHours } from "@/lib/meme/filters";
import { cfg, goodPair, goodRug, HOUR, NOW } from "./fixtures";

const codes = (r: { code: string }[]) => r.map((x) => x.code);

describe("checkPair (DexScreener-stage rug / quality checks)", () => {
  it("passes a healthy momentum pair", () => {
    expect(checkPair(goodPair(), cfg, NOW)).toEqual([]);
  });

  it("rejects thin liquidity and pools without a liquidity figure (bonding curves)", () => {
    expect(codes(checkPair(goodPair({ liquidityUsd: 49_999 }), cfg, NOW))).toContain("liquidity_below_min");
    expect(checkPair(goodPair({ liquidityUsd: 50_000 }), cfg, NOW)).toEqual([]); // boundary is inclusive
    expect(codes(checkPair(goodPair({ liquidityUsd: null }), cfg, NOW))).toEqual(["no_liquidity_data"]);
  });

  it("enforces the pool age window: too new (rug window) and too old (not a new token)", () => {
    expect(codes(checkPair(goodPair({ pairCreatedAtMs: NOW - 5.9 * HOUR }), cfg, NOW))).toContain("pair_too_new");
    expect(checkPair(goodPair({ pairCreatedAtMs: NOW - 6 * HOUR }), cfg, NOW)).toEqual([]);
    expect(codes(checkPair(goodPair({ pairCreatedAtMs: NOW - 169 * HOUR }), cfg, NOW))).toContain("pair_too_old");
    expect(codes(checkPair(goodPair({ pairCreatedAtMs: null }), cfg, NOW))).toContain("pair_age_unknown");
    expect(pairAgeHours(goodPair({ pairCreatedAtMs: NOW - 12 * HOUR }), NOW)).toBe(12);
  });

  it("requires volume, activity and more buys than sells", () => {
    expect(codes(checkPair(goodPair({ volume24h: 99_999 }), cfg, NOW))).toContain("volume_24h_below_min");
    expect(codes(checkPair(goodPair({ txns: { ...goodPair().txns, h1: { buys: 30, sells: 20 } } }), cfg, NOW))).toContain("too_few_txns_1h");
    const sellers = goodPair({ txns: { ...goodPair().txns, h1: { buys: 200, sells: 300 } } });
    expect(codes(checkPair(sellers, cfg, NOW))).toContain("buy_ratio_1h_low");
    const dayDump = goodPair({ txns: { ...goodPair().txns, h24: { buys: 3000, sells: 7000 } } });
    expect(codes(checkPair(dayDump, cfg, NOW))).toContain("buy_ratio_24h_low");
  });

  it("requires momentum but rejects absurd moves (vertical pumps) and a falling last 5 minutes", () => {
    expect(codes(checkPair(goodPair({ change: { m5: 0, h1: 2.9, h6: 30, h24: 10 } }), cfg, NOW))).toContain("no_momentum_1h");
    expect(codes(checkPair(goodPair({ change: { m5: 0, h1: 10, h6: -1, h24: 10 } }), cfg, NOW))).toContain("no_momentum_6h");
    expect(codes(checkPair(goodPair({ change: { m5: 0, h1: 41, h6: 50, h24: 100 } }), cfg, NOW))).toContain("absurd_change_1h");
    expect(codes(checkPair(goodPair({ change: { m5: 0, h1: 20, h6: 151, h24: 100 } }), cfg, NOW))).toContain("absurd_change_6h");
    expect(codes(checkPair(goodPair({ change: { m5: 0, h1: 20, h6: 50, h24: 401 } }), cfg, NOW))).toContain("absurd_change_24h");
    expect(codes(checkPair(goodPair({ change: { m5: -1.5, h1: 20, h6: 50, h24: 100 } }), cfg, NOW))).toContain("dumping_5m");
    expect(codes(checkPair(goodPair({ change: { m5: null, h1: null, h6: null, h24: null } }), cfg, NOW))).toContain("price_change_missing");
  });

  it("reports EVERY failing reason, with the numbers, not just the first", () => {
    const r = checkPair(goodPair({ liquidityUsd: 1000, volume24h: 10, pairCreatedAtMs: NOW - HOUR }), cfg, NOW);
    expect(codes(r)).toEqual(expect.arrayContaining(["liquidity_below_min", "volume_24h_below_min", "pair_too_new"]));
    expect(r.find((x) => x.code === "liquidity_below_min")?.detail).toMatch(/\$1,000 < \$50,000/);
  });
});

describe("checkRug (RugCheck stage)", () => {
  it("passes a clean report; liquidity-pool holdings do not count as concentration", () => {
    expect(checkRug(goodRug(), cfg)).toEqual([]);
    expect(nonPoolHolders(goodRug()).map((h) => h.address)).toEqual(["H1", "H2", "H3"]);
  });

  it("rejects enabled mint or freeze authority, unknown authority and rugged tokens", () => {
    expect(codes(checkRug(goodRug({ mintAuthorityEnabled: true }), cfg))).toContain("mint_authority_enabled");
    expect(codes(checkRug(goodRug({ freezeAuthorityEnabled: true }), cfg))).toContain("freeze_authority_enabled");
    expect(codes(checkRug(goodRug({ rugged: true }), cfg))).toContain("rugcheck_rugged");
    expect(codes(checkRug(goodRug({ transferFeePct: 5 }), cfg))).toContain("transfer_fee");
  });

  it("rejects a high risk score, danger-level risks and a missing score", () => {
    expect(codes(checkRug(goodRug({ scoreNormalised: 41 }), cfg))).toContain("rugcheck_score_high");
    expect(checkRug(goodRug({ scoreNormalised: 40 }), cfg)).toEqual([]);
    expect(codes(checkRug(goodRug({ dangerRisks: ["Creator history of rugged tokens"] }), cfg))).toContain("rugcheck_danger_risk");
    expect(codes(checkRug(goodRug({ scoreNormalised: null }), cfg))).toContain("rugcheck_score_missing");
  });

  it("rejects top-holder and top-10 concentration (non-pool holders only)", () => {
    expect(codes(checkRug(goodRug({ holders: [{ address: "H1", owner: "W1", pct: 10.5 }, ...goodRug().holders.slice(2)] }), cfg))).toContain("top_holder_concentration");
    const ten = Array.from({ length: 10 }, (_, i) => ({ address: `X${i}`, owner: `O${i}`, pct: 3.6 })); // 36% in 10 wallets, none above 10%
    const r = codes(checkRug(goodRug({ holders: ten }), cfg));
    expect(r).toContain("top10_concentration");
    expect(r).not.toContain("top_holder_concentration");
    expect(codes(checkRug(goodRug({ holders: [{ address: "POOL1", owner: "POOLOWNER", pct: 99 }] }), cfg))).toContain("holders_unknown");
  });

  it("fails CLOSED when RugCheck is unavailable (no buy without a rug check), unless explicitly disabled", () => {
    expect(codes(checkRug(null, cfg, "http_500"))).toEqual(["rugcheck_unavailable"]);
    expect(checkRug(null, { ...cfg, requireRugcheck: false })).toEqual([]);
  });
});
