import { createHash } from "node:crypto";
import { z } from "zod";
import { BUDGET, JOB_TYPES, SEVERITIES, type JobType, type Severity } from "./config";
import type { AnalysisContext, Entity, Fact, Section } from "./context";

/**
 * What the model may return, and the checks that stop it inventing anything.
 *  1. Shape: strict zod objects. Unknown keys ("hallucinated fields") fail the item.
 *  2. Grounding: evidence is a list of fact ids from the context; the stored evidence is resolved from the context, never from model text.
 *  3. Numbers: every number the model writes must be one of the facts (or a window/threshold constant).
 *  4. Actions: only worker_command (start|pause|stop on a worker that is in the context) or review_cloud; nothing else exists.
 */

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

const ActionNone = z.strictObject({ kind: z.literal("none") });
const ActionWorker = z.strictObject({ kind: z.literal("worker_command"), target_ref: z.string().regex(/^W\d{1,3}$/), command: z.enum(["start", "pause", "stop"]) });
const ActionCloud = z.strictObject({ kind: z.literal("review_cloud") });

export const RecommendationSchema = z.strictObject({
  type: z.enum(JOB_TYPES),
  severity: z.enum(SEVERITIES),
  title: text(3, 120),
  rationale: text(10, 700),
  evidence_fact_ids: z.array(z.string().regex(/^F\d{1,4}$/)).min(1).max(10),
  suggested_action: z.discriminatedUnion("kind", [ActionNone, ActionWorker, ActionCloud]),
});
export type ModelRecommendation = z.infer<typeof RecommendationSchema>;

/** The envelope is parsed loosely (array of unknown) so one bad item does not discard the good ones; each item is then strict. */
const Envelope = z.object({ recommendations: z.array(z.unknown()).max(40) });

// ------------------------------------------------------------------------------------------------ JSON extraction
/** Models sometimes wrap JSON in fences or prose. Extract the outermost object; never evaluate anything. */
export function extractJson(raw: string): unknown | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ verification
export type Discard = { index: number; reason: string };

export type ValidRecommendation = {
  type: JobType;
  severity: Severity;
  title: string;
  rationale: string;
  evidence: Array<{ ref: string; name: string; metric: string; value: Fact["value"]; unit?: string }>;
  action: { kind: "none" } | { kind: "review_cloud" } | { kind: "worker_command"; worker_id: string; worker_name: string; command: "start" | "pause" | "stop" };
  dedupe_key: string;
  worker_id: string | null;
};

const NUM = /-?\d+(?:\.\d+)?/g;

function allowedNumbers(ctx: AnalysisContext, type: JobType): number[] {
  const out: number[] = [];
  const push = (o: Record<string, unknown>) => Object.values(o).forEach((v) => typeof v === "number" && out.push(v));
  push(ctx.windows);
  push(ctx.thresholds);
  // Only the facts of the recommendation's own section count: a number from another section is not evidence for this one.
  for (const f of ctx.sections[type]?.facts ?? []) if (typeof f.value === "number") out.push(f.value, Math.abs(f.value));
  return out;
}

/** Numbers in free text that are not present in the provided facts. Entity refs like W1/F3 and entity names are ignored. */
export function unsupportedNumbers(textIn: string, ctx: AnalysisContext, type: JobType): string[] {
  const names = Object.values(ctx.sections).flatMap((s) => s?.entities.map((e) => e.name) ?? []);
  let t = textIn;
  for (const n of names.sort((a, b) => b.length - a.length)) if (n.length > 1) t = t.split(n).join(" ");
  t = t.replace(/\b(?:F|W|P|R)\d+\b/g, " ");
  const allowed = allowedNumbers(ctx, type);
  const bad: string[] = [];
  for (const m of t.match(NUM) ?? []) {
    const x = Number(m);
    if (!allowed.some((a) => Math.abs(a - x) <= Math.max(0.011, Math.abs(a) * 0.005))) bad.push(m);
  }
  return bad;
}

const sectionFor = (ctx: AnalysisContext, type: JobType): Section | undefined => ctx.sections[type];

export function dedupeKey(type: JobType, parts: string[]): string {
  return createHash("sha256").update([type, ...[...new Set(parts)].sort()].join("|")).digest("hex").slice(0, 32);
}

/** Validates one raw item against the schema AND the context. Returns the sanitized recommendation or the reason it was discarded. */
export function verifyItem(item: unknown, ctx: AnalysisContext): { ok: true; rec: ValidRecommendation } | { ok: false; reason: string } {
  const parsed = RecommendationSchema.safeParse(item);
  if (!parsed.success) return { ok: false, reason: `schema:${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}:${i.code}`).join(",")}` };
  const r = parsed.data;
  const sec = sectionFor(ctx, r.type);
  if (!sec) return { ok: false, reason: "section_not_requested" };
  if (!sec.data) return { ok: false, reason: "section_has_no_data" };
  if (sec.signals === 0) return { ok: false, reason: "section_has_no_signals" };

  const byId = new Map(sec.facts.map((f) => [f.id, f]));
  const entityByRef = new Map(sec.entities.map((e) => [e.ref, e]));
  const facts: Fact[] = [];
  for (const id of new Set(r.evidence_fact_ids)) {
    const f = byId.get(id);
    if (!f) return { ok: false, reason: "evidence_not_in_context" };
    facts.push(f);
  }
  const bad = unsupportedNumbers(`${r.title} ${r.rationale}`, ctx, r.type);
  if (bad.length) return { ok: false, reason: `number_not_in_facts:${bad.slice(0, 3).join("|")}` };

  let action: ValidRecommendation["action"] = { kind: "none" };
  let worker_id: string | null = null;
  if (r.suggested_action.kind === "worker_command") {
    if (r.type === "cloud_spend") return { ok: false, reason: "worker_command_on_cloud_rec" };
    const ent: Entity | undefined = entityByRef.get(r.suggested_action.target_ref);
    if (!ent || ent.kind !== "worker") return { ok: false, reason: "action_target_not_a_listed_worker" };
    if (!facts.some((f) => f.ref === ent.ref)) return { ok: false, reason: "action_target_not_in_evidence" };
    const status = sec.facts.find((f) => f.ref === ent.ref && f.metric === "status")?.value;
    const cmd = r.suggested_action.command;
    // A stop/pause only makes sense for a worker that is running; start only for one that is not.
    if ((cmd === "pause" || cmd === "stop") && status !== "online") return { ok: false, reason: "command_not_applicable_to_status" };
    if (cmd === "start" && status === "online") return { ok: false, reason: "command_not_applicable_to_status" };
    const pending = sec.facts.find((f) => f.ref === ent.ref && f.metric === "pending_commands")?.value;
    if (typeof pending === "string" && pending.split(",").includes(cmd)) return { ok: false, reason: "command_already_pending" };
    action = { kind: "worker_command", worker_id: ent.stable_id, worker_name: ent.name, command: cmd };
    worker_id = ent.stable_id;
  } else if (r.suggested_action.kind === "review_cloud") {
    if (r.type !== "cloud_spend") return { ok: false, reason: "review_cloud_on_non_cloud_rec" };
    action = { kind: "review_cloud" };
  }

  const stable = (ref: string) => entityByRef.get(ref)?.stable_id ?? ref;
  const evidence = facts.map((f) => ({ ref: f.ref, name: entityByRef.get(f.ref)?.name ?? f.ref, metric: f.metric, value: f.value, ...(f.unit ? { unit: f.unit } : {}) }));
  return {
    ok: true,
    rec: {
      type: r.type,
      severity: r.severity,
      title: r.title,
      rationale: r.rationale,
      evidence,
      action,
      worker_id,
      dedupe_key: dedupeKey(r.type, [...facts.map((f) => `${stable(f.ref)}:${f.metric}`), action.kind === "worker_command" ? `act:${action.worker_id}:${action.command}` : `act:${action.kind}`]),
    },
  };
}

/** Parses the model's text. Returns every valid recommendation and a reason for each discarded one (no model text is returned). */
export function parseModelOutput(raw: string, ctx: AnalysisContext): { ok: true; valid: ValidRecommendation[]; discarded: Discard[] } | { ok: false; reason: string } {
  const json = extractJson(raw);
  if (json === null) return { ok: false, reason: "not_json" };
  const env = Envelope.safeParse(json);
  if (!env.success) return { ok: false, reason: "envelope_invalid" };
  const valid: ValidRecommendation[] = [];
  const discarded: Discard[] = [];
  const seen = new Set<string>();
  env.data.recommendations.forEach((item, index) => {
    const v = verifyItem(item, ctx);
    if (!v.ok) return void discarded.push({ index, reason: v.reason });
    if (seen.has(v.rec.dedupe_key)) return void discarded.push({ index, reason: "duplicate_in_output" });
    if (valid.length >= BUDGET.maxRecommendations) return void discarded.push({ index, reason: "over_limit" });
    seen.add(v.rec.dedupe_key);
    valid.push(v.rec);
  });
  return { ok: true, valid, discarded };
}
