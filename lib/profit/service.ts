import "server-only";
import { z } from "zod";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import { ownerIdFor, type CloudActor } from "@/lib/cloud/service";
import { BRAIINS_POOL_FEE_PCT, HASHRATE_WINDOW_HOURS, SNAPSHOT_AUTO_REFRESH_MS } from "./config";
import { braiinsToken, fetchPoolPayouts, fetchPoolProfile, payoutsToLedgerRows, type PoolProfile } from "./braiins";
import { computeFinancials, confirmedFromLedger, type CostSettings, type Financials, type HashrateMeasure } from "./math";
import { classifySnapshot, fetchNetworkData, hasAnyNetworkData, networkInputsFrom, type Freshness, type NetworkFetch, type SnapshotRow } from "./network";
import { buildProfitSummary, type ProfitSummary } from "./summary";
import type { SettingsInput } from "./schemas";

/** Server-only wiring for the profitability engine: Supabase reads/writes, public network fetches, the optional Braiins token. */

const db = () => getSupabaseServer();
const nowFn = () => new Date();

// ------------------------------------------------------------------------------------------------ network snapshots
function toSnapshot(r: Record<string, unknown>): SnapshotRow {
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const iso = (v: unknown): string | null => (typeof v === "string" ? new Date(v).toISOString() : null);
  return {
    id: String(r.id),
    fetched_at: new Date(String(r.fetched_at)).toISOString(),
    source: String(r.source),
    trigger: String(r.trigger),
    block_height: n(r.block_height),
    difficulty: n(r.difficulty),
    network_hashrate_hs: n(r.network_hashrate_hs),
    subsidy_sats: n(r.subsidy_sats),
    avg_fee_sats: n(r.avg_fee_sats),
    fee_window_blocks: n(r.fee_window_blocks),
    btc_price_usd: n(r.btc_price_usd),
    price_source: typeof r.price_source === "string" ? r.price_source : null,
    price_time: iso(r.price_time),
    field_errors: (r.field_errors ?? {}) as Record<string, string>,
    raw: (r.raw ?? {}) as Record<string, unknown>,
  };
}

export async function latestSnapshot(): Promise<SnapshotRow | null> {
  const r = await db().from("network_snapshots").select("*").order("fetched_at", { ascending: false }).limit(1).maybeSingle();
  if (r.error) throw new Error("snapshot query failed");
  return r.data ? toSnapshot(r.data as Record<string, unknown>) : null;
}

export type RefreshOutcome = { ok: true; stored: boolean; fetch: NetworkFetch } | { ok: false; error: "unavailable"; fetch: NetworkFetch };

/** Fetches the public data now and stores one row (only when at least one field was fetched). Used by the button, the page and the cron. */
export async function refreshSnapshot(trigger: "on_demand" | "cron", audit?: { actor: string }): Promise<RefreshOutcome> {
  const f = await fetchNetworkData(fetch, nowFn());
  if (!hasAnyNetworkData(f)) return { ok: false, error: "unavailable", fetch: f };
  const ins = await db().from("network_snapshots").insert({
    fetched_at: f.fetched_at,
    source: f.source,
    trigger,
    block_height: f.block_height,
    difficulty: f.difficulty,
    network_hashrate_hs: f.network_hashrate_hs,
    subsidy_sats: f.subsidy_sats,
    avg_fee_sats: f.avg_fee_sats,
    fee_window_blocks: f.fee_window_blocks,
    btc_price_usd: f.btc_price_usd,
    price_source: f.price_source,
    price_time: f.price_time,
    field_errors: f.field_errors as Json,
    raw: f.raw as Json,
  });
  if (ins.error) throw new Error("snapshot insert failed");
  if (audit) {
    await db().from("audit_log").insert({
      actor: audit.actor,
      action: "network.snapshot.refreshed",
      entity_type: "network_snapshot",
      entity_id: f.fetched_at,
      details: { source: f.source, field_errors: f.field_errors } as Json,
    });
  }
  return { ok: true, stored: true, fetch: f };
}

/** Refreshes only when the newest row is older than 15 minutes. Never throws: a failure just leaves the (labelled) older row. */
export async function ensureFreshSnapshot(): Promise<{ attempted: boolean; failed: boolean }> {
  try {
    const latest = await latestSnapshot();
    if (latest && Date.now() - Date.parse(latest.fetched_at) < SNAPSHOT_AUTO_REFRESH_MS) return { attempted: false, failed: false };
    const r = await refreshSnapshot("on_demand");
    return { attempted: true, failed: !r.ok || Object.keys(r.fetch.field_errors).length > 0 };
  } catch {
    return { attempted: true, failed: true };
  }
}

// ------------------------------------------------------------------------------------------------ settings
const EMPTY_SETTINGS: CostSettings = { electricityUsdPerKwh: null, defaultWattsPerWorker: null, workerWatts: {}, poolFeePctOverride: null };

export async function loadSettings(owner: string): Promise<CostSettings & { updatedAt: string | null; updatedBy: string | null }> {
  const r = await db().from("profit_settings").select("*").eq("owner_id", owner).maybeSingle();
  if (r.error) throw new Error("settings query failed");
  if (!r.data) return { ...EMPTY_SETTINGS, updatedAt: null, updatedBy: null };
  const ww: Record<string, number> = {};
  for (const [k, v] of Object.entries((r.data.worker_watts ?? {}) as Record<string, unknown>)) if (Number.isFinite(Number(v))) ww[k] = Number(v);
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    electricityUsdPerKwh: n(r.data.electricity_usd_per_kwh),
    defaultWattsPerWorker: n(r.data.default_watts_per_worker),
    workerWatts: ww,
    poolFeePctOverride: n(r.data.pool_fee_pct_override),
    updatedAt: r.data.updated_at,
    updatedBy: r.data.updated_by,
  };
}

export async function saveSettings(input: SettingsInput, actor: CloudActor): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rpc = db().rpc as unknown as (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc("profit_save_settings", {
    p_owner: ownerIdFor(actor),
    p_actor: actor.login ?? "owner",
    p_kwh: input.electricity_usd_per_kwh,
    p_default_watts: input.default_watts_per_worker,
    p_worker_watts: input.worker_watts,
    p_fee_override: input.pool_fee_pct_override,
  });
  if (error) throw new Error("settings save failed");
  const parsed = z.object({ ok: z.boolean(), reason: z.string().optional() }).safeParse(data);
  if (!parsed.success) throw new Error("settings save returned an unexpected result");
  return parsed.data.ok ? { ok: true } : { ok: false, reason: parsed.data.reason ?? "failed" };
}

// ------------------------------------------------------------------------------------------------ Braiins (optional)
let profileMemo: { at: number; value: Awaited<ReturnType<typeof fetchPoolProfile>> } | null = null;

export type PoolState =
  | { connected: false }
  | { connected: true; ok: true; profile: PoolProfile }
  | { connected: true; ok: false; error: string };

/** Pool-reported account figures. Only when BRAIINS_POOL_TOKEN is set; memoised for 60 s (the pool allows ~1 request / 5 s). */
export async function loadPoolState(): Promise<PoolState> {
  const token = braiinsToken();
  if (!token) return { connected: false };
  if (!profileMemo || Date.now() - profileMemo.at > 60_000) profileMemo = { at: Date.now(), value: await fetchPoolProfile(fetch, token, nowFn()) };
  const v = profileMemo.value;
  return v.ok ? { connected: true, ok: true, profile: v.data } : { connected: true, ok: false, error: v.error };
}

export type ImportOutcome = { ok: true; fetched: number; imported: number; alreadyImported: number; skipped: { queued: number; failed: number; noReference: number } } | { ok: false; error: string };

/** Imports CONFIRMED Braiins payouts of the last 90 days into the ledger (source 'pool', ref = txid / preimage). Idempotent; audited. */
export async function importBraiinsPayouts(actor: CloudActor): Promise<ImportOutcome> {
  const token = braiinsToken();
  if (!token) return { ok: false, error: "not_connected" };
  const to = nowFn();
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const r = await fetchPoolPayouts(fetch, token, day(new Date(to.getTime() - 90 * 86_400_000)), day(to));
  if (!r.ok) return { ok: false, error: r.error };
  const { rows, skipped } = payoutsToLedgerRows(r.data);
  const owner = ownerIdFor(actor);
  let imported = 0;
  let already = 0;
  for (const row of rows) {
    const ins = await db().from("ledger").insert({ owner_id: owner, kind: row.kind, source: row.source, ref: row.ref, amount_sats: row.amount_sats, occurred_at: row.occurred_at, note: row.note });
    if (!ins.error) imported++;
    else if (ins.error.code === "23505") already++;
    else throw new Error("ledger insert failed");
  }
  await db().from("audit_log").insert({
    actor: actor.login ?? "owner",
    action: "profit.braiins.payouts_imported",
    entity_type: "ledger",
    entity_id: owner,
    details: { fetched: r.data.length, imported, already_imported: already, skipped } as Json,
  });
  return { ok: true, fetched: r.data.length, imported, alreadyImported: already, skipped };
}

// ------------------------------------------------------------------------------------------------ page data
export type FinancialsView = {
  now: string;
  network: { snapshot: SnapshotRow | null; freshness: Freshness | "none"; ageMs: number | null };
  financials: Financials;
  poolFee: { pct: number; source: "override" | "braiins-docs" };
  settings: Awaited<ReturnType<typeof loadSettings>>;
  confirmed: ReturnType<typeof confirmedFromLedger>;
  pool: PoolState;
  cloudProjectionCount: number;
};

const HashrateRows = z.array(z.object({ worker_id: z.string(), buckets: z.coerce.number(), avg_hs: z.coerce.number(), last_bucket: z.string().nullable().catch(null) }));

async function loadCore(actor: CloudActor, now: Date) {
  const owner = ownerIdFor(actor);
  const rpc = db().rpc as unknown as (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  const [workers, hr, cloud, ledger, settings, snapshot] = await Promise.all([
    db().from("workers").select("id, name, status, hardware_type").neq("status", "revoked").order("created_at", { ascending: true }).limit(200),
    rpc("profit_worker_hashrate", { p_now: now.toISOString(), p_hours: HASHRATE_WINDOW_HOURS }),
    db().from("cloud_resources").select("id, worker_id, label, hourly_price_usd, cost_known, state").eq("owner_id", owner).in("state", ["provisioning", "running"]).limit(200),
    db().from("ledger").select("id, kind, source, ref, amount_sats, occurred_at, note").eq("owner_id", owner).eq("kind", "confirmed_payout").order("occurred_at", { ascending: false }).limit(500),
    loadSettings(owner),
    latestSnapshot(),
  ]);
  if (workers.error || hr.error || cloud.error || ledger.error) throw new Error("financials query failed");
  const measured = new Map<string, HashrateMeasure>();
  for (const h of HashrateRows.parse(hr.data ?? [])) measured.set(h.worker_id, { avgHs: h.avg_hs, buckets: h.buckets, lastBucket: h.last_bucket });
  const feePct = settings.poolFeePctOverride ?? BRAIINS_POOL_FEE_PCT;
  const financials = computeFinancials({
    workers: workers.data ?? [],
    hashrates: measured,
    network: networkInputsFrom(snapshot, now),
    settings,
    cloudResources: (cloud.data ?? []).map((c) => ({ id: c.id, worker_id: c.worker_id, label: c.label, hourly_price_usd: Number(c.hourly_price_usd), cost_known: c.cost_known })),
    poolFeePct: feePct,
  });
  const confirmed = confirmedFromLedger((ledger.data ?? []).map((l) => ({ ...l, amount_sats: l.amount_sats === null ? null : Number(l.amount_sats) })));
  return { financials, confirmed, settings, snapshot, feePct, cloudCount: (cloud.data ?? []).length };
}

export async function loadFinancials(actor: CloudActor): Promise<FinancialsView> {
  const now = nowFn();
  const [core, pool] = await Promise.all([loadCore(actor, now), loadPoolState()]);
  return {
    now: now.toISOString(),
    network: { snapshot: core.snapshot, freshness: classifySnapshot(core.snapshot, now), ageMs: core.snapshot ? now.getTime() - Date.parse(core.snapshot.fetched_at) : null },
    financials: core.financials,
    poolFee: { pct: core.feePct, source: core.settings.poolFeePctOverride === null ? "braiins-docs" : "override" },
    settings: core.settings,
    confirmed: core.confirmed,
    pool,
    cloudProjectionCount: core.cloudCount,
  };
}

/** Read-only summary for the AI layer. Uses only the cached snapshot (no network fetch, no Braiins call). Never throws. */
export async function loadProfitSummary(actor: CloudActor): Promise<ProfitSummary | null> {
  try {
    const now = nowFn();
    const core = await loadCore(actor, now);
    return buildProfitSummary({ financials: core.financials, confirmed: core.confirmed, network: classifySnapshot(core.snapshot, now), poolConnected: braiinsToken() !== null });
  } catch {
    return null;
  }
}
