# BTC — Bitcoin security intelligence (defensive research)

A defensive Bitcoin security research platform: live network status, AI-assisted research grounded on
NVD / GitHub advisories / bitcoincore.org, a vulnerability feed, a static code scanner, a research database,
and automated public-source monitoring. It contains no attack tooling and refuses theft/attack requests.

Stack: Next.js 16 (App Router), Tailwind v4, Drizzle ORM + Neon Postgres, Auth.js v5 (GitHub), NVIDIA Nemotron 3 Ultra via OpenRouter.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill what you have; everything is optional
npm run dev
npm run lint && npm run typecheck && npm run build
```

## Database (Stage 6)

Set `DATABASE_URL` (Neon), then `npm run db:migrate`. Schema lives in `lib/db/schema.ts`; generate new migrations with
`npm run db:generate`. Without `DATABASE_URL` the app builds and runs and database pages show "Database not configured".

## Supabase — BTC Network AI (Phase 2)

Mining/worker/ledger data lives in a separate Supabase project (`btc-network-ai`, us-east-1); Neon/Drizzle keeps serving the existing
features. SQL migrations are in `supabase/migrations/` (applied through the Supabase MCP). Every table has RLS enabled with no
anon/authenticated policies and the client roles have no table grants, so only the server can touch the data, via
`lib/supabase/server.ts` (`import "server-only"`, `SUPABASE_URL` + `SUPABASE_SECRET_KEY`, never `NEXT_PUBLIC_`).
Types: `lib/supabase/types.ts` (generated). `GET /api/mining/health` (admin-gated) reports reachability and per-table row counts.

## Authentication (Stage 6)

Set `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` (and optionally `ADMIN_GITHUB_LOGINS`). When all three are set,
`/api/ai/*`, `/api/scan`, `/api/admin/*` and the private pages (`/intelligence`, `/scanner`, `/database`, `/reports`, `/monitoring`)
require a signed-in GitHub user on the allowlist. When they are not set, the previous guard applies (Vercel SSO on `*.vercel.app`, localhost,
or `AI_PUBLIC_ENABLED=true`). OAuth callback: `https://<domain>/api/auth/callback/github` (GitHub OAuth apps take one callback URL, so use
the production domain).

## Monitoring (Stage 7)

`vercel.json` schedules `GET /api/cron/ingest` daily (Hobby plan limit). It requires `Authorization: Bearer $CRON_SECRET` (Vercel adds it
automatically) and refuses everything if `CRON_SECRET` is unset. It ingests NVD (incremental `lastMod` window), GitHub advisories,
bitcoincore.org advisories + RSS and bitcoin/bitcoin releases into Postgres idempotently. Each source's first successful run is a baseline;
items first seen later are flagged new. Admins can also press "Run ingest now" on `/monitoring`.

Optional: `NVD_API_KEY`, `GITHUB_TOKEN` raise upstream rate limits.

## AI analysis (Phase 7)

`/ai` (admin only) shows recommendations from NVIDIA Nemotron over your own DB facts. It can only recommend; accepting needs a confirm and writes `audit_log`. See [docs/ai.md](docs/ai.md).

## Financials (Phase 8)

`/financials` (admin only) shows public network data (mempool.space, with source and time), labeled **Estimate** profitability from *measured* telemetry hashrate, and **Confirmed** earnings from ledger rows with a pool/chain source and reference. Estimated and confirmed figures are never combined, missing inputs mean "unknown" (never zero), and a tiny or negative result is shown as is. CPU/GPU mining yields essentially nothing; see [docs/profitability.md](docs/profitability.md) for the formula, sources and the optional `BRAIINS_POOL_TOKEN` connection (set by you in Vercel; never created by this repo).

## Windows 7 repair helper

A visible, ask-first repair script for an old Windows 7 PC plus the `/repair` admin page. The server only suggests allowlisted action ids; the person at the PC approves each command with Y/N. See [docs/win7-repair.md](docs/win7-repair.md) for the typed bootstrap, TLS limits (Win7 cannot open `*.vercel.app` itself, so Firefox ESR 115 is step one), the optional Cloudflare relay in `cloudflare/repair-relay`, and what is not verified.

## Windows 7 speed-up

A separate offline, ask-first speed-up tool for the same old PC, served at `/s` (`speedup.bat`, source `agent/win7-speedup/speedup.bat`). It scans read-only first, shows each change and waits for a local Y/N, saves an undo file, and never touches security software. See [docs/win7-speedup.md](docs/win7-speedup.md).
