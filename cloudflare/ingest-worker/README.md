# btc-network-ingest (Cloudflare Worker)

Signed ingest + command plane for BTC Network AI worker agents. Runs on the **Workers Free plan** at
`https://btc-network-ingest.btcnetworkai.workers.dev`. It talks to Supabase (PostgREST, server key) and never handles
mining traffic or per-share data — only one-minute rollups and start/pause/stop commands.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none (IP rate limited) | `{ok, supabase}` — `supabase` is a boolean ping, nothing else |
| `POST /v1/enroll` | one-time code + proof of key possession | Creates `workers` + `worker_credentials`, consumes the hashed code, writes `audit_log` (one transaction: `enroll_worker`) |
| `POST /v1/telemetry` | Ed25519 signature | Batch (≤120) of 1-minute rollups → upsert `telemetry_1m`, update `workers.last_seen_at/status` |
| `GET /v1/commands` | Ed25519 signature | Pending `start`/`pause`/`stop` commands for the calling worker |
| `POST /v1/commands/ack` | Ed25519 signature | `{ids:[…]}` — marks commands done; worker status follows (pause→paused, stop→offline, start→online) |

## Request signing

Headers: `x-btc-worker` (UUID; omitted on enroll), `x-btc-timestamp` (unix s), `x-btc-nonce` (16–64 chars `[A-Za-z0-9_-]`),
`x-btc-signature` (unpadded base64url Ed25519). Signed message:

```
BTCNAI1\n<METHOD>\n<PATH>\n<timestamp>\n<nonce>\n<sha256 hex of the raw body>
```

Public keys are raw 32-byte Ed25519 keys, base64url. Requests older than 5 min (or >60 s in the future) are rejected; each
`(worker, nonce)` is accepted once (per-worker SQLite Durable Object). No query strings are accepted.
`/v1/enroll` is signed by the key being registered (proof of possession).

## Security

- HTTPS only (HSTS), no CORS headers at all (browsers cannot call it), `Cache-Control: no-store`, CSP `default-src 'none'`.
- Generic errors: 401 `unauthorized` for every auth failure (bad/old/replayed signature, unknown or revoked worker, bad code).
- Rate limiting (Workers Rate Limiting binding, free): `RL_IP` 120/min per IP, `RL_ENROLL` 6/min per IP, `RL_WORKER` 40/min per worker
  (applied only after the signature verifies, so nobody can burn another worker's quota). The binding is per-location/approximate.
- Strict validation: unknown keys rejected, body caps (4 KB enroll, 32 KB telemetry), batch cap 120, minute-aligned buckets,
  value ranges.
- Secret: `SUPABASE_SECRET_KEY` is a Worker secret. Never commit it. Set it with
  `printf %s "$SUPABASE_SECRET_KEY" | npx wrangler secret put SUPABASE_SECRET_KEY` (needs `wrangler login` or `CLOUDFLARE_API_TOKEN`),
  or paste it in the Cloudflare dashboard: Workers & Pages → btc-network-ingest → Settings → Variables and Secrets.

## Develop

```
npm install
npm run types        # wrangler types (worker-configuration.d.ts is generated, git-ignored)
npm test             # vitest: signatures, timestamps, replay, validation, routing, CORS
npm run typecheck
npm run build        # wrangler deploy --dry-run --outdir dist
# local run against real Supabase (needs Node 20+; wrangler 4.86 pinned for Node 20 hosts):
cp .dev.vars.example .dev.vars   # fill SUPABASE_SECRET_KEY, set ALLOW_INSECURE_HTTP=1 (local only)
npx wrangler dev --local --compatibility-date 2026-05-03
BASE_URL=http://127.0.0.1:8787 SUPABASE_SECRET_KEY=… npm run e2e   # creates + deletes tagged test rows
```

`scripts/make-deploy-code.mjs` builds the body for the Cloudflare MCP `execute` tool (used when Wrangler has no credentials).
