-- BTC Network AI: Phase 3 — worker command queue + transactional RPCs used by the Cloudflare ingest Worker.
-- Access model is unchanged: RLS on, no anon/authenticated access. Only service_role (server key) can read/write
-- or execute the functions below.

alter table public.workers add column if not exists hardware jsonb not null default '{}'::jsonb;
comment on column public.workers.hardware is 'Self-reported hardware info from enrollment (cpu model/cores/memory/gpu/arch). Informational only.';

-- ---------------------------------------------------------- worker_commands
create table public.worker_commands (
  id                 uuid primary key default gen_random_uuid(),
  worker_id          uuid not null references public.workers (id) on delete cascade,
  owner_id           text not null,
  command            text not null check (command in ('start', 'pause', 'stop')),
  status             text not null default 'pending' check (status in ('pending', 'acked', 'cancelled', 'expired')),
  created_by         text not null,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '1 hour'),
  first_delivered_at timestamptz,
  acked_at           timestamptz,
  constraint worker_commands_expiry_after_create check (expires_at > created_at),
  constraint worker_commands_ack_consistent check ((status = 'acked') = (acked_at is not null))
);
comment on table public.worker_commands is 'Operator commands (start/pause/stop) queued for a worker agent; delivered via the signed GET /v1/commands poll.';
create index worker_commands_worker_status_idx on public.worker_commands (worker_id, status, created_at);
create index worker_commands_owner_id_idx on public.worker_commands (owner_id);

alter table public.worker_commands enable row level security;
revoke all on public.worker_commands from anon, authenticated;

-- ------------------------------------------------------------ enroll_worker
-- Atomically: validate+consume a hashed one-time code, create the worker + credential, audit. All or nothing.
create or replace function public.enroll_worker(
  p_code_hash        text,
  p_public_key       text,
  p_name             text,
  p_hardware_type    text,
  p_os               text,
  p_software_version text,
  p_hardware         jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_code   public.worker_enrollment_codes%rowtype;
  v_worker uuid;
  v_name   text := btrim(p_name);
  v_try    int := 0;
begin
  select * into v_code from public.worker_enrollment_codes where code_hash = p_code_hash for update;
  if not found or v_code.used_at is not null or v_code.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  -- (owner_id, name) is unique: suffix on collision.
  while exists (select 1 from public.workers w where w.owner_id = v_code.owner_id and w.name = v_name) and v_try < 50 loop
    v_try := v_try + 1;
    v_name := left(btrim(p_name), 56) || '-' || (v_try + 1)::text;
  end loop;

  insert into public.workers (owner_id, name, os, hardware_type, status, software_version, authorized_at, hardware)
  values (v_code.owner_id, v_name, p_os, p_hardware_type, 'offline', p_software_version, now(), coalesce(p_hardware, '{}'::jsonb))
  returning id into v_worker;

  insert into public.worker_credentials (worker_id, public_key) values (v_worker, p_public_key);

  update public.worker_enrollment_codes set used_at = now(), used_by_worker_id = v_worker where id = v_code.id;

  insert into public.audit_log (actor, action, entity_type, entity_id, details)
  values ('ingest-worker', 'worker.enrolled', 'worker', v_worker::text,
          jsonb_build_object('owner_id', v_code.owner_id, 'name', v_name, 'hardware_type', p_hardware_type, 'code_id', v_code.id));

  return jsonb_build_object('ok', true, 'worker_id', v_worker, 'name', v_name);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'conflict');
end;
$$;

-- --------------------------------------------------------- ingest_telemetry
create or replace function public.ingest_telemetry(
  p_worker_id        uuid,
  p_rows             jsonb,
  p_uptime_s         bigint,
  p_software_version text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_count  int;
  v_latest numeric;
begin
  insert into public.telemetry_1m as t (worker_id, bucket_start, avg_hashrate_hs, accepted, rejected, difficulty, temperature_c)
  select p_worker_id, r.bucket_start, r.avg_hashrate_hs, r.accepted, r.rejected, r.difficulty, r.temperature_c
  from jsonb_to_recordset(p_rows) as r(
    bucket_start timestamptz, avg_hashrate_hs numeric, accepted bigint, rejected bigint, difficulty numeric, temperature_c numeric
  )
  on conflict (worker_id, bucket_start) do update set
    avg_hashrate_hs = excluded.avg_hashrate_hs,
    accepted        = excluded.accepted,
    rejected        = excluded.rejected,
    difficulty      = excluded.difficulty,
    temperature_c   = excluded.temperature_c;
  get diagnostics v_count = row_count;

  select r.avg_hashrate_hs into v_latest
  from jsonb_to_recordset(p_rows) as r(bucket_start timestamptz, avg_hashrate_hs numeric)
  order by r.bucket_start desc limit 1;

  update public.workers w set
    last_seen_at        = now(),
    status              = case when w.authorized_at is not null and w.status in ('pending', 'offline', 'online') then 'online' else w.status end,
    current_hashrate_hs = coalesce(v_latest, w.current_hashrate_hs),
    uptime_s            = coalesce(p_uptime_s, w.uptime_s),
    software_version    = coalesce(p_software_version, w.software_version)
  where w.id = p_worker_id;

  return jsonb_build_object('ok', true, 'upserted', v_count);
end;
$$;

-- ------------------------------------------------------ claim / ack commands
create or replace function public.claim_worker_commands(p_worker_id uuid, p_limit int)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  update public.worker_commands set status = 'expired' where worker_id = p_worker_id and status = 'pending' and expires_at <= now();

  with picked as (
    select c.id from public.worker_commands c
    where c.worker_id = p_worker_id and c.status = 'pending' and c.expires_at > now()
    order by c.created_at asc limit greatest(1, least(coalesce(p_limit, 10), 50))
  ), upd as (
    update public.worker_commands c set first_delivered_at = coalesce(c.first_delivered_at, now())
    from picked where c.id = picked.id
    returning c.id, c.command, c.created_at, c.expires_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'command', command, 'created_at', created_at, 'expires_at', expires_at) order by created_at), '[]'::jsonb)
  into v_out from upd;
  return v_out;
end;
$$;

create or replace function public.ack_worker_commands(p_worker_id uuid, p_ids uuid[])
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ack  int;
  v_last text;
begin
  with a as (
    update public.worker_commands set status = 'acked', acked_at = now()
    where worker_id = p_worker_id and id = any (p_ids) and status = 'pending'
    returning command, created_at
  )
  select count(*)::int, (array_agg(command order by created_at desc))[1] into v_ack, v_last from a;

  if v_ack > 0 then
    update public.workers w set status = case v_last
        when 'pause' then 'paused'
        when 'stop'  then 'offline'
        when 'start' then case when w.authorized_at is not null and w.status <> 'revoked' then 'online' else w.status end
        else w.status end
    where w.id = p_worker_id and w.status <> 'revoked';
    insert into public.audit_log (actor, action, entity_type, entity_id, details)
    values ('ingest-worker', 'worker.commands_acked', 'worker', p_worker_id::text, jsonb_build_object('count', v_ack, 'last_command', v_last));
  end if;
  return jsonb_build_object('ok', true, 'acked', v_ack);
end;
$$;

-- Only the server (service_role) may call these.
revoke all on function public.enroll_worker(text, text, text, text, text, text, jsonb)  from public, anon, authenticated;
revoke all on function public.ingest_telemetry(uuid, jsonb, bigint, text)               from public, anon, authenticated;
revoke all on function public.claim_worker_commands(uuid, int)                           from public, anon, authenticated;
revoke all on function public.ack_worker_commands(uuid, uuid[])                          from public, anon, authenticated;
grant execute on function public.enroll_worker(text, text, text, text, text, text, jsonb)  to service_role;
grant execute on function public.ingest_telemetry(uuid, jsonb, bigint, text)               to service_role;
grant execute on function public.claim_worker_commands(uuid, int)                           to service_role;
grant execute on function public.ack_worker_commands(uuid, uuid[])                          to service_role;
