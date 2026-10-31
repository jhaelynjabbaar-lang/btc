-- Deny-by-default: RLS on every table, NO anon/authenticated policies.
-- Only the server (Supabase secret key / service_role, which bypasses RLS) can read or write.
alter table public.pools                    enable row level security;
alter table public.payout_addresses         enable row level security;
alter table public.cloud_providers          enable row level security;
alter table public.workers                  enable row level security;
alter table public.worker_credentials       enable row level security;
alter table public.worker_enrollment_codes  enable row level security;
alter table public.telemetry_1m             enable row level security;
alter table public.pool_stats               enable row level security;
alter table public.cloud_resources          enable row level security;
alter table public.ledger                   enable row level security;
alter table public.spend_limits             enable row level security;
alter table public.ai_recommendations       enable row level security;
alter table public.audit_log                enable row level security;

-- Defense in depth: also remove Data API table privileges from the client roles.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
