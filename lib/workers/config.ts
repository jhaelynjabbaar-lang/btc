/** Public base URL of the Cloudflare ingest Worker (not a secret). Override with INGEST_WORKER_URL. */
export const DEFAULT_INGEST_URL = "https://btc-network-ingest.btcnetworkai.workers.dev";

export function ingestUrl(): string {
  const v = process.env.INGEST_WORKER_URL?.trim();
  return (v && /^https:\/\//.test(v) ? v : DEFAULT_INGEST_URL).replace(/\/+$/, "");
}

export const WORKER_COMMANDS = ["start", "pause", "stop"] as const;
export type WorkerCommand = (typeof WORKER_COMMANDS)[number];
