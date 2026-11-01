# Profitability engine (Phase 8)

Admin-only page: **Financials** (`/financials`). It answers one question honestly: *what would my measured hashrate be expected to earn, what does it cost, and what has the pool or chain actually confirmed?*

Rules it is built around (they are enforced in code and tests, not just described here):

1. **Estimated and confirmed are different things and never share a total.** Estimates carry an `Estimate` label, confirmed amounts carry `Confirmed`, anything the pool's API reports carries `Pool-reported`.
2. **No manufactured numbers.** No measured hashrate → no estimate. No network data → no estimate. A cost that was never entered is *unknown*, not zero. Net is shown only when every input is known.
3. **No simulated reward is ever presented as an earning**, and nothing writes an `estimated_reward` to the ledger.
4. **Mining is not "successful" until the pool has verified accepted shares.** The page says "mining is not verified" unless the pool itself reports accepted shares.
5. **Honest results are shown as they are.** A tiny or negative net is displayed with its sign and its significant digits, never rounded to zero.

## The formula

```
share            = worker_hashrate / network_hashrate
gross_sats/day   = share × blocks_per_day × (subsidy_sats + avg_fee_sats)
pool_fee         = gross × pool_fee_pct / 100
revenue_sats/day = gross − pool_fee                      ← "Estimate"
revenue_usd/day  = revenue_sats/day ÷ 1e8 × btc_price_usd

electricity_usd/day = watts / 1000 × 24 × usd_per_kwh    (both user-entered; blank = unknown)
cloud_usd/day       = Σ hourly_price_usd × 24            ("Projection", from the Cloud page)

net_usd/day = revenue_usd/day − electricity_usd/day − cloud_usd/day     ← only when every input is known
```

| Input | Where it comes from |
|---|---|
| `worker_hashrate` | **Measured only**: the average of the one-minute `telemetry_1m.avg_hashrate_hs` buckets reported in the last 24 h (SQL function `profit_worker_hashrate`). Coverage (buckets ÷ 1440) is shown. It is the rate *while reporting*; a worker that ran 2 hours of the day is shown at 8% coverage, and the per-day figure assumes it keeps that rate for the whole day. Workers with no telemetry get no estimate. |
| `network_hashrate` | mempool.space `GET /api/v1/mining/hashrate/3d` → `currentHashrate` |
| difficulty | same endpoint → `currentDifficulty` (displayed; the difficulty-implied hashrate `D × 2³² / 600` is within about 1% of the reported one) |
| `subsidy_sats` | **Consensus rule** from the chain tip height: `50 BTC ÷ 2^⌊height / 210000⌋` (height from `GET /api/blocks/tip/height`). 3.125 BTC for heights 840,000 – 1,049,999 |
| `avg_fee_sats` | mempool.space `GET /api/v1/mining/reward-stats/144` → `totalFee ÷ blocks` over the last 144 blocks |
| `btc_price_usd` | mempool.space `GET /api/v1/prices` → `USD`; **CoinGecko** `simple/price` only if that fails, and the page then says so |
| `blocks_per_day` | 144 (10-minute target). Braiins' own FPPS specification also recalculates each day "as if the average 144 blocks had been mined" |
| `pool_fee_pct` | **2.5 %**, from Braiins' official docs: <https://academy.braiins.com/braiins-pool/rewards-and-payouts> ("Pool fee 2.5%", FPPS, fee subtracted from the gross reward). Miners running **Braiins OS** pay 0 %, which does not apply to this app's CPU/GPU workers. Override it in the cost form if you use another pool or a promotion. |
| electricity price, watts | **You**, in the cost form. Blank by default. Stored in `profit_settings`; every save is written to `audit_log` (old and new values) in the same transaction |
| cloud cost | `cloud_resources` in state `provisioning`/`running`: `hourly_price_usd × 24`, only where the price is known (`cost_known`). **A projection from declared prices, not billing**; the provider's invoice is the source of truth. A cloud-linked worker is costed from its cloud price only (its power is in the price) |

Fleet net counts revenue only from workers that have an estimate, electricity only for those workers, and **all** running cloud resources (a rented machine costs money even if its worker is silent). If any required input is missing, the page lists exactly what is missing instead of a number.

### Network data cache

`network_snapshots` stores each fetch with `source`, `fetched_at`, the raw values, the price source/time, and `field_errors`. A field that failed is `NULL` and shown as **unavailable** (with a short error code); it is never filled from an older row. The page refreshes the cache on view when the newest row is older than 15 minutes, the **Refresh network data** button refreshes on demand, and the existing daily `/api/cron/ingest` cron also takes a snapshot (no new cron job). Older data is always shown with its own timestamp: **fresh** ≤ 1 h, **STALE** ≤ 24 h (still used, clearly labelled), and older than 24 h it is displayed as "last known" only and estimates are withheld.

## Confirmed earnings

Only these count as **Confirmed**:

* `ledger` rows with `kind = 'confirmed_payout'`, `source` of `pool` or `chain`, and a non-empty `ref` (payout id / txid). The database enforces this too (`ledger_confirmed_payout_provenance`).
* **Pool-reported** values (balance, today's reward, shares) from the Braiins account API, shown in their own panel, never added into the Confirmed table.

### Braiins connection (optional, off by default)

Set the environment variable **`BRAIINS_POOL_TOKEN`** yourself in the Vercel dashboard (Production), then redeploy. This repo never creates or reads it anywhere except `lib/profit/braiins.ts`, never logs it, never stores or returns it, sends it only as the `Pool-Auth-Token` header to `pool.braiins.com`, and refuses redirects.

1. Braiins Pool → *Settings → Access Profiles* → pick a profile → enable *Allow access to web APIs* → *Generate New token* ([docs](https://academy.braiins.com/braiins-pool/monitoring)).
2. Add `BRAIINS_POOL_TOKEN` in Vercel, redeploy.
3. Open Financials: the pool panel shows `GET /accounts/profile/json/btc/` values, labelled *Pool-reported*, and an **Import confirmed payouts** button.

The import calls `GET /accounts/payouts/json/btc?from=…&to=…` (last 90 days) and writes a ledger row **only** for payouts with `status = confirmed` and a reference (on-chain `tx_id`, or `ln:<preimage>` for Lightning). Queued, failed and reference-less payouts are skipped and counted. It is idempotent (the ledger's unique `(kind, source, ref)` index) and audited (`profit.braiins.payouts_imported`). The Braiins API is documented to allow about one request per 5 seconds; the profile call is memoised for 60 s.

Without the variable the page says **Not connected** with these instructions and claims nothing about the pool.

⚠️ **Not verified against the live Braiins service**, because it needs your token: the response shapes follow Braiins' documentation samples and are validated strictly (an unexpected shape shows "unavailable" and imports nothing). Tests use the documented samples.

## Honest economics

Bitcoin mining is a race measured in hashes per second against the whole network. At the values fetched when this was written (network ≈ 1.07 ZH/s, subsidy 3.125 BTC, average fees ≈ 0.0146 BTC/block, price ≈ $77,943, pool fee 2.5 %), each unit of hashrate earns about:

| Hashrate | Expected revenue (estimate) |
|---|---|
| 1 MH/s | ≈ 0.00004 sats/day |
| 1 GH/s | ≈ 0.04 sats/day |
| 1 TH/s | ≈ 41 sats/day (≈ $0.03/day) |

A CPU (MH/s range) therefore earns a fraction of a **millionth** of a satoshi per day, around **$0.0000002/day** for a 5 MH/s test worker, while even a 100 W machine running 24 h at $0.10/kWh burns **$0.24/day** of electricity. A GPU is the same story at a larger but still negligible scale. **CPU/GPU mining on Bitcoin essentially yields nothing and loses money to electricity**; only purpose-built ASICs (hundreds of TH/s, thousands of watts) produce meaningful revenue, and whether they pay depends on power price and hardware cost, which this page does not include (no hardware amortization). Nothing in this app is a reason to expect profit; the page exists so the number is visible instead of imagined. Also note a pool pays proportionally to **accepted shares** and Braiins pays out only above a minimum (0.0002 BTC on-chain; Lightning 1 sat minimum), so a tiny earner may never see a payout.

Other limits: the estimate is an expectation, not a prediction (difficulty and price change; Braiins pays FPPS from a daily recalculation); the fee window and 144-blocks-per-day are approximations; no taxes, hardware, cooling or network costs are included.

## Files

* `lib/profit/` — `math.ts` (pure formulas), `network.ts` (public fetchers, snapshot freshness), `braiins.ts` (optional pool API), `service.ts` (server-only Supabase wiring), `summary.ts` (read-only summary for the AI layer), `format.ts`, `schemas.ts`, `config.ts`
* `app/financials/page.tsx`, `components/financials-console.tsx`, `app/api/admin/financials/{network,settings,braiins}/route.ts`
* `supabase/migrations/20261101200001_profitability.sql` — additive: tables `network_snapshots`, `profit_settings`; functions `profit_save_settings`, `profit_worker_hashrate` (RLS on, service role only)
* `tests/profit/` — formulas with known inputs, missing-input behaviour, negative net, estimate/confirmed separation, API failure handling, source/secret safety checks

## AI layer

`lib/analysis` may read a **read-only** summary (`profitability` object: `estimate` and `confirmed` kept apart, labelled). It is context only: the model cannot cite it as evidence, may not write any of its numbers (the existing "numbers must come from the section's facts" check discards such text), may not call an estimate earnings or imply profit, and still cannot run or change anything. Phase 7's constraints are unchanged.
