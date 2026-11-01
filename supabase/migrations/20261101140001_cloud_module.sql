-- BTC Network AI: Phase 6 — cloud provider management (registry, approval workflow, spend guard, kill switch).
-- ADDITIVE ONLY: new columns on cloud_providers / cloud_resources, one new table (cloud_controls), new functions and seed rows.
-- Nothing existing is dropped or rewritten. Access model is unchanged: RLS on, no anon/authenticated access; only the
-- server (Supabase secret key / service_role) can read, write or execute the functions below.
-- No purchase, provisioning or account creation happens here. This only records policy facts and gates future actions.

-- --------------------------------------------------------------- cloud_providers (registry columns)
alter table public.cloud_providers
  add column if not exists slug                       text,
  add column if not exists mining_policy              text not null default 'unknown',
  add column if not exists policy_url                 text,
  add column if not exists policy_quote               text,
  add column if not exists last_verified_on           date,
  add column if not exists notes                      text,
  add column if not exists adapter                    text not null default 'manual',
  add column if not exists pricing_url                text,
  add column if not exists written_permission_ref     text,
  add column if not exists conditions_acknowledged_at timestamptz;

alter table public.cloud_providers
  add constraint cloud_providers_mining_policy_check
    check (mining_policy in ('allowed', 'allowed_with_conditions', 'requires_written_permission', 'prohibited', 'unknown')),
  add constraint cloud_providers_adapter_check check (adapter in ('manual', 'rentgpupower_catalog')),
  add constraint cloud_providers_slug_key unique (slug),
  -- Anything other than 'unknown' must carry its evidence: the official policy URL and the date it was last read.
  add constraint cloud_providers_policy_needs_evidence
    check (mining_policy = 'unknown' or (policy_url is not null and last_verified_on is not null));

comment on column public.cloud_providers.mining_policy is 'What the provider''s own terms say about cryptocurrency mining. prohibited/unknown are blocked from provisioning in code AND in cloud_transition.';
comment on column public.cloud_providers.written_permission_ref is 'Owner-recorded reference (ticket id / email date) to written permission. Required for requires_written_permission providers before anything can be approved.';
comment on column public.cloud_providers.conditions_acknowledged_at is 'Set by the owner to confirm they read and will follow the provider''s mining conditions. Required for allowed_with_conditions.';

-- --------------------------------------------------------------- cloud_resources (approval workflow columns)
alter table public.cloud_resources
  add column if not exists state              text not null default 'pending_approval',
  add column if not exists label              text,
  add column if not exists adapter            text not null default 'manual',
  add column if not exists request_kind       text not null default 'register_manual',
  add column if not exists cost_known         boolean not null default false,
  add column if not exists price_source_url   text,
  add column if not exists price_note         text,
  add column if not exists requested_by       text,
  add column if not exists decided_by         text,
  add column if not exists decided_at         timestamptz,
  add column if not exists state_changed_at   timestamptz not null default now();

alter table public.cloud_resources
  add constraint cloud_resources_state_check
    check (state in ('pending_approval', 'approved', 'rejected', 'provisioning', 'running', 'stopped', 'destroyed')),
  add constraint cloud_resources_request_kind_check check (request_kind in ('register_manual', 'provision')),
  -- A price is only "known" when it cites the provider's published source. Unknown cost is stored as 0 with cost_known = false.
  add constraint cloud_resources_known_cost_has_source
    check (not cost_known or (price_source_url is not null and price_source_url ~ '^https://')),
  add constraint cloud_resources_active_state_authorized
    check (state not in ('approved', 'provisioning', 'running') or authorization_status = 'authorized');

comment on column public.cloud_resources.state is 'Approval lifecycle. New rows are ALWAYS pending_approval; only cloud_transition moves them.';
comment on column public.cloud_resources.hourly_price_usd is 'Estimated hourly price from the provider''s published price. 0 with cost_known = false means UNKNOWN, not free.';
create index if not exists cloud_resources_state_idx on public.cloud_resources (owner_id, state);

-- --------------------------------------------------------------- cloud_controls (kill switch)
create table public.cloud_controls (
  owner_id            text primary key,
  kill_switch_engaged boolean not null default false,
  changed_at          timestamptz not null default now(),
  changed_by          text
);
comment on table public.cloud_controls is 'Per-owner cloud controls. kill_switch_engaged blocks every approve/activate/start until the owner re-arms it.';
alter table public.cloud_controls enable row level security;
revoke all on public.cloud_controls from anon, authenticated;

-- --------------------------------------------------------------- state machine
create or replace function public.cloud_event_target(p_event text)
returns text language sql immutable set search_path = '' as $$
  select case p_event
    when 'approve'         then 'approved'
    when 'reject'          then 'rejected'
    when 'activate'        then 'provisioning'
    when 'confirm_running' then 'running'
    when 'start'           then 'running'
    when 'stop'            then 'stopped'
    when 'destroy'         then 'destroyed'
    when 'kill'            then null  -- target depends on the current state (see cloud_transition)
    else null end;
$$;

-- Allowed (from -> to) pairs. Terminal states (rejected, destroyed) have no exits.
create or replace function public.cloud_transition_allowed(p_from text, p_to text)
returns boolean language sql immutable set search_path = '' as $$
  select (p_from, p_to) in (
    ('pending_approval', 'approved'),
    ('pending_approval', 'rejected'),
    ('approved',         'provisioning'),
    ('approved',         'destroyed'),
    ('provisioning',     'running'),
    ('provisioning',     'stopped'),
    ('provisioning',     'destroyed'),
    ('running',          'stopped'),
    ('running',          'destroyed'),
    ('stopped',          'running'),
    ('stopped',          'destroyed')
  );
$$;

-- Does the provider's mining policy let anything be approved/activated right now? Returns null when OK, else a reason code.
create or replace function public.cloud_policy_block(p_provider uuid)
returns text language plpgsql stable set search_path = '' as $$
declare v public.cloud_providers%rowtype;
begin
  select * into v from public.cloud_providers where id = p_provider;
  if not found then return 'provider_not_found'; end if;
  return case v.mining_policy
    when 'allowed' then null
    when 'allowed_with_conditions' then case when v.conditions_acknowledged_at is null then 'conditions_not_acknowledged' end
    when 'requires_written_permission' then case when coalesce(btrim(v.written_permission_ref), '') = '' then 'written_permission_missing' end
    when 'prohibited' then 'policy_prohibited'
    else 'policy_unknown' end;
end;
$$;

-- Spend guard. All caps default to 0 (a missing or disabled limit row means 0): nothing can be spent until the owner sets limits.
-- Projection = hourly price x 730 h for every resource that is approved, provisioning or running.
create or replace function public.cloud_spend_check(
  p_owner text, p_provider uuid, p_hourly numeric, p_cost_known boolean, p_exclude uuid
) returns jsonb language plpgsql stable set search_path = '' as $$
declare
  c_hours constant numeric := 730;
  v_cap_hour   numeric;
  v_cap_g      numeric;
  v_cap_p      numeric;
  v_used_g     numeric;
  v_used_p     numeric;
begin
  if not coalesce(p_cost_known, false) then
    return jsonb_build_object('ok', false, 'reason', 'cost_unknown',
      'detail', 'The hourly price is unknown, so no cap can be checked. Cite the provider''s published price to proceed.');
  end if;

  -- Per-resource hourly cap: the smallest enabled hour limit that applies (global, or this provider's). None = 0.
  select coalesce(min(limit_usd), 0) into v_cap_hour from public.spend_limits
   where owner_id = p_owner and enabled and period = 'hour' and (scope = 'global' or provider_id = p_provider);
  if p_hourly > v_cap_hour then
    return jsonb_build_object('ok', false, 'reason', 'hourly_cap_exceeded', 'cap_usd', v_cap_hour, 'requested_usd', p_hourly);
  end if;

  select coalesce(max(limit_usd), 0) into v_cap_g from public.spend_limits
   where owner_id = p_owner and enabled and period = 'month' and scope = 'global';
  select coalesce(max(limit_usd), 0) into v_cap_p from public.spend_limits
   where owner_id = p_owner and enabled and period = 'month' and scope = 'provider' and provider_id = p_provider;

  select coalesce(sum(hourly_price_usd * c_hours), 0) into v_used_g from public.cloud_resources
   where owner_id = p_owner and state in ('approved', 'provisioning', 'running') and id is distinct from p_exclude;
  select coalesce(sum(hourly_price_usd * c_hours), 0) into v_used_p from public.cloud_resources
   where owner_id = p_owner and provider_id = p_provider and state in ('approved', 'provisioning', 'running') and id is distinct from p_exclude;

  if v_used_g + p_hourly * c_hours > v_cap_g then
    return jsonb_build_object('ok', false, 'reason', 'global_monthly_cap_exceeded', 'cap_usd', v_cap_g,
      'committed_usd', round(v_used_g, 2), 'requested_usd', round(p_hourly * c_hours, 2));
  end if;
  if v_used_p + p_hourly * c_hours > v_cap_p then
    return jsonb_build_object('ok', false, 'reason', 'provider_monthly_cap_exceeded', 'cap_usd', v_cap_p,
      'committed_usd', round(v_used_p, 2), 'requested_usd', round(p_hourly * c_hours, 2));
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- --------------------------------------------------------------- request a resource (always pending_approval)
create or replace function public.cloud_request_resource(
  p_owner text, p_provider uuid, p_label text, p_instance_id text, p_request_kind text, p_capacity jsonb,
  p_hourly numeric, p_cost_known boolean, p_price_source_url text, p_price_note text, p_actor text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  v_prov  public.cloud_providers%rowtype;
  v_id    uuid := gen_random_uuid();
  v_known boolean := coalesce(p_cost_known, false) and p_hourly is not null and p_price_source_url is not null;
  v_ctrl  boolean;
begin
  select * into v_prov from public.cloud_providers where id = p_provider;
  if not found then return jsonb_build_object('ok', false, 'reason', 'provider_not_found'); end if;
  -- prohibited / unknown providers never get a row at all.
  if v_prov.mining_policy in ('prohibited', 'unknown') then
    insert into public.audit_log (actor, action, entity_type, entity_id, details)
    values (p_actor, 'cloud_resource.request_blocked', 'cloud_provider', p_provider::text,
            jsonb_build_object('reason', 'policy_' || v_prov.mining_policy, 'label', p_label));
    return jsonb_build_object('ok', false, 'reason', 'policy_' || v_prov.mining_policy);
  end if;
  select kill_switch_engaged into v_ctrl from public.cloud_controls where owner_id = p_owner;
  if coalesce(v_ctrl, false) then return jsonb_build_object('ok', false, 'reason', 'kill_switch_engaged'); end if;

  insert into public.cloud_resources (
    id, owner_id, provider_id, instance_id, capacity, hourly_price_usd, status, authorization_status,
    state, label, adapter, request_kind, cost_known, price_source_url, price_note, requested_by)
  values (
    v_id, p_owner, p_provider, coalesce(nullif(btrim(p_instance_id), ''), 'pending-' || v_id::text), coalesce(p_capacity, '{}'::jsonb),
    case when v_known then p_hourly else 0 end, 'unknown', 'pending',
    'pending_approval', nullif(btrim(p_label), ''), v_prov.adapter, p_request_kind, v_known,
    case when v_known then p_price_source_url end, nullif(btrim(p_price_note), ''), p_actor);

  insert into public.audit_log (actor, action, entity_type, entity_id, details)
  values (p_actor, 'cloud_resource.requested', 'cloud_resource', v_id::text,
          jsonb_build_object('provider_id', p_provider, 'state', 'pending_approval', 'request_kind', p_request_kind,
                             'cost_known', v_known, 'hourly_usd', case when v_known then p_hourly end,
                             'price_source_url', case when v_known then p_price_source_url end));
  return jsonb_build_object('ok', true, 'id', v_id, 'state', 'pending_approval');
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'duplicate_instance');
end;
$$;

-- --------------------------------------------------------------- the only way a resource changes state
create or replace function public.cloud_transition(p_id uuid, p_event text, p_actor text, p_note text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  r        public.cloud_resources%rowtype;
  v_to     text := public.cloud_event_target(p_event);
  v_block  text;
  v_spend  jsonb;
  v_ctrl   boolean;
begin
  if p_event not in ('approve', 'reject', 'activate', 'confirm_running', 'start', 'stop', 'destroy', 'kill') then
    return jsonb_build_object('ok', false, 'reason', 'unknown_event');
  end if;
  select * into r from public.cloud_resources where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  if p_event = 'kill' then
    -- pending -> rejected; approved but never activated -> destroyed (nothing exists to stop); provisioning/running -> stopped.
    v_to := case r.state when 'pending_approval' then 'rejected' when 'approved' then 'destroyed' else 'stopped' end;
  end if;
  if not public.cloud_transition_allowed(r.state, v_to) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_transition', 'from', r.state, 'event', p_event);
  end if;

  -- Entering an active state needs everything to line up, checked here as well as in the app (defense in depth).
  if v_to in ('approved', 'provisioning', 'running') then
    select kill_switch_engaged into v_ctrl from public.cloud_controls where owner_id = r.owner_id;
    if coalesce(v_ctrl, false) then return jsonb_build_object('ok', false, 'reason', 'kill_switch_engaged'); end if;
    v_block := public.cloud_policy_block(r.provider_id);
    if v_block is not null then return jsonb_build_object('ok', false, 'reason', v_block); end if;
    if v_to <> 'approved' and r.authorization_status <> 'authorized' then
      return jsonb_build_object('ok', false, 'reason', 'not_approved');
    end if;
    v_spend := public.cloud_spend_check(r.owner_id, r.provider_id, r.hourly_price_usd, r.cost_known, r.id);
    if not (v_spend ->> 'ok')::boolean then return v_spend; end if;
  end if;

  update public.cloud_resources set
    state = v_to,
    state_changed_at = now(),
    authorization_status = case
      when v_to = 'approved' then 'authorized'
      when v_to = 'rejected' then 'denied'
      when p_event = 'kill' or v_to = 'destroyed' then 'revoked'
      else authorization_status end,
    authorized_at = case when v_to = 'approved' then now() else authorized_at end,
    decided_by = case when v_to in ('approved', 'rejected') then p_actor else decided_by end,
    decided_at = case when v_to in ('approved', 'rejected') then now() else decided_at end,
    status = case v_to
      when 'provisioning' then 'provisioning' when 'running' then 'running'
      when 'stopped' then 'stopped' when 'destroyed' then 'terminated' else status end
  where id = r.id;

  insert into public.audit_log (actor, action, entity_type, entity_id, details)
  values (p_actor, 'cloud_resource.' || p_event, 'cloud_resource', r.id::text,
          jsonb_build_object('from', r.state, 'to', v_to, 'provider_id', r.provider_id, 'hourly_usd', r.hourly_price_usd,
                             'cost_known', r.cost_known, 'note', nullif(btrim(p_note), '')));
  return jsonb_build_object('ok', true, 'from', r.state, 'to', v_to);
end;
$$;

-- --------------------------------------------------------------- kill switch ("Stop all cloud resources")
create or replace function public.cloud_set_kill_switch(p_owner text, p_engage boolean, p_actor text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  r        public.cloud_resources%rowtype;
  v_stop   jsonb := '[]'::jsonb;
  v_reject int := 0;
begin
  insert into public.cloud_controls (owner_id, kill_switch_engaged, changed_at, changed_by)
  values (p_owner, p_engage, now(), p_actor)
  on conflict (owner_id) do update set kill_switch_engaged = excluded.kill_switch_engaged, changed_at = now(), changed_by = p_actor;

  insert into public.audit_log (actor, action, entity_type, entity_id, details)
  values (p_actor, case when p_engage then 'cloud.kill_switch_engaged' else 'cloud.kill_switch_rearmed' end, 'cloud_controls', p_owner, '{}'::jsonb);

  if p_engage then
    for r in select * from public.cloud_resources where owner_id = p_owner and state in ('pending_approval', 'approved', 'provisioning', 'running') for update loop
      if r.state = 'pending_approval' then
        v_reject := v_reject + 1;
        update public.cloud_resources set state = 'rejected', authorization_status = 'denied', state_changed_at = now(),
               decided_by = p_actor, decided_at = now() where id = r.id;
        insert into public.audit_log (actor, action, entity_type, entity_id, details)
        values (p_actor, 'cloud_resource.kill', 'cloud_resource', r.id::text, jsonb_build_object('from', r.state, 'to', 'rejected'));
      else
        -- approved but never activated -> destroyed (nothing exists to stop); provisioning/running -> stopped, authorization revoked.
        update public.cloud_resources set
               state = case when r.state = 'approved' then 'destroyed' else 'stopped' end,
               status = case when r.state = 'approved' then 'terminated' else 'stopped' end,
               authorization_status = 'revoked', state_changed_at = now() where id = r.id;
        insert into public.audit_log (actor, action, entity_type, entity_id, details)
        values (p_actor, 'cloud_resource.kill', 'cloud_resource', r.id::text,
                jsonb_build_object('from', r.state, 'to', case when r.state = 'approved' then 'destroyed' else 'stopped' end, 'adapter', r.adapter));
        if r.state in ('provisioning', 'running') then
          v_stop := v_stop || jsonb_build_array(jsonb_build_object('id', r.id, 'adapter', r.adapter, 'provider_id', r.provider_id, 'instance_id', r.instance_id));
        end if;
      end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'engaged', p_engage, 'rejected_pending', v_reject, 'needs_adapter_stop', v_stop);
end;
$$;

-- --------------------------------------------------------------- spend limits and provider attestations (audited upserts)
create or replace function public.cloud_set_spend_limit(
  p_owner text, p_scope text, p_provider uuid, p_period text, p_limit numeric, p_actor text
) returns jsonb language plpgsql set search_path = '' as $$
declare v_old numeric; v_id uuid;
begin
  if p_scope not in ('global', 'provider') or p_period not in ('hour', 'month') or p_limit is null or p_limit < 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_limit');
  end if;
  if (p_scope = 'provider') <> (p_provider is not null) then return jsonb_build_object('ok', false, 'reason', 'invalid_scope'); end if;
  if p_provider is not null and not exists (select 1 from public.cloud_providers where id = p_provider) then
    return jsonb_build_object('ok', false, 'reason', 'provider_not_found');
  end if;

  select id, limit_usd into v_id, v_old from public.spend_limits
   where owner_id = p_owner and scope = p_scope and period = p_period and provider_id is not distinct from p_provider;
  if v_id is null then
    insert into public.spend_limits (owner_id, scope, provider_id, period, limit_usd, hard_stop, enabled)
    values (p_owner, p_scope, p_provider, p_period, p_limit, true, true) returning id into v_id;
  else
    update public.spend_limits set limit_usd = p_limit, enabled = true, hard_stop = true where id = v_id;
  end if;
  insert into public.audit_log (actor, action, entity_type, entity_id, details)
  values (p_actor, 'cloud_spend_limit.set', 'spend_limit', v_id::text,
          jsonb_build_object('scope', p_scope, 'period', p_period, 'provider_id', p_provider, 'old_usd', v_old, 'new_usd', p_limit));
  return jsonb_build_object('ok', true, 'id', v_id, 'old_usd', v_old, 'new_usd', p_limit);
end;
$$;

create or replace function public.cloud_set_provider_attestation(
  p_provider uuid, p_permission_ref text, p_acknowledge boolean, p_actor text
) returns jsonb language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.cloud_providers where id = p_provider) then
    return jsonb_build_object('ok', false, 'reason', 'provider_not_found');
  end if;
  update public.cloud_providers set
    written_permission_ref = nullif(btrim(coalesce(p_permission_ref, '')), ''),
    conditions_acknowledged_at = case when p_acknowledge then coalesce(conditions_acknowledged_at, now()) else null end
  where id = p_provider;
  insert into public.audit_log (actor, action, entity_type, entity_id, details)
  values (p_actor, 'cloud_provider.attestation_set', 'cloud_provider', p_provider::text,
          jsonb_build_object('permission_ref_recorded', nullif(btrim(coalesce(p_permission_ref, '')), '') is not null, 'conditions_acknowledged', p_acknowledge));
  return jsonb_build_object('ok', true);
end;
$$;

-- Only the server (service_role) may call these.
revoke all on function public.cloud_event_target(text)                                                                    from public, anon, authenticated;
revoke all on function public.cloud_transition_allowed(text, text)                                                        from public, anon, authenticated;
revoke all on function public.cloud_policy_block(uuid)                                                                    from public, anon, authenticated;
revoke all on function public.cloud_spend_check(text, uuid, numeric, boolean, uuid)                                       from public, anon, authenticated;
revoke all on function public.cloud_request_resource(text, uuid, text, text, text, jsonb, numeric, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public.cloud_transition(uuid, text, text, text)                                                    from public, anon, authenticated;
revoke all on function public.cloud_set_kill_switch(text, boolean, text)                                                  from public, anon, authenticated;
revoke all on function public.cloud_set_spend_limit(text, text, uuid, text, numeric, text)                                from public, anon, authenticated;
revoke all on function public.cloud_set_provider_attestation(uuid, text, boolean, text)                                   from public, anon, authenticated;
grant execute on function public.cloud_event_target(text), public.cloud_transition_allowed(text, text), public.cloud_policy_block(uuid),
  public.cloud_spend_check(text, uuid, numeric, boolean, uuid),
  public.cloud_request_resource(text, uuid, text, text, text, jsonb, numeric, boolean, text, text, text),
  public.cloud_transition(uuid, text, text, text), public.cloud_set_kill_switch(text, boolean, text),
  public.cloud_set_spend_limit(text, text, uuid, text, numeric, text), public.cloud_set_provider_attestation(uuid, text, boolean, text)
  to service_role;
