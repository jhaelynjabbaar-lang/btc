import { describe, expect, it } from "vitest";
import { buildContext } from "@/lib/analysis/context";
import { JOB_TYPES } from "@/lib/analysis/config";
import { extractJson, parseModelOutput, unsupportedNumbers, verifyItem } from "@/lib/analysis/schema";
import { FULL, NOW, W1, W2 } from "./fixtures";

const ctx = buildContext(FULL, JOB_TYPES, NOW);
const health = ctx.sections.worker_health!;
const w1 = health.entities.find((e) => e.stable_id === W1)!;
const fid = (ref: string, metric: string, sec = health) => sec.facts.find((f) => f.ref === ref && f.metric === metric)!.id;

const valid = () => ({
  type: "worker_health",
  severity: "warning",
  title: "test-rig-1 rejects many shares",
  rationale: "test-rig-1 has a recent reject rate of 20 % and its hashrate is -60 % versus its own baseline.",
  evidence_fact_ids: [fid(w1.ref, "recent_reject_rate_pct"), fid(w1.ref, "hashrate_change_vs_own_baseline_pct"), fid(w1.ref, "status")],
  suggested_action: { kind: "worker_command", target_ref: w1.ref, command: "pause" },
});

describe("zod parsing of model output", () => {
  it("accepts a valid recommendation and resolves evidence from the context, not from the model", () => {
    const r = verifyItem(valid(), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rec.evidence.map((e) => e.metric)).toEqual(["recent_reject_rate_pct", "hashrate_change_vs_own_baseline_pct", "status"]);
    expect(r.rec.evidence[0].value).toBe(20);
    expect(r.rec.action).toEqual({ kind: "worker_command", worker_id: W1, worker_name: "test-rig-1", command: "pause" });
    expect(r.rec.worker_id).toBe(W1);
  });

  it("rejects missing fields, bad enums and out-of-range text", () => {
    for (const bad of [
      { ...valid(), severity: "urgent" },
      { ...valid(), type: "profitability" },
      { ...valid(), title: "" },
      { ...valid(), evidence_fact_ids: [] },
      { ...valid(), rationale: "x".repeat(701) },
      (() => { const { rationale, ...rest } = valid(); void rationale; return rest; })(),
    ]) {
      const r = verifyItem(bad, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/^schema:/);
    }
  });

  it("rejects hallucinated fields and invented actions (strict objects)", () => {
    expect(verifyItem({ ...valid(), estimated_earnings_usd: 12 }, ctx)).toEqual({ ok: false, reason: expect.stringMatching(/^schema:/) });
    expect(verifyItem({ ...valid(), suggested_action: { kind: "set_spend_limit", limit_usd: 500 } }, ctx).ok).toBe(false);
    expect(verifyItem({ ...valid(), suggested_action: { kind: "approve_cloud_resource", id: "x" } }, ctx).ok).toBe(false);
    expect(verifyItem({ ...valid(), suggested_action: { kind: "worker_command", target_ref: w1.ref, command: "format_disk" } }, ctx).ok).toBe(false);
    expect(verifyItem({ ...valid(), suggested_action: { kind: "worker_command", target_ref: w1.ref, command: "pause", worker_id: W2 } }, ctx).ok).toBe(false);
  });

  it("rejects evidence that is not in the provided facts", () => {
    expect(verifyItem({ ...valid(), evidence_fact_ids: ["F999"] }, ctx)).toEqual({ ok: false, reason: "evidence_not_in_context" });
  });

  it("rejects numbers in the text that are not provided facts", () => {
    const r = verifyItem({ ...valid(), rationale: "test-rig-1 lost 73 % of its hashrate and may earn 0.0004 BTC less per day." }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^number_not_in_facts:/);
    expect(unsupportedNumbers("reject rate 20 % over 60 minutes", ctx, "worker_health")).toEqual([]);
  });

  it("rejects an action on a worker that is not listed, or that is not in the cited evidence", () => {
    expect(verifyItem({ ...valid(), suggested_action: { kind: "worker_command", target_ref: "W42", command: "pause" } }, ctx).ok).toBe(false);
    const w3 = health.entities.find((e) => e.name === "test-rig-3")!;
    const r = verifyItem({ ...valid(), suggested_action: { kind: "worker_command", target_ref: w3.ref, command: "pause" } }, ctx);
    expect(r).toEqual({ ok: false, reason: "action_target_not_in_evidence" });
  });

  it("rejects a command that makes no sense for the worker's status, and worker commands on cloud recommendations", () => {
    expect(verifyItem({ ...valid(), suggested_action: { kind: "worker_command", target_ref: w1.ref, command: "start" } }, ctx)).toEqual({ ok: false, reason: "command_not_applicable_to_status" });
    const cloud = ctx.sections.cloud_spend!;
    const cf = cloud.facts.find((f) => f.metric === "global_cap_utilization_pct")!;
    const base = { type: "cloud_spend", severity: "warning", title: "Spend is near the global cap", rationale: "Committed spend is at 91.25 % of the global monthly cap.", evidence_fact_ids: [cf.id] };
    expect(verifyItem({ ...base, suggested_action: { kind: "review_cloud" } }, ctx).ok).toBe(true);
    expect(verifyItem({ ...base, suggested_action: { kind: "worker_command", target_ref: w1.ref, command: "stop" } }, ctx)).toEqual({ ok: false, reason: "worker_command_on_cloud_rec" });
    expect(verifyItem({ ...valid(), suggested_action: { kind: "review_cloud" } }, ctx)).toEqual({ ok: false, reason: "review_cloud_on_non_cloud_rec" });
  });

  it("produces no recommendation for a section that has no data", () => {
    const empty = buildContext({ ...FULL, resources: [], limits: [] }, JOB_TYPES, NOW);
    const r = verifyItem({ type: "cloud_spend", severity: "info", title: "Cloud looks fine", rationale: "No cloud records exist at all.", evidence_fact_ids: ["F1"], suggested_action: { kind: "none" } }, empty);
    expect(r).toEqual({ ok: false, reason: "section_has_no_data" });
  });

  it("extracts JSON from fenced or chatty output and keeps good items when one is bad", () => {
    expect(extractJson("not json")).toBeNull();
    const out = "Here you go:\n```json\n" + JSON.stringify({ recommendations: [valid(), { nonsense: true }] }) + "\n```";
    const p = parseModelOutput(out, ctx);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.valid).toHaveLength(1);
    expect(p.discarded).toEqual([{ index: 1, reason: expect.stringMatching(/^schema:/) }]);
  });

  it("fails the whole output when it is not the expected envelope", () => {
    expect(parseModelOutput("I think everything is fine.", ctx)).toEqual({ ok: false, reason: "not_json" });
    expect(parseModelOutput(JSON.stringify({ recommendations: "none" }), ctx)).toEqual({ ok: false, reason: "envelope_invalid" });
    expect(parseModelOutput(JSON.stringify({ recommendations: [] }), ctx)).toEqual({ ok: true, valid: [], discarded: [] });
  });

  it("dedupes identical recommendations and gives a stable dedupe key across runs", () => {
    const a = parseModelOutput(JSON.stringify({ recommendations: [valid(), valid()] }), ctx);
    expect(a.ok && a.valid.length).toBe(1);
    const ctx2 = buildContext(FULL, JOB_TYPES, new Date(NOW.getTime() + 1000));
    const w = ctx2.sections.worker_health!;
    const e = w.entities.find((x) => x.stable_id === W1)!;
    const v2 = { ...valid(), evidence_fact_ids: [fid(e.ref, "recent_reject_rate_pct", w), fid(e.ref, "hashrate_change_vs_own_baseline_pct", w), fid(e.ref, "status", w)], suggested_action: { kind: "worker_command", target_ref: e.ref, command: "pause" } };
    const k1 = verifyItem(valid(), ctx);
    const k2 = verifyItem(v2, ctx2);
    expect(k1.ok && k2.ok && k1.rec.dedupe_key === k2.rec.dedupe_key).toBe(true);
  });
});
