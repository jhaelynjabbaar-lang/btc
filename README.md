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
