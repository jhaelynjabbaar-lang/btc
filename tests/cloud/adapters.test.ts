import { describe, expect, it, vi } from "vitest";
import { manualAdapter } from "@/lib/cloud/adapters/manual";
import { RENTGPUPOWER_CATALOG_URL, catalogUrl, createRentGpuPowerAdapter, parseCatalog } from "@/lib/cloud/adapters/rentgpupower";
import { AdapterUnsupportedError, citedEstimate } from "@/lib/cloud/adapters/types";
import { getAdapter } from "@/lib/cloud/adapters";

const catalog = { gpus: [{ listing_id: 7, gpu_model: "Test GPU", vram_gb: 24, region: "eu", price_cents_hour: 35, cpu_cores: 8, ram_gb: 32, disk_gb: 100, available: true }, { listing_id: "x9", price_cents_hour: 5 }] };
const REF = { id: "1", instanceId: "i", providerSlug: "x" };
const okFetch = (body: unknown, status = 200) => vi.fn(async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }));

describe("citedEstimate", () => {
  it("returns a price only with an https source link, otherwise unknown", () => {
    expect(citedEstimate(0.3, "https://example.com/pricing", "n").hourlyUsd).toBe(0.3);
    expect(citedEstimate(0.3, undefined, "n")).toMatchObject({ hourlyUsd: null, sourceUrl: null });
    expect(citedEstimate(0.3, "http://example.com", "n").hourlyUsd).toBeNull();
    expect(citedEstimate(undefined, "https://example.com", "n").hourlyUsd).toBeNull();
    expect(citedEstimate(-1, "https://example.com", "n").hourlyUsd).toBeNull();
  });
});

describe("manual adapter", () => {
  it("never acts: every operation only returns instructions", async () => {
    for (const r of [await manualAdapter.provision(REF), await manualAdapter.start(REF), await manualAdapter.stop(REF), await manualAdapter.destroy(REF)]) expect(r).toMatchObject({ ok: true, manual: true });
    expect(await manualAdapter.listOffers()).toEqual([]);
    expect((await manualAdapter.status(REF)).known).toBe(false);
  });
  it("estimates cost only from a cited price", async () => {
    expect((await manualAdapter.estimateCost({})).hourlyUsd).toBeNull();
    expect((await manualAdapter.estimateCost({ citedHourlyUsd: 1, citedSourceUrl: "https://example.com/p" })).hourlyUsd).toBe(1);
  });
  it("is the fallback for every provider except the catalogue one", () => {
    expect(getAdapter("manual").id).toBe("manual");
    expect(getAdapter("rentgpupower_catalog").id).toBe("rentgpupower_catalog");
    expect(getAdapter("anything-else").id).toBe("manual");
  });
});

describe("RentGPUPower read-only catalogue adapter", () => {
  it("parses cents/hour into USD and never claims mining is allowed", () => {
    const offers = parseCatalog(catalog);
    expect(offers[0]).toMatchObject({ id: "7", hourlyUsd: 0.35, vramGb: 24, availableNow: true, miningFlag: "not_stated" });
    expect(offers[1]).toMatchObject({ id: "x9", hourlyUsd: 0.05, availableNow: false, gpuModel: null });
  });
  it("rejects malformed responses", () => {
    expect(() => parseCatalog({ nope: 1 })).toThrow();
    expect(() => parseCatalog({ gpus: [{ listing_id: 1, price_cents_hour: -1 }] })).toThrow();
  });
  it("builds a keyless GET on the public catalogue URL", async () => {
    const f = okFetch(catalog);
    const a = createRentGpuPowerAdapter(f);
    const offers = await a.listOffers({ gpuModel: "A", minVramGb: 16, maxHourlyUsd: 1 });
    expect(offers).toHaveLength(2);
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; redirect: string }];
    expect(url.startsWith(RENTGPUPOWER_CATALOG_URL)).toBe(true);
    expect(url).toContain("max_price_cents_hour=100");
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).toEqual(["accept"]); // no Authorization / cookie
    expect(init.redirect).toBe("error");
    expect(catalogUrl()).toContain("accelerator=gpu");
  });
  it("turns an HTTP error into a thrown error rather than fake offers", async () => {
    await expect(createRentGpuPowerAdapter(okFetch({}, 500)).listOffers()).rejects.toThrow(/HTTP 500/);
  });
  it("estimates from the public catalogue, or says unknown", async () => {
    const a = createRentGpuPowerAdapter(okFetch(catalog));
    expect(await a.estimateCost({ offerId: "7" })).toMatchObject({ hourlyUsd: 0.35, sourceUrl: RENTGPUPOWER_CATALOG_URL });
    expect((await a.estimateCost({ offerId: "nope" })).hourlyUsd).toBeNull();
    expect((await a.estimateCost({})).hourlyUsd).toBeNull();
  });
  it("cannot provision, start, stop, destroy or read status", async () => {
    const f = okFetch(catalog);
    const a = createRentGpuPowerAdapter(f);
    for (const fn of [a.provision, a.start, a.stop, a.destroy, a.status]) await expect(fn(REF)).rejects.toBeInstanceOf(AdapterUnsupportedError);
    expect(a.capabilities).toEqual({ listOffers: true, provision: false, start: false, stop: false, destroy: false, status: false });
    expect(f).not.toHaveBeenCalled();
  });
});
