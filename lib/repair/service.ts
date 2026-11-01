import { ACTION_BY_ID, isActionId, isFindingId, type ActionId, type FindingId, type FindingStatus } from "./actions";
import { buildPrompt, filterAiOutput, type FindingRow } from "./ai";
import { MAX_ACTIVE_PAIR_CODES, PAIR_TTL_MS, generateDeviceToken, generatePairCode, hashClient, hashDeviceToken, hashPairCode, normalizePairCode, parseBearer } from "./pairing";
import type { ReportInput } from "./schemas";

/**
 * Business logic for the repair helper, written against a small Store interface so it is unit-tested with an in-memory store.
 * The Supabase implementation lives in store.ts (server-only). Nothing here can execute anything: the server only records
 * SUGGESTED allowlisted action ids; the person at the PC approves each one locally.
 */

export type Device = { id: string; owner_id: string; name: string; status: "active" | "revoked"; last_seen_at: string | null };
export type SuggestionRow = { id: string; device_id: string | null; report_id: string | null; action_id: string; explanation: string; status: string; expires_at: string };

export interface Store {
  countEvents(kind: string, keyHash: string, sinceIso: string): Promise<number>;
  addEvent(kind: string, keyHash: string): Promise<void>;
  countActiveCodes(owner: string, nowIso: string): Promise<number>;
  insertCode(row: { owner_id: string; label: string; code_hash: string; expires_at: string; created_by: string }): Promise<string>;
  consumeCode(codeHash: string, nowIso: string): Promise<{ id: string; owner_id: string; label: string } | null>;
  insertDevice(row: { owner_id: string; name: string; token_hash: string; agent_version: string | null }): Promise<string>;
  linkCode(codeId: string, deviceId: string): Promise<void>;
  deviceByTokenHash(hash: string): Promise<Device | null>;
  touchDevice(id: string, iso: string): Promise<void>;
  insertReport(row: { owner_id: string; device_id: string | null; source: "device" | "offline_code" | "admin_paste"; kind: string; agent_version: string | null; host: unknown; findings: unknown; errors: unknown; action_results: unknown; offline_code?: string | null; created_by?: string | null }): Promise<string>;
  updateDeviceHost(id: string, host: { agent_version: string; os_caption?: string; os_version?: string; arch?: string; ram_mb?: number }): Promise<void>;
  countReportsSince(deviceId: string, sinceIso: string): Promise<number>;
  queuedSuggestions(deviceId: string, nowIso: string): Promise<SuggestionRow[]>;
  markDelivered(ids: string[], iso: string): Promise<void>;
  getSuggestion(id: string): Promise<(SuggestionRow & { owner_id: string }) | null>;
  resolveSuggestion(id: string, patch: { status: string; exit_code: number | null; result_note: string | null; resolved_at: string }): Promise<void>;
  setSuggestionStatus(id: string, status: string, patch?: { queued_at?: string }): Promise<void>;
  insertSuggestion(row: { owner_id: string; device_id: string | null; report_id: string | null; action_id: ActionId; explanation: string; source: "ai" | "admin"; status: "proposed" | "queued"; model: string | null; created_by: string; queued_at: string | null }): Promise<string>;
  openSuggestionKeys(reportId: string): Promise<Set<string>>;
}

export const RATE = {
  pairPerAddress: { limit: 8, windowMs: 10 * 60_000 },
  pairGlobal: { limit: 40, windowMs: 60 * 60_000 },
  reportPerDevice: { limit: 30, windowMs: 60 * 60_000 },
} as const;

type Clock = () => Date;

async function limited(store: Store, kind: string, key: string, rule: { limit: number; windowMs: number }, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - rule.windowMs).toISOString();
  if ((await store.countEvents(kind, key, since)) >= rule.limit) return true;
  await store.addEvent(kind, key);
  return false;
}

// ------------------------------------------------------------------------------------------------ admin: pairing code
export type MintOutcome = { ok: true; code: string; expiresAt: string } | { ok: false; reason: "too_many_active" };

export async function mintPairingCode(store: Store, owner: string, label: string, actor: string, now: Clock = () => new Date()): Promise<MintOutcome> {
  const n = now();
  if ((await store.countActiveCodes(owner, n.toISOString())) >= MAX_ACTIVE_PAIR_CODES) return { ok: false, reason: "too_many_active" };
  const code = generatePairCode();
  const expiresAt = new Date(n.getTime() + PAIR_TTL_MS).toISOString();
  await store.insertCode({ owner_id: owner, label, code_hash: hashPairCode(normalizePairCode(code)!), expires_at: expiresAt, created_by: actor });
  return { ok: true, code, expiresAt };
}

// ------------------------------------------------------------------------------------------------ device: pair
export type PairOutcome = { ok: true; deviceId: string; token: string } | { ok: false; reason: "rate_limited" | "invalid_code"; retryAfterSec?: number };

export async function pairDevice(store: Store, input: { code: string; agentVersion?: string }, clientAddress: string, now: Clock = () => new Date()): Promise<PairOutcome> {
  const n = now();
  const key = hashClient(clientAddress);
  if (await limited(store, "pair_attempt", key, RATE.pairPerAddress, n)) return { ok: false, reason: "rate_limited", retryAfterSec: 60 };
  if (await limited(store, "pair_attempt_global", "all", RATE.pairGlobal, n)) return { ok: false, reason: "rate_limited", retryAfterSec: 300 };
  const norm = normalizePairCode(input.code);
  if (!norm) return { ok: false, reason: "invalid_code" };
  const row = await store.consumeCode(hashPairCode(norm), n.toISOString());
  if (!row) return { ok: false, reason: "invalid_code" };
  const token = generateDeviceToken();
  const deviceId = await store.insertDevice({ owner_id: row.owner_id, name: row.label, token_hash: hashDeviceToken(token), agent_version: input.agentVersion ?? null });
  await store.linkCode(row.id, deviceId);
  return { ok: true, deviceId, token };
}

// ------------------------------------------------------------------------------------------------ device: auth
export async function authenticateDevice(store: Store, authorization: string | null, now: Clock = () => new Date()): Promise<Device | null> {
  const token = parseBearer(authorization);
  if (!token) return null;
  const d = await store.deviceByTokenHash(hashDeviceToken(token));
  if (!d || d.status !== "active") return null;
  const n = now();
  if (!d.last_seen_at || n.getTime() - new Date(d.last_seen_at).getTime() > 60_000) await store.touchDevice(d.id, n.toISOString());
  return d;
}

// ------------------------------------------------------------------------------------------------ device: report
export async function submitReport(store: Store, device: Device, report: ReportInput, now: Clock = () => new Date()): Promise<{ ok: true; reportId: string } | { ok: false; reason: "rate_limited" }> {
  const n = now();
  if ((await store.countReportsSince(device.id, new Date(n.getTime() - RATE.reportPerDevice.windowMs).toISOString())) >= RATE.reportPerDevice.limit) return { ok: false, reason: "rate_limited" };
  const reportId = await store.insertReport({
    owner_id: device.owner_id,
    device_id: device.id,
    source: "device",
    kind: report.kind,
    agent_version: report.agent_version,
    host: report.host,
    findings: report.findings,
    errors: report.errors,
    action_results: report.action_results,
  });
  await store.updateDeviceHost(device.id, { agent_version: report.agent_version, os_caption: report.host.os_caption, os_version: report.host.os_version, arch: report.host.arch, ram_mb: report.host.ram_mb });
  return { ok: true, reportId };
}

// ------------------------------------------------------------------------------------------------ device: suggestions
export async function pollSuggestions(store: Store, device: Device, now: Clock = () => new Date()): Promise<{ id: string; action_id: ActionId; explanation: string }[]> {
  const n = now();
  const rows = await store.queuedSuggestions(device.id, n.toISOString());
  // Re-validate on the way out: an id that is not (or is no longer) on the allowlist is never delivered.
  const ok = rows.filter((r): r is SuggestionRow & { action_id: ActionId } => isActionId(r.action_id));
  if (ok.length) await store.markDelivered(ok.map((r) => r.id), n.toISOString());
  return ok.map((r) => ({ id: r.id, action_id: r.action_id, explanation: r.explanation }));
}

export async function ackSuggestion(
  store: Store,
  device: Device,
  id: string,
  ack: { outcome: "succeeded" | "failed" | "declined"; exit_code?: number | null; note?: string },
  now: Clock = () => new Date(),
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "already_resolved" }> {
  const s = await store.getSuggestion(id);
  if (!s || s.device_id !== device.id) return { ok: false, reason: "not_found" };
  if (!["queued", "delivered"].includes(s.status)) return { ok: false, reason: "already_resolved" };
  await store.resolveSuggestion(id, { status: ack.outcome, exit_code: ack.exit_code ?? null, result_note: ack.note ?? null, resolved_at: now().toISOString() });
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ admin: suggestions
export async function adminQueueSuggestion(
  store: Store,
  owner: string,
  actor: string,
  input: { device_id?: string; report_id?: string; action_id: string; explanation: string },
  now: Clock = () => new Date(),
): Promise<{ ok: true; id: string } | { ok: false; reason: "invalid_action" | "needs_device" }> {
  if (!isActionId(input.action_id)) return { ok: false, reason: "invalid_action" };
  if (!input.device_id) return { ok: false, reason: "needs_device" };
  const id = await store.insertSuggestion({ owner_id: owner, device_id: input.device_id, report_id: input.report_id ?? null, action_id: input.action_id, explanation: input.explanation, source: "admin", status: "queued", model: null, created_by: actor, queued_at: now().toISOString() });
  return { ok: true, id };
}

export async function adminDecide(store: Store, id: string, owner: string, decision: "queue" | "dismiss", now: Clock = () => new Date()): Promise<{ ok: true } | { ok: false; reason: "not_found" | "bad_state" | "needs_device" }> {
  const s = await store.getSuggestion(id);
  if (!s || s.owner_id !== owner) return { ok: false, reason: "not_found" };
  if (s.status !== "proposed" && !(decision === "dismiss" && s.status === "queued")) return { ok: false, reason: "bad_state" };
  if (decision === "queue") {
    if (!s.device_id) return { ok: false, reason: "needs_device" };
    await store.setSuggestionStatus(id, "queued", { queued_at: now().toISOString() });
  } else {
    await store.setSuggestionStatus(id, "dismissed");
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ admin: AI analysis
export type ModelCaller = (messages: ReturnType<typeof buildPrompt>) => Promise<{ content: string; model: string }>;

export type AnalyzeOutcome =
  | { ok: true; created: number; discarded: string[]; modelCalled: boolean; note: string }
  | { ok: false; reason: "model_error" | "bad_output" };

export async function analyzeReport(
  store: Store,
  args: { owner: string; actor: string; reportId: string; deviceId: string | null; findings: FindingRow[]; host: Record<string, unknown> },
  callModel: ModelCaller,
): Promise<AnalyzeOutcome> {
  const bad = args.findings.filter((f) => f.status === "warn" || f.status === "fail");
  if (bad.length === 0) return { ok: true, created: 0, discarded: [], modelCalled: false, note: "No finding is warn/fail, so the model was not called." };
  let res: { content: string; model: string };
  try {
    res = await callModel(buildPrompt(args.findings, args.host));
  } catch {
    return { ok: false, reason: "model_error" };
  }
  const out = filterAiOutput(res.content, args.findings);
  if (!out.ok) return { ok: false, reason: "bad_output" };
  const open = await store.openSuggestionKeys(args.reportId);
  let created = 0;
  for (const v of out.valid) {
    if (open.has(v.action_id)) continue;
    await store.insertSuggestion({ owner_id: args.owner, device_id: args.deviceId, report_id: args.reportId, action_id: v.action_id, explanation: v.explanation, source: "ai", status: "proposed", model: res.model, created_by: args.actor, queued_at: null });
    created++;
  }
  return { ok: true, created, discarded: out.discarded.map((d) => d.reason), modelCalled: true, note: `${created} suggestion(s) proposed. Nothing runs until you queue it and the person at the PC answers Y.` };
}

/** Normalizes stored report findings (jsonb) into typed rows, dropping anything not on the finding allowlist. */
export function toFindingRows(raw: unknown): FindingRow[] {
  if (!Array.isArray(raw)) return [];
  const out: FindingRow[] = [];
  for (const f of raw) {
    const o = f as { id?: unknown; status?: unknown; value?: unknown };
    if (!isFindingId(o.id)) continue;
    const st = o.status;
    if (st !== "ok" && st !== "warn" && st !== "fail" && st !== "unknown") continue;
    out.push({ id: o.id as FindingId, status: st as FindingStatus, value: typeof o.value === "string" ? o.value.slice(0, 120) : "" });
  }
  return out;
}

export { ACTION_BY_ID };
