import { BUDGET, HOURS_PER_MONTH, JOB_TYPES, THRESHOLDS, WINDOWS, type JobType } from "./config";
import { redactDeep } from "./redact";

/**
 * Compact, factual context for the model, built ONLY from rows read from the database (no I/O here: the raw rows are passed in).
 * Deterministic thresholds decide what is a "signal"; the model only explains and prioritises what was found. Every number the
 * model may use is a `Fact` with an id, and anything missing is stated as NO DATA instead of being left for the model to fill in.
 */

// ------------------------------------------------------------------------------------------------ raw input
export type RawWorker = {
  id: string;
  name: string;
  status: string;
  hardware_type: string;
  current_hashrate_hs: number;
  last_seen_at: string | null;
};
export type RawAggregate = {
  worker_id: string;
  recent_buckets: number;
  recent_avg_hs: number | null;
  recent_accepted: number;
  recent_rejected: number;
  recent_max_temp_c: number | null;
  base_buckets: number;
  base_avg_hs: number | null;
  base_accepted: number;
  base_rejected: number;
  last_bucket: string | null;
};
export type RawCommand = { worker_id: string; command: string; status: string; created_at: string };
export type RawProvider = { id: string; name: string; mining_policy: string; conditions_acknowledged: boolean; written_permission_recorded: boolean };
export type RawResource = { id: string; provider_id: string; label: string | null; state: string; cost_known: boolean; hourly_price_usd: number; state_changed_at: string; created_at: string };
export type RawLimit = { scope: "global" | "provider"; provider_id: string | null; period: "hour" | "day" | "month"; limit_usd: number; enabled: boolean };
export type RawData = {
  workers: RawWorker[];
  aggregates: RawAggregate[];
  commands: RawCommand[];
  providers: RawProvider[];
  resources: RawResource[];
  limits: RawLimit[];
  killSwitchEngaged: boolean;
  /** Sum of ledger rows of kind expense_cloud over the ledger window, or null when there are none. */
  cloudExpensesUsd: number | null;
};

// ------------------------------------------------------------------------------------------------ output
export type FactValue = number | string | boolean | null;
export type Fact = { id: string; ref: string; metric: string; value: FactValue; unit?: string };
export type Entity = {
  ref: string;
  kind: "worker" | "provider" | "resource" | "fleet" | "cloud";
  name: string;
  /** Internal stable id (worker uuid etc.). Never needed by the model; used to resolve actions and dedupe keys. */
  stable_id: string;
};
export type Section = { data: boolean; note: string; signals: number; entities: Entity[]; facts: Fact[] };
export type AnalysisContext = {
  generated_at: string;
  windows: typeof WINDOWS;
  thresholds: typeof THRESHOLDS;
  sections: Partial<Record<JobType, Section>>;
};

// ------------------------------------------------------------------------------------------------ helpers
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Scale a hashrate (H/s) to a readable unit so numbers in the context match what a human would write. */
export function scaleHashrate(hs: number): { value: number; unit: string } {
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s"];
  let v = Math.max(0, hs);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return { value: r2(v), unit: units[i] };
}

const minutesBetween = (later: number, earlier: string | null): number | null => {
  if (!earlier) return null;
  const t = Date.parse(earlier);
  return Number.isFinite(t) ? Math.max(0, Math.round((later - t) / 60_000)) : null;
};

class FactBook {
  private n = 0;
  private counters: Record<string, number> = {};
  entities: Entity[] = [];
  facts: Fact[] = [];
  signals = 0;
  entity(kind: Entity["kind"], name: string, stable_id: string): Entity {
    const prefix = { worker: "W", provider: "P", resource: "R", fleet: "FLEET", cloud: "CLOUD" }[kind];
    const ref = kind === "fleet" || kind === "cloud" ? prefix : `${prefix}${(this.counters[prefix] = (this.counters[prefix] ?? 0) + 1)}`;
    const e = { ref, kind, name, stable_id };
    this.entities.push(e);
    return e;
  }
  fact(ref: string, metric: string, value: FactValue, unit?: string) {
    if (this.facts.length >= BUDGET.maxFactsPerSection) return;
    this.facts.push({ id: `F${++this.n}`, ref, metric, value, ...(unit ? { unit } : {}) });
  }
}

// ------------------------------------------------------------------------------------------------ worker sections
type WorkerEval = {
  w: RawWorker;
  agg: RawAggregate | null;
  minutesSinceSeen: number | null;
  recentShares: number;
  recentReject: number | null;
  baseReject: number | null;
  dropPct: number | null;
  health: string[];
  efficiency: string[];
};

function evalWorker(w: RawWorker, agg: RawAggregate | null, nowMs: number): WorkerEval {
  const T = THRESHOLDS;
  const minutesSinceSeen = minutesBetween(nowMs, w.last_seen_at);
  const recentShares = agg ? agg.recent_accepted + agg.recent_rejected : 0;
  const baseShares = agg ? agg.base_accepted + agg.base_rejected : 0;
  const recentReject = agg && recentShares >= T.min_shares_for_rate ? (agg.recent_rejected / recentShares) * 100 : null;
  const baseReject = agg && baseShares >= T.min_baseline_shares ? (agg.base_rejected / baseShares) * 100 : null;
  const haveRates = agg && agg.recent_buckets >= T.min_recent_buckets && agg.base_buckets >= T.min_baseline_buckets && (agg.base_avg_hs ?? 0) > 0;
  const dropPct = haveRates ? ((agg!.base_avg_hs! - (agg!.recent_avg_hs ?? 0)) / agg!.base_avg_hs!) * 100 : null;

  const health: string[] = [];
  const efficiency: string[] = [];
  if (w.status === "online" && (minutesSinceSeen === null || minutesSinceSeen >= T.stale_heartbeat_minutes)) health.push("stale_heartbeat");
  if (w.status === "offline") health.push("reported_offline");
  if (recentReject !== null && recentReject >= T.reject_rate_high_pct) health.push("high_reject_rate");
  if (w.status === "online" && dropPct !== null && dropPct >= T.hashrate_drop_pct) health.push("hashrate_drop");
  if (w.status === "online" && dropPct !== null && dropPct >= T.underperform_pct && dropPct < T.hashrate_drop_pct) efficiency.push("below_own_baseline");
  if (
    recentReject !== null &&
    baseReject !== null &&
    recentReject < T.reject_rate_high_pct &&
    recentReject >= T.min_reject_rate_pct_for_baseline_compare &&
    recentReject >= baseReject * T.reject_rate_vs_baseline_x
  )
    efficiency.push("reject_rate_above_own_baseline");
  return { w, agg, minutesSinceSeen, recentShares, recentReject, baseReject, dropPct, health, efficiency };
}

function commandFacts(book: FactBook, ref: string, workerId: string, commands: RawCommand[], nowMs: number) {
  const mine = commands.filter((c) => c.worker_id === workerId);
  book.fact(ref, "commands_last_7d", mine.length);
  const pending = mine.filter((c) => c.status === "pending").map((c) => c.command);
  book.fact(ref, "pending_commands", pending.length ? pending.join(",") : "none");
  const latest = [...mine].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (latest) {
    book.fact(ref, "latest_command", `${latest.command} (${latest.status})`);
    const m = minutesBetween(nowMs, latest.created_at);
    if (m !== null) book.fact(ref, "latest_command_minutes_ago", m, "min");
  }
}

function workerSection(job: "worker_health" | "efficiency", raw: RawData, nowMs: number): Section {
  const book = new FactBook();
  const eligible = raw.workers.filter((w) => w.status !== "revoked" && w.status !== "pending");
  if (raw.workers.length === 0)
    return { data: false, note: "NO DATA: no workers are enrolled. Do not produce any recommendation for this section.", signals: 0, entities: [], facts: [] };
  const aggBy = new Map(raw.aggregates.map((a) => [a.worker_id, a]));
  const evals = eligible.map((w) => evalWorker(w, aggBy.get(w.id) ?? null, nowMs));
  const flagged = evals.filter((e) => (job === "worker_health" ? e.health : e.efficiency).length > 0).slice(0, BUDGET.maxEntitiesPerSection);

  const fleet = book.entity("fleet", "fleet", "fleet");
  const count = (s: string) => raw.workers.filter((w) => w.status === s).length;
  book.fact(fleet.ref, "workers_total", raw.workers.length);
  book.fact(fleet.ref, "workers_online", count("online"));
  book.fact(fleet.ref, "workers_offline", count("offline"));
  book.fact(fleet.ref, "workers_paused", count("paused"));
  book.fact(fleet.ref, "workers_pending_enrollment", count("pending"));
  const withTelemetry = eligible.filter((w) => (aggBy.get(w.id)?.recent_buckets ?? 0) > 0).length;
  book.fact(fleet.ref, "workers_with_telemetry_in_last_60_min", withTelemetry);

  for (const e of flagged) {
    const ent = book.entity("worker", e.w.name, e.w.id);
    const signals = job === "worker_health" ? e.health : e.efficiency;
    book.signals += signals.length;
    book.fact(ent.ref, "signals", signals.join(","));
    book.fact(ent.ref, "status", e.w.status);
    book.fact(ent.ref, "hardware_type", e.w.hardware_type);
    book.fact(ent.ref, "minutes_since_last_heartbeat", e.minutesSinceSeen, e.minutesSinceSeen === null ? undefined : "min");
    if (e.agg && e.agg.recent_buckets > 0 && e.agg.recent_avg_hs !== null) {
      const s = scaleHashrate(e.agg.recent_avg_hs);
      book.fact(ent.ref, "recent_avg_hashrate", s.value, s.unit);
    }
    if (e.agg && e.agg.base_buckets > 0 && e.agg.base_avg_hs !== null) {
      const s = scaleHashrate(e.agg.base_avg_hs);
      book.fact(ent.ref, "own_baseline_avg_hashrate", s.value, s.unit);
    }
    if (e.dropPct !== null) book.fact(ent.ref, "hashrate_change_vs_own_baseline_pct", r2(-e.dropPct), "%");
    if (e.agg) {
      book.fact(ent.ref, "recent_shares", e.recentShares);
      if (e.recentReject !== null) book.fact(ent.ref, "recent_reject_rate_pct", r2(e.recentReject), "%");
      if (e.baseReject !== null) book.fact(ent.ref, "own_baseline_reject_rate_pct", r2(e.baseReject), "%");
      if (e.agg.recent_max_temp_c !== null) book.fact(ent.ref, "recent_max_temperature_c", r2(e.agg.recent_max_temp_c), "C");
    }
    commandFacts(book, ent.ref, e.w.id, raw.commands, nowMs);
  }
  const note =
    book.signals === 0
      ? `Data present for ${raw.workers.length} worker(s). No worker crossed a ${job === "worker_health" ? "health" : "efficiency"} threshold, so there is nothing to recommend.`
      : `${book.signals} signal(s) on ${flagged.length} worker(s). Only flagged workers are listed; all other workers crossed no threshold.`;
  return { data: true, note, signals: book.signals, entities: book.entities, facts: book.facts };
}

// ------------------------------------------------------------------------------------------------ cloud section
const COMMITTED = new Set(["approved", "provisioning", "running"]);

function cloudSection(raw: RawData, nowMs: number): Section {
  const T = THRESHOLDS;
  const live = raw.resources.filter((r) => r.state !== "destroyed" && r.state !== "rejected");
  const hasLimits = raw.limits.some((l) => l.enabled);
  if (raw.resources.length === 0 && !hasLimits)
    return {
      data: false,
      note: "NO DATA: no cloud resources and no enabled spend limits are recorded (every cap defaults to 0). Do not produce any recommendation for this section.",
      signals: 0,
      entities: [],
      facts: [],
    };
  const book = new FactBook();
  const cloud = book.entity("cloud", "cloud", "cloud");
  const committed = live.filter((r) => COMMITTED.has(r.state));
  const knownMonthly = (rs: RawResource[]) => r2(rs.filter((r) => r.cost_known).reduce((s, r) => s + r.hourly_price_usd * HOURS_PER_MONTH, 0));
  const globalCap = Math.max(0, ...raw.limits.filter((l) => l.enabled && l.scope === "global" && l.period === "month").map((l) => l.limit_usd));

  book.fact(cloud.ref, "kill_switch_engaged", raw.killSwitchEngaged);
  for (const s of ["pending_approval", "approved", "provisioning", "running", "stopped"]) book.fact(cloud.ref, `resources_${s}`, raw.resources.filter((r) => r.state === s).length);
  book.fact(cloud.ref, "projected_monthly_committed_usd_known_prices_only", knownMonthly(committed), "USD");
  book.fact(cloud.ref, "global_monthly_cap_usd", globalCap, "USD");
  if (raw.cloudExpensesUsd !== null) book.fact(cloud.ref, `recorded_cloud_expenses_last_${WINDOWS.ledger_days}d_usd`, r2(raw.cloudExpensesUsd), "USD");
  else book.fact(cloud.ref, `recorded_cloud_expenses_last_${WINDOWS.ledger_days}d_usd`, "NO DATA (no ledger rows)");

  if (committed.length > 0 && globalCap === 0) {
    book.signals++;
    book.fact(cloud.ref, "signal", "committed_resources_but_global_monthly_cap_is_0");
  } else if (globalCap > 0) {
    const pct = (knownMonthly(committed) / globalCap) * 100;
    book.fact(cloud.ref, "global_cap_utilization_pct", r2(pct), "%");
    if (pct >= T.cap_near_pct) {
      book.signals++;
      book.fact(cloud.ref, "signal", pct >= 100 ? "global_monthly_cap_reached" : "global_monthly_cap_near");
    }
  }

  const providers = new Map(raw.providers.map((p) => [p.id, p]));
  const byProvider = new Map<string, RawResource[]>();
  for (const r of live) byProvider.set(r.provider_id, [...(byProvider.get(r.provider_id) ?? []), r]);
  let listed = 0;
  for (const [pid, rs] of byProvider) {
    const p = providers.get(pid);
    if (!p || listed >= BUDGET.maxEntitiesPerSection) continue;
    const provCap = Math.max(0, ...raw.limits.filter((l) => l.enabled && l.scope === "provider" && l.provider_id === pid && l.period === "month").map((l) => l.limit_usd));
    const provCommitted = knownMonthly(rs.filter((r) => COMMITTED.has(r.state)));
    const unknownCost = rs.filter((r) => !r.cost_known).length;
    const conditional = p.mining_policy === "allowed_with_conditions" || p.mining_policy === "requires_written_permission";
    const unmet = (p.mining_policy === "allowed_with_conditions" && !p.conditions_acknowledged) || (p.mining_policy === "requires_written_permission" && !p.written_permission_recorded);
    const pct = provCap > 0 ? (provCommitted / provCap) * 100 : null;
    const sig: string[] = [];
    if (pct !== null && pct >= T.cap_near_pct) sig.push(pct >= 100 ? "provider_monthly_cap_reached" : "provider_monthly_cap_near");
    if (provCap === 0 && rs.some((r) => COMMITTED.has(r.state))) sig.push("committed_resources_but_provider_monthly_cap_is_0");
    if (unknownCost > 0) sig.push("resources_with_unknown_price");
    if (conditional && unmet) sig.push("conditional_policy_not_satisfied");
    if (sig.length === 0 && !conditional) continue;
    listed++;
    const ent = book.entity("provider", p.name, p.id);
    book.signals += sig.length;
    book.fact(ent.ref, "signals", sig.length ? sig.join(",") : "none");
    book.fact(ent.ref, "mining_policy", p.mining_policy);
    if (conditional) book.fact(ent.ref, p.mining_policy === "allowed_with_conditions" ? "conditions_acknowledged" : "written_permission_recorded", p.mining_policy === "allowed_with_conditions" ? p.conditions_acknowledged : p.written_permission_recorded);
    book.fact(ent.ref, "resources_open", rs.length);
    book.fact(ent.ref, "resources_unknown_price", unknownCost);
    book.fact(ent.ref, "projected_monthly_committed_usd_known_prices_only", provCommitted, "USD");
    book.fact(ent.ref, "provider_monthly_cap_usd", provCap, "USD");
    if (pct !== null) book.fact(ent.ref, "provider_cap_utilization_pct", r2(pct), "%");
  }

  const pending = live.filter((r) => r.state === "pending_approval");
  if (pending.length > 0) {
    const oldestH = Math.max(...pending.map((r) => (minutesBetween(nowMs, r.created_at) ?? 0) / 60));
    book.fact(cloud.ref, "oldest_pending_approval_hours", r2(oldestH), "h");
    if (oldestH >= T.pending_approval_stale_hours) {
      book.signals++;
      book.fact(cloud.ref, "signal", "pending_approval_waiting_over_threshold");
    }
  }
  const note = book.signals === 0 ? "Cloud data present. No cap, price or policy threshold was crossed, so there is nothing to recommend." : `${book.signals} cloud/spend signal(s).`;
  return { data: true, note, signals: book.signals, entities: book.entities, facts: book.facts };
}

// ------------------------------------------------------------------------------------------------ entry point
export function buildContext(raw: RawData, jobs: readonly JobType[], now: Date): AnalysisContext {
  const nowMs = now.getTime();
  const sections: AnalysisContext["sections"] = {};
  for (const j of JOB_TYPES) {
    if (!jobs.includes(j)) continue;
    sections[j] = j === "cloud_spend" ? cloudSection(raw, nowMs) : workerSection(j, raw, nowMs);
  }
  const ctx: AnalysisContext = { generated_at: now.toISOString(), windows: WINDOWS, thresholds: THRESHOLDS, sections };
  // Facts hold only numbers, enums and operator-chosen names; this removes anything credential-shaped regardless.
  return trimToBudget(redactDeep(ctx));
}

/** Keeps the serialised context under the size budget by dropping the last entities (and their facts) whole. Never cuts JSON mid-way. */
function trimToBudget(ctx: AnalysisContext): AnalysisContext {
  while (renderContext(ctx).length > BUDGET.maxContextChars) {
    const secs = Object.values(ctx.sections).filter((s): s is Section => !!s && s.entities.filter((e) => e.kind !== "fleet" && e.kind !== "cloud").length > 0);
    if (secs.length === 0) break;
    const biggest = secs.sort((a, b) => b.facts.length - a.facts.length)[0];
    const drop = [...biggest.entities].reverse().find((e) => e.kind !== "fleet" && e.kind !== "cloud")!;
    biggest.entities = biggest.entities.filter((e) => e !== drop);
    biggest.facts = biggest.facts.filter((f) => f.ref !== drop.ref);
    biggest.note += ` (${drop.kind} list truncated for size)`;
  }
  return ctx;
}

export const totalSignals = (ctx: AnalysisContext): number => Object.values(ctx.sections).reduce((s, sec) => s + (sec?.signals ?? 0), 0);
export const hasAnyData = (ctx: AnalysisContext): boolean => Object.values(ctx.sections).some((sec) => sec?.data);

/** Serialises the model's input as compact JSON. */
export function renderContext(ctx: AnalysisContext): string {
  const compact = {
    generated_at: ctx.generated_at,
    windows: ctx.windows,
    thresholds: ctx.thresholds,
    sections: Object.fromEntries(
      Object.entries(ctx.sections).map(([k, sec]) => [
        k,
        {
          data: sec!.data,
          note: sec!.note,
          entities: sec!.entities.map((e) => ({ ref: e.ref, kind: e.kind, name: e.name })),
          facts: sec!.facts.map((f) => ({ id: f.id, ref: f.ref, metric: f.metric, value: f.value, ...(f.unit ? { unit: f.unit } : {}) })),
        },
      ]),
    ),
  };
  return JSON.stringify(compact);
}
