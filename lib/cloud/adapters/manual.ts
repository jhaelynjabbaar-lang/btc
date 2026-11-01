import {
  citedEstimate,
  type AdapterResult,
  type AdapterStatus,
  type CloudAdapter,
  type CostEstimate,
  type EstimateInput,
  type Offer,
} from "./types";

const manual = (message: string): AdapterResult => ({ ok: true, manual: true, message });

/**
 * "Manual" adapter: the owner provisions the machine at the provider themselves and registers it here. It never calls any
 * provider API, never spends money and never creates anything. Every action only returns instructions.
 */
export const manualAdapter: CloudAdapter = {
  id: "manual",
  capabilities: { listOffers: true, provision: true, start: true, stop: true, destroy: true, status: true },

  async listOffers(): Promise<Offer[]> {
    return []; // nothing to list: offers are whatever the owner finds on the provider's own site
  },

  async estimateCost(input: EstimateInput): Promise<CostEstimate> {
    return citedEstimate(input.citedHourlyUsd, input.citedSourceUrl, "Price cited by the owner from the provider's published price page.");
  },

  async provision(): Promise<AdapterResult> {
    return manual("Manual adapter: nothing was provisioned. Provision the machine yourself at the provider, then it is tracked here as running.");
  },
  async start(): Promise<AdapterResult> {
    return manual("Manual adapter: start the machine yourself at the provider.");
  },
  async stop(): Promise<AdapterResult> {
    return manual("Manual adapter: nothing was stopped at the provider. Power the machine off or cancel it yourself so it stops billing.");
  },
  async destroy(): Promise<AdapterResult> {
    return manual("Manual adapter: nothing was destroyed at the provider. Cancel or delete the machine yourself.");
  },
  async status(): Promise<AdapterStatus> {
    return { known: false, message: "Manual adapter: the real machine state is not observable; the state shown is what you recorded." };
  },
};
