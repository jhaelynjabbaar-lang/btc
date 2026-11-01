import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chatCompletion } from "@/lib/ai/openrouter";
import { getAiConfig } from "@/lib/ai/config";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import { ownerIdFor, type CloudActor } from "@/lib/cloud/service";
import { BUDGET, STATUS_FROM_DB, WINDOWS, type JobType, type RecStatus } from "./config";
import type { RawData } from "./context";
import { redactString } from "./redact";
import { runAnalysis, type RunDeps, type RunOutcome } from "./run";
import { decideRecommendation, type DecideResult, type Rpc } from "./decide";

/**
 * Server-only wiring: Supabase reads (real rows only), the existing OpenRouter client (OPENROUTER_API_KEY / AI_MODEL, server-side),
 * the audit log and ai_recommendations. Nothing here is importable from a client component.
 */

const num = z.coerce.number().catch(0);
const nnum = z.union([z.coerce.number(), z.null()]).catch(null);
const Aggregates = z.array(
  z.object({
    worker_id: z.string(),
    recent_buckets: num,
    recent_avg_hs: nnum,
    recent_accepted: num,
    recent_rejected: num,
    recent_max_temp_c: nnum,
    base_buckets: num,
    base_avg_hs: nnum,
    base_accepted: num,
    base_rejected: num,
    last_bucket: z.string().nullable().catch(null),
  }),
);

async function loadRaw(actor: CloudActor, now: Date): Promise<RawData> {
  const db = getSupabaseServer();
  const owner = ownerIdFor(actor);
  const since = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const [workers, agg, commands, providers, resources, limits, controls, ledger] = await Promise.all([
    db.from("workers").select("id, name, status, hardware_type, current_hashrate_hs, last_seen_at").limit(200),
    (db.rpc as unknown as (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>)("ai_worker_aggregates", {
      p_now: now.toISOString(),
      p_recent_minutes: WINDOWS.recent_minutes,
      p_baseline_days: WINDOWS.baseline_days,
    }),
    db.from("worker_commands").select("worker_id, command, status, created_at, expires_at").gte("created_at", since(WINDOWS.command_history_days)).order("created_at", { ascending: false }).limit(300),
    db.from("cloud_providers").select("id, name, mining_policy, conditions_acknowledged_at, written_permission_ref").limit(50),
    db.from("cloud_resources").select("id, provider_id, label, state, cost_known, hourly_price_usd, state_changed_at, created_at").eq("owner_id", owner).limit(200),
    db.from("spend_limits").select("scope, provider_id, period, limit_usd, enabled").eq("owner_id", owner).limit(100),
    db.from("cloud_controls").select("kill_switch_engaged").eq("owner_id", owner).maybeSingle(),
    db.from("ledger").select("amount_usd").eq("owner_id", owner).eq("kind", "expense_cloud").gte("occurred_at", since(WINDOWS.ledger_days)).limit(1000),
  ]);
  for (const r of [workers, commands, providers, resources, limits, controls, ledger]) if (r.error) throw new Error("query failed");
  if (agg.error) throw new Error("aggregate query failed");
  const nowMs = now.getTime();
  const expenses = (ledger.data ?? []).map((l) => Number(l.amount_usd)).filter((n) => Number.isFinite(n));
  return {
    workers: (workers.data ?? []).map((w) => ({ ...w, current_hashrate_hs: Number(w.current_hashrate_hs) })),
    aggregates: Aggregates.parse(agg.data ?? []),
    commands: (commands.data ?? []).map((c) => ({
      worker_id: c.worker_id,
      command: c.command,
      // A 'pending' command past its expiry is no longer pending.
      status: c.status === "pending" && Date.parse(c.expires_at) <= nowMs ? "expired" : c.status,
      created_at: c.created_at,
    })),
    providers: (providers.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      mining_policy: p.mining_policy,
      conditions_acknowledged: Boolean(p.conditions_acknowledged_at),
      written_permission_recorded: Boolean(p.written_permission_ref?.trim()),
    })),
    resources: (resources.data ?? []).map((r) => ({ ...r, hourly_price_usd: Number(r.hourly_price_usd) })),
    limits: (limits.data ?? []).map((l) => ({
      scope: l.scope as "global" | "provider",
      provider_id: l.provider_id,
      period: l.period as "hour" | "day" | "month",
      limit_usd: Number(l.limit_usd),
      enabled: l.enabled,
    })),
    killSwitchEngaged: controls.data?.kill_switch_engaged ?? false,
    cloudExpensesUsd: expenses.length ? expenses.reduce((a, b) => a + b, 0) : null,
  };
}

function makeDeps(actor: CloudActor, actorName: string): RunDeps {
  const db = getSupabaseServer();
  const owner = ownerIdFor(actor);
  return {
    now: () => new Date(),
    newId: () => randomUUID(),
    loadRaw: (now) => loadRaw(actor, now),
    callModel: async (messages) => {
      const r = await chatCompletion({
        messages,
        maxTokens: BUDGET.maxCompletionTokens,
        temperature: 0,
        timeoutMs: BUDGET.modelTimeoutMs,
        reasoningEffort: BUDGET.reasoningEffort,
      });
      return { content: r.content, model: r.model, usage: r.usage ? { totalTokens: r.usage.totalTokens } : null };
    },
    modelName: getAiConfig().model,
    lastStartedAt: async () => {
      const r = await db.from("audit_log").select("occurred_at").eq("action", "ai.analysis.started").order("id", { ascending: false }).limit(1).maybeSingle();
      if (r.error) throw new Error("rate-limit lookup failed");
      return r.data ? new Date(r.data.occurred_at) : null;
    },
    audit: async (action, runId, details) => {
      const r = await db.from("audit_log").insert({ actor: actorName, action, entity_type: "ai_analysis", entity_id: runId, details: details as Json });
      if (r.error) throw new Error("audit write failed");
    },
    openDedupeKeys: async () => {
      const r = await db.from("ai_recommendations").select("dedupe_key").eq("owner_id", owner).eq("status", "pending").not("dedupe_key", "is", null).limit(500);
      if (r.error) throw new Error("dedupe lookup failed");
      return new Set((r.data ?? []).map((x) => x.dedupe_key as string));
    },
    insertRecommendations: async (rows) => {
      const payload = rows.map((s) => ({
        owner_id: owner,
        worker_id: s.rec.worker_id,
        kind: s.rec.type,
        job: s.job,
        run_id: s.run_id,
        severity: s.rec.severity,
        title: s.rec.title,
        explanation: s.rec.rationale,
        inputs: { context_generated_at: s.context_generated_at, windows: WINDOWS, facts: s.rec.evidence } as unknown as Json,
        suggested_action: (s.rec.action.kind === "worker_command"
          ? { kind: "worker_command", worker_id: s.rec.action.worker_id, worker_name: s.rec.action.worker_name, command: s.rec.action.command }
          : s.rec.action) as unknown as Json,
        model: s.model,
        dedupe_key: s.rec.dedupe_key,
      }));
      const r = await db.from("ai_recommendations").insert(payload);
      if (r.error) throw new Error("insert failed");
    },
    log: (event, data) => console.warn(redactString(JSON.stringify({ event, ...data }))),
  };
}

export function runAnalysisServer(jobs: readonly JobType[], actor: CloudActor, opts: { enforceCooldown: boolean; auditActor?: string }): Promise<RunOutcome> {
  return runAnalysis(jobs, makeDeps(actor, opts.auditActor ?? actor.login ?? "owner"), { enforceCooldown: opts.enforceCooldown });
}

export function decideServer(args: { id: string; decision: "accept" | "dismiss"; confirm?: boolean }, actor: CloudActor): Promise<DecideResult> {
  const db = getSupabaseServer();
  const rpc: Rpc = (name, a) => (db.rpc as unknown as Rpc)(name, a);
  return decideRecommendation({ ...args, owner: ownerIdFor(actor), actor: actor.login ?? "owner" }, rpc);
}

// ------------------------------------------------------------------------------------------------ page data
export type RecView = {
  id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  rationale: string;
  evidence: Array<{ ref: string; name: string; metric: string; value: string | number | boolean | null; unit?: string }>;
  action: { kind: "none" } | { kind: "review_cloud" } | { kind: "worker_command"; worker_id: string; worker_name: string; command: string };
  status: RecStatus;
  model: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export type AiPageData = {
  recs: RecView[];
  lastRun: { at: string; status: "completed" | "failed" | "started"; modelCalled: boolean | null; created: number | null; discarded: number | null; note?: string } | null;
  model: string;
  configured: boolean;
};

const ViewAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("review_cloud") }),
  z.object({ kind: z.literal("worker_command"), worker_id: z.string(), worker_name: z.string().catch(""), command: z.string() }),
]);

export async function loadAiPage(actor: CloudActor): Promise<AiPageData> {
  const db = getSupabaseServer();
  const owner = ownerIdFor(actor);
  const cfg = getAiConfig();
  const [recs, runs] = await Promise.all([
    db.from("ai_recommendations").select("*").eq("owner_id", owner).in("kind", ["worker_health", "efficiency", "cloud_spend"]).order("created_at", { ascending: false }).limit(100),
    db.from("audit_log").select("id, occurred_at, action, entity_id, details").in("action", ["ai.analysis.started", "ai.analysis.completed", "ai.analysis.failed"]).order("id", { ascending: false }).limit(10),
  ]);
  if (recs.error || runs.error) throw new Error("query failed");
  const rows: RecView[] = (recs.data ?? []).map((r) => {
    const inputs = (r.inputs ?? {}) as { facts?: RecView["evidence"] };
    const action = ViewAction.safeParse(r.suggested_action);
    return {
      id: r.id,
      type: r.kind,
      severity: (["info", "warning", "critical"] as const).find((s) => s === r.severity) ?? "info",
      title: r.title ?? r.kind,
      rationale: r.explanation,
      evidence: Array.isArray(inputs.facts) ? inputs.facts : [],
      action: action.success ? action.data : { kind: "none" },
      status: STATUS_FROM_DB[r.status as keyof typeof STATUS_FROM_DB] ?? "proposed",
      model: r.model,
      created_at: r.created_at,
      decided_at: r.decided_at,
      decided_by: r.decided_by,
    };
  });
  const latest = (runs.data ?? [])[0];
  let lastRun: AiPageData["lastRun"] = null;
  if (latest) {
    // The newest terminal entry for the newest run, otherwise "started" (still running or interrupted).
    const terminal = (runs.data ?? []).find((x) => x.entity_id === latest.entity_id && x.action !== "ai.analysis.started");
    const d = ((terminal ?? latest).details ?? {}) as Record<string, unknown>;
    lastRun = {
      at: latest.occurred_at,
      status: terminal ? (terminal.action === "ai.analysis.completed" ? "completed" : "failed") : "started",
      modelCalled: typeof d.model_called === "boolean" ? d.model_called : null,
      created: typeof d.created === "number" ? d.created : null,
      discarded: typeof d.discarded === "number" ? d.discarded : null,
      note: typeof d.note === "string" ? d.note : typeof d.error === "string" ? `Failed at ${String(d.stage ?? "run")}: ${d.error}` : undefined,
    };
  }
  return { recs: rows, lastRun, model: cfg.model, configured: cfg.configured };
}
