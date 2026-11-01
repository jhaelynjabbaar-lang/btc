import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/supabase/server";
import { configFromEnv, DEFAULT_CONFIG, SATS_PER_BTC, validateConfig, type PaperConfig } from "./config";
import { expectedCandleStartMs, planTick, type RunState, type SkipReason } from "./engine";
import { fetchCandles, fetchTicker } from "./market";

/** Server-only wiring: Supabase reads/writes (service role, RLS deny-all tables) and the public market-data fetches. */

// The paper_* tables are not in the generated Database type (kept out of shared files on purpose), so use an untyped view.
const db = (): SupabaseClient => getSupabaseServer() as unknown as SupabaseClient;

export type RunRow = {
  id: string;
  created_at: string;
  ended_at: string | null;
  is_active: boolean;
  paused: boolean;
  starting_usd: number;
  cash_usd: number;
  qty_btc: number;
  fees_paid_usd: number;
  config: PaperConfig;
  bench_entry_at: string | null;
  bench_entry_price: number | null;
  bench_qty_btc: number | null;
  bench_cash_usd: number | null;
  last_candle_at: string | null;
};

const cents = (usd: unknown): number => Math.round(Number(usd) * 100);
const sats = (btc: unknown): number => Math.round(Number(btc) * SATS_PER_BTC);

export function toRunState(r: RunRow): RunState {
  return {
    id: r.id,
    config: { ...DEFAULT_CONFIG, ...r.config },
    cashCents: cents(r.cash_usd),
    qtySats: sats(r.qty_btc),
    feesCents: cents(r.fees_paid_usd),
    benchEntered: r.bench_entry_at !== null,
    benchCashCents: r.bench_cash_usd === null ? 0 : cents(r.bench_cash_usd),
    benchQtySats: r.bench_qty_btc === null ? 0 : sats(r.bench_qty_btc),
    lastCandleAt: r.last_candle_at,
  };
}

export async function activeRun(): Promise<RunRow | null> {
  const r = await db().from("paper_runs").select("*").eq("is_active", true).maybeSingle();
  if (r.error) throw new Error("paper run query failed");
  return (r.data as RunRow | null) ?? null;
}

export async function logEvent(kind: string, message: string, level: "info" | "warn" | "error", runId: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  // Never throws: logging must not break a tick. Details contain only public data (URLs without credentials, error codes).
  try {
    await db().from("paper_events").insert({ run_id: runId, kind, message, level, detail });
  } catch {
    /* ignore */
  }
}

export type StartOutcome = { ok: true; created: boolean; runId: string } | { ok: false; reason: string };

export async function startRun(actor: string, config: PaperConfig, onlyIfNone: boolean): Promise<StartOutcome> {
  const bad = validateConfig(config);
  if (bad) return { ok: false, reason: bad };
  const r = await db().rpc("paper_start_run", { p_actor: actor, p_starting: config.startCents / 100, p_config: config, p_only_if_none: onlyIfNone });
  if (r.error) throw new Error("paper_start_run failed");
  const d = r.data as { ok: boolean; created?: boolean; run_id?: string; reason?: string };
  return d.ok ? { ok: true, created: Boolean(d.created), runId: String(d.run_id) } : { ok: false, reason: d.reason ?? "failed" };
}

export async function setPaused(actor: string, paused: boolean): Promise<{ ok: boolean; reason?: string }> {
  const r = await db().rpc("paper_set_paused", { p_actor: actor, p_paused: paused });
  if (r.error) throw new Error("paper_set_paused failed");
  const d = r.data as { ok: boolean; reason?: string };
  return { ok: d.ok, reason: d.reason };
}

export type TickResult =
  | { status: "applied"; action: string; candle_start: string; price: number; price_time: string; source: string }
  | { status: "already_processed"; candle_start: string }
  | { status: "paused" }
  | { status: "skipped"; reason: SkipReason | "fetch_failed" | "stale_state" | "run_inactive"; detail?: string };

/**
 * One scheduled tick. Idempotent per closed hourly candle: calling it twice (or concurrently) in the same hour changes nothing the
 * second time. A failed price fetch or implausible data skips the tick and logs an event; prices are never guessed or filled in.
 */
export async function runPaperTick(opts: { actor: string; autoStart: boolean; now?: () => Date } = { actor: "cron", autoStart: true }): Promise<TickResult> {
  const now = opts.now ?? (() => new Date());
  let run = await activeRun();
  if (!run) {
    if (!opts.autoStart) return { status: "skipped", reason: "run_inactive", detail: "no active paper run; start one from /paper" };
    const s = await startRun(opts.actor, configFromEnv(), true);
    if (!s.ok) return { status: "skipped", reason: "run_inactive", detail: s.reason };
    run = await activeRun();
    if (!run) return { status: "skipped", reason: "run_inactive" };
  }
  if (run.paused) return { status: "paused" };

  const nowMs = now().getTime();
  const expectedIso = new Date(expectedCandleStartMs(nowMs)).toISOString();
  if (run.last_candle_at && new Date(run.last_candle_at).getTime() >= new Date(expectedIso).getTime()) return { status: "already_processed", candle_start: expectedIso };

  const [candles, ticker] = await Promise.all([fetchCandles(fetch, now), fetchTicker(fetch, now)]);
  if (!candles.ok || !ticker.ok) {
    const failed = [candles, ticker].filter((f) => !f.ok).map((f) => ({ url: f.url, error: f.ok ? "" : f.error }));
    await logEvent("fetch_failed", "Price fetch failed; tick skipped (no prices were guessed).", "warn", run.id, { failed, candle_start: expectedIso });
    return { status: "skipped", reason: "fetch_failed", detail: failed.map((f) => f.error).join(",") };
  }

  const plan = planTick(toRunState(run), { candles: candles.data, ticker: ticker.data, candlesFetchedAt: candles.fetchedAt, tickerFetchedAt: ticker.fetchedAt }, nowMs);
  if (plan.kind === "skip") {
    await logEvent("tick_skipped", `Tick skipped: ${plan.reason}`, "warn", run.id, { reason: plan.reason, detail: plan.detail, candle_start: expectedIso });
    return { status: "skipped", reason: plan.reason, detail: plan.detail };
  }

  const r = await db().rpc("paper_apply_tick", { p: plan.payload });
  if (r.error) throw new Error("paper_apply_tick failed");
  const d = r.data as { ok: boolean; applied: boolean; reason?: string; action?: string };
  if (d.applied) {
    return { status: "applied", action: d.action ?? plan.payload.action, candle_start: plan.payload.candle_start, price: plan.payload.price, price_time: plan.payload.price_time, source: plan.payload.price_source };
  }
  if (d.reason === "duplicate_candle" || d.reason === "out_of_order") return { status: "already_processed", candle_start: plan.payload.candle_start };
  if (d.reason === "paused") return { status: "paused" };
  await logEvent("tick_rejected", `Database refused the tick: ${d.reason}`, "warn", run.id, { reason: d.reason, candle_start: plan.payload.candle_start });
  return { status: "skipped", reason: d.reason === "run_inactive" ? "run_inactive" : "stale_state", detail: d.reason };
}

// ------------------------------------------------------------------------------------------------ page data
export type TradeRow = { id: string; executed_at: string; side: "buy" | "sell"; qty_btc: number; ref_price: number; fill_price: number; notional_usd: number; fee_usd: number; slippage_usd: number; price_source: string; price_time: string; reason: string };
export type PositionRow = { id: string; opened_at: string; closed_at: string | null; status: "open" | "closed"; qty_btc: number; entry_price: number; cost_usd: number; exit_price: number | null; proceeds_usd: number | null; pnl_usd: number | null };
export type SnapshotRow = { candle_start: string; price: number; price_source: string; price_time: string; sma_fast: number | null; sma_slow: number | null; signal: string; action: string; reason: string; cash_usd: number; qty_btc: number; fees_paid_usd: number; equity_usd: number; bench_equity_usd: number };
export type EventRow = { id: string; at: string; level: string; kind: string; message: string };

export type PaperView = {
  run: RunRow | null;
  trades: TradeRow[];
  position: PositionRow | null;
  closedPositions: PositionRow[];
  snapshots: SnapshotRow[];
  events: EventRow[];
  archivedRuns: number;
};

const num = <T extends Record<string, unknown>>(row: T, keys: string[]): T => {
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  return out as T;
};

export async function loadPaperView(): Promise<PaperView> {
  const run = await activeRun();
  const events = await db().from("paper_events").select("id, at, level, kind, message").order("at", { ascending: false }).limit(15);
  const archived = await db().from("paper_runs").select("id", { count: "exact", head: true }).eq("is_active", false);
  if (events.error || archived.error) throw new Error("paper query failed");
  if (!run) return { run: null, trades: [], position: null, closedPositions: [], snapshots: [], events: (events.data ?? []) as EventRow[], archivedRuns: archived.count ?? 0 };
  const normRun = num(run as unknown as Record<string, unknown>, ["starting_usd", "cash_usd", "qty_btc", "fees_paid_usd", "bench_entry_price", "bench_qty_btc", "bench_cash_usd"]) as unknown as RunRow;
  const [trades, positions, snaps] = await Promise.all([
    db().from("paper_trades").select("*").eq("run_id", run.id).order("executed_at", { ascending: false }).limit(100),
    db().from("paper_positions").select("*").eq("run_id", run.id).order("opened_at", { ascending: false }).limit(50),
    // Newest 1500 hourly snapshots (about 62 days), returned oldest-first for charting.
    db().from("paper_equity_snapshots").select("*").eq("run_id", run.id).order("candle_start", { ascending: false }).limit(1500),
  ]);
  if (trades.error || positions.error || snaps.error) throw new Error("paper query failed");
  const pos = ((positions.data ?? []) as Record<string, unknown>[]).map((p) => num(p, ["qty_btc", "entry_price", "cost_usd", "exit_price", "proceeds_usd", "pnl_usd"]) as unknown as PositionRow);
  return {
    run: normRun,
    trades: ((trades.data ?? []) as Record<string, unknown>[]).map((t) => num(t, ["qty_btc", "ref_price", "fill_price", "notional_usd", "fee_usd", "slippage_usd"]) as unknown as TradeRow),
    position: pos.find((p) => p.status === "open") ?? null,
    closedPositions: pos.filter((p) => p.status === "closed"),
    snapshots: ((snaps.data ?? []) as Record<string, unknown>[])
      .map((s) => num(s, ["price", "sma_fast", "sma_slow", "cash_usd", "qty_btc", "fees_paid_usd", "equity_usd", "bench_equity_usd"]) as unknown as SnapshotRow)
      .reverse(),
    events: (events.data ?? []) as EventRow[],
    archivedRuns: archived.count ?? 0,
  };
}
