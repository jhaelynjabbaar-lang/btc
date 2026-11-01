/**
 * Provider adapter interface. An adapter is the ONLY code allowed to talk to a provider, and the service layer only calls
 * provision / start / stop / destroy for a resource that is already approved (see lib/cloud/service.ts). Adapters never hold
 * or return secrets; any provider API key lives in Vercel env vars (set by the owner) and is read server-side only.
 */

export type AdapterId = "manual" | "rentgpupower_catalog";

export type Offer = {
  /** Provider's own listing id (string). */
  id: string;
  providerSlug: string;
  title: string;
  gpuModel: string | null;
  vramGb: number | null;
  cpuCores: number | null;
  ramGb: number | null;
  diskGb: number | null;
  region: string | null;
  /** Provider's published hourly price in USD, exactly as listed (never derived or guessed). */
  hourlyUsd: number;
  availableNow: boolean;
  /** Where that price was read from. */
  sourceUrl: string;
  /** What the listing says about mining. Catalogue data usually does not say, so this is "not_stated", never an assumption. */
  miningFlag: "not_stated";
};

export type OfferFilter = { gpuModel?: string; minVramGb?: number; region?: string; maxHourlyUsd?: number; includeCpu?: boolean };

export type CostEstimate = {
  /** null = UNKNOWN. Only ever a provider-published price with a source link. */
  hourlyUsd: number | null;
  sourceUrl: string | null;
  note: string;
};

export type EstimateInput = { offerId?: string; citedHourlyUsd?: number; citedSourceUrl?: string };

export type ResourceRef = { id: string; instanceId: string; providerSlug: string };

export type ProvisionRequest = ResourceRef & { offerId?: string; label?: string | null };

export type AdapterResult = {
  ok: true;
  /** true when the adapter did NOT act at the provider and the owner must do it by hand. */
  manual: boolean;
  message: string;
};

export type AdapterStatus = { known: boolean; state?: "running" | "stopped" | "absent"; message: string };

export type AdapterCapabilities = { listOffers: boolean; provision: boolean; start: boolean; stop: boolean; destroy: boolean; status: boolean };

export interface CloudAdapter {
  readonly id: AdapterId;
  readonly capabilities: AdapterCapabilities;
  listOffers(filter?: OfferFilter): Promise<Offer[]>;
  estimateCost(input: EstimateInput): Promise<CostEstimate>;
  provision(req: ProvisionRequest): Promise<AdapterResult>;
  start(ref: ResourceRef): Promise<AdapterResult>;
  stop(ref: ResourceRef): Promise<AdapterResult>;
  destroy(ref: ResourceRef): Promise<AdapterResult>;
  status(ref: ResourceRef): Promise<AdapterStatus>;
}

export class AdapterUnsupportedError extends Error {
  constructor(adapter: string, action: string) {
    super(`The ${adapter} adapter does not support '${action}'. Do it at the provider yourself and register the machine.`);
    this.name = "AdapterUnsupportedError";
  }
}

/** A cited price must come with an https source link; otherwise the cost is UNKNOWN. */
export function citedEstimate(hourlyUsd: number | undefined, sourceUrl: string | undefined, note: string): CostEstimate {
  const okPrice = typeof hourlyUsd === "number" && Number.isFinite(hourlyUsd) && hourlyUsd >= 0;
  const okUrl = typeof sourceUrl === "string" && /^https:\/\/[^\s]+$/.test(sourceUrl);
  if (okPrice && okUrl) return { hourlyUsd, sourceUrl, note };
  return { hourlyUsd: null, sourceUrl: null, note: "unknown: no provider-published price with a source link was given" };
}
