-- BTC Network AI: Windows 7 repair helper ("repair agent") backend.
-- ADDITIVE ONLY: five new tables, their indexes and RLS. Nothing existing is altered, dropped or rewritten.
-- Access model is the same as every other table: RLS ON, NO anon/authenticated policies, client roles have no grants.
-- Only the server (Supabase secret key / service_role) can read or write.
--
-- Secrets: pairing codes and device tokens are NEVER stored; only their SHA-256 hashes (code_hash, token_hash).
-- The allowlist of action ids below is a defense-in-depth copy of lib/repair/actions.ts (a test keeps them identical).
-- The server can only SUGGEST an action id; the person at the PC approves (Y/N) every change locally.

create table if not exists public.repair_pairing_codes (
  id          uuid primary key default gen_random_uuid(),
  owner_id    text not null,
  label       text not null check (char_length(label) between 1 and 40),
  code_hash   text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  device_id   uuid,
  created_by  text not null,
  created_at  timestamptz not null default now()
);
create index if not exists repair_pairing_codes_owner_open on public.repair_pairing_codes (owner_id) where used_at is null;

create table if not exists public.repair_devices (
  id            uuid primary key default gen_random_uuid(),
  owner_id      text not null,
  name          text not null check (char_length(name) between 1 and 40),
  token_hash    text not null unique,
  status        text not null default 'active' check (status in ('active', 'revoked')),
  agent_version text,
  os_caption    text,
  os_version    text,
  arch          text,
  ram_mb        integer,
  paired_at     timestamptz not null default now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists repair_devices_owner on public.repair_devices (owner_id, created_at desc);

create table if not exists public.repair_reports (
  id             uuid primary key default gen_random_uuid(),
  owner_id       text not null,
  device_id      uuid references public.repair_devices (id) on delete cascade,
  source         text not null check (source in ('device', 'offline_code', 'admin_paste')),
  kind           text not null check (kind in ('diagnostics', 'actions', 'error', 'offline_code')),
  agent_version  text,
  host           jsonb not null default '{}'::jsonb,
  findings       jsonb not null default '[]'::jsonb,
  errors         jsonb not null default '[]'::jsonb,
  action_results jsonb not null default '[]'::jsonb,
  offline_code   text,
  created_by     text,
  created_at     timestamptz not null default now()
);
create index if not exists repair_reports_device_created on public.repair_reports (device_id, created_at desc);
create index if not exists repair_reports_owner_created on public.repair_reports (owner_id, created_at desc);

create table if not exists public.repair_suggestions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    text not null,
  device_id   uuid references public.repair_devices (id) on delete cascade,
  report_id   uuid references public.repair_reports (id) on delete set null,
  action_id   text not null check (action_id in (
    'flush_dns', 'renew_ip', 'reset_winsock', 'reset_tcpip', 'reset_winhttp_proxy', 'clear_ie_proxy', 'reset_hosts', 'resync_time',
    'sfc_scan', 'chkdsk_readonly', 'enable_tls12_schannel', 'enable_tls12_winhttp', 'enable_tls12_dotnet', 'enable_ie_tls12',
    'enable_ie_feature', 'reset_url_associations', 'fix_exe_association', 'clear_disallowrun', 'clear_ifeo_debugger',
    'clean_user_temp', 'download_firefox', 'install_firefox'
  )),
  explanation text not null check (char_length(explanation) between 1 and 400),
  source      text not null check (source in ('ai', 'admin')),
  status      text not null default 'proposed' check (status in ('proposed', 'queued', 'delivered', 'succeeded', 'failed', 'declined', 'dismissed', 'expired')),
  model       text,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  queued_at   timestamptz,
  delivered_at timestamptz,
  resolved_at timestamptz,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  exit_code   integer,
  result_note text check (result_note is null or char_length(result_note) <= 200)
);
create index if not exists repair_suggestions_device_status on public.repair_suggestions (device_id, status);
create index if not exists repair_suggestions_report on public.repair_suggestions (report_id);

-- Rate-limit + audit events for the public device endpoints (key_hash = SHA-256 of a salted client address; never the address).
create table if not exists public.repair_events (
  id         bigint generated always as identity primary key,
  kind       text not null,
  key_hash   text not null,
  created_at timestamptz not null default now()
);
create index if not exists repair_events_kind_key_created on public.repair_events (kind, key_hash, created_at desc);

alter table public.repair_pairing_codes enable row level security;
alter table public.repair_devices       enable row level security;
alter table public.repair_reports       enable row level security;
alter table public.repair_suggestions   enable row level security;
alter table public.repair_events        enable row level security;

revoke all on public.repair_pairing_codes, public.repair_devices, public.repair_reports, public.repair_suggestions, public.repair_events from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

comment on table public.repair_devices is 'Windows 7 repair helper devices. Only a SHA-256 of the per-device bearer token is stored.';
comment on table public.repair_suggestions is 'Server-side SUGGESTIONS of allowlisted action ids. Nothing runs unless the person at the PC answers Y to a prompt showing the exact command.';
