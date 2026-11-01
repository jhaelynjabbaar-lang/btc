# Memecoin paper trading (simulation only: paper money, not real)

`/paper/meme` (admin only) runs a small bot that trades **new, trending Solana memecoins with fake money** against **real public
prices**, behind a set of rug checks. It exists to find out honestly what a "$5 memecoin bot" would have done, costs included.
**No wallet, private key, RPC, DEX router, exchange account or real order exists anywhere in this code.** It is a separate account from
the BTC paper bot (`/paper`, `docs/paper-trading.md`).

> **PAPER MONEY ONLY. Memecoins are extremely risky: most go to zero and many are scams. Past or simulated paper results do not predict
> real results. Nothing here is financial advice.** Paper fills assume you can always trade at the quoted price plus modelled costs;
> real memecoin trading adds failed transactions, sandwich attacks, honeypots that cannot be sold, and gaps far worse than any stop.

## Data (all public, keyless, read-only GETs)

| Source | Endpoint | Used for |
| --- | --- | --- |
| DexScreener | `GET /token-boosts/latest/v1`, `/token-profiles/latest/v1` | discovery of recently boosted / newly profiled tokens (Solana only) |
| GeckoTerminal | `GET /api/v2/networks/solana/trending_pools` | discovery (trending pools) |
| DexScreener | `GET /tokens/v1/solana/{addr1,...<=30}` | **price, liquidity, volume, txns, price change, pool age: every fill and mark** |
| DexScreener | `GET /tokens/v1/solana/So1111...` | SOL/USD (deepest SOL-USDC pool) for the Solana fee estimate |
| RugCheck.xyz | `GET /v1/tokens/{mint}/report` | mint/freeze authority, risk score and risks, holders, pool accounts |

Price used for every trade and mark is the DexScreener `priceUsd` of the token's deepest pool quoted in SOL, USDC or USDT, fetched
during the tick; the source and fetch time are stored with every trade. Token names/symbols come from token creators and are treated as
untrusted (control characters stripped, length capped, never used in decisions). Nothing is interpolated or carried forward.

Failures are handled, not hidden: a 429/5xx/timeout/malformed body returns an error result. If prices cannot be fetched (or discovery
fails and nothing is open) the **tick is skipped** and a `skipped` row with the reason is written to `meme_paper_ticks`. A failed
discovery source only removes that source; a failed RugCheck request means **no buy** for that candidate (fail closed). A failed price
fetch for an open token leaves the position untouched that tick (no guessed mark).

## Rug checks (before any buy; all configurable in `lib/meme/config.ts`; every failed check is logged)

All reasons that apply are stored per candidate in `meme_paper_candidates` (kept 7 days) and shown on the page.

| Check | Default | Reason code |
| --- | --- | --- |
| Pool has a liquidity figure | required (pump.fun bonding curves have none) | `no_liquidity_data` |
| Liquidity | ≥ $50,000 | `liquidity_below_min` |
| Pool age | ≥ 6 h (most rugs happen first) and ≤ 168 h (7 d: "new", not ancient) | `pair_too_new`, `pair_too_old`, `pair_age_unknown` |
| 24h volume | ≥ $100,000 | `volume_24h_below_min` |
| Activity | ≥ 100 txns in the last hour | `too_few_txns_1h` |
| Buys vs sells | buys/(buys+sells) ≥ 52% (1h) and ≥ 45% (24h) | `buy_ratio_1h_low`, `buy_ratio_24h_low` |
| Momentum | 1h change +3%…+40%, 6h change 0%…+150% | `no_momentum_1h/6h` |
| Not absurd | 1h ≤ +40%, 6h ≤ +150%, 24h ≤ +400% (no chasing vertical pumps) | `absurd_change_1h/6h/24h` |
| Not dumping now | 5m change ≥ −1% | `dumping_5m` |
| Supported pool | SOL/USDC/USDT-quoted, base token is the token itself (impostor pools ignored) | `no_supported_pair` |
| RugCheck: renounced authorities | mint **and** freeze authority must be null (unknown counts as enabled) | `mint_authority_enabled`, `freeze_authority_enabled` |
| RugCheck: risk | not flagged rugged; `score_normalised` ≤ 40 (0 safest, 100 riskiest); no `danger`-level risk; no transfer fee | `rugcheck_rugged`, `rugcheck_score_high`, `rugcheck_danger_risk`, `transfer_fee` |
| RugCheck: holders | largest **non-pool** holder ≤ 10%, top 10 non-pool holders ≤ 35% (liquidity-pool and burn accounts excluded) | `top_holder_concentration`, `top10_concentration`, `holders_unknown` |
| RugCheck reachable | required (`requireRugcheck`) | `rugcheck_unavailable` |
| Already held / cooled down | one position per token; no re-buy for 24 h after an exit | `already_held`, `cooldown` |

These checks lower, but cannot remove, the chance of buying a scam (insiders can still dump, and RugCheck can be wrong or stale). The
filters are strict on purpose: **many ticks will buy nothing, and that is the expected, honest outcome.**

RugCheck is asked only for candidates that already passed every DexScreener-stage check and that could actually be bought (a free slot
and enough cash), strongest 1h momentum first, at most 8 reports per tick.

## Strategy (momentum entries, hard risk limits)

* **Entry:** passes every check above. Candidates are ranked by 1h price change (strongest first) and bought while a slot and cash are free.
* **Sizing:** 30% of current equity per position (30% of $5 = $1.50), **max 3 open positions**, minimum $0.50, never more than cash on hand.
  An entry whose modelled round-trip cost (buy then sell at the same quote) exceeds 10% of the position is refused (`cost_too_high`).
* **Exits**, first rule that fires on each tick's real mark (checked in this order):
  1. pool missing from successful API responses for 3 ticks in a row → **written off at $0** (assume rugged), `written_off_pair_gone`;
  2. liquidity down > 40% from entry (or gone) → sell now, `liquidity_collapse`;
  3. **stop-loss** at −20% vs the entry fill, `stop_loss`;
  4. **trailing stop**: once the peak is +20% over entry, sell if the mark is 15% below the peak, `trailing_stop`;
  5. **take-profit** at +40% vs the entry fill, `take_profit`;
  6. **max hold** 12 h, `max_hold`.
* Ticks are 15 minutes apart, so a stop only fires on a tick: the fill is at that tick's real mark, which can be far below the stop level
  (the simulation does not pretend it caught the price at −20%). Between ticks nothing is monitored.
* Equity = cash + open positions marked at the latest real price. It does **not** subtract the cost of exiting; the page says so.

## Cost model (`lib/meme/costs.ts`)

| Item | Default | Notes |
| --- | --- | --- |
| DEX fee | 0.30% of the traded value, each side | pool swap fee (Raydium/PumpSwap are ~0.25-0.30%) |
| Solana fee | 0.0003 SOL per transaction × SOL/USD fetched in the same tick | base fee + priority fee; ≈ $0.03 at SOL ≈ $94 |
| Slippage | **1.00% floor** + 2 × constant-product impact (`trade / (liquidity / 2)`) | buys fill above the quote, sells below it |
| Entry slippage cap | 3.00% | above this the entry is refused (`cost_refused`) |
| Exit slippage cap | 50% | exits are never refused (a stop must be able to fire) but a drained pool is punished |

On a $1.50 position in a deep pool a flat-price round trip costs about **6.6%** (2 × 0.30% fee + 2 × ~1.0% slippage + 2 × $0.03 tx fee), so
+40% take-profit and −20% stop are not symmetric in practice. Money is stored to 8 decimals; prices to 20.

## Schedule

Vercel cron `/api/cron/meme-paper` at `*/15 * * * *` (every 15 minutes). Sub-daily crons need a Vercel Pro (or higher) plan; Hobby allows
daily only, and a Hobby deployment with this entry would fail. The route requires `Authorization: Bearer $CRON_SECRET` and refuses
everything when `CRON_SECRET` is unset, exactly like the other cron routes. Vercel may start a run a little late; ticks are keyed by
15-minute bucket, so a late or repeated call neither double-trades nor skips state.

**Idempotent:** `meme_paper_apply_tick` (Postgres) locks the account row, refuses a bucket that already has an applied tick, refuses a
plan computed from an older account `version`, and writes marks, exits, entries, the candidate log, the tick row and the new balances in
one transaction (a failure rolls everything back).

## Data model (Supabase, migration `20261102000001_meme_paper_trading.sql`)

`meme_paper_accounts` (balance, config in force, version), `meme_paper_positions`, `meme_paper_trades`, `meme_paper_ticks` (one row per
attempt; `skipped` rows carry the reason), `meme_paper_candidates` (every token considered, decision, all reasons, metrics). RLS is
enabled with **no policies** and no anon/authenticated grants; only the server (service role, `lib/supabase/server.ts`) reads or writes,
and the three functions are executable by `service_role` only. There are no wallet, key or real-money columns.

## Admin controls

`/paper/meme` shows equity, cash, open positions (token, address linking to the DexScreener pair page, entry, current, P/L, liquidity),
trade history, recent rejections with reasons, recent ticks and the rules in force. `POST /api/admin/meme-paper/control` (signed-in
allowlisted admin, same-origin): `pause`, `resume`, `reset` (needs `confirm: true`, optional `starting_usd`; archives the account and
starts a new one), `tick` (runs the same tick on demand in its own one-minute bucket). They only change the simulation.

Optional env overrides (all optional, invalid values ignored): `MEME_PAPER_START_USD`, `MEME_PAPER_MIN_LIQUIDITY_USD`, `MEME_PAPER_MAX_OPEN`.
Values in force are copied into each account and shown on the page.

## Not built: what real money would require

Real-money trading is **out of scope and not implemented**. It would need, at minimum: explicit user approval of every order, hard
server-side spending caps and a kill switch, a dedicated throw-away wallet whose key is never in the repo, honeypot/sell simulation before
every buy, MEV-protected execution and failure handling, and a long paper record that beats doing nothing after real costs. Until then
the bot stays paper-only.
