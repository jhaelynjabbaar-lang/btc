-- BTC Network AI: Phase 8 — profitability engine.
-- ADDITIVE ONLY: two new tables (network_snapshots, profit_settings) and two new functions. Nothing existing is altered,
-- dropped or rewritten. Access model is unchanged: RLS on, no anon/authenticated access; only the server (Supabase secret
-- key / service_role) can read, write or execute anything below.
-- No seed data. network_snapshots holds ONLY values fetched from public APIs (source + fetched_at recorded with every row).
-- profit_settings holds ONLY values the owner typed in (electricity price, watts); every column is NULL until entered.

-- ----------------------------------------------------------------------------------------------- network_snapshots
create table public.network_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  fetched_at          timestamptz not null default now(),
  -- Where the block/difficulty/hashrate/fee numbers came from, e.g. 'mempool.space'. The price has its own source (below).
  source              text not null check (length(btrim(source)) > 0),
  trigger             text not null default 'on_demand' check (trigger in ('on_demand', 'cron')),
  block_height        integer check (block_height is null or block_height >= 0),
  difficulty          numeric(30,4) check (difficulty is null or difficulty > 0),
  network_hashrate_hs numeric(30,2) check (network_hashrate_hs is null or network_hashrate_hs > 0),
  subsidy_sats        bigint check (subsidy_sats is null or subsidy_sats >= 0),
  avg_fee_sats        numeric(20,2) check (avg_fee_sats is null or avg_fee_sats >= 0),
  fee_window_blocks   integer check (fee_window_blocks is null or fee_window_blocks > 0),
  btc_price_usd       numeric(18,4) check (btc_price_usd is null or btc_price_usd > 0),
  price_source        text,
  price_time          timestamptz,
  -- A field that could not be fetched is NULL here and named in field_errors (never filled from an older row).
  field_errors        jsonb not null default '{}'::jsonb,
  -- The raw (small) public API payloads the values were derived from.
  raw                 jsonb not null default '{}'::jsonb,
  constraint network_snapshots_has_data check (num_nonnulls(block_height, difficulty, network_hashrate_hs, avg_fee_sats, btc_price_usd) >= 1),
  constraint network_snapshots_price_has_source check (btc_price_usd is null or (price_source is not null and length(btrim(price_source)) > 0))
);
comment on table public.network_snapshots is 'Public Bitcoin network data (difficulty, hashrate, subsidy, average fees, USD price) with source and fetch time. Never user-entered, never simulated.';
create index network_snapshots_fetched_at_idx on public.network_snapshots (fetched_at desc);
alter table public.network_snapshots enable row level security;
revoke all on public.network_snapshots from anon, authenticated;

-- ----------------------------------------------------------------------------------------------- profit_settings
create table public.profit_settings (
  owner_id                text primary key,
  -- All NULL by default: with a NULL electricity price or NULL watts the electricity cost is UNKNOWN (not zero).
  electricity_usd_per_kwh numeric(10,4) check (electricity_usd_per_kwh is null or (electricity_usd_per_kwh >= 0 and electricity_usd_per_kwh <= 100)),
  default_watts_per_worker numeric(10,2) check (default_watts_per_worker is null or (default_watts_per_worker >= 0 and default_watts_per_worker <= 100000)),
  -- Optional per-worker override: { "<worker uuid>": watts }.
  worker_watts            jsonb not null default '{}'::jsonb check (jsonb_typeof(worker_watts) = 'object'),
  -- NULL = use the pool fee documented by the pool (Braiins: 2.5%, see docs/profitability.md); set it to override.
  pool_fee_pct_override   numeric(5,2) check (pool_fee_pct_override is null or (pool_fee_pct_override >= 0 and pool_fee_pct_override <= 100)),
  updated_at              timestamptz not null default now(),
  updated_by              text
);
comment on table public.profit_settings is 'Owner-entered cost inputs for the profitability engine. NULL means not entered (cost unknown), never zero.';
alter table public.profit_settings enable row level security;
revoke all on public.profit_settings from anon, authenticated;

-- ----------------------------------------------------------------------------------------------- audited settings write
-- One transaction: upsert the settings AND append to audit_log (old and new values; these are the owner's own inputs, not secrets).
create or replace function public.profit_save_settings(
  p_owner text, p_actor text,
  p_kwh numeric, p_default_watts numeric, p_worker_watts jsonb, p_fee_override numeric
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  old_row public.profit_settings%rowtype;
  new_row public.profit_settings%rowtype;
begin
  if p_owner is null or length(btrim(p_owner)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'owner_required');
  end if;
  if p_worker_watts is null or jsonb_typeof(p_worker_watts) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_worker_watts');
  end if;
  select * into old_row from public.profit_settings where owner_id = p_owner;

  insert into public.profit_settings as s (owner_id, electricity_usd_per_kwh, default_watts_per_worker, worker_watts, pool_fee_pct_override, updated_by)
  values (p_owner, p_kwh, p_default_watts, p_worker_watts, p_fee_override, p_actor)
  on conflict (owner_id) do update
    set electricity_usd_per_kwh  = excluded.electricity_usd_per_kwh,
        default_watts_per_worker = excluded.default_watts_per_worker,
        worker_watts             = excluded.worker_watts,
        pool_fee_pct_override    = excluded.pool_fee_pct_override,
        updated_at               = now(),
        updated_by               = excluded.updated_by
  returning * into new_row;

  insert into public.audit_log (actor, action, entity_type, entity_id, details)
  values (p_actor, 'profit.settings.updated', 'profit_settings', p_owner,
          jsonb_build_object(
            'old', case when old_row.owner_id is null then null else jsonb_build_object(
              'electricity_usd_per_kwh', old_row.electricity_usd_per_kwh, 'default_watts_per_worker', old_row.default_watts_per_worker,
              'worker_watts', old_row.worker_watts, 'pool_fee_pct_override', old_row.pool_fee_pct_override) end,
            'new', jsonb_build_object(
              'electricity_usd_per_kwh', new_row.electricity_usd_per_kwh, 'default_watts_per_worker', new_row.default_watts_per_worker,
              'worker_watts', new_row.worker_watts, 'pool_fee_pct_override', new_row.pool_fee_pct_override)));
  return jsonb_build_object('ok', true);
end;
$$;

-- ----------------------------------------------------------------------------------------------- measured hashrate
-- Read-only: per non-revoked worker, the average of the MEASURED one-minute hashrates reported in the window, plus how many
-- minute buckets that average rests on. Workers with no telemetry in the window are simply absent (no row, so no estimate).
create or replace function public.profit_worker_hashrate(p_now timestamptz, p_hours int)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(a)::jsonb), '[]'::jsonb)
  from (
    select
      t.worker_id,
      count(*)                as buckets,
      avg(t.avg_hashrate_hs)  as avg_hs,
      min(t.bucket_start)     as first_bucket,
      max(t.bucket_start)     as last_bucket
    from public.telemetry_1m t
    join public.workers w on w.id = t.worker_id and w.status <> 'revoked'
    where t.bucket_start >= p_now - make_interval(hours => p_hours) and t.bucket_start <= p_now
    group by t.worker_id
  ) a;
$$;

revoke all on function public.profit_save_settings(text, text, numeric, numeric, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.profit_worker_hashrate(timestamptz, int)                           from public, anon, authenticated;
grant execute on function public.profit_save_settings(text, text, numeric, numeric, jsonb, numeric) to service_role;
grant execute on function public.profit_worker_hashrate(timestamptz, int)                           to service_role;
