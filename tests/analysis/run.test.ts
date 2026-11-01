import { describe, expect, it, vi } from "vitest";
import { JOB_TYPES, MANUAL_RUN_COOLDOWN_MS } from "@/lib/analysis/config";
import { buildContext, type RawData } from "@/lib/analysis/context";
import { runAnalysis, type RunDeps, type StoredRecommendation } from "@/lib/analysis/run";
import { EMPTY, FULL, NOW, W1 } from "./fixtures";

const ctx = buildContext(FULL, JOB_TYPES, NOW);
const w1 = ctx.sections.worker_health!.entities.find((e) => e.stable_id === W1)!;
const f = (metric: string) => ctx.sections.worker_health!.facts.find((x) => x.ref === w1.ref && x.metric === metric)!.id;
const goodItem = {
  type: "worker_health",
  severity: "warning",
  title: "test-rig-1 rejects many shares",
  rationale: "test-rig-1 has a recent reject rate of 20 % and its hashrate is -60 % versus its own baseline.",
  evidence_fact_ids: [f("recent_reject_rate_pct"), f("hashrate_change_vs_own_baseline_pct"), f("status")],
  suggested_action: { kind: "worker_command", target_ref: w1.ref, command: "pause" },
};

function harness(raw: RawData, model: (n: number) => Promise<{ content: string; model: string }>, over: Partial<RunDeps> = {}) {
  const audits: Array<[string, Record<string, unknown>]> = [];
  const stored: StoredRecommendation[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  let calls = 0;
  const callModel = vi.fn(async () => model(++calls));
  const deps: RunDeps = {
    now: () => NOW,
    newId: () => "run-1",
    loadRaw: async () => raw,
    callModel,
    modelName: "nvidia/nemotron-3-ultra-550b-a55b",
    lastStartedAt: async () => null,
    audit: async (a, _id, d) => void audits.push([a, d]),
    openDedupeKeys: async () => new Set(),
    insertRecommendations: async (rows) => void stored.push(...rows),
    log: (e, d) => void logs.push([e, d]),
    ...over,
  };
  return { deps, audits, stored, logs, callModel };
}
const ok = (o: unknown) => async () => ({ content: JSON.stringify(o), model: "nvidia/nemotron-3-ultra-550b-a55b" });

describe("analysis run with a MOCKED model (no network, no key)", () => {
  it("empty database: says so, never calls the model, stores nothing", async () => {
    const h = harness(EMPTY, ok({ recommendations: [goodItem] }));
    const out = await runAnalysis(JOB_TYPES, h.deps);
    expect(out).toMatchObject({ ok: true, modelCalled: false, created: 0 });
    expect(h.callModel).not.toHaveBeenCalled();
    expect(h.stored).toHaveLength(0);
    expect(h.audits.map((a) => a[0])).toEqual(["ai.analysis.started", "ai.analysis.completed"]);
  });

  it("data but no threshold crossed: model not called", async () => {
    const quiet: RawData = { ...FULL, workers: [FULL.workers[1]], aggregates: [FULL.aggregates[1]], resources: [], limits: [] };
    const h = harness(quiet, ok({ recommendations: [goodItem] }));
    const out = await runAnalysis(JOB_TYPES, h.deps);
    expect(out).toMatchObject({ ok: true, modelCalled: false });
    expect(h.callModel).not.toHaveBeenCalled();
  });

  it("valid output is stored with model name, evidence and the suggested action; audit has start + completion", async () => {
    const h = harness(FULL, ok({ recommendations: [goodItem] }));
    const out = await runAnalysis(JOB_TYPES, h.deps);
    expect(out).toMatchObject({ ok: true, modelCalled: true, created: 1, model: "nvidia/nemotron-3-ultra-550b-a55b" });
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0].rec.action).toMatchObject({ kind: "worker_command", command: "pause", worker_id: W1 });
    expect(h.stored[0].rec.evidence.length).toBe(3);
    expect(h.audits[1][1]).toMatchObject({ model_called: true, created: 1 });
  });

  it("sends the model only the system prompt and the compact context (no secrets, size bounded)", async () => {
    const h = harness(FULL, ok({ recommendations: [] }));
    await runAnalysis(JOB_TYPES, h.deps);
    const messages = (h.callModel.mock.calls[0] as unknown as [Array<{ role: string; content: string }>])[0];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0].content).toMatch(/cannot run commands|RECOMMEND only/);
    expect(messages[0].content).toMatch(/Cite ONLY the provided facts/);
    expect(messages[1].content.length).toBeLessThan(9500);
    expect(messages[1].content).not.toMatch(/sk-or-|sb_secret_|eyJ/);
  });

  it("invalid output (not JSON) is discarded and logged, never stored", async () => {
    const h = harness(FULL, async () => ({ content: "Sure! Everything looks great.", model: "m" }));
    const out = await runAnalysis(JOB_TYPES, h.deps);
    expect(out).toMatchObject({ ok: false, reason: "bad_output" });
    expect(h.stored).toHaveLength(0);
    expect(h.logs[0][0]).toBe("ai.analysis.invalid_output");
    expect(JSON.stringify(h.logs)).not.toContain("Everything looks great"); // raw model text is not logged
    expect(h.audits.at(-1)![0]).toBe("ai.analysis.failed");
  });

  it("hallucinated items are dropped, valid ones kept, and the drop is logged", async () => {
    const bad = { ...goodItem, rationale: "test-rig-1 will earn 0.5 BTC less.", estimated_earnings: 1 };
    const h = harness(FULL, ok({ recommendations: [bad, goodItem] }));
    const out = await runAnalysis(JOB_TYPES, h.deps);
    expect(out).toMatchObject({ ok: true, created: 1 });
    expect(h.logs.some((l) => l[0] === "ai.analysis.items_discarded")).toBe(true);
    expect((out as { discarded: unknown[] }).discarded).toHaveLength(1);
  });

  it("does not stack a recommendation that is already open", async () => {
    const first = harness(FULL, ok({ recommendations: [goodItem] }));
    await runAnalysis(JOB_TYPES, first.deps);
    const keys = new Set(first.stored.map((s) => s.rec.dedupe_key));
    const h = harness(FULL, ok({ recommendations: [goodItem] }), { openDedupeKeys: async () => keys });
    const out = await runAnalysis(JOB_TYPES, h.deps);
    expect(out).toMatchObject({ ok: true, created: 0, skippedDuplicates: 1 });
    expect(h.stored).toHaveLength(0);
  });

  it("rate limits manual runs to one per minute (counted from the audit log) and does not call the model", async () => {
    const h = harness(FULL, ok({ recommendations: [] }), { lastStartedAt: async () => new Date(NOW.getTime() - 20_000) });
    const out = await runAnalysis(JOB_TYPES, h.deps);
    expect(out).toEqual({ ok: false, reason: "rate_limited", retryAfterSec: 40 });
    expect(h.callModel).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
    const later = harness(FULL, ok({ recommendations: [] }), { lastStartedAt: async () => new Date(NOW.getTime() - MANUAL_RUN_COOLDOWN_MS - 1) });
    expect((await runAnalysis(JOB_TYPES, later.deps)).ok).toBe(true);
  });

  it("provider errors are handled: nothing stored, failure audited with a safe code only", async () => {
    const err = Object.assign(new Error("provider said: key sk-or-v1-abcdef0123456789abcdef0123"), { code: "timeout" });
    const h = harness(FULL, async () => { throw err; });
    const out = await runAnalysis(JOB_TYPES, h.deps);
    expect(out).toMatchObject({ ok: false, reason: "model_error" });
    expect(JSON.stringify([h.audits, h.logs])).not.toContain("sk-or-");
    expect(h.audits.at(-1)).toEqual(["ai.analysis.failed", { stage: "model", error: "timeout" }]);
  });

  it("data load failure and store failure are audited, not thrown", async () => {
    const a = harness(FULL, ok({ recommendations: [] }), { loadRaw: async () => { throw new Error("db down"); } });
    expect(await runAnalysis(JOB_TYPES, a.deps)).toMatchObject({ ok: false, reason: "load_failed" });
    const b = harness(FULL, ok({ recommendations: [goodItem] }), { insertRecommendations: async () => { throw new Error("nope"); } });
    expect(await runAnalysis(JOB_TYPES, b.deps)).toMatchObject({ ok: false, reason: "store_failed" });
  });
});
