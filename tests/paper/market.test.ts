import { describe, expect, it } from "vitest";
import { fetchCandles, fetchTicker, parseCandles, parseTicker } from "@/lib/paper/market";

const okJson = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("parseCandles", () => {
  it("parses Coinbase rows, sorts oldest-first", () => {
    const c = parseCandles([
      [1793559600, 77499.99, 77785, 77763.56, 77710.76, 130.4],
      [1793556000, 77734.26, 77875.84, 77853.99, 77763.56, 98.1],
    ]);
    expect(c).not.toBeNull();
    expect(c![0].startSec).toBe(1793556000);
    expect(c![1].close).toBe(77710.76);
  });
  it("rejects malformed rows, impossible OHLC and duplicates", () => {
    expect(parseCandles([])).toBeNull();
    expect(parseCandles("nope")).toBeNull();
    expect(parseCandles([[1, 2, 3]])).toBeNull();
    expect(parseCandles([[1793559600, 100, 90, 95, 95, 1]])).toBeNull(); // high < low
    expect(parseCandles([[1793559600, 90, 100, 95, 101, 1]])).toBeNull(); // close above high
    expect(parseCandles([[1793559600, 0, 100, 95, 95, 1]])).toBeNull(); // zero price
    expect(parseCandles([[1793559600, 90, 100, 95, 95, 1], [1793559600, 90, 100, 95, 95, 1]])).toBeNull();
  });
});

describe("parseTicker", () => {
  it("parses a Coinbase ticker", () => {
    const t = parseTicker({ ask: "77657.42", bid: "77657.41", price: "77657.88", time: "2026-11-01T19:33:35.343768647Z" });
    expect(t).toEqual({ price: 77657.88, bid: 77657.41, ask: 77657.42, time: "2026-11-01T19:33:35.343Z" });
  });
  it("rejects crossed books, missing or non-positive fields", () => {
    expect(parseTicker({ ask: "1", bid: "2", price: "1", time: "2026-11-01T19:33:35Z" })).toBeNull();
    expect(parseTicker({ ask: "1", bid: "1", price: "0", time: "2026-11-01T19:33:35Z" })).toBeNull();
    expect(parseTicker({ ask: "1", bid: "1", price: "1", time: "garbage" })).toBeNull();
    expect(parseTicker(null)).toBeNull();
  });
});

describe("fetch wrappers", () => {
  it("record the URL and fetch time, and report errors instead of inventing data", async () => {
    const now = () => new Date("2026-11-01T20:05:00Z");
    const good = await fetchTicker(okJson({ ask: "2", bid: "1", price: "1.5", time: "2026-11-01T20:04:50Z" }), now);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.fetchedAt).toBe("2026-11-01T20:05:00.000Z");
      expect(good.url).toContain("api.exchange.coinbase.com/products/BTC-USD/ticker");
    }
    const http500 = await fetchCandles((async () => new Response("x", { status: 503 })) as unknown as typeof fetch, now);
    expect(http500).toMatchObject({ ok: false, error: "http_503" });
    const boom = await fetchCandles((async () => { throw new Error("down"); }) as unknown as typeof fetch, now);
    expect(boom).toMatchObject({ ok: false, error: "network_error" });
    const bad = await fetchCandles(okJson({ message: "rate limited" }), now);
    expect(bad).toMatchObject({ ok: false, error: "malformed_candles" });
  });
});
