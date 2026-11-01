import { DATA_SOURCE_URL, GRANULARITY_SECONDS, PRODUCT } from "./config";

/**
 * Live prices from Coinbase Exchange's PUBLIC, keyless market-data API (no account, no API key, read-only GET requests):
 *   GET /products/BTC-USD/candles?granularity=3600   -> [[start_unix_s, low, high, open, close, volume], ...] (newest first, max 300)
 *   GET /products/BTC-USD/ticker                     -> { price, bid, ask, time, ... }
 * Nothing is ever interpolated or back-filled: a failed or malformed response is an error and the tick is skipped.
 */

export type Candle = { startSec: number; low: number; high: number; open: number; close: number; volume: number };
export type Ticker = { price: number; bid: number; ask: number; time: string };

export type Fetched<T> = { ok: true; data: T; fetchedAt: string; url: string } | { ok: false; error: string; url: string };

const HEADERS = { accept: "application/json", "user-agent": "btc-paper-trading/1.0 (public market data, read-only)" };
const TIMEOUT_MS = 8000;

export const candlesUrl = () => `${DATA_SOURCE_URL}/products/${PRODUCT}/candles?granularity=${GRANULARITY_SECONDS}`;
export const tickerUrl = () => `${DATA_SOURCE_URL}/products/${PRODUCT}/ticker`;

const pos = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function parseCandles(body: unknown): Candle[] | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const out: Candle[] = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 6) return null;
    const start = Number(row[0]);
    const low = pos(row[1]);
    const high = pos(row[2]);
    const open = pos(row[3]);
    const close = pos(row[4]);
    const volume = Number(row[5]);
    if (!Number.isInteger(start) || start <= 0 || low === null || high === null || open === null || close === null || !Number.isFinite(volume) || volume < 0) return null;
    if (high < low || close > high || close < low || open > high || open < low) return null;
    out.push({ startSec: start, low, high, open, close, volume });
  }
  out.sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < out.length; i++) if (out[i].startSec === out[i - 1].startSec) return null; // duplicate candle: refuse
  return out;
}

export function parseTicker(body: unknown): Ticker | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const price = pos(b.price);
  const bid = pos(b.bid);
  const ask = pos(b.ask);
  const time = typeof b.time === "string" ? new Date(b.time) : null;
  if (price === null || bid === null || ask === null || !time || Number.isNaN(time.getTime())) return null;
  if (bid > ask) return null;
  return { price, bid, ask, time: time.toISOString() };
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetchFn(url, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error" };
  }
}

export async function fetchCandles(fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<Fetched<Candle[]>> {
  const url = candlesUrl();
  const r = await getJson(fetchFn, url);
  if (!r.ok) return { ok: false, error: r.error, url };
  const data = parseCandles(r.body);
  if (!data) return { ok: false, error: "malformed_candles", url };
  return { ok: true, data, fetchedAt: now().toISOString(), url };
}

export async function fetchTicker(fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<Fetched<Ticker>> {
  const url = tickerUrl();
  const r = await getJson(fetchFn, url);
  if (!r.ok) return { ok: false, error: r.error, url };
  const data = parseTicker(r.body);
  if (!data) return { ok: false, error: "malformed_ticker", url };
  return { ok: true, data, fetchedAt: now().toISOString(), url };
}

