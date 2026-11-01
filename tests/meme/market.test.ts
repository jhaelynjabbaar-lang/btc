import { describe, expect, it } from "vitest";
import { cleanLabel, discover, fetchPairs, fetchRugReport, fetchSolPrice, getJson, parseDexPairs, parseRugReport, pickBestPair, pickDexTokens, pickGeckoTokens, solPriceFromPairs, type FetchLike } from "@/lib/meme/market";
import { USDC_MINT, WSOL_MINT } from "@/lib/meme/config";
import { goodPair, TOKEN, PAIR } from "./fixtures";

const now = () => new Date("2026-11-01T21:00:00Z");
const res = (status: number, body: unknown, headers: Record<string, string> = {}): ReturnType<FetchLike> =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)), headers: new Headers(headers) });

// Shape copied from a real https://api.dexscreener.com/tokens/v1/solana/{address} response (trimmed).
const rawPair = {
  chainId: "solana",
  dexId: "raydium",
  pairAddress: PAIR,
  baseToken: { address: TOKEN, name: "GTA6", symbol: "GTA 6 Coin" },
  quoteToken: { address: WSOL_MINT, name: "Wrapped SOL", symbol: "SOL" },
  priceNative: "0.00001446",
  priceUsd: "0.001360",
  txns: { m5: { buys: 4, sells: 1 }, h1: { buys: 79, sells: 83 }, h6: { buys: 200, sells: 247 }, h24: { buys: 591, sells: 579 } },
  volume: { h24: 49198.72, h6: 15589.13, h1: 4300.12, m5: 67.56 },
  priceChange: { m5: -0.58, h1: 4.77, h6: 19.62, h24: 15.71 },
  liquidity: { usd: 160724.25, base: 58995399, quote: 854.8994 },
  fdv: 1358708,
  pairCreatedAt: 1738111507000,
};

describe("DexScreener parsing", () => {
  it("parses a real-shaped pair and sanitises untrusted names", () => {
    const [p] = parseDexPairs([{ ...rawPair, baseToken: { ...rawPair.baseToken, symbol: "EVIL\u202e\u0000 <script>" } }]);
    expect(p).toMatchObject({ tokenAddress: TOKEN, priceUsd: 0.00136, liquidityUsd: 160724.25, volume24h: 49198.72, change: { h1: 4.77, m5: -0.58 } });
    expect(p.symbol).toBe("EVIL <script>"); // control / bidi characters stripped (display escapes the rest)
    expect(cleanLabel("x".repeat(100), 10)).toHaveLength(10);
    expect(cleanLabel(42)).toBe("?");
  });
  it("drops malformed entries and non-Solana chains", () => {
    expect(parseDexPairs("nope")).toEqual([]);
    expect(parseDexPairs([{ ...rawPair, priceUsd: "0" }, { ...rawPair, chainId: "base" }, { ...rawPair, pairAddress: "bad address!" }, null, 5])).toEqual([]);
  });
  it("missing liquidity (bonding curve) parses as null", () => {
    const { liquidity: _l, ...noLiq } = rawPair;
    void _l;
    expect(parseDexPairs([noLiq])[0].liquidityUsd).toBeNull();
  });
  it("picks the deepest SOL/USDC/USDT pool of THAT token and ignores other quotes and impostor base tokens", () => {
    const pairs = [
      goodPair({ pairAddress: "P1", liquidityUsd: 60_000 }),
      goodPair({ pairAddress: "P2", liquidityUsd: 90_000 }),
      goodPair({ pairAddress: "P3", liquidityUsd: 999_999, quoteAddress: "SomeWeirdQuoteMint1111111111111111111111111" }),
      goodPair({ pairAddress: "P4", liquidityUsd: 999_999, tokenAddress: "OtherToken11111111111111111111111111111111" }),
      goodPair({ pairAddress: "P5", liquidityUsd: null }),
    ];
    expect(pickBestPair(pairs, TOKEN)?.pairAddress).toBe("P2");
    expect(pickBestPair([pairs[2]], TOKEN)).toBeNull();
    expect(pickBestPair([goodPair({ pairAddress: "P5", liquidityUsd: null })], TOKEN)?.pairAddress).toBe("P5");
  });
  it("derives SOL/USD from the median of >=3 liquid SOL pools, otherwise null", () => {
    const mk = (usd: number, nat: number) => goodPair({ priceUsd: usd, priceNative: nat, liquidityUsd: 100_000 });
    expect(solPriceFromPairs([mk(94, 1), mk(188, 2), mk(10_000, 1)])).toBe(94);
    expect(solPriceFromPairs([mk(94, 1)])).toBeNull();
  });
});

describe("discovery feeds", () => {
  it("extracts Solana tokens from boosts/profiles and GeckoTerminal trending pools", () => {
    expect(pickDexTokens([{ chainId: "solana", tokenAddress: TOKEN }, { chainId: "base", tokenAddress: TOKEN }, { chainId: "solana", tokenAddress: "bad" }])).toEqual([TOKEN]);
    expect(pickGeckoTokens({ data: [{ relationships: { base_token: { data: { id: `solana_${TOKEN}` } } } }, { relationships: {} }, { relationships: { base_token: { data: { id: "eth_0x1" } } } }] })).toEqual([TOKEN]);
    expect(pickDexTokens(null)).toEqual([]);
    expect(pickGeckoTokens({})).toEqual([]);
  });
  it("survives a failing source (others still used) and reports each source's status", async () => {
    const f: FetchLike = (url) => {
      if (url.includes("token-boosts")) return res(429, "slow down", { "retry-after": "30" });
      if (url.includes("token-profiles")) return res(200, [{ chainId: "solana", tokenAddress: TOKEN }]);
      return res(500, "boom");
    };
    const d = await discover(f, now);
    expect([...d.addresses.keys()]).toEqual([TOKEN]);
    expect(d.sources.map((s) => [s.name, s.ok, s.error])).toEqual([
      ["dexscreener_boosts_latest", false, "rate_limited_429_retry_after_30s"],
      ["dexscreener_profiles_latest", true, undefined],
      ["geckoterminal_trending", false, "http_500"],
    ]);
  });
});

describe("HTTP failure handling (skip, never guess)", () => {
  it("maps 429, 5xx, invalid JSON, oversized bodies, network errors and timeouts to error results", async () => {
    expect(await getJson(() => res(429, ""), "u", now)).toMatchObject({ ok: false, error: "rate_limited_429" });
    expect(await getJson(() => res(503, ""), "u", now)).toMatchObject({ ok: false, error: "http_503" });
    expect(await getJson(() => res(200, "<html>"), "u", now)).toMatchObject({ ok: false, error: "invalid_json" });
    expect(await getJson(() => res(200, "x".repeat(2_000_001)), "u", now)).toMatchObject({ ok: false, error: "body_too_large" });
    expect(await getJson(() => Promise.reject(new Error("dns")), "u", now)).toMatchObject({ ok: false, error: "network_error" });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(await getJson(() => Promise.reject(abort), "u", now)).toMatchObject({ ok: false, error: "timeout" });
    expect(await getJson(() => res(200, [1]), "u", now)).toMatchObject({ ok: true, data: [1], fetchedAt: "2026-11-01T21:00:00.000Z" });
  });
  it("fetchPairs chunks by 30 and marks only the failed chunk's tokens as failed", async () => {
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const addrs = Array.from({ length: 45 }, (_, i) => `${B58[i % 33]}${B58[Math.floor(i / 33)]}${"A".repeat(40)}`);
    const urls: string[] = [];
    const f: FetchLike = (url) => {
      urls.push(url);
      return url.includes(addrs[0]) ? res(500, "") : res(200, [{ ...rawPair, baseToken: { ...rawPair.baseToken, address: addrs[44] } }]);
    };
    const r = await fetchPairs(f, addrs, now);
    expect(urls).toHaveLength(2);
    expect(r.failedAddresses.size).toBe(30);
    expect(r.failedAddresses.has(addrs[0])).toBe(true);
    expect(r.failedAddresses.has(addrs[44])).toBe(false);
    expect(r.pairs).toHaveLength(1);
    expect(r.errors[0].error).toBe("http_500");
  });
  it("fetchSolPrice uses the deepest SOL/USDC pool and fails when there is none", async () => {
    const sol = (liq: number, price: string) => ({ ...rawPair, baseToken: { address: WSOL_MINT, name: "SOL", symbol: "SOL" }, quoteToken: { address: USDC_MINT, name: "USDC", symbol: "USDC" }, priceUsd: price, liquidity: { usd: liq } });
    expect(await fetchSolPrice(() => res(200, [sol(1_000, "50"), sol(5_000_000, "94.38")]), now)).toMatchObject({ ok: true, data: 94.38 });
    expect(await fetchSolPrice(() => res(200, [rawPair]), now)).toMatchObject({ ok: false, error: "no_sol_usdc_pair" });
  });
});

describe("RugCheck parsing", () => {
  // Shape copied from a real https://api.rugcheck.xyz/v1/tokens/{mint}/report response (trimmed).
  const raw = {
    mint: TOKEN,
    token: { mintAuthority: null, freezeAuthority: null, supply: 1 },
    mintAuthority: null,
    freezeAuthority: null,
    score_normalised: 1,
    rugged: false,
    risks: [{ name: "Low Liquidity", level: "warn" }, { name: "Mutable metadata", level: "danger" }],
    topHolders: [{ address: "ACC1", owner: "OWN1", pct: 5.9 }, { address: "ACC2", owner: "OWN2", pct: 3.3 }],
    markets: [{ pubkey: PAIR, liquidityA: "LA", liquidityB: "ACC1", mintLP: "LP", liquidityAAccount: { owner: "OWN1" }, liquidityBAccount: { owner: "OWN1" } }],
    transferFee: { pct: 0 },
  };
  it("reads authorities, score, risks, holders and pool accounts", () => {
    const r = parseRugReport(raw, TOKEN)!;
    expect(r).toMatchObject({ mintAuthorityEnabled: false, freezeAuthorityEnabled: false, rugged: false, scoreNormalised: 1, dangerRisks: ["Mutable metadata"], warnRisks: ["Low Liquidity"] });
    expect(r.poolAccounts).toEqual(expect.arrayContaining([PAIR, "LA", "ACC1", "LP"]));
    expect(r.poolOwners).toEqual(["OWN1"]);
  });
  it("treats an enabled authority as enabled and an UNKNOWN authority as enabled (fail closed)", () => {
    expect(parseRugReport({ ...raw, mintAuthority: "SomeWallet", token: { mintAuthority: "SomeWallet" } }, TOKEN)!.mintAuthorityEnabled).toBe(true);
    const { mintAuthority: _m, freezeAuthority: _f, ...rest } = raw;
    void _m;
    void _f;
    const r = parseRugReport({ ...rest, token: {} }, TOKEN)!;
    expect(r.mintAuthorityEnabled).toBe(true);
    expect(r.freezeAuthorityEnabled).toBe(true);
  });
  it("refuses a report for a different mint or a malformed body; fetchRugReport surfaces errors", async () => {
    expect(parseRugReport({ ...raw, mint: "Other" }, TOKEN)).toBeNull();
    expect(parseRugReport("x", TOKEN)).toBeNull();
    expect(await fetchRugReport(() => res(429, ""), TOKEN, now)).toMatchObject({ ok: false, error: "rate_limited_429" });
    expect(await fetchRugReport(() => res(200, { nope: 1 }), TOKEN, now)).toMatchObject({ ok: false, error: "unexpected_shape" });
    expect(await fetchRugReport(() => res(200, raw), TOKEN, now)).toMatchObject({ ok: true });
  });
});
