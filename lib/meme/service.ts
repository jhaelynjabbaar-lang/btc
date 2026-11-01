import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/supabase/server";
import { bucketStartMs, memeConfigFromEnv, validateMemeConfig, DEFAULT_MEME_CONFIG, type MemeConfig } from "./config";
import { round6 } from "./costs";
import { equityOf, openPayload, planBuy, planExits, screenCandidates, type AccountState, type CandidateLog, type OpenPayload, type OpenPositionRow } from "./engine";
import { checkRug, type Reason } from "./filters";
import { discover, fetchPairs, fetchRugReport, fetchSolPrice, solPriceFromPairs, type FetchLike } from "./market";

/** Server-only wiring: Supabase reads/writes (service role, RLS deny-all tables) and the public market-data fetches. PAPER MONEY ONLY. */

// The meme_paper_* tables are not in the generated Database type (kept out of shared files on purpose), so use an untyped view.
const db = (): SupabaseClient => getSupabaseServer() as unknown as SupabaseClient;

/** Maximum RugCheck reports requested per tick (each is one public GET); candidates are checked strongest-momentum first. */
export const MAX_RUG_CHECKS_PER_TICK = 8;
/** Maximum discovered tokens priced per tick (30 per DexScreener request). */
export const MAX_DISCOVERED = 60;

export type AccountRow = {
  id: string;
  created_at: string;
  is_active: boolean;
  paused: boolean;
  starting_usd: number;
  cash_usd: number;
  fees_paid_usd: number;
  version: number;
  config: MemeConfig;
  last_bucket_at: string | null;
};

const n = (v: unknown): number => Number(v);

function normAccount(r: Record<string, unknown>): AccountRow {
  return { ...(r as unknown as AccountRow), starting_usd: n(r.starting_usd), cash_usd: n(r.cash_usd), fees_paid_usd: n(r.fees_paid_usd), version: n(r.version), config: { ...DEFAULT_MEME_CONFIG, ...(r.config as Partial<MemeConfig>) } };
}

export async function activeAccount(): Promise<AccountRow | null> {
  const r = await db().from("meme_paper_accounts").select("*").eq("is_active", true).maybeSingle();
  if (r.error) throw new Error("meme account query failed");
  return r.data ? normAccount(r.data as Record<string, unknown>) : null;
}

export type StartOutcome = { ok: true; created: boolean; accountId: string } | { ok: false; reason: string };

export async function startAccount(actor: string, config: MemeConfig, onlyIfNone: boolean): Promise<StartOutcome> {
  const bad = validateMemeConfig(config);
  if (bad) return { ok: false, reason: bad };
  const r = await db().rpc("meme_paper_start_run", { p_actor: actor, p_starting: config.startUsd, p_config: config, p_only_if_none: onlyIfNone });
  if (r.error) throw new Error("meme_paper_start_run failed");
  const d = r.data as { ok: boolean; created?: boolean; account_id?: string; reason?: string };
  return d.ok ? { ok: true, created: Boolean(d.created), accountId: String(d.account_id) } : { ok: false, reason: d.reason ?? "failed" };
}

export async function setMemePaused(actor: string, paused: boolean): Promise<{ ok: boolean; reason?: string }> {
  const r = await db().rpc("meme_paper_set_paused", { p_actor: actor, p_paused: paused });
  if (r.error) throw new Error("meme_paper_set_paused failed");
  const d = r.data as { ok: boolean; reason?: string };
  return { ok: d.ok, reason: d.reason };
}

async function openPositions(accountId: string): Promise<OpenPositionRow[]> {
  const r = await db().from("meme_paper_positions").select("*").eq("account_id", accountId).eq("status", "open").order("opened_at", { ascending: true });
  if (r.error) throw new Error("meme positions query failed");
  return ((r.data ?? []) as Record<string, unknown>[]).map((p) => ({
    id: String(p.id),
    tokenAddress: String(p.token_address),
    symbol: String(p.symbol),
    pairAddress: String(p.pair_address),
    qty: n(p.qty),
    costUsd: n(p.cost_usd),
    entryFillPrice: n(p.entry_fill_price),
    peakPrice: n(p.peak_price),
    lastPrice: p.last_price === null ? null : n(p.last_price),
    openedAtMs: new Date(String(p.opened_at)).getTime(),
    entryLiquidityUsd: n(p.entry_liquidity_usd),
    missingTicks: n(p.missing_ticks),
  }));
}

async function recentExits(accountId: string, cooldownHours: number): Promise<Record<string, number>> {
  const since = new Date(Date.now() - cooldownHours * 3_600_000).toISOString();
  const r = await db().from("meme_paper_positions").select("token_address, closed_at").eq("account_id", accountId).eq("status", "closed").gte("closed_at", since);
  if (r.error) throw new Error("meme exits query failed");
  const out: Record<string, number> = {};
  for (const p of (r.data ?? []) as { token_address: string; closed_at: string }[]) out[p.token_address] = Math.max(out[p.token_address] ?? 0, new Date(p.closed_at).getTime());
  return out;
}

async function logSkip(accountId: string, bucketIso: string, reason: string, notes: unknown[]): Promise<void> {
  // Never throws: logging must not break a tick. Notes contain only public data (URLs without credentials, error codes).
  try {
    await db().from("meme_paper_ticks").insert({ account_id: accountId, bucket_start: bucketIso, status: "skipped", skip_reason: reason, notes });
  } catch {
    /* ignore */
  }
}

export type TickResult =
  | {
      status: "applied";
      tick_id: string;
      bucket_start: string;
      candidates_seen: number;
      rejected: number;
      rejection_counts: Record<string, number>;
      bought: { symbol: string; token_address: string; ref_price: number; fill_price: number; spend_usd: number; qty: number; liquidity_usd: number; slippage_bps: number; fees_usd: number }[];
      sold: { symbol: string; token_address: string; reason: string; proceeds_usd: number; pnl_usd: number }[];
      open_positions: number;
      cash_usd: number;
      equity_usd: number;
      sol_price_usd: number;
      sources: { name: string; ok: boolean; count: number; error?: string }[];
      notes: string[];
    }
  | { status: "already_processed"; bucket_start: string }
  | { status: "paused" }
  | { status: "skipped"; reason: string; detail?: string };

export type TickOptions = { actor: string; autoStart: boolean; manual?: boolean; now?: () => Date; fetchFn?: FetchLike };

/**
 * One tick. Idempotent per 15-minute bucket (manual admin ticks use a one-minute bucket). A failed or malformed price fetch skips the tick
 * and records why; prices are never guessed, interpolated or carried forward. Only simulated fills are written: there is no wallet,
 * key or order anywhere in this code path.
 */
export async function runMemeTick(opts: TickOptions): Promise<TickResult> {
  const now = opts.now ?? (() => new Date());
  const fetchFn: FetchLike = opts.fetchFn ?? ((u, i) => fetch(u, i as RequestInit));
  let acct = await activeAccount();
  if (!acct) {
    if (!opts.autoStart) return { status: "skipped", reason: "no_active_account", detail: "no active memecoin paper account; start one from /paper/meme" };
    const s = await startAccount(opts.actor, memeConfigFromEnv(), true);
    if (!s.ok) return { status: "skipped", reason: "no_active_account", detail: s.reason };
    acct = await activeAccount();
    if (!acct) return { status: "skipped", reason: "no_active_account" };
  }
  if (acct.paused) return { status: "paused" };

  const startedMs = now().getTime();
  const bucketMs = opts.manual ? startedMs - (startedMs % 60_000) : bucketStartMs(startedMs);
  const bucketIso = new Date(bucketMs).toISOString();
  const dup = await db().from("meme_paper_ticks").select("id", { head: true, count: "exact" }).eq("account_id", acct.id).eq("bucket_start", bucketIso).eq("status", "applied");
  if (dup.error) throw new Error("meme tick query failed");
  if ((dup.count ?? 0) > 0) return { status: "already_processed", bucket_start: bucketIso };

  const cfg = acct.config;
  const positions = await openPositions(acct.id);
  const exits = await recentExits(acct.id, cfg.cooldownHours);
  const notes: string[] = [];

  // ---- data: discovery + SOL price in parallel, then pairs for positions first, discovered tokens after
  const [disc, sol] = await Promise.all([discover(fetchFn, now), fetchSolPrice(fetchFn, now)]);
  const discoveryOk = disc.sources.some((s) => s.ok);
  for (const s of disc.sources) if (!s.ok) notes.push(`discovery source ${s.name} failed: ${s.error}`);
  if (!discoveryOk) notes.push("all discovery sources failed: no new entries this tick");
  const heldAddrs = positions.map((p) => p.tokenAddress);
  const discovered = new Map([...disc.addresses].slice(0, MAX_DISCOVERED));
  const fetched = await fetchPairs(fetchFn, [...heldAddrs, ...discovered.keys()], now);
  for (const e of fetched.errors) notes.push(`${e.url}: ${e.error}`);
  const fetchedAtIso = fetched.fetchedAt;
  const nowMs = new Date(fetchedAtIso).getTime();

  if (fetched.pairs.length === 0 && fetched.errors.length > 0) {
    await logSkip(acct.id, bucketIso, "price_fetch_failed", notes);
    return { status: "skipped", reason: "price_fetch_failed", detail: fetched.errors.map((e) => e.error).join(",") };
  }
  if (!discoveryOk && positions.length === 0) {
    await logSkip(acct.id, bucketIso, "discovery_failed", notes);
    return { status: "skipped", reason: "discovery_failed", detail: disc.sources.map((s) => s.error).join(",") };
  }

  let solPrice: number | null = sol.ok ? sol.data : solPriceFromPairs(fetched.pairs);
  if (!sol.ok) notes.push(solPrice !== null ? `SOL price from DexScreener fetch failed (${sol.error}); derived from this tick's SOL pools instead` : `SOL price fetch failed: ${sol.error}`);
  if (solPrice === null) {
    const last = await db().from("meme_paper_ticks").select("sol_price_usd").eq("account_id", acct.id).eq("status", "applied").order("at", { ascending: false }).limit(1);
    const prev = (last.data?.[0] as { sol_price_usd: unknown } | undefined)?.sol_price_usd;
    if (prev !== undefined && prev !== null && Number(prev) > 0) {
      solPrice = Number(prev);
      notes.push("SOL price unavailable this tick; used the previous tick's observed value for the fee estimate");
    }
  }
  if (solPrice === null) {
    await logSkip(acct.id, bucketIso, "sol_price_unavailable", notes);
    return { status: "skipped", reason: "sol_price_unavailable" };
  }

  // ---- exits first
  const state: AccountState = { id: acct.id, version: acct.version, cashUsd: acct.cash_usd, feesPaidUsd: acct.fees_paid_usd, config: cfg, positions, recentExits: exits };
  const ex = planExits(state, fetched.pairs, fetched.failedAddresses, solPrice, nowMs, fetchedAtIso);
  const closedIds = new Set(ex.closes.map((c) => c.position_id));
  const remaining = positions.filter((p) => !closedIds.has(p.id));
  const markPrice = (p: OpenPositionRow) => ex.marks.find((m) => m.position_id === p.id)?.last_price ?? p.lastPrice ?? p.entryFillPrice;
  let cash = ex.cashAfter;
  let fees = ex.feesAfter;
  const equityBefore = equityOf(cash, remaining.map((p) => ({ qty: p.qty, price: markPrice(p) })));

  // ---- candidates
  const cooldown = { ...exits };
  for (const t of ex.closedTokens) cooldown[t] = nowMs;
  const screened = screenCandidates(discoveryOk ? discovered : new Map(), fetched.pairs, fetched.failedAddresses, new Set(heldAddrs), cooldown, cfg, nowMs);
  const log: CandidateLog[] = [...screened.rejected, ...screened.held];
  const opens: OpenPayload[] = [];
  const boughtInfo: Extract<TickResult, { status: "applied" }>["bought"] = [];
  let openCount = remaining.length;
  let rugChecks = 0;
  let rugLimited = false;
  let closedReason: Reason[] | null = null;
  for (const el of screened.eligible) {
    const base = { token_address: el.pair.tokenAddress, symbol: el.pair.symbol, pair_address: el.pair.pairAddress, sources: el.sources };
    const metrics = { dex: el.pair.dexId, price_usd: el.pair.priceUsd, liquidity_usd: el.pair.liquidityUsd, change_pct: el.pair.change, volume_24h_usd: el.pair.volume24h, txns_1h: el.pair.txns.h1 };
    if (closedReason || openCount >= cfg.maxOpenPositions) {
      closedReason ??= [{ code: "no_free_slot", detail: `${openCount}/${cfg.maxOpenPositions} positions open; rug checks not run for this candidate` }];
      log.push({ ...base, decision: "skipped", reasons: closedReason, metrics });
      continue;
    }
    // Cheap pre-check before spending a RugCheck request: is there any room to size an entry at all?
    const pre = planBuy(el.pair, cash, equityBefore, openCount, solPrice, cfg);
    if (!pre.ok) {
      log.push({ ...base, decision: "skipped", reasons: pre.reasons, metrics });
      if (pre.reasons[0].code === "size_below_min") closedReason = pre.reasons;
      continue;
    }
    let rugReasons: Reason[];
    let score: number | null = null;
    if (rugLimited || rugChecks >= MAX_RUG_CHECKS_PER_TICK) {
      rugReasons = checkRug(null, cfg, rugLimited ? "rate limited earlier this tick" : `per-tick limit of ${MAX_RUG_CHECKS_PER_TICK} reports reached`);
    } else {
      rugChecks++;
      const rr = await fetchRugReport(fetchFn, el.pair.tokenAddress, now);
      if (!rr.ok && rr.error.startsWith("rate_limited")) rugLimited = true;
      rugReasons = checkRug(rr.ok ? rr.data : null, cfg, rr.ok ? "" : rr.error);
      if (rr.ok) score = rr.data.scoreNormalised;
    }
    if (rugReasons.length) {
      log.push({ ...base, decision: "rejected", reasons: rugReasons, metrics: { ...metrics, rugcheck_score: score } });
      continue;
    }
    const buy = planBuy(el.pair, cash, equityBefore, openCount, solPrice, cfg);
    if (!buy.ok) {
      log.push({ ...base, decision: "skipped", reasons: buy.reasons, metrics });
      continue;
    }
    const op = openPayload(buy.buy, score, fetchedAtIso, nowMs);
    opens.push(op);
    cash = round6(cash - buy.buy.fill.spendUsd);
    fees = round6(fees + buy.buy.fill.dexFeeUsd + buy.buy.fill.txFeeUsd);
    openCount++;
    log.push({ ...base, decision: "bought", reasons: [], metrics: { ...metrics, rugcheck_score: score, fill_price: buy.buy.fill.fillPrice, spend_usd: buy.buy.fill.spendUsd } });
    boughtInfo.push({
      symbol: el.pair.symbol,
      token_address: el.pair.tokenAddress,
      ref_price: buy.buy.fill.refPrice,
      fill_price: buy.buy.fill.fillPrice,
      spend_usd: buy.buy.fill.spendUsd,
      qty: buy.buy.fill.qty,
      liquidity_usd: el.pair.liquidityUsd as number,
      slippage_bps: Math.round(buy.buy.fill.slippageBps),
      fees_usd: round6(buy.buy.fill.dexFeeUsd + buy.buy.fill.txFeeUsd),
    });
  }

  const marketValue = round6(remaining.reduce((a, p) => a + p.qty * markPrice(p), 0) + opens.reduce((a, o) => a + o.position.qty * o.position.last_price, 0));
  const equity = round6(cash + marketValue);
  const rejected = log.filter((c) => c.decision === "rejected");
  const counts: Record<string, number> = {};
  for (const c of rejected) for (const r of c.reasons) counts[r.code] = (counts[r.code] ?? 0) + 1;

  const payload = {
    account_id: acct.id,
    expected_version: acct.version,
    bucket_start: bucketIso,
    cash_usd: cash,
    fees_paid_usd: fees,
    tick: {
      candidates_seen: log.length,
      rejected: rejected.length,
      bought: opens.length,
      sold: ex.closes.length,
      open_positions: openCount,
      market_value_usd: marketValue,
      equity_usd: equity,
      sol_price_usd: solPrice,
      sources: disc.sources,
      notes,
    },
    marks: ex.marks,
    closes: ex.closes,
    opens,
    candidates: log,
  };
  const r = await db().rpc("meme_paper_apply_tick", { p: payload });
  if (r.error) throw new Error("meme_paper_apply_tick failed");
  const d = r.data as { ok: boolean; applied: boolean; reason?: string; tick_id?: string };
  if (!d.applied) {
    if (d.reason === "duplicate_bucket") return { status: "already_processed", bucket_start: bucketIso };
    if (d.reason === "paused") return { status: "paused" };
    await logSkip(acct.id, bucketIso, `db_refused_${d.reason ?? "unknown"}`, notes);
    return { status: "skipped", reason: d.reason === "account_inactive" ? "no_active_account" : "stale_state", detail: d.reason };
  }
  return {
    status: "applied",
    tick_id: String(d.tick_id),
    bucket_start: bucketIso,
    candidates_seen: log.length,
    rejected: rejected.length,
    rejection_counts: counts,
    bought: boughtInfo,
    sold: ex.closes.map((c) => {
      const p = positions.find((x) => x.id === c.position_id) as OpenPositionRow;
      return { symbol: p.symbol, token_address: p.tokenAddress, reason: c.exit_reason, proceeds_usd: c.proceeds_usd, pnl_usd: c.pnl_usd };
    }),
    open_positions: openCount,
    cash_usd: cash,
    equity_usd: equity,
    sol_price_usd: solPrice,
    sources: disc.sources,
    notes,
  };
}

// ------------------------------------------------------------------------------------------------ page data
export type PositionView = {
  id: string;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  token_address: string;
  symbol: string;
  pair_address: string;
  dex_id: string | null;
  qty: number;
  entry_fill_price: number;
  cost_usd: number;
  entry_liquidity_usd: number;
  last_price: number;
  last_liquidity_usd: number | null;
  last_marked_at: string | null;
  peak_price: number;
  exit_reason: string | null;
  exit_fill_price: number | null;
  proceeds_usd: number | null;
  pnl_usd: number | null;
};
export type TradeView = { id: string; executed_at: string; side: "buy" | "sell"; symbol: string; token_address: string; pair_address: string; qty: number; ref_price: number; fill_price: number; notional_usd: number; dex_fee_usd: number; tx_fee_usd: number; slippage_bps: number; price_source: string; price_time: string; reason: string };
export type CandidateView = { id: string; seen_at: string; token_address: string; symbol: string; pair_address: string | null; decision: string; reasons: Reason[] };
export type TickView = { id: string; at: string; status: string; skip_reason: string | null; candidates_seen: number; rejected: number; bought: number; sold: number; open_positions: number; equity_usd: number | null; cash_usd: number | null; sol_price_usd: number | null; notes: string[] };

export type MemeView = {
  account: AccountRow | null;
  open: PositionView[];
  closed: PositionView[];
  trades: TradeView[];
  rejections: CandidateView[];
  ticks: TickView[];
  archived: number;
};

const numify = <T extends Record<string, unknown>>(row: T, keys: string[]): T => {
  const out: Record<string, unknown> = { ...row };
  for (const k of keys) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  return out as T;
};

export async function loadMemeView(): Promise<MemeView> {
  const account = await activeAccount();
  const archived = await db().from("meme_paper_accounts").select("id", { count: "exact", head: true }).eq("is_active", false);
  if (archived.error) throw new Error("meme query failed");
  if (!account) return { account: null, open: [], closed: [], trades: [], rejections: [], ticks: [], archived: archived.count ?? 0 };
  const [pos, trades, cands, ticks] = await Promise.all([
    db().from("meme_paper_positions").select("*").eq("account_id", account.id).order("opened_at", { ascending: false }).limit(60),
    db().from("meme_paper_trades").select("*").eq("account_id", account.id).order("executed_at", { ascending: false }).limit(60),
    db().from("meme_paper_candidates").select("id, seen_at, token_address, symbol, pair_address, decision, reasons").eq("account_id", account.id).in("decision", ["rejected", "skipped"]).order("seen_at", { ascending: false }).limit(60),
    db().from("meme_paper_ticks").select("id, at, status, skip_reason, candidates_seen, rejected, bought, sold, open_positions, equity_usd, cash_usd, sol_price_usd, notes").eq("account_id", account.id).order("at", { ascending: false }).limit(12),
  ]);
  if (pos.error || trades.error || cands.error || ticks.error) throw new Error("meme query failed");
  const P = ((pos.data ?? []) as Record<string, unknown>[]).map((p) => numify(p, ["qty", "entry_fill_price", "cost_usd", "entry_liquidity_usd", "last_price", "last_liquidity_usd", "peak_price", "exit_fill_price", "proceeds_usd", "pnl_usd"]) as unknown as PositionView);
  return {
    account,
    open: P.filter((p) => p.status === "open"),
    closed: P.filter((p) => p.status === "closed"),
    trades: ((trades.data ?? []) as Record<string, unknown>[]).map((t) => numify(t, ["qty", "ref_price", "fill_price", "notional_usd", "dex_fee_usd", "tx_fee_usd", "slippage_bps"]) as unknown as TradeView),
    rejections: (cands.data ?? []) as unknown as CandidateView[],
    ticks: ((ticks.data ?? []) as Record<string, unknown>[]).map((t) => numify(t, ["equity_usd", "cash_usd", "sol_price_usd"]) as unknown as TickView),
    archived: archived.count ?? 0,
  };
}
