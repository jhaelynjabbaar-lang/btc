import { z } from "zod";
import {
  AdapterUnsupportedError,
  type AdapterResult,
  type AdapterStatus,
  type CloudAdapter,
  type CostEstimate,
  type EstimateInput,
  type Offer,
  type OfferFilter,
} from "./types";

/**
 * READ-ONLY adapter for RentGPUPower's public pool catalogue.
 *
 *   GET https://rentgpupower.com/api/v1/compute/gpus   (no API key, no account; "security: []" in the provider's OpenAPI spec,
 *   https://rentgpupower.com/openapi.json, summary "Public pool catalog with floor prices (no auth)")
 *
 * It is the only adapter that touches the network, it only does that one GET, and it cannot provision, start, stop or destroy
 * anything (those throw AdapterUnsupportedError). RentGPUPower's terms allow mining only on listings marked "Mining allowed", and
 * this catalogue does not expose that flag, so every offer carries miningFlag = "not_stated": check the listing on the marketplace.
 */

export const RENTGPUPOWER_CATALOG_URL = "https://rentgpupower.com/api/v1/compute/gpus";
export const RENTGPUPOWER_OPENAPI_URL = "https://rentgpupower.com/openapi.json";
const MAX_BODY_BYTES = 1_000_000;
const TIMEOUT_MS = 8_000;

const Listing = z.object({
  listing_id: z.union([z.number(), z.string()]),
  gpu_model: z.string().nullable().optional(),
  vram_gb: z.number().nullable().optional(),
  region: z.string().nullable().optional(),
  price_cents_hour: z.number().nonnegative(),
  cpu_cores: z.number().nullable().optional(),
  ram_gb: z.number().nullable().optional(),
  disk_gb: z.number().nullable().optional(),
  available: z.boolean().optional(),
});
const Catalog = z.object({ gpus: z.array(Listing) });

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "error" | "follow" | "manual" }) => Promise<Pick<Response, "ok" | "status" | "text">>;

export function parseCatalog(json: unknown): Offer[] {
  const parsed = Catalog.parse(json);
  return parsed.gpus.map((g) => ({
    id: String(g.listing_id),
    providerSlug: "rentgpupower",
    title: `${g.gpu_model ?? "Unknown model"}${g.vram_gb ? ` (${g.vram_gb} GB)` : ""}`,
    gpuModel: g.gpu_model ?? null,
    vramGb: g.vram_gb ?? null,
    cpuCores: g.cpu_cores ?? null,
    ramGb: g.ram_gb ?? null,
    diskGb: g.disk_gb ?? null,
    region: g.region ?? null,
    hourlyUsd: g.price_cents_hour / 100,
    availableNow: g.available === true,
    sourceUrl: RENTGPUPOWER_CATALOG_URL,
    miningFlag: "not_stated" as const,
  }));
}

export function catalogUrl(filter: OfferFilter = {}): string {
  const u = new URL(RENTGPUPOWER_CATALOG_URL);
  if (filter.gpuModel) u.searchParams.set("gpu_model", filter.gpuModel.slice(0, 80));
  if (filter.minVramGb !== undefined) u.searchParams.set("min_vram_gb", String(Math.max(0, Math.floor(filter.minVramGb))));
  if (filter.region) u.searchParams.set("region", filter.region.slice(0, 40));
  if (filter.maxHourlyUsd !== undefined) u.searchParams.set("max_price_cents_hour", String(Math.max(0, Math.floor(filter.maxHourlyUsd * 100))));
  u.searchParams.set("accelerator", filter.includeCpu ? "any" : "gpu");
  return u.toString();
}

export function createRentGpuPowerAdapter(fetchImpl: FetchLike = fetch as unknown as FetchLike): CloudAdapter {
  async function listOffers(filter?: OfferFilter): Promise<Offer[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      // No Authorization header, no cookies, no redirects: a keyless public GET and nothing else.
      const res = await fetchImpl(catalogUrl(filter), { signal: ctl.signal, headers: { accept: "application/json" }, redirect: "error" });
      if (!res.ok) throw new Error(`RentGPUPower catalogue answered HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) throw new Error("RentGPUPower catalogue response is unexpectedly large");
      return parseCatalog(JSON.parse(text));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: "rentgpupower_catalog",
    capabilities: { listOffers: true, provision: false, start: false, stop: false, destroy: false, status: false },
    listOffers,
    async estimateCost(input: EstimateInput): Promise<CostEstimate> {
      if (!input.offerId) return { hourlyUsd: null, sourceUrl: null, note: "unknown: no offer selected" };
      const offer = (await listOffers({ includeCpu: true })).find((o) => o.id === input.offerId);
      if (!offer) return { hourlyUsd: null, sourceUrl: null, note: "unknown: that listing is not in the current public catalogue" };
      return {
        hourlyUsd: offer.hourlyUsd,
        sourceUrl: offer.sourceUrl,
        note: "Host-set hourly price from RentGPUPower's public catalogue at the time of the request; it can change and does not say whether the host allows mining.",
      };
    },
    async provision(): Promise<AdapterResult> {
      throw new AdapterUnsupportedError("rentgpupower_catalog", "provision");
    },
    async start(): Promise<AdapterResult> {
      throw new AdapterUnsupportedError("rentgpupower_catalog", "start");
    },
    async stop(): Promise<AdapterResult> {
      throw new AdapterUnsupportedError("rentgpupower_catalog", "stop");
    },
    async destroy(): Promise<AdapterResult> {
      throw new AdapterUnsupportedError("rentgpupower_catalog", "destroy");
    },
    async status(): Promise<AdapterStatus> {
      throw new AdapterUnsupportedError("rentgpupower_catalog", "status");
    },
  };
}

export const rentGpuPowerAdapter = createRentGpuPowerAdapter();
