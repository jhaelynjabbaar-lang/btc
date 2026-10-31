-- BTC Network AI: core schema (Phase 2).
-- Access model: ONLY the Next.js server touches this database, using the Supabase secret key
-- (service_role, bypasses RLS). anon/authenticated get nothing. owner_id is the Auth.js user id
-- (text) from the app's Neon DB; Supabase Auth is not used for identity.
-- No seed data. No private keys, seeds or xprv material is ever stored.

-- Shared trigger function: keep updated_at fresh.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- pools
create table public.pools (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  url           text not null,
  protocol      text not null check (protocol in ('sv1', 'sv2')),
  payout_method text not null check (payout_method in ('pplns', 'fpps', 'pps', 'pps_plus', 'prop', 'solo', 'other')),
  fee_pct       numeric(5,2) not null default 0 check (fee_pct >= 0 and fee_pct <= 100),
  stats_api_url text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint pools_name_key unique (name),
  constraint pools_name_nonempty check (length(btrim(name)) > 0)
);
comment on table public.pools is 'Mining pools the user may point workers at. url is the stratum endpoint.';

-- ------------------------------------------------------ payout_addresses
create table public.payout_addresses (
  id         uuid primary key default gen_random_uuid(),
  owner_id   text not null,
  address    text not null,
  network    text not null default 'mainnet' check (network in ('mainnet', 'testnet', 'signet', 'regtest')),
  label      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payout_addresses_owner_address_key unique (owner_id, address),
  -- Public address shapes only (bech32/bech32m, base58 P2PKH/P2SH, testnet). Rejects extended private keys.
  constraint payout_addresses_format check (
    address ~ '^(bc1|tb1|bcrt1)[0-9a-z]{11,87}$'
    or address ~ '^[13mn2][1-9A-HJ-NP-Za-km-z]{25,39}$'
  )
);
comment on table public.payout_addresses is 'PUBLIC Bitcoin receive addresses only. Never store private keys, WIF, seeds or xprv.';
create index payout_addresses_owner_id_idx on public.payout_addresses (owner_id);

-- --------------------------------------------------------- cloud_providers
create table public.cloud_providers (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  terms_url            text,
  mining_allowed_quote text,
  verified_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint cloud_providers_name_key unique (name),
  -- A provider can only be marked verified when the ToS URL and the quote that allows mining are recorded.
  constraint cloud_providers_verified_needs_evidence check (
    verified_at is null or (terms_url is not null and mining_allowed_quote is not null and length(btrim(mining_allowed_quote)) > 0)
  )
);
comment on table public.cloud_providers is 'Cloud providers and the verbatim terms quote showing mining is allowed.';

-- ---------------------------------------------------------------- workers
create table public.workers (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            text not null,
  name                text not null,
  os                  text,
  hardware_type       text not null default 'other' check (hardware_type in ('cpu', 'gpu', 'asic', 'cloud', 'other')),
  status              text not null default 'pending' check (status in ('pending', 'online', 'offline', 'paused', 'revoked')),
  current_hashrate_hs numeric(24,2) not null default 0 check (current_hashrate_hs >= 0),
  uptime_s            bigint not null default 0 check (uptime_s >= 0),
  last_seen_at        timestamptz,
  software_version    text,
  authorized_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint workers_owner_name_key unique (owner_id, name),
  constraint workers_name_nonempty check (length(btrim(name)) > 0),
  -- A worker can only be online/paused after the owner authorized it.
  constraint workers_active_needs_authorization check (status in ('pending', 'offline', 'revoked') or authorized_at is not null)
);
comment on table public.workers is 'Worker machines (user-owned or authorized cloud) reporting hashrate.';
create index workers_owner_id_idx on public.workers (owner_id);
create index workers_status_idx on public.workers (status);
create index workers_last_seen_at_idx on public.workers (last_seen_at desc);

-- ------------------------------------------------------ worker_credentials
create table public.worker_credentials (
  id          uuid primary key default gen_random_uuid(),
  worker_id   uuid not null references public.workers (id) on delete cascade,
  public_key  text,
  token_hash  text,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  -- Exactly one of a public key or a token hash. Plaintext tokens/secrets are never stored.
  constraint worker_credentials_one_kind check (num_nonnulls(public_key, token_hash) = 1)
);
comment on table public.worker_credentials is 'Worker auth material: a public key or a hash of a token. Never a plaintext secret.';
create index worker_credentials_worker_id_idx on public.worker_credentials (worker_id);
create unique index worker_credentials_token_hash_key on public.worker_credentials (token_hash) where token_hash is not null;
create unique index worker_credentials_public_key_key on public.worker_credentials (public_key) where public_key is not null;

-- ------------------------------------------------- worker_enrollment_codes
create table public.worker_enrollment_codes (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            text not null,
  code_hash           text not null,
  expires_at          timestamptz not null,
  used_at             timestamptz,
  used_by_worker_id   uuid references public.workers (id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint worker_enrollment_codes_code_hash_key unique (code_hash),
  constraint worker_enrollment_codes_expiry_after_create check (expires_at > created_at)
);
comment on table public.worker_enrollment_codes is 'One-time worker enrollment codes, stored hashed only.';
create index worker_enrollment_codes_owner_id_idx on public.worker_enrollment_codes (owner_id);
create index worker_enrollment_codes_expires_at_idx on public.worker_enrollment_codes (expires_at);
create index worker_enrollment_codes_used_by_worker_id_idx on public.worker_enrollment_codes (used_by_worker_id);

-- ------------------------------------------------------------ telemetry_1m
create table public.telemetry_1m (
  worker_id       uuid not null references public.workers (id) on delete cascade,
  bucket_start    timestamptz not null,
  avg_hashrate_hs numeric(24,2) not null check (avg_hashrate_hs >= 0),
  accepted        bigint not null default 0 check (accepted >= 0),
  rejected        bigint not null default 0 check (rejected >= 0),
  difficulty      numeric(30,8) check (difficulty is null or difficulty >= 0),
  pool_id         uuid references public.pools (id) on delete set null,
  temperature_c   numeric(5,2),
  -- one row per worker per minute bucket (also the idempotent upsert key)
  constraint telemetry_1m_pkey primary key (worker_id, bucket_start)
);
comment on table public.telemetry_1m is 'One-minute telemetry rollups per worker.';
create index telemetry_1m_bucket_start_idx on public.telemetry_1m (bucket_start desc);
create index telemetry_1m_pool_id_idx on public.telemetry_1m (pool_id);

-- --------------------------------------------------------------- pool_stats
create table public.pool_stats (
  id               uuid primary key default gen_random_uuid(),
  pool_id          uuid not null references public.pools (id) on delete cascade,
  payout_address_id uuid references public.payout_addresses (id) on delete set null,
  period_start     timestamptz not null,
  period_end       timestamptz not null,
  hashrate_hs      numeric(24,2) check (hashrate_hs is null or hashrate_hs >= 0),
  workers_count    integer check (workers_count is null or workers_count >= 0),
  shares_accepted  bigint check (shares_accepted is null or shares_accepted >= 0),
  shares_rejected  bigint check (shares_rejected is null or shares_rejected >= 0),
  balance_sats     bigint check (balance_sats is null or balance_sats >= 0),
  paid_sats        bigint check (paid_sats is null or paid_sats >= 0),
  raw              jsonb,
  fetched_at       timestamptz not null default now(),
  constraint pool_stats_period_valid check (period_end > period_start),
  constraint pool_stats_pool_period_key unique (pool_id, period_start, period_end)
);
comment on table public.pool_stats is 'Rollups pulled from a pool''s own API (source of truth for pool-side numbers).';
create index pool_stats_payout_address_id_idx on public.pool_stats (payout_address_id);
create index pool_stats_period_end_idx on public.pool_stats (period_end desc);

-- ---------------------------------------------------------- cloud_resources
create table public.cloud_resources (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             text not null,
  provider_id          uuid not null references public.cloud_providers (id) on delete restrict,
  worker_id            uuid references public.workers (id) on delete set null,
  instance_id          text not null,
  capacity             jsonb not null default '{}'::jsonb,
  hourly_price_usd     numeric(12,4) not null check (hourly_price_usd >= 0),
  status               text not null default 'unknown' check (status in ('provisioning', 'running', 'stopped', 'terminated', 'unknown')),
  authorization_status text not null default 'pending' check (authorization_status in ('pending', 'authorized', 'denied', 'revoked')),
  authorized_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint cloud_resources_provider_instance_key unique (provider_id, instance_id),
  -- Nothing may be provisioned/running unless explicitly authorized.
  constraint cloud_resources_active_needs_authorization check (
    status not in ('provisioning', 'running') or (authorization_status = 'authorized' and authorized_at is not null)
  )
);
comment on table public.cloud_resources is 'Cloud instances. Only usable when authorization_status = authorized.';
create index cloud_resources_owner_id_idx on public.cloud_resources (owner_id);
create index cloud_resources_provider_id_idx on public.cloud_resources (provider_id);
create index cloud_resources_worker_id_idx on public.cloud_resources (worker_id);

-- ------------------------------------------------------------------- ledger
create table public.ledger (
  id                uuid primary key default gen_random_uuid(),
  owner_id          text not null,
  kind              text not null check (kind in ('estimated_reward', 'confirmed_payout', 'expense_cloud', 'expense_electricity', 'expense_other')),
  amount_sats       bigint check (amount_sats is null or amount_sats >= 0),
  amount_usd        numeric(18,4) check (amount_usd is null or amount_usd >= 0),
  source            text not null check (source in ('pool', 'chain', 'estimate', 'cloud_billing', 'electricity_meter', 'manual')),
  ref               text,
  pool_id           uuid references public.pools (id) on delete set null,
  payout_address_id uuid references public.payout_addresses (id) on delete set null,
  cloud_resource_id uuid references public.cloud_resources (id) on delete set null,
  note              text,
  occurred_at       timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint ledger_amount_present check (num_nonnulls(amount_sats, amount_usd) >= 1),
  -- Rewards are denominated in sats, expenses in USD.
  constraint ledger_kind_amount check (
    (kind in ('estimated_reward', 'confirmed_payout') and amount_sats is not null)
    or (kind in ('expense_cloud', 'expense_electricity', 'expense_other') and amount_usd is not null)
  ),
  -- Confirmed payouts may ONLY come from pool or chain data, and must be traceable (payout id / txid).
  constraint ledger_confirmed_payout_provenance check (
    kind <> 'confirmed_payout' or (source in ('pool', 'chain') and ref is not null and length(btrim(ref)) > 0)
  ),
  constraint ledger_estimate_source check (kind <> 'estimated_reward' or source in ('estimate', 'pool'))
);
comment on table public.ledger is 'Money ledger. confirmed_payout rows only from pool/chain with a reference; estimates are never payouts.';
create unique index ledger_dedupe_key on public.ledger (kind, source, ref) where ref is not null;
create index ledger_owner_occurred_idx on public.ledger (owner_id, occurred_at desc);
create index ledger_pool_id_idx on public.ledger (pool_id);
create index ledger_payout_address_id_idx on public.ledger (payout_address_id);
create index ledger_cloud_resource_id_idx on public.ledger (cloud_resource_id);

-- ------------------------------------------------------------- spend_limits
create table public.spend_limits (
  id          uuid primary key default gen_random_uuid(),
  owner_id    text not null,
  scope       text not null default 'global' check (scope in ('global', 'provider')),
  provider_id uuid references public.cloud_providers (id) on delete cascade,
  period      text not null check (period in ('hour', 'day', 'month')),
  limit_usd   numeric(12,2) not null check (limit_usd >= 0),
  hard_stop   boolean not null default true,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint spend_limits_scope_provider check ((scope = 'provider') = (provider_id is not null))
);
comment on table public.spend_limits is 'Hard spending caps for cloud usage. hard_stop = block spend when reached.';
create unique index spend_limits_unique_scope on public.spend_limits (owner_id, scope, period, coalesce(provider_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index spend_limits_provider_id_idx on public.spend_limits (provider_id);

-- -------------------------------------------------------- ai_recommendations
create table public.ai_recommendations (
  id          uuid primary key default gen_random_uuid(),
  owner_id    text not null,
  worker_id   uuid references public.workers (id) on delete set null,
  kind        text not null default 'general',
  inputs      jsonb not null default '{}'::jsonb,
  explanation text not null,
  model       text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_at  timestamptz,
  decided_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ai_recommendations_decision_consistent check ((status = 'pending') = (decided_at is null))
);
comment on table public.ai_recommendations is 'AI suggestions; nothing executes until a human approves (status = approved).';
create index ai_recommendations_owner_status_idx on public.ai_recommendations (owner_id, status, created_at desc);
create index ai_recommendations_worker_id_idx on public.ai_recommendations (worker_id);

-- ---------------------------------------------------------------- audit_log
create table public.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor       text not null,
  action      text not null,
  entity_type text,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  request_id  text
);
comment on table public.audit_log is 'Append-only audit trail (updates and deletes are blocked by trigger).';
create index audit_log_occurred_at_idx on public.audit_log (occurred_at desc);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_actor_idx on public.audit_log (actor);

create or replace function public.audit_log_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;
create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function public.audit_log_block_mutation();

-- ------------------------------------------------------ updated_at triggers
create trigger set_updated_at before update on public.pools              for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.payout_addresses   for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.cloud_providers    for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.workers            for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.cloud_resources    for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.ledger             for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.spend_limits       for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.ai_recommendations for each row execute function public.set_updated_at();
