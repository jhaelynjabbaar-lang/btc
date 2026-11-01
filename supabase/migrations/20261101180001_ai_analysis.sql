-- BTC Network AI: Phase 7 — AI analysis layer (recommendations only; a human decides).
-- ADDITIVE ONLY: new nullable/defaulted columns on ai_recommendations, one partial unique index, two new functions.
-- Nothing is dropped, renamed or rewritten, and no existing constraint is altered. Access model is unchanged: RLS stays on,
-- anon/authenticated have no access; only the server (Supabase secret key / service_role) can execute the functions below.
--
-- Column mapping for ai_recommendations (the Phase 2 columns are reused, not duplicated):
--   type         = kind          ('worker_health' | 'efficiency' | 'cloud_spend')
--   rationale    = explanation
--   evidence     = inputs        (the exact facts/metrics the model was shown and cited)
--   model        = model
--   created_at   = created_at
--   status       = status        stored as the Phase 2 vocabulary: pending / approved / rejected, shown in the app as
--                                proposed / accepted / dismissed (the existing CHECK constraints are left untouched).
--   NEW: severity, title, suggested_action, run_id, job, dedupe_key

alter table public.ai_recommendations
  add column if not exists severity         text    not null default 'info',
  add column if not exists title            text,
  add column if not exists suggested_action jsonb   not null default '{"kind":"none"}'::jsonb,
  add column if not exists run_id           uuid,
  add column if not exists job              text,
  add column if not exists dedupe_key       text;

alter table public.ai_recommendations
  add constraint ai_recommendations_severity_check check (severity in ('info', 'warning', 'critical')),
  add constraint ai_recommendations_action_kind_check check (suggested_action ->> 'kind' in ('none', 'worker_command', 'review_cloud'));

comment on column public.ai_recommendations.kind is 'Recommendation type: worker_health | efficiency | cloud_spend (Phase 7), or general (older rows).';
comment on column public.ai_recommendations.explanation is 'Rationale written by the model, restricted to numbers present in the evidence.';
comment on column public.ai_recommendations.inputs is 'Evidence: the exact facts (metric, value, unit) the model was given and cited. Resolved server-side, never model-supplied.';
comment on column public.ai_recommendations.status is 'pending = proposed, approved = accepted by an admin, rejected = dismissed by an admin. Nothing executes without the admin click.';
comment on column public.ai_recommendations.suggested_action is 'One of {"kind":"none"} | {"kind":"worker_command","worker_id":uuid,"command":"start|pause|stop"} | {"kind":"review_cloud"}. Only worker_command can ever create anything, and only via ai_decide_recommendation(accept, confirm = true).';
comment on column public.ai_recommendations.dedupe_key is 'Stable key over (type, subject ids, metrics) so a repeated run does not stack identical open proposals.';

create unique index if not exists ai_recommendations_open_dedupe_key
  on public.ai_recommendations (owner_id, dedupe_key) where status = 'pending' and dedupe_key is not null;
create index if not exists ai_recommendations_run_id_idx on public.ai_recommendations (run_id);

-- ---------------------------------------------------------------------------------------------- telemetry aggregates
-- Read-only per-worker aggregates over telemetry_1m: a recent window and the worker's own earlier baseline. Aggregation happens
-- in SQL so the app never pulls raw minute rows. Revoked workers are excluded.
create or replace function public.ai_worker_aggregates(p_now timestamptz, p_recent_minutes int, p_baseline_days int)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(a)::jsonb), '[]'::jsonb)
  from (
    select
      t.worker_id,
      count(*) filter (where t.bucket_start >= p_now - make_interval(mins => p_recent_minutes))                                                        as recent_buckets,
      avg(t.avg_hashrate_hs) filter (where t.bucket_start >= p_now - make_interval(mins => p_recent_minutes))                                          as recent_avg_hs,
      coalesce(sum(t.accepted) filter (where t.bucket_start >= p_now - make_interval(mins => p_recent_minutes)), 0)                                    as recent_accepted,
      coalesce(sum(t.rejected) filter (where t.bucket_start >= p_now - make_interval(mins => p_recent_minutes)), 0)                                    as recent_rejected,
      max(t.temperature_c) filter (where t.bucket_start >= p_now - make_interval(mins => p_recent_minutes))                                           as recent_max_temp_c,
      count(*) filter (where t.bucket_start < p_now - make_interval(mins => p_recent_minutes))                                                         as base_buckets,
      avg(t.avg_hashrate_hs) filter (where t.bucket_start < p_now - make_interval(mins => p_recent_minutes))                                           as base_avg_hs,
      coalesce(sum(t.accepted) filter (where t.bucket_start < p_now - make_interval(mins => p_recent_minutes)), 0)                                     as base_accepted,
      coalesce(sum(t.rejected) filter (where t.bucket_start < p_now - make_interval(mins => p_recent_minutes)), 0)                                     as base_rejected,
      max(t.bucket_start)                                                                                                                              as last_bucket
    from public.telemetry_1m t
    join public.workers w on w.id = t.worker_id and w.status <> 'revoked'
    where t.bucket_start >= p_now - make_interval(days => p_baseline_days) and t.bucket_start <= p_now
    group by t.worker_id
  ) a;
$$;

-- ---------------------------------------------------------------------------------------------- accept / dismiss
-- The ONLY way a recommendation changes state. One transaction: lock the row, change status, (for an accepted worker_command
-- suggestion) queue a NORMAL worker_commands row exactly like the Workers page does, and write audit_log.
-- Accepting requires p_confirm = true. Dismissing needs no confirmation (it changes nothing but the recommendation).
-- Cloud suggestions never create anything: accepting only marks them reviewed. This function never touches cloud_resources,
-- spend_limits, ledger or any money.
create or replace function public.ai_decide_recommendation(p_owner text, p_id uuid, p_decision text, p_confirm boolean, p_actor text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r        public.ai_recommendations%rowtype;
  v_action jsonb;
  v_wid    uuid;
  v_cmd    text;
  w        public.workers%rowtype;
  v_cmd_id uuid;
  v_exp    timestamptz;
begin
  if p_decision not in ('accept', 'dismiss') then return jsonb_build_object('ok', false, 'reason', 'invalid_decision'); end if;
  if p_decision = 'accept' and p_confirm is distinct from true then return jsonb_build_object('ok', false, 'reason', 'confirmation_required'); end if;

  select * into r from public.ai_recommendations where id = p_id and owner_id = p_owner for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if r.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;

  if p_decision = 'dismiss' then
    update public.ai_recommendations set status = 'rejected', decided_at = now(), decided_by = p_actor where id = r.id;
    insert into public.audit_log (actor, action, entity_type, entity_id, details)
    values (p_actor, 'ai.recommendation.dismissed', 'ai_recommendation', r.id::text, jsonb_build_object('kind', r.kind, 'severity', r.severity));
    return jsonb_build_object('ok', true, 'status', 'dismissed');
  end if;

  v_action := r.suggested_action;
  if v_action ->> 'kind' = 'worker_command' then
    v_cmd := v_action ->> 'command';
    if v_cmd is null or v_cmd not in ('start', 'pause', 'stop') then return jsonb_build_object('ok', false, 'reason', 'invalid_action'); end if;
    if coalesce(v_action ->> 'worker_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('ok', false, 'reason', 'invalid_action');
    end if;
    v_wid := (v_action ->> 'worker_id')::uuid;
    select * into w from public.workers where id = v_wid;
    if not found then return jsonb_build_object('ok', false, 'reason', 'worker_not_found'); end if;
    if w.status = 'revoked' then return jsonb_build_object('ok', false, 'reason', 'worker_revoked'); end if;
    if exists (select 1 from public.worker_commands c where c.worker_id = v_wid and c.command = v_cmd and c.status = 'pending' and c.expires_at > now()) then
      return jsonb_build_object('ok', false, 'reason', 'duplicate_command');
    end if;
    insert into public.worker_commands (worker_id, owner_id, command, created_by)
    values (v_wid, w.owner_id, v_cmd, p_actor) returning id, expires_at into v_cmd_id, v_exp;
    insert into public.audit_log (actor, action, entity_type, entity_id, details)
    values (p_actor, 'worker_command.queued', 'worker', v_wid::text, jsonb_build_object('command', v_cmd, 'command_id', v_cmd_id, 'via', 'ai_recommendation', 'recommendation_id', r.id));
  end if;

  update public.ai_recommendations set status = 'approved', decided_at = now(), decided_by = p_actor where id = r.id;
  insert into public.audit_log (actor, action, entity_type, entity_id, details)
  values (p_actor, 'ai.recommendation.accepted', 'ai_recommendation', r.id::text,
          jsonb_build_object('kind', r.kind, 'severity', r.severity, 'action', v_action ->> 'kind', 'command_id', v_cmd_id));
  return jsonb_build_object('ok', true, 'status', 'accepted', 'command_id', v_cmd_id, 'expires_at', v_exp);
end;
$$;

revoke all on function public.ai_worker_aggregates(timestamptz, int, int)                  from public, anon, authenticated;
revoke all on function public.ai_decide_recommendation(text, uuid, text, boolean, text)     from public, anon, authenticated;
grant execute on function public.ai_worker_aggregates(timestamptz, int, int)                to service_role;
grant execute on function public.ai_decide_recommendation(text, uuid, text, boolean, text)  to service_role;
