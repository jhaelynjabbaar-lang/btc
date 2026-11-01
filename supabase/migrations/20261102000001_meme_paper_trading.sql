-- BTC Network AI: memecoin paper-trading bot (PAPER MONEY, NOT REAL).
-- ADDITIVE ONLY: five new tables and three new functions, all prefixed meme_paper_. Nothing existing is altered or dropped.
-- Same access model as the BTC paper bot: RLS on, no policies, no anon/authenticated grants; only the server (service_role)
-- can read, write or execute anything below. There are NO wallets, private keys, exchange credentials or real-money fields here.
-- Every trade and mark stores the price source and the time the price was fetched.

-- ------------------------------------------------------------------------------------------------ meme_paper_accounts
-- One row per paper account. Reset archives the active account and starts a new one, so history is never rewritten.
create table public.meme_paper_accounts (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  ended_at       timestamptz,
  is_active      boolean not null default true,
  paused         boolean not null default false,
  created_by     text,
  starting_usd   numeric(20,8) not null check (starting_usd > 0),
  cash_usd       numeric(20,8) not null check (cash_usd >= 0),
  fees_paid_usd  numeric(20,8) not null default 0 check (fees_paid_usd >= 0),
  -- Optimistic-concurrency counter: a tick plan computed from an older version is refused.
  version        integer not null default 0,
  -- Strategy, rug-check and cost parameters in force for this account (copied at creation).
  config         jsonb not null check (jsonb_typeof(config) = 'object'),
  last_bucket_at timestamptz,
  constraint meme_paper_accounts_ended_consistent check ((is_active and ended_at is null) or (not is_active and ended_at is not null))
);
comment on table public.meme_paper_accounts is 'Memecoin paper-trading accounts. PAPER MONEY, NOT REAL. Exactly one active account at a time.';
create unique index meme_paper_accounts_one_active on public.meme_paper_accounts (is_active) where is_active;

-- ------------------------------------------------------------------------------------------------ meme_paper_positions
create table public.meme_paper_positions (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references public.meme_paper_accounts (id) on delete cascade,
  opened_at            timestamptz not null default now(),
  closed_at            timestamptz,
  status               text not null default 'open' check (status in ('open', 'closed')),
  token_address        text not null,
  symbol               text not null,
  name                 text,
  pair_address         text not null,
  dex_id               text,
  qty                  numeric(40,12) not null check (qty > 0),
  entry_ref_price      numeric(40,20) not null check (entry_ref_price > 0),
  entry_fill_price     numeric(40,20) not null check (entry_fill_price > 0),
  -- Cash spent, all-in (includes DEX fee and Solana fee).
  cost_usd             numeric(20,8) not null check (cost_usd > 0),
  entry_liquidity_usd  numeric(20,2) not null,
  peak_price           numeric(40,20) not null,
  last_price           numeric(40,20) not null,
  last_liquidity_usd   numeric(20,2),
  last_marked_at       timestamptz,
  -- Consecutive ticks in which the pool was absent from a successful API response (written off at the configured limit).
  missing_ticks        integer not null default 0,
  rugcheck_score       numeric(8,2),
  entry_context        jsonb not null default '{}'::jsonb,
  exit_reason          text,
  exit_ref_price       numeric(40,20),
  exit_fill_price      numeric(40,20),
  -- Cash received after fees and slippage (0 for a write-off).
  proceeds_usd         numeric(20,8),
  pnl_usd              numeric(20,8),
  constraint meme_paper_positions_closed_consistent check ((status = 'open' and closed_at is null) or (status = 'closed' and closed_at is not null and proceeds_usd is not null and exit_reason is not null))
);
create unique index meme_paper_positions_one_open_per_token on public.meme_paper_positions (account_id, token_address) where status = 'open';
create index meme_paper_positions_account_idx on public.meme_paper_positions (account_id, opened_at desc);

-- ------------------------------------------------------------------------------------------------ meme_paper_ticks
-- One row per tick attempt. Applied ticks are unique per (account, 15-minute bucket): the idempotency key. Skipped ticks record why.
create table public.meme_paper_ticks (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.meme_paper_accounts (id) on delete cascade,
  bucket_start      timestamptz not null,
  at                timestamptz not null default now(),
  status            text not null check (status in ('applied', 'skipped')),
  skip_reason       text,
  candidates_seen   integer not null default 0,
  rejected          integer not null default 0,
  bought            integer not null default 0,
  sold              integer not null default 0,
  open_positions    integer not null default 0,
  cash_usd          numeric(20,8),
  market_value_usd  numeric(20,8),
  equity_usd        numeric(20,8),
  sol_price_usd     numeric(20,6),
  sources           jsonb not null default '[]'::jsonb,
  notes             jsonb not null default '[]'::jsonb
);
create unique index meme_paper_ticks_one_applied_per_bucket on public.meme_paper_ticks (account_id, bucket_start) where status = 'applied';
create index meme_paper_ticks_account_idx on public.meme_paper_ticks (account_id, at desc);

-- ------------------------------------------------------------------------------------------------ meme_paper_trades
create table public.meme_paper_trades (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.meme_paper_accounts (id) on delete cascade,
  position_id    uuid references public.meme_paper_positions (id) on delete set null,
  tick_id        uuid references public.meme_paper_ticks (id) on delete set null,
  executed_at    timestamptz not null default now(),
  side           text not null check (side in ('buy', 'sell')),
  token_address  text not null,
  symbol         text not null,
  pair_address   text not null,
  qty            numeric(40,12) not null check (qty > 0),
  ref_price      numeric(40,20) not null check (ref_price > 0),
  fill_price     numeric(40,20) not null check (fill_price > 0),
  notional_usd   numeric(20,8) not null,
  dex_fee_usd    numeric(20,8) not null check (dex_fee_usd >= 0),
  tx_fee_usd     numeric(20,8) not null check (tx_fee_usd >= 0),
  slippage_bps   numeric(12,2) not null check (slippage_bps >= 0),
  slippage_usd   numeric(20,8) not null,
  price_source   text not null,
  price_time     timestamptz not null,
  reason         text not null
);
create index meme_paper_trades_account_idx on public.meme_paper_trades (account_id, executed_at desc);

-- ------------------------------------------------------------------------------------------------ meme_paper_candidates
-- Every token considered in a tick with the decision and ALL rejection reasons (kept 7 days, pruned by meme_paper_apply_tick).
create table public.meme_paper_candidates (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.meme_paper_accounts (id) on delete cascade,
  tick_id        uuid references public.meme_paper_ticks (id) on delete cascade,
  seen_at        timestamptz not null default now(),
  token_address  text not null,
  symbol         text not null,
  pair_address   text,
  sources        jsonb not null default '[]'::jsonb,
  decision       text not null check (decision in ('rejected', 'bought', 'skipped', 'held')),
  reasons        jsonb not null default '[]'::jsonb,
  metrics        jsonb not null default '{}'::jsonb
);
create index meme_paper_candidates_account_idx on public.meme_paper_candidates (account_id, seen_at desc);
create index meme_paper_candidates_tick_idx on public.meme_paper_candidates (tick_id);

alter table public.meme_paper_accounts   enable row level security;
alter table public.meme_paper_positions  enable row level security;
alter table public.meme_paper_ticks      enable row level security;
alter table public.meme_paper_trades     enable row level security;
alter table public.meme_paper_candidates enable row level security;
revoke all on public.meme_paper_accounts, public.meme_paper_positions, public.meme_paper_ticks, public.meme_paper_trades, public.meme_paper_candidates from anon, authenticated;

-- ------------------------------------------------------------------------------------------------ meme_paper_start_run
-- Atomically archives the active account (unless p_only_if_none) and creates a new one.
create or replace function public.meme_paper_start_run(p_actor text, p_starting numeric, p_config jsonb, p_only_if_none boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  old_id uuid;
  new_id uuid;
begin
  if p_starting is null or p_starting <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_starting_balance');
  end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_config');
  end if;
  perform pg_advisory_xact_lock(hashtext('meme_paper_start_run'));
  select id into old_id from public.meme_paper_accounts where is_active for update;
  if old_id is not null and p_only_if_none then
    return jsonb_build_object('ok', true, 'created', false, 'account_id', old_id);
  end if;
  if old_id is not null then
    -- Open positions of the archived account are left as they were (never silently closed or re-priced).
    update public.meme_paper_accounts set is_active = false, ended_at = now() where id = old_id;
  end if;
  insert into public.meme_paper_accounts (created_by, starting_usd, cash_usd, config)
  values (p_actor, p_starting, p_starting, p_config)
  returning id into new_id;
  return jsonb_build_object('ok', true, 'created', true, 'account_id', new_id, 'previous_account', old_id);
end;
$$;

-- ------------------------------------------------------------------------------------------------ meme_paper_set_paused
create or replace function public.meme_paper_set_paused(p_actor text, p_paused boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  aid uuid;
begin
  update public.meme_paper_accounts set paused = p_paused where is_active returning id into aid;
  if aid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_active_account');
  end if;
  return jsonb_build_object('ok', true, 'account_id', aid, 'paused', p_paused);
end;
$$;

-- ------------------------------------------------------------------------------------------------ meme_paper_apply_tick
-- Atomically applies one planned tick (computed and unit-tested in lib/meme/engine.ts). The account row is locked, so concurrent
-- invocations are serialised; the (account, bucket) unique index makes each 15-minute bucket apply exactly once; the version check
-- refuses a plan computed from stale balances. Marks, exits, entries, candidate log and account totals change in one transaction.
create or replace function public.meme_paper_apply_tick(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  a        public.meme_paper_accounts%rowtype;
  v_bucket timestamptz := (p->>'bucket_start')::timestamptz;
  t        jsonb := p->'tick';
  v_tick   uuid;
  m        jsonb;
  c        jsonb;
  o        jsonb;
  v_pos    uuid;
  v_cash   numeric(20,8) := (p->>'cash_usd')::numeric;
  v_fees   numeric(20,8) := (p->>'fees_paid_usd')::numeric;
begin
  select * into a from public.meme_paper_accounts where id = (p->>'account_id')::uuid for update;
  if not found then return jsonb_build_object('ok', false, 'applied', false, 'reason', 'account_not_found'); end if;
  if not a.is_active then return jsonb_build_object('ok', false, 'applied', false, 'reason', 'account_inactive'); end if;
  if a.paused then return jsonb_build_object('ok', true, 'applied', false, 'reason', 'paused'); end if;
  if exists (select 1 from public.meme_paper_ticks where account_id = a.id and bucket_start = v_bucket and status = 'applied') then
    return jsonb_build_object('ok', true, 'applied', false, 'reason', 'duplicate_bucket');
  end if;
  if a.version <> (p->>'expected_version')::integer then
    return jsonb_build_object('ok', false, 'applied', false, 'reason', 'stale_state');
  end if;
  if v_cash < 0 or v_fees < a.fees_paid_usd then return jsonb_build_object('ok', false, 'applied', false, 'reason', 'invalid_balance'); end if;

  insert into public.meme_paper_ticks (account_id, bucket_start, status, candidates_seen, rejected, bought, sold, open_positions, cash_usd, market_value_usd, equity_usd, sol_price_usd, sources, notes)
  values (a.id, v_bucket, 'applied', (t->>'candidates_seen')::integer, (t->>'rejected')::integer, (t->>'bought')::integer, (t->>'sold')::integer, (t->>'open_positions')::integer,
          v_cash, (t->>'market_value_usd')::numeric, (t->>'equity_usd')::numeric, (t->>'sol_price_usd')::numeric, coalesce(t->'sources', '[]'::jsonb), coalesce(t->'notes', '[]'::jsonb))
  returning id into v_tick;

  for m in select * from jsonb_array_elements(coalesce(p->'marks', '[]'::jsonb)) loop
    update public.meme_paper_positions
       set last_price = (m->>'last_price')::numeric, last_liquidity_usd = coalesce((m->>'last_liquidity_usd')::numeric, last_liquidity_usd),
           peak_price = (m->>'peak_price')::numeric, missing_ticks = (m->>'missing_ticks')::integer, last_marked_at = (m->>'last_marked_at')::timestamptz
     where id = (m->>'position_id')::uuid and account_id = a.id and status = 'open';
  end loop;

  for c in select * from jsonb_array_elements(coalesce(p->'closes', '[]'::jsonb)) loop
    update public.meme_paper_positions
       set status = 'closed', closed_at = now(), exit_reason = c->>'exit_reason', exit_ref_price = (c->>'exit_ref_price')::numeric,
           exit_fill_price = (c->>'exit_fill_price')::numeric, proceeds_usd = (c->>'proceeds_usd')::numeric, pnl_usd = (c->>'pnl_usd')::numeric,
           missing_ticks = case when c->>'exit_reason' = 'written_off_pair_gone' then missing_ticks else 0 end
     where id = (c->>'position_id')::uuid and account_id = a.id and status = 'open'
     returning id into v_pos;
    if v_pos is null then raise exception 'meme_paper_apply_tick: position % is not open', c->>'position_id'; end if;
    if c->'trade' is not null and jsonb_typeof(c->'trade') = 'object' then
      o := c->'trade';
      insert into public.meme_paper_trades (account_id, position_id, tick_id, side, token_address, symbol, pair_address, qty, ref_price, fill_price, notional_usd, dex_fee_usd, tx_fee_usd, slippage_bps, slippage_usd, price_source, price_time, reason)
      values (a.id, v_pos, v_tick, o->>'side', o->>'token_address', o->>'symbol', o->>'pair_address', (o->>'qty')::numeric, (o->>'ref_price')::numeric, (o->>'fill_price')::numeric,
              (o->>'notional_usd')::numeric, (o->>'dex_fee_usd')::numeric, (o->>'tx_fee_usd')::numeric, (o->>'slippage_bps')::numeric, (o->>'slippage_usd')::numeric,
              o->>'price_source', (o->>'price_time')::timestamptz, o->>'reason');
    end if;
  end loop;

  for c in select * from jsonb_array_elements(coalesce(p->'opens', '[]'::jsonb)) loop
    o := c->'position';
    insert into public.meme_paper_positions (account_id, token_address, symbol, name, pair_address, dex_id, qty, entry_ref_price, entry_fill_price, cost_usd, entry_liquidity_usd,
                                             peak_price, last_price, last_liquidity_usd, last_marked_at, rugcheck_score, entry_context)
    values (a.id, o->>'token_address', o->>'symbol', o->>'name', o->>'pair_address', o->>'dex_id', (o->>'qty')::numeric, (o->>'entry_ref_price')::numeric, (o->>'entry_fill_price')::numeric,
            (o->>'cost_usd')::numeric, (o->>'entry_liquidity_usd')::numeric, (o->>'peak_price')::numeric, (o->>'last_price')::numeric, (o->>'last_liquidity_usd')::numeric, now(),
            (o->>'rugcheck_score')::numeric, coalesce(o->'entry_context', '{}'::jsonb))
    returning id into v_pos;
    o := c->'trade';
    insert into public.meme_paper_trades (account_id, position_id, tick_id, side, token_address, symbol, pair_address, qty, ref_price, fill_price, notional_usd, dex_fee_usd, tx_fee_usd, slippage_bps, slippage_usd, price_source, price_time, reason)
    values (a.id, v_pos, v_tick, o->>'side', o->>'token_address', o->>'symbol', o->>'pair_address', (o->>'qty')::numeric, (o->>'ref_price')::numeric, (o->>'fill_price')::numeric,
            (o->>'notional_usd')::numeric, (o->>'dex_fee_usd')::numeric, (o->>'tx_fee_usd')::numeric, (o->>'slippage_bps')::numeric, (o->>'slippage_usd')::numeric,
            o->>'price_source', (o->>'price_time')::timestamptz, o->>'reason');
  end loop;

  insert into public.meme_paper_candidates (account_id, tick_id, token_address, symbol, pair_address, sources, decision, reasons, metrics)
  select a.id, v_tick, x->>'token_address', x->>'symbol', x->>'pair_address', coalesce(x->'sources', '[]'::jsonb), x->>'decision', coalesce(x->'reasons', '[]'::jsonb), coalesce(x->'metrics', '{}'::jsonb)
    from jsonb_array_elements(coalesce(p->'candidates', '[]'::jsonb)) x;

  update public.meme_paper_accounts set cash_usd = v_cash, fees_paid_usd = v_fees, version = version + 1, last_bucket_at = v_bucket where id = a.id;
  delete from public.meme_paper_candidates where seen_at < now() - interval '7 days';
  return jsonb_build_object('ok', true, 'applied', true, 'tick_id', v_tick);
end;
$$;

revoke all on function public.meme_paper_start_run(text, numeric, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.meme_paper_set_paused(text, boolean)                from public, anon, authenticated;
revoke all on function public.meme_paper_apply_tick(jsonb)                        from public, anon, authenticated;
grant execute on function public.meme_paper_start_run(text, numeric, jsonb, boolean) to service_role;
grant execute on function public.meme_paper_set_paused(text, boolean)                to service_role;
grant execute on function public.meme_paper_apply_tick(jsonb)                        to service_role;
