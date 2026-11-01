import { DEXSCREENER_URL, GECKOTERMINAL_URL, QUOTE_MINTS, RUGCHECK_URL, WSOL_MINT, USDC_MINT } from "./config";

/**
 * Public, keyless, read-only market data. Nothing here needs an account, an API key, a wallet or a signature.
 *  - DexScreener  GET /token-boosts/latest/v1, /token-profiles/latest/v1   -> recently boosted / newly profiled tokens (discovery)
 *  - DexScreener  GET /tokens/v1/solana/{addr1,addr2,...<=30}              -> every pair of those tokens: price, liquidity, volume, txns
 *  - GeckoTerminal GET /networks/solana/trending_pools                     -> trending pools (discovery only)
 *  - RugCheck     GET /v1/tokens/{mint}/report                             -> mint/freeze authority, risk score, holders
 * All numbers used for fills and marks come from the DexScreener /tokens response fetched during the tick. Failures, rate limits and
 * malformed bodies become `{ ok: false }` results so the caller can skip the tick and log why. Token names/symbols are untrusted
 * strings: they are sanitised for display only and never influence a decision.
 */

export type Fetched<T> = { ok: true; data: T; fetchedAt: string; url: string } | { ok: false; error: string; url: string };

const HEADERS = { accept: "application/json", "user-agent": "btc-meme-paper/1.0 (public market data, read-only; paper trading only)" };
const TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 2_000_000;

export type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; cache?: "no-store" }) => Promise<Pick<Response, "ok" | "status" | "text" | "headers">>;

/** The URL host+path is recorded on failure; query strings never contain secrets (there are none). */
export async function getJson(fetchFn: FetchLike, url: string, now: () => Date = () => new Date()): Promise<Fetched<unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: ac.signal, headers: HEADERS, cache: "no-store" });
    if (res.status === 429) return { ok: false, error: `rate_limited_429${retryAfter(res)}`, url };
    if (!res.ok) return { ok: false, error: `http_${res.status}`, url };
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) return { ok: false, error: "body_too_large", url };
    try {
      return { ok: true, data: JSON.parse(text), fetchedAt: now().toISOString(), url };
    } catch {
      return { ok: false, error: "invalid_json", url };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "AbortError" ? "timeout" : "network_error", url };
  } finally {
    clearTimeout(timer);
  }
}

function retryAfter(res: Pick<Response, "headers">): string {
  const v = res.headers?.get?.("retry-after");
  return v && /^\d{1,5}$/.test(v) ? `_retry_after_${v}s` : "";
}

// ------------------------------------------------------------------------------------------------ helpers
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const posOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
};
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Solana base58 address shape (32-44 chars). Anything else from an API is dropped before it reaches a URL. */
export const isSolAddress = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** Token name/symbol come from the token creator: strip control characters and cap the length. Display only. */
export function cleanLabel(s: unknown, max = 24): string {
  if (typeof s !== "string") return "?";
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  return (t || "?").slice(0, max);
}

// ------------------------------------------------------------------------------------------------ DexScreener pairs
export type Txns = { buys: number; sells: number };
export type DexPair = {
  tokenAddress: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  quoteAddress: string;
  quoteSymbol: string;
  priceUsd: number;
  priceNative: number | null;
  liquidityUsd: number | null;
  volume24h: number;
  volume1h: number;
  txns: { m5: Txns; h1: Txns; h6: Txns; h24: Txns };
  change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  pairCreatedAtMs: number | null;
  fdv: number | null;
};

const tx = (v: unknown): Txns => {
  const r = isRec(v) ? v : {};
  return { buys: Math.max(0, numOrNull(r.buys) ?? 0), sells: Math.max(0, numOrNull(r.sells) ?? 0) };
};

export function parseDexPairs(body: unknown): DexPair[] {
  if (!Array.isArray(body)) return [];
  const out: DexPair[] = [];
  for (const p of body) {
    if (!isRec(p) || p.chainId !== "solana" || !isRec(p.baseToken) || !isRec(p.quoteToken)) continue;
    const tokenAddress = p.baseToken.address;
    const quoteAddress = p.quoteToken.address;
    const priceUsd = posOrNull(p.priceUsd);
    if (!isSolAddress(tokenAddress) || !isSolAddress(quoteAddress) || !isSolAddress(p.pairAddress) || priceUsd === null) continue;
    const txns = isRec(p.txns) ? p.txns : {};
    const vol = isRec(p.volume) ? p.volume : {};
    const pc = isRec(p.priceChange) ? p.priceChange : {};
    const liq = isRec(p.liquidity) ? numOrNull(p.liquidity.usd) : null;
    out.push({
      tokenAddress,
      symbol: cleanLabel(p.baseToken.symbol),
      name: cleanLabel(p.baseToken.name, 40),
      pairAddress: p.pairAddress,
      dexId: cleanLabel(p.dexId, 24),
      quoteAddress,
      quoteSymbol: cleanLabel(p.quoteToken.symbol, 12),
      priceUsd,
      priceNative: posOrNull(p.priceNative),
      liquidityUsd: liq !== null && liq >= 0 ? liq : null,
      volume24h: Math.max(0, numOrNull(vol.h24) ?? 0),
      volume1h: Math.max(0, numOrNull(vol.h1) ?? 0),
      txns: { m5: tx(txns.m5), h1: tx(txns.h1), h6: tx(txns.h6), h24: tx(txns.h24) },
      change: { m5: numOrNull(pc.m5), h1: numOrNull(pc.h1), h6: numOrNull(pc.h6), h24: numOrNull(pc.h24) },
      pairCreatedAtMs: posOrNull(p.pairCreatedAt),
      fdv: posOrNull(p.fdv),
    });
  }
  return out;
}

/**
 * The pair we trade and mark a token on: its deepest pool quoted in SOL/USDC/USDT. Pairs quoted in other tokens, or whose base token is
 * not the token itself, are ignored (impostor pools are common). Pools with no liquidity figure (e.g. pump.fun bonding curves) sort last
 * and are rejected later with `no_liquidity_data`.
 */
export function pickBestPair(pairs: DexPair[], tokenAddress: string): DexPair | null {
  const ok = pairs.filter((p) => p.tokenAddress === tokenAddress && QUOTE_MINTS.includes(p.quoteAddress));
  if (ok.length === 0) return null;
  return ok.reduce((best, p) => ((p.liquidityUsd ?? -1) > (best.liquidityUsd ?? -1) ? p : best));
}

/** SOL/USD derived from a SOL-quoted pair of this very response (priceUsd / priceNative). Null if none usable. */
export function solPriceFromPairs(pairs: DexPair[]): number | null {
  const vals = pairs
    .filter((p) => p.quoteAddress === WSOL_MINT && p.priceNative !== null && (p.liquidityUsd ?? 0) > 20_000)
    .map((p) => p.priceUsd / (p.priceNative as number))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (vals.length < 3) return null;
  return vals[Math.floor(vals.length / 2)]; // median of >= 3 pools: robust to one bad pool
}

export const dexTokensUrl = (addrs: string[]) => `${DEXSCREENER_URL}/tokens/v1/solana/${addrs.join(",")}`;
/** Public DexScreener page of a pair (for links in the UI). Only shape-checked addresses are ever linked. */
export const dexscreenerPairUrl = (pairAddress: string) => (isSolAddress(pairAddress) ? `https://dexscreener.com/solana/${pairAddress}` : null);

export async function fetchPairs(fetchFn: FetchLike, addresses: string[], now: () => Date): Promise<{ pairs: DexPair[]; failedAddresses: Set<string>; errors: { url: string; error: string }[]; fetchedAt: string }> {
  const uniq = [...new Set(addresses.filter(isSolAddress))];
  const pairs: DexPair[] = [];
  const failed = new Set<string>();
  const errors: { url: string; error: string }[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += 30) chunks.push(uniq.slice(i, i + 30));
  const results = await Promise.all(chunks.map((c) => getJson(fetchFn, dexTokensUrl(c), now)));
  results.forEach((r, i) => {
    if (!r.ok) {
      chunks[i].forEach((a) => failed.add(a));
      errors.push({ url: `${DEXSCREENER_URL}/tokens/v1/solana/[${chunks[i].length} tokens]`, error: r.error });
    } else if (!Array.isArray(r.data)) {
      chunks[i].forEach((a) => failed.add(a));
      errors.push({ url: `${DEXSCREENER_URL}/tokens/v1/solana/[${chunks[i].length} tokens]`, error: "unexpected_shape" });
    } else pairs.push(...parseDexPairs(r.data));
  });
  return { pairs, failedAddresses: failed, errors, fetchedAt: now().toISOString() };
}

/** Reference SOL/USD price: deepest SOL-USDC pool on DexScreener, fetched on its own so costs never depend on candidate data. */
export async function fetchSolPrice(fetchFn: FetchLike, now: () => Date): Promise<Fetched<number>> {
  const url = dexTokensUrl([WSOL_MINT]);
  const r = await getJson(fetchFn, url, now);
  if (!r.ok) return r;
  const pairs = parseDexPairs(r.data).filter((p) => p.tokenAddress === WSOL_MINT && p.quoteAddress === USDC_MINT && p.liquidityUsd !== null);
  if (pairs.length === 0) return { ok: false, error: "no_sol_usdc_pair", url };
  const best = pairs.reduce((a, p) => ((p.liquidityUsd ?? 0) > (a.liquidityUsd ?? 0) ? p : a));
  return { ok: true, data: best.priceUsd, fetchedAt: r.fetchedAt, url };
}

// ------------------------------------------------------------------------------------------------ discovery
export type Discovery = {
  addresses: Map<string, string[]>; // address -> discovery sources
  sources: { name: string; ok: boolean; count: number; error?: string }[];
};

/** Collects Solana token addresses from the trending/new feeds. Fails only if every source fails. */
export async function discover(fetchFn: FetchLike, now: () => Date): Promise<Discovery> {
  const feeds = [
    { name: "dexscreener_boosts_latest", url: `${DEXSCREENER_URL}/token-boosts/latest/v1`, pick: pickDexTokens },
    { name: "dexscreener_profiles_latest", url: `${DEXSCREENER_URL}/token-profiles/latest/v1`, pick: pickDexTokens },
    { name: "geckoterminal_trending", url: `${GECKOTERMINAL_URL}/networks/solana/trending_pools?page=1`, pick: pickGeckoTokens },
  ];
  const results = await Promise.all(feeds.map((f) => getJson(fetchFn, f.url, now)));
  const addresses = new Map<string, string[]>();
  const sources: Discovery["sources"] = [];
  results.forEach((r, i) => {
    const f = feeds[i];
    if (!r.ok) return void sources.push({ name: f.name, ok: false, count: 0, error: r.error });
    const found = f.pick(r.data);
    sources.push({ name: f.name, ok: true, count: found.length });
    for (const a of found) addresses.set(a, [...(addresses.get(a) ?? []), f.name]);
  });
  return { addresses, sources };
}

export function pickDexTokens(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  const out: string[] = [];
  for (const t of body) if (isRec(t) && t.chainId === "solana" && isSolAddress(t.tokenAddress)) out.push(t.tokenAddress);
  return out;
}

export function pickGeckoTokens(body: unknown): string[] {
  if (!isRec(body) || !Array.isArray(body.data)) return [];
  const out: string[] = [];
  for (const p of body.data) {
    if (!isRec(p) || !isRec(p.relationships) || !isRec(p.relationships.base_token) || !isRec(p.relationships.base_token.data)) continue;
    const id = p.relationships.base_token.data.id;
    const addr = typeof id === "string" && id.startsWith("solana_") ? id.slice(7) : null;
    if (isSolAddress(addr)) out.push(addr);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ RugCheck
export type RugReport = {
  mint: string;
  mintAuthorityEnabled: boolean;
  freezeAuthorityEnabled: boolean;
  rugged: boolean;
  scoreNormalised: number | null;
  transferFeePct: number;
  dangerRisks: string[];
  warnRisks: string[];
  /** Holders as reported (token account address, wallet owner, % of supply). */
  holders: { address: string; owner: string | null; pct: number }[];
  /** Token accounts / owners that belong to liquidity pools (excluded from holder concentration). */
  poolAccounts: string[];
  poolOwners: string[];
};

export const rugcheckUrl = (mint: string) => `${RUGCHECK_URL}/tokens/${mint}/report`;

export function parseRugReport(body: unknown, mint: string): RugReport | null {
  if (!isRec(body) || body.mint !== mint) return null;
  const token = isRec(body.token) ? body.token : {};
  // `mintAuthority`/`freezeAuthority` are null when renounced. If the key is absent entirely we cannot tell: treat as unknown -> enabled.
  const authOn = (k: string): boolean => {
    const top = k in body ? body[k] : undefined;
    const nested = k in token ? token[k] : undefined;
    const v = top !== undefined ? top : nested;
    return v === undefined ? true : v !== null;
  };
  const risks = Array.isArray(body.risks) ? body.risks.filter(isRec) : [];
  const holders = (Array.isArray(body.topHolders) ? body.topHolders : [])
    .filter(isRec)
    .map((h) => ({ address: typeof h.address === "string" ? h.address : "", owner: typeof h.owner === "string" ? h.owner : null, pct: numOrNull(h.pct) ?? 0 }))
    .filter((h) => h.address && h.pct >= 0);
  const poolAccounts = new Set<string>();
  const poolOwners = new Set<string>();
  for (const m of Array.isArray(body.markets) ? body.markets : []) {
    if (!isRec(m)) continue;
    for (const k of ["pubkey", "liquidityA", "liquidityB", "mintLP"]) if (typeof m[k] === "string") poolAccounts.add(m[k] as string);
    for (const k of ["liquidityAAccount", "liquidityBAccount"]) {
      const acc = m[k];
      if (isRec(acc) && typeof acc.owner === "string") poolOwners.add(acc.owner);
    }
  }
  const tf = isRec(body.transferFee) ? numOrNull(body.transferFee.pct) : null;
  return {
    mint,
    mintAuthorityEnabled: authOn("mintAuthority"),
    freezeAuthorityEnabled: authOn("freezeAuthority"),
    rugged: body.rugged === true,
    scoreNormalised: numOrNull(body.score_normalised),
    transferFeePct: tf ?? 0,
    dangerRisks: risks.filter((r) => r.level === "danger").map((r) => cleanLabel(r.name, 60)),
    warnRisks: risks.filter((r) => r.level === "warn").map((r) => cleanLabel(r.name, 60)),
    holders,
    poolAccounts: [...poolAccounts],
    poolOwners: [...poolOwners],
  };
}

export async function fetchRugReport(fetchFn: FetchLike, mint: string, now: () => Date): Promise<Fetched<RugReport>> {
  const url = rugcheckUrl(mint);
  const r = await getJson(fetchFn, url, now);
  if (!r.ok) return r;
  const rep = parseRugReport(r.data, mint);
  return rep ? { ok: true, data: rep, fetchedAt: r.fetchedAt, url } : { ok: false, error: "unexpected_shape", url };
}
