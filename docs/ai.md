# AI analysis layer (Phase 7)

The **AI Control** page (`/ai`, admin only) shows recommendations written by **NVIDIA Nemotron 3 Ultra** (`nvidia/nemotron-3-ultra-550b-a55b`, through OpenRouter).
It is the only AI provider in the project. The model **recommends**; a human decides. Nothing the model writes is ever executed on its own.

## What the AI can and cannot do

| | |
| --- | --- |
| **Can** | Read a compact, factual summary of your own database (below) and propose rows in `ai_recommendations`: a title, a rationale, a severity, the exact metrics it relied on, and at most one suggested action. |
| **Can** | Suggest a worker command (`start` / `pause` / `stop`) for a worker that is listed in the data it was given, or point you to the **Cloud** page. |
| **Cannot** | Run a worker command, approve/reject/start/stop a cloud resource, change a spend limit or a provider attestation, touch the kill switch, write the ledger, or move money. The analysis code has no write path to any of those tables or functions (a test asserts it). |
| **Cannot** | Invent data. A section with no data is sent as `NO DATA`, the model is told to cite only provided facts, and its output is checked (see *Validation*). |
| **Cannot** | Claim earnings. No earnings, payout, revenue or profitability figure is sent to the model, and any such number in its text fails validation. |
| **Cannot** | See secrets. The API key never leaves the server; the context contains no keys, tokens, credentials, hashes, addresses or enrollment codes, and is scrubbed for secret-shaped strings anyway. |

A recommendation is only a proposal until an admin clicks **Accept…** and then **Confirm**. Accepting a `worker_command` suggestion creates a **normal `worker_commands` row**
(the same one the Workers page creates; the agent receives it on its next signed poll). Accepting a cloud suggestion changes nothing: the card links to `/cloud`, where every
approval still goes through the policy registry, the spend caps (default 0) and the approval workflow. Every accept and dismiss is written to `audit_log`.

## What is analyzed

Three jobs, each built from real rows only:

| Job (`kind`) | Looks at | A *signal* exists when |
| --- | --- | --- |
| `worker_health` | workers, 1-minute telemetry aggregates (last 60 min vs the worker's own previous 7 days), command history | status `online` but no heartbeat for ≥ 10 min; status `offline`; reject rate ≥ 5 % over ≥ 20 recent shares; average hashrate ≥ 40 % below the worker's own baseline |
| `efficiency` | the same, compared with the worker's **own** history | average hashrate 15–40 % below its own baseline; reject rate ≥ 2 % and ≥ 2× its own baseline |
| `cloud_spend` | `cloud_resources` states, `spend_limits`, `cloud_controls`, provider mining policy and attestations, recorded `expense_cloud` ledger rows (30 days) | committed projection (hourly price × 730 h, known prices only) ≥ 80 % of a monthly cap, or any committed resource while the relevant monthly cap is 0; resources with unknown price; a conditional provider (`allowed_with_conditions` / `requires_written_permission`) whose condition is not acknowledged / permission not recorded; a pending approval waiting ≥ 24 h |

Thresholds live in `lib/analysis/config.ts`. They are deterministic: the model is **not** asked to hunt for anomalies in raw rows, only to explain and prioritise the signals that were found.

**When there is nothing to analyze the model is not called at all.** No data, or data with no threshold crossed, produces a run with `model_called: false` and zero recommendations, so a quiet fleet costs nothing and nothing can be hallucinated.

## The data the model sees

Per run, one JSON document (≤ 9,000 characters, completion capped at 3,000 tokens, 60 s timeout) with, for each requested job:

- `data` (true/false) and a `note`; `NO DATA: …` when the section has nothing.
- `entities`: `ref` (`W1`, `P1`, …), `kind`, and the operator-chosen `name` of flagged workers/providers. UUIDs are **not** sent.
- `facts`: `{ id, ref, metric, value, unit }`, e.g. `recent_reject_rate_pct = 20 %`, `hashrate_change_vs_own_baseline_pct = -60 %`, `minutes_since_last_heartbeat = 45`,
  `global_cap_utilization_pct = 91.25 %`. Only flagged entities are listed, plus fleet/cloud summary counts.
- the `windows` and `thresholds` used.

Not sent: API keys, tokens, signatures, public keys, credential hashes, enrollment codes, payout addresses, pool credentials, raw telemetry rows, earnings or ledger income, the provider policy quotes.
Requests ask OpenRouter not to retain prompts (`provider.data_collection = deny`), the same as the security research engine.

## Validation (nothing unvalidated is stored)

1. The model must answer with one JSON object. Not JSON → the whole answer is discarded and logged (reason only, never the text).
2. Each recommendation is checked with a **strict** zod schema (unknown keys such as `estimated_earnings` fail it) and then against the context:
   - `evidence_fact_ids` must exist in the section of that type. The stored evidence is **resolved from the context**, not copied from the model.
   - every number in the title/rationale must equal a fact of that section (or a window/threshold constant); anything else is discarded as `number_not_in_facts`;
   - an action may only be `none`, `review_cloud` (cloud type only) or `worker_command` (`start|pause|stop`) on a listed worker that appears in the cited evidence, with a command that fits the worker's status and is not already pending; a worker command on a cloud recommendation is rejected.
3. Invalid items are dropped and logged; valid ones in the same answer are kept. The number of discarded items is shown on the page and in `audit_log`.
4. A recommendation whose evidence is identical to one that is still open is not stacked again (`dedupe_key`, partial unique index).

## Storage

`ai_recommendations` (Phase 2 table, extended additively by `20261101180001_ai_analysis.sql`):

| Spec | Column |
| --- | --- |
| type | `kind` (`worker_health` / `efficiency` / `cloud_spend`) |
| severity | `severity` (`info` / `warning` / `critical`) — new |
| title | `title` — new |
| rationale | `explanation` |
| evidence (exact metrics) | `inputs` → `{ context_generated_at, windows, facts: [{ref,name,metric,value,unit}] }` |
| suggested action | `suggested_action` — new (`none` / `review_cloud` / `worker_command`) |
| status | `status`, stored as `pending` / `approved` / `rejected` (the Phase 2 CHECK is untouched) and shown as **proposed / accepted / dismissed** |
| model, created_at | `model`, `created_at` |
| also new | `run_id`, `job`, `dedupe_key` |

Also new (functions, `service_role` only): `ai_worker_aggregates` (SQL aggregation of `telemetry_1m`) and `ai_decide_recommendation` (one transaction: lock, status change, normal worker command, audit rows;
it refuses an accept unless `p_confirm = true`).

`audit_log` actions written: `ai.analysis.started`, `ai.analysis.completed`, `ai.analysis.failed`, `ai.recommendation.accepted`, `ai.recommendation.dismissed`, and `worker_command.queued` (with `via: ai_recommendation`).

## Running it

- **Manual:** AI Control → *Run analysis* (`POST /api/admin/ai/analyze`, admin session, same-origin). Limited to **one run per minute**; the limit is counted from `audit_log`, so it holds across serverless instances.
- **Cron:** `vercel.json` schedules `GET /api/cron/ai-analysis` daily at 06:47 UTC. It requires `Authorization: Bearer $CRON_SECRET` (Vercel sends it automatically when the variable is set) and refuses everything when `CRON_SECRET` is unset. A quiet day makes no model call. Remove the entry from `vercel.json` if you do not want it.
- **Environment (all server-only, already used by the research engine):** `OPENROUTER_API_KEY`, optional `AI_MODEL` (default `nvidia/nemotron-3-ultra-550b-a55b`), `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`. No new variables.

## Limits you should know

- The page and routes work only after the migration is applied to Supabase.
- Recommendations are only as good as the telemetry: with no enrolled workers or cloud records you will see an honest empty state.
- Validation is strict on purpose; a real model answer may lose items to `number_not_in_facts` (for example when it rounds a value). Discards are counted on the page.
- The cloud numbers are projections from declared hourly prices (× 730 h), not metered billing; the provider's invoice is the source of truth.
- The hashrate baseline is the worker's own last 7 days, including any earlier problem period.
