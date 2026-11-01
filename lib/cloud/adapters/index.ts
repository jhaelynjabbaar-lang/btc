import { manualAdapter } from "./manual";
import { rentGpuPowerAdapter } from "./rentgpupower";
import type { AdapterId, CloudAdapter } from "./types";

const ADAPTERS: Record<AdapterId, CloudAdapter> = { manual: manualAdapter, rentgpupower_catalog: rentGpuPowerAdapter };

export function getAdapter(id: string): CloudAdapter {
  return (ADAPTERS as Record<string, CloudAdapter | undefined>)[id] ?? manualAdapter;
}
export type { AdapterId, CloudAdapter } from "./types";
