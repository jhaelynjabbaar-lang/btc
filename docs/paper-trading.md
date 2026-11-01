# Paper trading (simulation only: paper money, not real)

`/paper` (admin only) runs a small trading bot with **fake money** against **live public prices**. It exists to find out honestly
what a "$5 bot" would have done, costs included, before anyone considers real money. **No exchange account, API key, wallet or
real order exists anywhere in this code.**

## What it does

- **Account:** starts with a virtual **$5.00** (configurable). Everything is labelled "Paper money, not real".
- **Prices:** Coinbase Exchange *public* market data, keyless and read-only:
  `GET https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600` (hourly candles) and
  `.../products/BTC-USD/ticker` (last price, bid, ask, time). The source and price time are stored with every snapshot and trade.
  Nothing is interpolated or back-filled: a failed/malformed fetch, a stale candle set, a gap in the candle window, a stale ticker
  (> 5 min) or a ticker more than 2% away from the last close **skips the tick** and writes a row to `paper_events`.
- **Schedule:** Vercel cron `/api/cron/paper-trade` at minute 5 of every hour (`5 * * * *`, allowed on the Pro plan; Hobby allows
  daily only). Protected exactly like the other cron routes (`Authorization: Bearer $CRON_SECRET`; refuses if unset).
- **Idempotent:** each tick is keyed by the start time of the latest *closed* hourly candle. `paper_apply_tick` (Postgres) locks the run,
  refuses a candle already processed, refuses plans built from stale balances, and writes the trade, position, run balances and equity
  snapshot in one transaction. Calling the cron twice in an hour, or concurrently, changes nothing the second time.

## Strategy (long-only SMA trend filter)

On closed hourly BTC-USD closes, with fast SMA = 20 and slow SMA = 50 and a 0.10% dead band:

| Condition | Desired state |
| --- | --- |
| fast > slow x (1 + 0.10%) | long: hold BTC (buy with the whole balance if flat) |
| fast < slow x (1 - 0.10%) | flat: hold USD (sell everything if long) |
| otherwise | keep the current state |

The rule is a *state*, not a one-off cross, so a missed cron run corrects itself on the next candle. No shorting, no leverage, one
position at a time. At the first tick of a run the bot may enter immediately if the trend is already up.

## Cost model

| Setting | Default | Env override |
| --- | --- | --- |
| Starting balance | $5.00 | `PAPER_START_USD` |
| Taker fee | 0.60% of each fill, rounded **up** to the cent | `PAPER_FEE_BPS` (60) |
| Slippage | 0.05% adverse, on top of the real quote | `PAPER_SLIPPAGE_BPS` (5) |
| Minimum order | $1.00 notional (Coinbase BTC-USD `min_market_funds`) | `PAPER_MIN_ORDER_USD` |
| Minimum size | 1 satoshi (Coinbase `base_increment` 0.00000001) | - |
| SMA lengths | 20 / 50 | `PAPER_SMA_FAST`, `PAPER_SMA_SLOW` |
| Dead band | 0.10% | `PAPER_BAND_BPS` (10) |

Buys fill at the **ask** plus slippage, sells at the **bid** minus slippage. Orders below the minimum are refused, never rounded up; a
position too small to sell stays open (and the skip is logged). Money is integer cents and BTC integer satoshis. Values in force are
copied into each run (`paper_runs.config`) and shown on the page. Reset lets the admin change starting balance, fee and slippage.

**Expect honesty, not profit:** a flat-price round trip costs about 1.3% (2 x 0.6% fee + slippage), and on $5 the fee is rounded to whole
cents. The page shows total fees paid and compares against **buy-and-hold** (same cash, bought at the run's first tick with the same
fee/slippage/minimums). Both are marked to the last recorded price with no exit cost applied.

## Data model (Supabase, migration `20261101230001_paper_trading.sql`)

`paper_runs` (account, config, benchmark entry), `paper_positions`, `paper_trades`, `paper_equity_snapshots` (one per processed candle,
also the idempotency key), `paper_events` (skips, pauses, resets). RLS is enabled with no policies and no anon/authenticated grants:
only the server (service role) touches them. Reset archives the active run and starts a new one; history is kept.

## Admin controls

`POST /api/admin/paper/control` (signed-in allowlisted admin, same-origin): `pause`, `resume`, `reset` (needs `confirm: true`), `tick`
(runs the same idempotent tick on demand). They only change the simulation.

## Not built: what real money would require

Real-money trading is **out of scope and not implemented**. Before any such step, at minimum:

1. **Explicit user approval of every single order** (amount, side, estimated price and fees shown first); no autonomous trading.
2. **Hard spending caps** enforced server-side and at the exchange: per-order, per-day and total deposit caps, plus a kill switch.
3. A separate, trade-only (never withdrawal-enabled) exchange API key stored as a secret with IP allow-listing, never in the repo.
4. Real execution handling: partial fills, rejects, rate limits, reconciliation against the exchange's own balances and fills.
5. A reviewed period of paper results that beat buy-and-hold **after** costs, plus tax-record and legal review.

Until all of that exists, the bot stays paper-only.
