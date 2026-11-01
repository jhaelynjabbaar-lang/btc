import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { openPayload, planBuy, planExits, type AccountState, type OpenPositionRow } from "@/lib/meme/engine";
import { cfg, goodPair, NOW, TOKEN, PAIR } from "./fixtures";

/**
 * Runs the REAL migration (supabase/migrations/*_meme_paper_trading.sql) in an in-process Postgres (PGlite) and drives
 * meme_paper_apply_tick with plans from the engine: idempotency per bucket, atomicity, stale-state refusal, pause, reset.
 */
const SQL = readFileSync(new URL("../../supabase/migrations/20261102000001_meme_paper_trading.sql", import.meta.url), "utf8");
const SOL = 100;
const iso = (ms: number) => new Date(ms).toISOString();
const BUCKET = (i: number) => iso(NOW + i * 15 * 60_000);

let db: PGlite;
async function rpc<T = Record<string, unknown>>(fn: string, ...args: unknown[]): Promise<T> {
  const params = args.map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : a));
  const casts = args.map((a, i) => (typeof a === "object" && a !== null ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const r = await db.query<{ r: T }>(`select public.${fn}(${casts.join(", ")}) as r`, params);
  return r.rows[0].r;
}
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows[0];
const count = async (t: string) => Number((await one<{ n: string }>(`select count(*) as n from public.${t}`)).n);

type Acct = { id: string; version: number; cash: number; fees: number };
async function acct(id: string): Promise<Acct> {
  const r = await one<{ version: number; cash_usd: string; fees_paid_usd: string }>("select * from public.meme_paper_accounts where id = $1", [id]);
  return { id, version: r.version, cash: Number(r.cash_usd), fees: Number(r.fees_paid_usd) };
}
async function openRows(id: string): Promise<OpenPositionRow[]> {
  const r = await db.query<Record<string, string>>("select * from public.meme_paper_positions where account_id = $1 and status = 'open'", [id]);
  return r.rows.map((p) => ({ id: p.id, tokenAddress: p.token_address, symbol: p.symbol, pairAddress: p.pair_address, qty: Number(p.qty), costUsd: Number(p.cost_usd), entryFillPrice: Number(p.entry_fill_price), peakPrice: Number(p.peak_price), lastPrice: Number(p.last_price), openedAtMs: new Date(p.opened_at).getTime(), entryLiquidityUsd: Number(p.entry_liquidity_usd), missingTicks: Number(p.missing_ticks) }));
}

/** Mirrors the payload assembly in lib/meme/service.ts for one tick with a single candidate pair. */
async function buildPayload(a: Acct, bucket: string, pair: ReturnType<typeof goodPair>, buy: boolean) {
  const positions = await openRows(a.id);
  const state: AccountState = { id: a.id, version: a.version, cashUsd: a.cash, feesPaidUsd: a.fees, config: cfg, positions, recentExits: {} };
  const ex = planExits(state, [pair], new Set(), SOL, NOW, iso(NOW));
  let cash = ex.cashAfter;
  let fees = ex.feesAfter;
  const opens = [];
  if (buy) {
    const b = planBuy(pair, cash, cash, positions.length - ex.closes.length, SOL, cfg);
    if (!b.ok) throw new Error("expected a buy: " + b.reasons[0].code);
    opens.push(openPayload(b.buy, 1, iso(NOW), NOW));
    cash = Math.round((cash - b.buy.fill.spendUsd) * 1e6) / 1e6;
    fees = Math.round((fees + b.buy.fill.dexFeeUsd + b.buy.fill.txFeeUsd) * 1e6) / 1e6;
  }
  return {
    account_id: a.id,
    expected_version: a.version,
    bucket_start: bucket,
    cash_usd: cash,
    fees_paid_usd: fees,
    tick: { candidates_seen: 2, rejected: 1, bought: opens.length, sold: ex.closes.length, open_positions: positions.length - ex.closes.length + opens.length, market_value_usd: 1.4, equity_usd: cash + 1.4, sol_price_usd: SOL, sources: [{ name: "x", ok: true, count: 1 }], notes: [] },
    marks: ex.marks,
    closes: ex.closes,
    opens,
    candidates: [
      { token_address: TOKEN, symbol: "GOOD", pair_address: PAIR, sources: ["dexscreener_boosts_latest"], decision: buy ? "bought" : "held", reasons: [], metrics: { liquidity_usd: 120000 } },
      { token_address: "Rejected1111111111111111111111111111111111", symbol: "BAD", pair_address: null, sources: [], decision: "rejected", reasons: [{ code: "liquidity_below_min", detail: "$100 < $50,000" }], metrics: {} },
    ],
  };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon nologin; create role authenticated nologin; create role service_role nologin;");
  await db.exec(SQL);
}, 60_000);

describe("meme_paper_apply_tick against the real migration", () => {
  let id = "";

  it("starts an account once (idempotent with only_if_none)", async () => {
    const a = await rpc<{ ok: boolean; created: boolean; account_id: string }>("meme_paper_start_run", "test", 5, cfg, true);
    expect(a).toMatchObject({ ok: true, created: true });
    id = a.account_id;
    expect(await rpc("meme_paper_start_run", "test", 5, cfg, true)).toMatchObject({ ok: true, created: false, account_id: id });
    expect(await rpc("meme_paper_start_run", "test", 0, cfg, true)).toMatchObject({ ok: false, reason: "invalid_starting_balance" });
  });

  it("applies a buy tick atomically: position, trade, candidates, tick row and account totals", async () => {
    const a = await acct(id);
    const p = await buildPayload(a, BUCKET(0), goodPair(), true);
    const r = await rpc<{ applied: boolean }>("meme_paper_apply_tick", p);
    expect(r.applied).toBe(true);
    expect(await count("meme_paper_positions")).toBe(1);
    expect(await count("meme_paper_trades")).toBe(1);
    expect(await count("meme_paper_candidates")).toBe(2);
    const after = await acct(id);
    expect(after.version).toBe(1);
    expect(after.cash).toBeCloseTo(5 - 1.5, 6);
    expect(after.fees).toBeGreaterThan(0);
    const t = await one<{ price_source: string; side: string }>("select * from public.meme_paper_trades");
    expect(t).toMatchObject({ price_source: "dexscreener", side: "buy" });
    const pos = await one<{ status: string; qty: string }>("select * from public.meme_paper_positions");
    expect(pos.status).toBe("open");
  });

  it("is idempotent per bucket: the same bucket twice changes nothing", async () => {
    const a = await acct(id);
    const p = await buildPayload(a, BUCKET(0), goodPair(), false);
    expect(await rpc("meme_paper_apply_tick", p)).toMatchObject({ applied: false, reason: "duplicate_bucket" });
    expect(await count("meme_paper_ticks")).toBe(1);
    expect((await acct(id)).version).toBe(1);
  });

  it("refuses a plan built from stale state (version mismatch), changing nothing", async () => {
    const a = await acct(id);
    const p = await buildPayload(a, BUCKET(1), goodPair({ priceUsd: 0.0011 }), false);
    const stale = { ...p, expected_version: a.version - 1 };
    expect(await rpc("meme_paper_apply_tick", stale)).toMatchObject({ applied: false, reason: "stale_state" });
    expect(await count("meme_paper_ticks")).toBe(1);
  });

  it("marks, then a stop-loss tick closes the position and credits the cash in one transaction", async () => {
    const a = await acct(id);
    const mark = await buildPayload(a, BUCKET(1), goodPair({ priceUsd: 0.00098 }), false); // above the stop, below entry fill? (entry fill ~0.00101)
    expect((await rpc<{ applied: boolean }>("meme_paper_apply_tick", mark)).applied).toBe(true);
    const row = await one<{ last_price: string }>("select last_price from public.meme_paper_positions");
    expect(Number(row.last_price)).toBe(0.00098);

    const a2 = await acct(id);
    const stop = await buildPayload(a2, BUCKET(2), goodPair({ priceUsd: 0.0007 }), false);
    expect(stop.closes[0].exit_reason).toBe("stop_loss");
    expect((await rpc<{ applied: boolean }>("meme_paper_apply_tick", stop)).applied).toBe(true);
    const pos = await one<{ status: string; exit_reason: string; pnl_usd: string; proceeds_usd: string }>("select * from public.meme_paper_positions");
    expect(pos).toMatchObject({ status: "closed", exit_reason: "stop_loss" });
    expect(Number(pos.pnl_usd)).toBeLessThan(0);
    expect(await count("meme_paper_trades")).toBe(2);
    const fin = await acct(id);
    expect(fin.cash).toBeCloseTo(5 - 1.5 + Number(pos.proceeds_usd), 5);
    expect(fin.cash).toBeLessThan(5);
  });

  it("only one open position per token per account (unique index)", async () => {
    const a = await acct(id);
    const p1 = await buildPayload(a, BUCKET(3), goodPair(), true);
    expect((await rpc<{ applied: boolean }>("meme_paper_apply_tick", p1)).applied).toBe(true);
    const a2 = await acct(id);
    const p2 = await buildPayload(a2, BUCKET(4), goodPair(), true); // buys the same token again while open
    await expect(rpc("meme_paper_apply_tick", p2)).rejects.toThrow();
    expect(await count("meme_paper_ticks")).toBe(4); // the failed tick rolled back entirely (no tick row, no partial trade)
    expect((await acct(id)).version).toBe(4);
  });

  it("pause stops ticks; reset archives the account and starts a fresh $5 one", async () => {
    expect(await rpc("meme_paper_set_paused", "t", true)).toMatchObject({ ok: true, paused: true });
    const a = await acct(id);
    const p = await buildPayload(a, BUCKET(9), goodPair(), false);
    expect(await rpc("meme_paper_apply_tick", p)).toMatchObject({ applied: false, reason: "paused" });
    await rpc("meme_paper_set_paused", "t", false);
    const reset = await rpc<{ account_id: string; previous_account: string }>("meme_paper_start_run", "t", 5, cfg, false);
    expect(reset.previous_account).toBe(id);
    expect(reset.account_id).not.toBe(id);
    expect(Number((await one<{ cash_usd: string }>("select cash_usd from public.meme_paper_accounts where is_active")).cash_usd)).toBe(5);
    expect(await count("meme_paper_accounts")).toBe(2);
    expect(await rpc("meme_paper_apply_tick", { ...p })).toMatchObject({ applied: false, reason: "account_inactive" });
  });

  it("locks everything down: RLS on, no anon/authenticated table grants, execute only for service_role", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname like 'meme_paper_%' and relkind = 'r'");
    expect(rls.rows).toHaveLength(5);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    const pol = await db.query("select * from pg_policies where tablename like 'meme_paper_%'");
    expect(pol.rows).toHaveLength(0);
    const g = await db.query("select grantee from information_schema.role_table_grants where table_name like 'meme_paper_%' and grantee in ('anon','authenticated','public')");
    expect(g.rows).toHaveLength(0);
    const ex = await db.query<{ ok: boolean }>("select has_function_privilege('anon', 'public.meme_paper_apply_tick(jsonb)', 'execute') as ok");
    expect(ex.rows[0].ok).toBe(false);
    const ex2 = await db.query<{ ok: boolean }>("select has_function_privilege('service_role', 'public.meme_paper_apply_tick(jsonb)', 'execute') as ok");
    expect(ex2.rows[0].ok).toBe(true);
  });
});
