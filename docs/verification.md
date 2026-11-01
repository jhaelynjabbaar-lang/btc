# Mining verification (Phase 9)

**Status of this phase:** the repository contains no written plan for Phase 9 (the README, `docs/` and the earlier PR descriptions only define Phases 2-8). This phase was chosen from the repo's own documented gaps and the project rules: *"no claims of mining success without pool-verified accepted shares"* had no place in the UI that enforces it. If you intended a different Phase 9, this PR is small and self-contained (no migration).

## What it does

`/verification` (admin only, read-only) answers one question per enrolled worker: **does the pool itself confirm this machine is submitting accepted shares right now?**

| Verdict | Meaning |
|---|---|
| **Pool-verified** | Braiins' Worker API lists a worker with the same name and its `last_share` (last accepted share) is at most **15 minutes** old |
| Pool: no recent share | The pool lists the worker, but its last accepted share is older than 15 minutes, or none is reported |
| Not seen by pool | The pool answered and has no worker with that name (no share submitted, or the agent's pool worker name differs from the enrolled name) |
| Ambiguous name | More than one pool worker matches; shares cannot be attributed to one machine |
| Unverified (pool unavailable) | `BRAIINS_POOL_TOKEN` is not set, or the pool request failed (rejected token, timeout, bad shape): **nothing** is verified |

Agent telemetry (`telemetry_1m` accepted/rejected over the last 60 minutes) is shown in a separate column labelled *agent-reported (unverified)*. If the agent reports accepted shares but the pool does not confirm them, the row carries a warning. Agent numbers never produce a "verified" verdict.

Pool workers that match no enrolled worker are listed separately so a name mismatch is visible. They are not counted.

An enrolled worker that is `online` but has sent no telemetry for over 5 minutes is flagged *Agent silent* (the agent cannot announce that it exited; see `agent/README.md`).

## Matching rule

An enrolled worker `rig1` matches the pool worker `<account>.rig1` (the part after the first `.`, case-insensitive) or a pool worker named exactly `rig1`. No prefix or fuzzy matching.

## Data source

Braiins Pool Worker API, `GET https://pool.braiins.com/accounts/workers/json/btc`, header `Pool-Auth-Token` (same optional `BRAIINS_POOL_TOKEN` that Phase 8 uses; set by you in Vercel, never created or stored by this repo). Fields used: `state`, `last_share`, `shares_5m/60m/24h`, `hash_rate_*`. The call is memoised for 60 s (the pool allows roughly one request per 5 s), refuses redirects, and the token is never logged, stored or returned.

⚠️ **Not verified against the live service**: the response shape follows Braiins' documentation sample and is validated strictly with zod. An unexpected shape results in *Unverified (pool unavailable)*, never in numbers.

## What it does not do

* Verified shares are **not earnings**. Money is only ever shown as *Confirmed* on Financials, from pool payouts with a reference.
* No writes: no ledger rows, no audit rows, no worker commands, no migration.
* No other pool is supported (no other pool API was documented clearly enough to implement).
* Telemetry is read up to 1000 rows per page load; the page says so if it was truncated.

## Files

`lib/verify/verdict.ts` (pure rules), `lib/verify/service.ts` (server-only reads), `lib/profit/braiins.ts` (`fetchPoolWorkers`), `app/verification/page.tsx`, `tests/verify/`.
