-- BTC Network AI: paper-trading bot (PAPER MONEY, NOT REAL).
-- ADDITIVE ONLY: five new tables and three new functions, all prefixed paper_. Nothing existing is altered or dropped.
-- Access model is unchanged: RLS on, no policies, no anon/authenticated grants; only the server (service_role) can read, write
-- or execute anything below. There are NO exchange credentials, wallets or real-money fields anywhere in this schema.
-- Prices stored here were fetched from a public keyless API; every snapshot and trade records its price source and price time.

-- ------------------------------------------------------------------------------------------------------- paper_runs
-- One row per paper account ("run"). Reset archives the active run and starts a new one, so history is never rewritten.
create table public.paper_runs (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  ended_at           timestamptz,
  is_active          boolean not null default true,
  paused             boolean not null default false,
  created_by         text,
  starting_usd       numeric(20,2) not null check (starting_usd > 0),
  cash_usd           numeric(20,2) not null check (cash_usd >= 0),
  qty_btc            numeric(20,8) not null default 0 check (qty_btc >= 0),
  fees_paid_usd      numeric(20,2) not null default 0 check (fees_paid_usd >= 0),
  -- Parameters in force for this run (fee, slippage, SMA lengths, minimum order...), copied at creation.
  config             jsonb not null check (jsonb_typeof(config) = 'object'),
  -- Buy-and-hold benchmark: filled once, at the run's first tick (same cash, fee, slippage and minimums as the bot).
  bench_entry_at     timestamptz,
  bench_entry_price  numeric(20,2),
  bench_qty_btc      numeric(20,8),
  bench_cash_usd     numeric(20,2),
  last_candle_at     timestamptz,
  constraint paper_runs_ended_consistent check ((is_active and ended_at is null) or (not is_active and ended_at is not null))
);
comment on table public.paper_runs is 'Paper-trading accounts. PAPER MONEY, NOT REAL. Exactly one active run at a time.';
create unique index paper_runs_one_active on public.paper_runs (is_active) where is_active;

-- ------------------------------------------------------------------------------------------------------- paper_positions
create table public.paper_positions (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.paper_runs (id) on delete cascade,
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  status        text not null default 'open' check (status in ('open', 'closed')),
  qty_btc       numeric(20,8) not null check (qty_btc > 0),
  entry_price   numeric(20,2) not null check (entry_price > 0),
  -- Cash spent including the fee.
  cost_usd      numeric(20,2) not null check (cost_usd > 0),
  exit_price    numeric(20,2),
  -- Cash received after the fee.
  proceeds_usd  numeric(20,2),
  pnl_usd       numeric(20,2),
  constraint paper_positions_closed_consistent check ((status = 'open' and closed_at is null) or (status = 'closed' and closed_at is not null and exit_price is not null and proceeds_usd is not null))
);
create unique index paper_positions_one_open on public.paper_positions (run_id) where status = 'open';
create index paper_positions_run_idx on public.paper_positions (run_id, opened_at desc);

-- ------------------------------------------------------------------------------------------------------- paper_trades
create table public.paper_trades (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.paper_runs (id) on delete cascade,
  position_id    uuid references public.paper_positions (id) on delete set null,
  candle_start   timestamptz not null,
  executed_at    timestamptz not null default now(),
  side           text not null check (side in ('buy', 'sell')),
  qty_btc        numeric(20,8) not null check (qty_btc > 0),
  -- Quoted ask (buy) / bid (sell) from the public ticker, and the simulated fill after slippage.
  ref_price      numeric(20,2) not null check (ref_price > 0),
  fill_price     numeric(20,2) not null check (fill_price > 0),
  notional_usd   numeric(20,2) not null check (notional_usd > 0),
  fee_usd        numeric(20,2) not null check (fee_usd >= 0),
  slippage_usd   numeric(20,2) not null default 0,
  cash_after_usd numeric(20,2) not null check (cash_after_usd >= 0),
  qty_after_btc  numeric(20,8) not null check (qty_after_btc >= 0),
  price_source   text not null check (length(btrim(price_source)) > 0),
  price_time     timestamptz not null,
  reason         text not null,
  -- One trade per candle per run: replaying a candle can never double-trade.
  constraint paper_trades_one_per_candle unique (run_id, candle_start)
);
create index paper_trades_run_idx on public.paper_trades (run_id, executed_at desc);

-- ------------------------------------------------------------------------------------------------------- paper_equity_snapshots
-- One row per processed candle (also the idempotency key): the decision, the price used and the resulting equity.
create table public.paper_equity_snapshots (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references public.paper_runs (id) on delete cascade,
  candle_start     timestamptz not null,
  created_at       timestamptz not null default now(),
  price            numeric(20,2) not null check (price > 0),
  price_source     text not null check (length(btrim(price_source)) > 0),
  price_time       timestamptz not null,
  candle_close     numeric(20,2) not null check (candle_close > 0),
  sma_fast         numeric(20,4),
  sma_slow         numeric(20,4),
  signal           text not null check (signal in ('long', 'flat', 'hold')),
  action           text not null,
  reason           text not null,
  cash_usd         numeric(20,2) not null check (cash_usd >= 0),
  qty_btc          numeric(20,8) not null check (qty_btc >= 0),
  fees_paid_usd    numeric(20,2) not null check (fees_paid_usd >= 0),
  equity_usd       numeric(20,2) not null,
  bench_equity_usd numeric(20,2) not null,
  constraint paper_equity_one_per_candle unique (run_id, candle_start)
);
create index paper_equity_run_idx on public.paper_equity_snapshots (run_id, candle_start);

-- ------------------------------------------------------------------------------------------------------- paper_events
-- Log of skipped ticks (fetch failures, stale data), pauses, resumes and resets. No secrets are ever written here.
create table public.paper_events (
  id        uuid primary key default gen_random_uuid(),
  run_id    uuid references public.paper_runs (id) on delete set null,
  at        timestamptz not null default now(),
  level     text not null default 'info' check (level in ('info', 'warn', 'error')),
  kind      text not null check (length(btrim(kind)) > 0),
  message   text not null,
  detail    jsonb not null default '{}'::jsonb
);
create index paper_events_at_idx on public.paper_events (at desc);

alter table public.paper_runs             enable row level security;
alter table public.paper_positions        enable row level security;
alter table public.paper_trades           enable row level security;
alter table public.paper_equity_snapshots enable row level security;
alter table public.paper_events           enable row level security;
revoke all on public.paper_runs, public.paper_positions, public.paper_trades, public.paper_equity_snapshots, public.paper_events from anon, authenticated;

-- ------------------------------------------------------------------------------------------------------- paper_start_run
-- Atomically archives the active run (unless p_only_if_none) and creates a new one.
create or replace function public.paper_start_run(p_actor text, p_starting numeric, p_config jsonb, p_only_if_none boolean)
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
  perform pg_advisory_xact_lock(hashtext('paper_start_run'));
  select id into old_id from public.paper_runs where is_active for update;
  if old_id is not null and p_only_if_none then
    return jsonb_build_object('ok', true, 'created', false, 'run_id', old_id);
  end if;
  if old_id is not null then
    update public.paper_runs set is_active = false, ended_at = now() where id = old_id;
  end if;
  insert into public.paper_runs (created_by, starting_usd, cash_usd, config)
  values (p_actor, p_starting, p_starting, p_config)
  returning id into new_id;
  insert into public.paper_events (run_id, kind, message, detail)
  values (new_id, case when old_id is null then 'start' else 'reset' end,
          case when old_id is null then 'Paper run started (paper money, not real).' else 'Paper run reset: previous run archived, new run started (paper money, not real).' end,
          jsonb_build_object('actor', p_actor, 'previous_run', old_id, 'starting_usd', p_starting, 'config', p_config));
  return jsonb_build_object('ok', true, 'created', true, 'run_id', new_id, 'previous_run', old_id);
end;
$$;

-- ------------------------------------------------------------------------------------------------------- paper_set_paused
create or replace function public.paper_set_paused(p_actor text, p_paused boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  rid uuid;
begin
  update public.paper_runs set paused = p_paused where is_active returning id into rid;
  if rid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_active_run');
  end if;
  insert into public.paper_events (run_id, kind, message, detail)
  values (rid, case when p_paused then 'pause' else 'resume' end, case when p_paused then 'Paper trading paused by admin.' else 'Paper trading resumed by admin.' end, jsonb_build_object('actor', p_actor));
  return jsonb_build_object('ok', true, 'run_id', rid, 'paused', p_paused);
end;
$$;

-- ------------------------------------------------------------------------------------------------------- paper_apply_tick
-- Atomically applies one planned tick (computed and unit-tested in lib/paper/engine.ts). The run row is locked, so two
-- concurrent invocations are serialised; the (run_id, candle_start) unique key makes each candle apply exactly once, and a
-- state check refuses a plan computed from stale balances.
create or replace function public.paper_apply_tick(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r        public.paper_runs%rowtype;
  v_candle timestamptz := (p->>'candle_start')::timestamptz;
  t        jsonb := p->'trade';
  b        jsonb := p->'bench';
  v_pos    uuid;
  v_cash   numeric(20,2) := (p->>'cash_usd')::numeric;
  v_qty    numeric(20,8) := (p->>'qty_btc')::numeric;
  v_fees   numeric(20,2) := (p->>'fees_paid_usd')::numeric;
  v_pos_id uuid;
begin
  select * into r from public.paper_runs where id = (p->>'run_id')::uuid for update;
  if not found then return jsonb_build_object('ok', false, 'applied', false, 'reason', 'run_not_found'); end if;
  if not r.is_active then return jsonb_build_object('ok', false, 'applied', false, 'reason', 'run_inactive'); end if;
  if r.paused then return jsonb_build_object('ok', true, 'applied', false, 'reason', 'paused'); end if;
  if exists (select 1 from public.paper_equity_snapshots where run_id = r.id and candle_start = v_candle) then
    return jsonb_build_object('ok', true, 'applied', false, 'reason', 'duplicate_candle');
  end if;
  if r.last_candle_at is not null and r.last_candle_at >= v_candle then
    return jsonb_build_object('ok', true, 'applied', false, 'reason', 'out_of_order');
  end if;
  if r.cash_usd <> (p->>'expected_cash')::numeric or r.qty_btc <> (p->>'expected_qty')::numeric then
    return jsonb_build_object('ok', false, 'applied', false, 'reason', 'stale_state');
  end if;
  if v_cash < 0 or v_qty < 0 then return jsonb_build_object('ok', false, 'applied', false, 'reason', 'negative_balance'); end if;

  if r.bench_entry_at is null and b is not null and jsonb_typeof(b) = 'object' then
    update public.paper_runs
       set bench_entry_at = (p->>'price_time')::timestamptz, bench_entry_price = (b->>'entry_price')::numeric,
           bench_qty_btc = (b->>'qty_btc')::numeric, bench_cash_usd = (b->>'cash_usd')::numeric
     where id = r.id;
  end if;

  if t is not null and jsonb_typeof(t) = 'object' then
    if t->>'side' = 'buy' then
      insert into public.paper_positions (run_id, opened_at, qty_btc, entry_price, cost_usd)
      values (r.id, now(), (t->>'qty_btc')::numeric, (t->>'fill_price')::numeric, (t->>'notional_usd')::numeric + (t->>'fee_usd')::numeric)
      returning id into v_pos_id;
    else
      update public.paper_positions
         set status = 'closed', closed_at = now(), exit_price = (t->>'fill_price')::numeric,
             proceeds_usd = (t->>'notional_usd')::numeric - (t->>'fee_usd')::numeric,
             pnl_usd = (t->>'notional_usd')::numeric - (t->>'fee_usd')::numeric - cost_usd
       where run_id = r.id and status = 'open'
       returning id into v_pos_id;
    end if;
    insert into public.paper_trades (run_id, position_id, candle_start, side, qty_btc, ref_price, fill_price, notional_usd, fee_usd, slippage_usd,
                                     cash_after_usd, qty_after_btc, price_source, price_time, reason)
    values (r.id, v_pos_id, v_candle, t->>'side', (t->>'qty_btc')::numeric, (t->>'ref_price')::numeric, (t->>'fill_price')::numeric,
            (t->>'notional_usd')::numeric, (t->>'fee_usd')::numeric, (t->>'slippage_usd')::numeric, v_cash, v_qty,
            p->>'price_source', (p->>'price_time')::timestamptz, p->>'reason');
  end if;

  insert into public.paper_equity_snapshots (run_id, candle_start, price, price_source, price_time, candle_close, sma_fast, sma_slow, signal, action, reason,
                                             cash_usd, qty_btc, fees_paid_usd, equity_usd, bench_equity_usd)
  values (r.id, v_candle, (p->>'price')::numeric, p->>'price_source', (p->>'price_time')::timestamptz, (p->>'candle_close')::numeric,
          (p->>'sma_fast')::numeric, (p->>'sma_slow')::numeric, p->>'signal', p->>'action', p->>'reason',
          v_cash, v_qty, v_fees, (p->>'equity_usd')::numeric, (p->>'bench_equity_usd')::numeric);

  update public.paper_runs set cash_usd = v_cash, qty_btc = v_qty, fees_paid_usd = v_fees, last_candle_at = v_candle where id = r.id;
  return jsonb_build_object('ok', true, 'applied', true, 'action', p->>'action');
end;
$$;

revoke all on function public.paper_start_run(text, numeric, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.paper_set_paused(text, boolean)                from public, anon, authenticated;
revoke all on function public.paper_apply_tick(jsonb)                        from public, anon, authenticated;
grant execute on function public.paper_start_run(text, numeric, jsonb, boolean) to service_role;
grant execute on function public.paper_set_paused(text, boolean)                to service_role;
grant execute on function public.paper_apply_tick(jsonb)                        to service_role;
