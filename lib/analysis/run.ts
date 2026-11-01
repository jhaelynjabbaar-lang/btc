import { BUDGET, MANUAL_RUN_COOLDOWN_MS, type JobType } from "./config";
import { buildContext, hasAnyData, totalSignals, type RawData } from "./context";
import { buildMessages } from "./prompt";
import { parseModelOutput, type Discard, type ValidRecommendation } from "./schema";

/**
 * Orchestration of one analysis run, with every side effect injected so it is unit-tested with a mocked model and an in-memory store.
 * The model is only ever asked to EXPLAIN signals computed from real rows; it has no tools and no path to any write except
 * "propose a row in ai_recommendations", which a human must still accept.
 */

export type ModelResult = { content: string; model: string; usage?: { totalTokens: number } | null };
export type ModelCaller = (messages: ReturnType<typeof buildMessages>) => Promise<ModelResult>;

export type RunDeps = {
  now: () => Date;
  newId: () => string;
  loadRaw: (now: Date) => Promise<RawData>;
  callModel: ModelCaller;
  modelName: string;
  /** Latest `ai.analysis.started` timestamp, from the durable audit log. */
  lastStartedAt: () => Promise<Date | null>;
  audit: (action: "ai.analysis.started" | "ai.analysis.completed" | "ai.analysis.failed", runId: string, details: Record<string, unknown>) => Promise<void>;
  openDedupeKeys: () => Promise<Set<string>>;
  insertRecommendations: (rows: StoredRecommendation[]) => Promise<void>;
  log: (event: string, data: Record<string, unknown>) => void;
};

export type StoredRecommendation = {
  run_id: string;
  job: string;
  rec: ValidRecommendation;
  model: string;
  context_generated_at: string;
};

export type RunOutcome =
  | { ok: false; reason: "rate_limited"; retryAfterSec: number }
  | { ok: false; reason: "model_error" | "bad_output" | "load_failed" | "store_failed"; runId: string; message: string }
  | {
      ok: true;
      runId: string;
      modelCalled: boolean;
      model: string | null;
      created: number;
      skippedDuplicates: number;
      discarded: Discard[];
      signals: number;
      note: string;
    };

export async function runAnalysis(jobs: readonly JobType[], deps: RunDeps, opts: { enforceCooldown: boolean } = { enforceCooldown: true }): Promise<RunOutcome> {
  const now = deps.now();
  if (opts.enforceCooldown) {
    const last = await deps.lastStartedAt();
    if (last && now.getTime() - last.getTime() < MANUAL_RUN_COOLDOWN_MS) {
      return { ok: false, reason: "rate_limited", retryAfterSec: Math.max(1, Math.ceil((MANUAL_RUN_COOLDOWN_MS - (now.getTime() - last.getTime())) / 1000)) };
    }
  }
  const runId = deps.newId();
  // Recorded BEFORE any work so concurrent or failing runs still count against the cooldown.
  await deps.audit("ai.analysis.started", runId, { jobs });

  let raw: RawData;
  try {
    raw = await deps.loadRaw(now);
  } catch {
    await deps.audit("ai.analysis.failed", runId, { stage: "load", error: "load_failed" });
    return { ok: false, reason: "load_failed", runId, message: "The platform data could not be read." };
  }

  const ctx = buildContext(raw, jobs, now);
  const signals = totalSignals(ctx);
  if (!hasAnyData(ctx) || signals === 0) {
    // Nothing to explain: do NOT call the model (no cost, and nothing it could invent).
    const note = !hasAnyData(ctx) ? "No data to analyze (no workers or cloud records yet). The model was not called." : "No metric crossed a threshold. The model was not called.";
    await deps.audit("ai.analysis.completed", runId, { jobs, model_called: false, signals, created: 0, discarded: 0, note });
    return { ok: true, runId, modelCalled: false, model: null, created: 0, skippedDuplicates: 0, discarded: [], signals, note };
  }

  let result: ModelResult;
  try {
    result = await deps.callModel(buildMessages(ctx));
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "model_error";
    deps.log("ai.analysis.model_error", { runId, code });
    await deps.audit("ai.analysis.failed", runId, { stage: "model", error: code });
    return { ok: false, reason: "model_error", runId, message: "The AI provider could not complete the analysis." };
  }

  const parsed = parseModelOutput(result.content, ctx);
  if (!parsed.ok) {
    // Invalid output is discarded and logged (reason only, never the raw text), not stored.
    deps.log("ai.analysis.invalid_output", { runId, reason: parsed.reason, chars: result.content.length });
    await deps.audit("ai.analysis.failed", runId, { stage: "parse", error: parsed.reason, model: result.model });
    return { ok: false, reason: "bad_output", runId, message: "The model's answer was not valid structured output and was discarded." };
  }
  if (parsed.discarded.length) deps.log("ai.analysis.items_discarded", { runId, discarded: parsed.discarded });

  const open = await deps.openDedupeKeys();
  const fresh = parsed.valid.filter((v) => !open.has(v.dedupe_key));
  const rows: StoredRecommendation[] = fresh.map((rec) => ({ run_id: runId, job: rec.type, rec, model: result.model || deps.modelName, context_generated_at: ctx.generated_at }));
  if (rows.length) {
    try {
      await deps.insertRecommendations(rows);
    } catch {
      await deps.audit("ai.analysis.failed", runId, { stage: "store", error: "insert_failed", model: result.model });
      return { ok: false, reason: "store_failed", runId, message: "The recommendations could not be stored." };
    }
  }

  const skippedDuplicates = parsed.valid.length - fresh.length;
  await deps.audit("ai.analysis.completed", runId, {
    jobs,
    model_called: true,
    model: result.model,
    signals,
    created: rows.length,
    skipped_duplicates: skippedDuplicates,
    discarded: parsed.discarded.length,
    discard_reasons: parsed.discarded.map((d) => d.reason.split(":")[0]),
    total_tokens: result.usage?.totalTokens ?? null,
    max_completion_tokens: BUDGET.maxCompletionTokens,
  });
  return { ok: true, runId, modelCalled: true, model: result.model, created: rows.length, skippedDuplicates, discarded: parsed.discarded, signals, note: `${rows.length} recommendation(s) stored.` };
}
