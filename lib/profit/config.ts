/** Phase 8 constants. No I/O, no secrets. Shared by the math, the fetchers, the UI and the tests. */

export const SATS_PER_BTC = 100_000_000;
export const HOURS_PER_DAY = 24;

/** Window for "measured hashrate": the average of the one-minute telemetry buckets reported in the last 24 hours. */
export const HASHRATE_WINDOW_HOURS = 24;
export const MINUTES_PER_DAY = 1440;

/** Bitcoin targets one block per 10 minutes, i.e. 144 per day. Braiins' FPPS spec also recalculates each day "as if the average 144 blocks had been mined". */
export const BLOCKS_PER_DAY = 144;

/**
 * Braiins Pool fee. VERIFIED against the official docs (read 2026-11-01): "Pool fee 2.5%", FPPS, fee is subtracted from the gross reward.
 * Miners running Braiins OS pay 0%; this app's CPU/GPU workers do not, so 2.5% applies. The owner can override it in the cost form.
 */
export const BRAIINS_POOL_FEE_PCT = 2.5;
export const BRAIINS_FEE_SOURCE_URL = "https://academy.braiins.com/braiins-pool/rewards-and-payouts";
export const BRAIINS_MONITORING_DOCS_URL = "https://academy.braiins.com/braiins-pool/monitoring";

/** How old the cached network data may be before it is flagged stale / refused for estimates. */
export const SNAPSHOT_FRESH_MS = 60 * 60 * 1000; // <= 1 h: fresh
export const SNAPSHOT_USABLE_MS = 24 * 60 * 60 * 1000; // <= 24 h: usable but labelled STALE; older: estimates are withheld
/** The page refreshes the cache on view only when it is older than this (keeps public API traffic tiny). */
export const SNAPSHOT_AUTO_REFRESH_MS = 15 * 60 * 1000;

export const NETWORK_SOURCE = "mempool.space";
export const NETWORK_SOURCE_URL = "https://mempool.space/docs/api/rest";
export const PRICE_FALLBACK_SOURCE = "coingecko.com";

export const FETCH_TIMEOUT_MS = 8_000;
