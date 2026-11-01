import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/supabase/server";
import { chatCompletion } from "@/lib/ai/openrouter";
import { getAiConfig } from "@/lib/ai/config";
import { hashClient } from "./pairing";
import { analyzeReport, toFindingRows, type AnalyzeOutcome } from "./service";
import { supabaseStore } from "./store";
import { decodeOfflineCode } from "./offline-code";
import { FINDING_IDS } from "./actions";
import type { ReportInput } from "./schemas";

const db = () => getSupabaseServer() as unknown as SupabaseClient;

export const ownerOf = (login: string | null) => (login ?? "owner").toLowerCase();

export async function revokeDevice(owner: string, id: string): Promise<boolean> {
  const r = await db().from("repair_devices").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("id", id).eq("owner_id", owner).select("id").maybeSingle();
  if (r.error || !r.data) return false;
  // Anything still waiting for a revoked device can never run.
  await db().from("repair_suggestions").update({ status: "dismissed" }).eq("device_id", id).in("status", ["proposed", "queued", "delivered"]);
  return true;
}

export async function saveOfflineReport(owner: string, actor: string, code: string): Promise<{ ok: true; id: string } | { ok: false; reason: "format" | "checksum" }> {
  const d = decodeOfflineCode(code);
  if (!d.ok) return d;
  const findings = Object.entries(d.statuses)
    .filter(([id]) => (FINDING_IDS as readonly string[]).includes(id))
    .map(([id, status]) => ({ id, status, value: "" }));
  const id = await supabaseStore.insertReport({ owner_id: owner, device_id: null, source: "offline_code", kind: "offline_code", agent_version: null, host: {}, findings, errors: [], action_results: [], offline_code: d.code, created_by: actor });
  return { ok: true, id };
}

/** At most 1 analysis per 20 s and 12 per hour per admin (durable, from repair_events). */
export async function analysisRateLimited(owner: string): Promise<boolean> {
  const key = hashClient(owner, "btcrepair-analyze");
  const now = Date.now();
  if ((await supabaseStore.countEvents("analyze", key, new Date(now - 20_000).toISOString())) > 0) return true;
  if ((await supabaseStore.countEvents("analyze", key, new Date(now - 3_600_000).toISOString())) >= 12) return true;
  await supabaseStore.addEvent("analyze", key);
  return false;
}

export async function analyzeStoredReport(owner: string, actor: string, reportId: string): Promise<AnalyzeOutcome | { ok: false; reason: "not_found" | "not_configured" }> {
  if (!getAiConfig().configured) return { ok: false, reason: "not_configured" };
  const r = await db().from("repair_reports").select("id, owner_id, device_id, host, findings").eq("id", reportId).eq("owner_id", owner).maybeSingle();
  if (r.error || !r.data) return { ok: false, reason: "not_found" };
  const row = r.data as { id: string; device_id: string | null; host: Record<string, unknown>; findings: unknown };
  return analyzeReport(
    supabaseStore,
    { owner, actor, reportId: row.id, deviceId: row.device_id, findings: toFindingRows(row.findings), host: row.host ?? {} },
    async (messages) => {
      const res = await chatCompletion({ messages, maxTokens: 1500, temperature: 0.1, timeoutMs: 60_000, reasoningEffort: "low" });
      return { content: res.content, model: res.model };
    },
  );
}

/** Browser fallback: the admin pastes the compact report (report-*.json) copied from the PC. Same strict schema as the device endpoint. */
export async function savePastedReport(owner: string, actor: string, report: ReportInput): Promise<string> {
  return supabaseStore.insertReport({ owner_id: owner, device_id: null, source: "admin_paste", kind: report.kind, agent_version: report.agent_version, host: report.host, findings: report.findings, errors: report.errors, action_results: report.action_results, created_by: actor });
}
