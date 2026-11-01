import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, GRANULARITY_MS } from "@/lib/paper/config";
import { planTick, type Market, type RunState, type TickPayload } from "@/lib/paper/engine";
import type { Candle } from "@/lib/paper/market";

/**
 * Runs the REAL migration (supabase/migrations/*_paper_trading.sql) in an in-process Postgres (PGlite) and drives the
 * paper_apply_tick function with plans from the engine: idempotency per candle, atomicity, stale-state refusal, pause, reset.
 */

const SQL = readFileSync(new URL("../../supabase/migrations/20261101230001_paper_trading.sql", import.meta.url), "utf8");
const HOUR = GRANULARITY_MS;
const T0 = Date.UTC(2026, 10, 1, 20, 5, 0);

let db: PGlite;

async function rpc<T = Record<string, unknown>>(fn: string, ...args: unknown[]): Promise<T> {
  const params = args.map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : a));
  const casts = args.map((a, i) => (typeof a === "object" && a !== null ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const r = await db.query<{ r: T }>(`select public.${fn}(${casts.join(", ")}) as r`, params);
  return r.rows[0].r;
}

function candles(closes: number[], lastStartMs: number): Candle[] {
  return closes.map((close, i) => ({ startSec: (lastStartMs - (closes.length - 1 - i) * HOUR) / 1000, low: close - 5, high: close + 5, open: close, close, volume: 1 }));
}
const up = Array.from({ length: 80 }, (_, i) => 70_000 + i * 100);
const down = Array.from({ length: 80 }, (_, i) => 78_000 - i * 100);

function market(closes: number[], nowMs: number): Market {
  const last = nowMs - (nowMs % HOUR) - HOUR;
  const price = closes[closes.length - 1];
  return {
    candles: candles(closes, last),
    ticker: { price, bid: price - 0.5, ask: price + 0.5, time: new Date(nowMs - 10_000).toISOString() },
    candlesFetchedAt: new Date(nowMs).toISOString(),
    tickerFetchedAt: new Date(nowMs).toISOString(),
  };
}

async function state(runId: string): Promise<RunState> {
  const r = (await db.query<Record<string, unknown>>("select * from public.paper_runs where id = $1", [runId])).rows[0];
  const c = (v: unknown) => Math.round(Number(v) * 100);
  const s = (v: unknown) => Math.round(Number(v) * 1e8);
  return {
    id: runId,
    config: DEFAULT_CONFIG,
    cashCents: c(r.cash_usd),
    qtySats: s(r.qty_btc),
    feesCents: c(r.fees_paid_usd),
    benchEntered: r.bench_entry_at !== null,
    benchCashCents: r.bench_cash_usd === null ? 0 : c(r.bench_cash_usd),
    benchQtySats: r.bench_qty_btc === null ? 0 : s(r.bench_qty_btc),
    lastCandleAt: null,
  };
}

async function plan(runId: string, closes: number[], nowMs: number): Promise<TickPayload> {
  const p = planTick(await state(runId), market(closes, nowMs), nowMs);
  if (p.kind !== "apply") throw new Error("expected apply: " + p.detail);
  return p.payload;
}

const count = async (table: string) => Number((await db.query<{ n: string }>(`select count(*) as n from public.${table}`)).rows[0].n);

beforeAll(async () => {
  db = new PGlite();
  // Supabase roles that the migration grants to.
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
  await db.exec(SQL);
}, 60_000);

describe("paper_apply_tick against the real migration", () => {
  let runId = "";

  it("starts a run once (idempotent when only_if_none) and a reset archives it", async () => {
    const a = await rpc<{ ok: boolean; created: boolean; run_id: string }>("paper_start_run", "test", 5, DEFAULT_CONFIG, true);
    expect(a).toMatchObject({ ok: true, created: true });
    runId = a.run_id;
    const b = await rpc<{ created: boolean; run_id: string }>("paper_start_run", "cron", 5, DEFAULT_CONFIG, true);
    expect(b).toMatchObject({ created: false, run_id: runId });
    expect(await count("paper_runs")).toBe(1);
  });

  it("applies a buy once; replaying the same candle (even concurrently) changes nothing", async () => {
    const payload = await plan(runId, up, T0);
    expect(payload.action).toBe("buy");
    const first = await rpc<{ applied: boolean }>("paper_apply_tick", payload);
    expect(first.applied).toBe(true);
    const [again, again2] = await Promise.all([rpc<{ applied: boolean; reason: string }>("paper_apply_tick", payload), rpc<{ applied: boolean; reason: string }>("paper_apply_tick", payload)]);
    expect(again).toMatchObject({ applied: false });
    expect(again2).toMatchObject({ applied: false });
    expect(["duplicate_candle", "stale_state"]).toContain(again.reason);
    expect(await count("paper_trades")).toBe(1);
    expect(await count("paper_equity_snapshots")).toBe(1);
    expect(await count("paper_positions")).toBe(1);
    const run = (await db.query<{ cash_usd: string; qty_btc: string; fees_paid_usd: string; bench_qty_btc: string }>("select * from public.paper_runs where id = $1", [runId])).rows[0];
    expect(Number(run.fees_paid_usd)).toBe(0.03);
    expect(Number(run.qty_btc)).toBeGreaterThan(0);
    expect(Number(run.bench_qty_btc)).toBe(Number(run.qty_btc));
  });

  it("a stale plan for the already-processed candle is rejected as duplicate even with fresh balances", async () => {
    const stale = await plan(runId, up, T0); // recomputed from CURRENT state, same candle
    const r = await rpc<{ applied: boolean; reason: string }>("paper_apply_tick", stale);
    expect(r).toMatchObject({ applied: false, reason: "duplicate_candle" });
  });

  it("refuses a plan computed from stale balances for a new candle (no double spend)", async () => {
    const nextNow = T0 + HOUR;
    const good = await plan(runId, down, nextNow); // sell signal from current state
    const staleBalances = { ...good, expected_cash: 4.99 };
    const r = await rpc<{ applied: boolean; reason: string }>("paper_apply_tick", staleBalances);
    expect(r).toMatchObject({ applied: false, reason: "stale_state" });
    expect(await count("paper_equity_snapshots")).toBe(1);
  });

  it("does not trade or snapshot while paused, then resumes", async () => {
    const nextNow = T0 + HOUR;
    const payload = await plan(runId, down, nextNow);
    expect(await rpc("paper_set_paused", "test", true)).toMatchObject({ ok: true, paused: true });
    expect(await rpc("paper_apply_tick", payload)).toMatchObject({ applied: false, reason: "paused" });
    expect(await count("paper_equity_snapshots")).toBe(1);
    await rpc("paper_set_paused", "test", false);
    const r = await rpc<{ applied: boolean }>("paper_apply_tick", payload);
    expect(r.applied).toBe(true);
  });

  it("the sell closes the position with P&L after fees and rejects out-of-order candles", async () => {
    const pos = (await db.query<{ status: string; pnl_usd: string; cost_usd: string; proceeds_usd: string }>("select * from public.paper_positions")).rows[0];
    expect(pos.status).toBe("closed");
    expect(Number(pos.pnl_usd)).toBeCloseTo(Number(pos.proceeds_usd) - Number(pos.cost_usd), 2);
    expect(Number(pos.pnl_usd)).toBeLessThan(0); // price fell from 77,900 to 70,100 in this scenario, plus costs
    const trades = (await db.query<{ side: string }>("select side from public.paper_trades order by executed_at, candle_start")).rows.map((t) => t.side);
    expect(trades).toEqual(["buy", "sell"]);
    const old = await plan(runId, up, T0 - HOUR);
    const r = await rpc<{ applied: boolean; reason: string }>("paper_apply_tick", old);
    expect(r).toMatchObject({ applied: false, reason: "out_of_order" });
  });

  it("reset archives the run and starts a fresh one with the full starting balance; history is kept", async () => {
    const r = await rpc<{ ok: boolean; run_id: string; previous_run: string }>("paper_start_run", "admin", 5, DEFAULT_CONFIG, false);
    expect(r.ok).toBe(true);
    expect(r.previous_run).toBe(runId);
    expect(await count("paper_runs")).toBe(2);
    const active = (await db.query<{ id: string; cash_usd: string; qty_btc: string }>("select * from public.paper_runs where is_active")).rows;
    expect(active).toHaveLength(1);
    expect(Number(active[0].cash_usd)).toBe(5);
    expect(await count("paper_trades")).toBe(2);
    // the archived run can no longer be ticked
    const stale = await plan(runId, up, T0 + 5 * HOUR);
    expect(await rpc("paper_apply_tick", stale)).toMatchObject({ applied: false, reason: "run_inactive" });
  });

  it("schema is deny-all for anon/authenticated and RLS is on", async () => {
    const rls = (await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname like 'paper\\_%' and relkind = 'r'")).rows;
    expect(rls).toHaveLength(5);
    expect(rls.every((t) => t.relrowsecurity)).toBe(true);
    const grants = (await db.query<{ n: string }>("select count(*) as n from information_schema.role_table_grants where table_name like 'paper\\_%' and grantee in ('anon','authenticated')")).rows[0].n;
    expect(Number(grants)).toBe(0);
  });
});
