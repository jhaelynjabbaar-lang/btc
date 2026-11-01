import { z } from "zod";
import { FETCH_TIMEOUT_MS } from "./config";
import type { FetchLike } from "./network";

/**
 * Braiins Pool account API (official docs: https://academy.braiins.com/braiins-pool/monitoring). Everything returned here is
 * "Pool-reported". The token (BRAIINS_POOL_TOKEN, set by the owner in the Vercel dashboard) is only ever sent in the
 * Pool-Auth-Token header to pool.braiins.com. It is never logged, stored, returned or put in an error message.
 */

export const BRAIINS_ORIGIN = "https://pool.braiins.com";
export const BRAIINS_PROFILE_URL = `${BRAIINS_ORIGIN}/accounts/profile/json/btc/`;
export const braiinsPayoutsUrl = (from: string, to: string) => `${BRAIINS_ORIGIN}/accounts/payouts/json/btc?from=${from}&to=${to}`;

export const braiinsToken = (env: Record<string, string | undefined> = process.env): string | null => {
  const t = env.BRAIINS_POOL_TOKEN?.trim();
  return t ? t : null;
};

const decimal = z.union([z.string(), z.number()]).transform((v) => Number(v)).pipe(z.number().finite().nonnegative());
const ProfileResp = z.object({
  username: z.string().optional(),
  btc: z.object({
    all_time_reward: decimal,
    current_balance: decimal,
    today_reward: decimal,
    hash_rate_unit: z.string(),
    hash_rate_5m: decimal,
    hash_rate_24h: decimal,
    shares_5m: z.number().nonnegative(),
    shares_24h: z.number().nonnegative(),
    ok_workers: z.number().nonnegative().optional(),
    low_workers: z.number().nonnegative().optional(),
    off_workers: z.number().nonnegative().optional(),
  }),
});

export type PoolProfile = {
  label: "Pool-reported";
  username: string | null;
  allTimeRewardBtc: number;
  currentBalanceBtc: number;
  todayRewardBtc: number;
  hashRateUnit: string;
  hashRate5m: number;
  hashRate24h: number;
  shares5m: number;
  shares24h: number;
  okWorkers: number | null;
  fetchedAt: string;
};

export type PoolPayout = {
  label: "Pool-reported";
  channel: "onchain" | "lightning";
  status: "queued" | "confirmed" | "failed";
  amountSats: number;
  feeSats: number;
  resolvedAtIso: string | null;
  ref: string | null;
};

const PayoutItem = z.object({
  status: z.enum(["queued", "confirmed", "failed"]),
  amount_sats: z.number().int().nonnegative(),
  fee_sats: z.number().int().nonnegative().optional().default(0),
  requested_at_ts: z.number().int().positive(),
  resolved_at_ts: z.number().int().positive().nullable().optional(),
  tx_id: z.string().nullable().optional(),
  preimage: z.string().nullable().optional(),
});
const PayoutsResp = z.object({ onchain: z.array(PayoutItem).optional().default([]), lightning: z.array(PayoutItem).optional().default([]) });

export type BraiinsResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function get<T>(fetchImpl: FetchLike, url: string, token: string, schema: z.ZodType<T>, timeoutMs: number): Promise<BraiinsResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "Pool-Auth-Token": token, accept: "application/json" }, redirect: "error" });
  } catch (e) {
    return { ok: false, error: e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network_error" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: "token_rejected" };
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "invalid_response" };
  }
  const p = schema.safeParse(body);
  return p.success ? { ok: true, data: p.data } : { ok: false, error: "invalid_response" };
}

export async function fetchPoolProfile(fetchImpl: FetchLike, token: string, now: Date = new Date(), timeoutMs: number = FETCH_TIMEOUT_MS): Promise<BraiinsResult<PoolProfile>> {
  const r = await get(fetchImpl, BRAIINS_PROFILE_URL, token, ProfileResp, timeoutMs);
  if (!r.ok) return r;
  const b = r.data.btc;
  return {
    ok: true,
    data: {
      label: "Pool-reported",
      username: r.data.username ?? null,
      allTimeRewardBtc: b.all_time_reward,
      currentBalanceBtc: b.current_balance,
      todayRewardBtc: b.today_reward,
      hashRateUnit: b.hash_rate_unit,
      hashRate5m: b.hash_rate_5m,
      hashRate24h: b.hash_rate_24h,
      shares5m: b.shares_5m,
      shares24h: b.shares_24h,
      okWorkers: b.ok_workers ?? null,
      fetchedAt: now.toISOString(),
    },
  };
}

export async function fetchPoolPayouts(fetchImpl: FetchLike, token: string, from: string, to: string, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<BraiinsResult<PoolPayout[]>> {
  const r = await get(fetchImpl, braiinsPayoutsUrl(from, to), token, PayoutsResp, timeoutMs);
  if (!r.ok) return r;
  const iso = (ts: number | null | undefined) => (ts ? new Date(ts * 1000).toISOString() : null);
  const map = (channel: PoolPayout["channel"]) => (p: z.infer<typeof PayoutItem>): PoolPayout => ({
    label: "Pool-reported",
    channel,
    status: p.status,
    amountSats: p.amount_sats,
    feeSats: p.fee_sats ?? 0,
    resolvedAtIso: iso(p.resolved_at_ts ?? null),
    // A reference that identifies the payout: the on-chain txid, or the Lightning payment preimage. Without one, the payout has no reference.
    ref: channel === "onchain" ? (p.tx_id?.trim() || null) : p.preimage?.trim() ? `ln:${p.preimage.trim()}` : null,
  });
  return { ok: true, data: [...r.data.onchain.map(map("onchain")), ...r.data.lightning.map(map("lightning"))] };
}

export type LedgerImportRow = { kind: "confirmed_payout"; source: "pool"; ref: string; amount_sats: number; occurred_at: string; note: string };

/**
 * Which pool payouts may enter the ledger as CONFIRMED: status "confirmed", with a reference (txid / preimage) and a resolution time.
 * Queued and failed payouts are not confirmed; a payout without a reference is skipped (the ledger would reject it anyway).
 */
export function payoutsToLedgerRows(payouts: readonly PoolPayout[]): { rows: LedgerImportRow[]; skipped: { queued: number; failed: number; noReference: number } } {
  const skipped = { queued: 0, failed: 0, noReference: 0 };
  const rows: LedgerImportRow[] = [];
  for (const p of payouts) {
    if (p.status === "queued") skipped.queued++;
    else if (p.status === "failed") skipped.failed++;
    else if (!p.ref || !p.resolvedAtIso) skipped.noReference++;
    else
      rows.push({
        kind: "confirmed_payout",
        source: "pool",
        ref: p.ref,
        amount_sats: p.amountSats,
        occurred_at: p.resolvedAtIso,
        note: `Pool-reported by Braiins payouts API (${p.channel}); payout fee reported: ${p.feeSats} sats.`,
      });
  }
  return { rows, skipped };
}
