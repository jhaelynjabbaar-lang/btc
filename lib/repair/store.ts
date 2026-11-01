import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Device, Store, SuggestionRow } from "./service";

/**
 * Supabase-backed Store. The generated Database type does not know the repair_* tables yet, so the client is used untyped here
 * (row shapes are declared next to each query). Server-only: uses the secret key, which bypasses RLS.
 */
function db(): SupabaseClient {
  return getSupabaseServer() as unknown as SupabaseClient;
}
const fail = (what: string): never => {
  throw new Error(`repair store: ${what}`);
};

export const supabaseStore: Store = {
  async countEvents(kind, keyHash, sinceIso) {
    const r = await db().from("repair_events").select("id", { count: "exact", head: true }).eq("kind", kind).eq("key_hash", keyHash).gte("created_at", sinceIso);
    if (r.error) fail("countEvents");
    return r.count ?? 0;
  },
  async addEvent(kind, keyHash) {
    const r = await db().from("repair_events").insert({ kind, key_hash: keyHash });
    if (r.error) fail("addEvent");
  },
  async countActiveCodes(owner, nowIso) {
    const r = await db().from("repair_pairing_codes").select("id", { count: "exact", head: true }).eq("owner_id", owner).is("used_at", null).gt("expires_at", nowIso);
    if (r.error) fail("countActiveCodes");
    return r.count ?? 0;
  },
  async insertCode(row) {
    const r = await db().from("repair_pairing_codes").insert(row).select("id").single();
    if (r.error || !r.data) return fail("insertCode");
    return (r.data as { id: string }).id;
  },
  async consumeCode(codeHash, nowIso) {
    // Single conditional UPDATE: atomically claims an unused, unexpired code exactly once.
    const r = await db().from("repair_pairing_codes").update({ used_at: nowIso }).eq("code_hash", codeHash).is("used_at", null).gt("expires_at", nowIso).select("id, owner_id, label").maybeSingle();
    if (r.error) fail("consumeCode");
    return (r.data as { id: string; owner_id: string; label: string } | null) ?? null;
  },
  async insertDevice(row) {
    const r = await db().from("repair_devices").insert(row).select("id").single();
    if (r.error || !r.data) return fail("insertDevice");
    return (r.data as { id: string }).id;
  },
  async linkCode(codeId, deviceId) {
    const r = await db().from("repair_pairing_codes").update({ device_id: deviceId }).eq("id", codeId);
    if (r.error) fail("linkCode");
  },
  async deviceByTokenHash(hash) {
    const r = await db().from("repair_devices").select("id, owner_id, name, status, last_seen_at").eq("token_hash", hash).maybeSingle();
    if (r.error) fail("deviceByTokenHash");
    return (r.data as Device | null) ?? null;
  },
  async touchDevice(id, iso) {
    await db().from("repair_devices").update({ last_seen_at: iso }).eq("id", id);
  },
  async insertReport(row) {
    const r = await db().from("repair_reports").insert(row).select("id").single();
    if (r.error || !r.data) return fail("insertReport");
    return (r.data as { id: string }).id;
  },
  async updateDeviceHost(id, host) {
    await db().from("repair_devices").update({ agent_version: host.agent_version, os_caption: host.os_caption ?? null, os_version: host.os_version ?? null, arch: host.arch ?? null, ram_mb: host.ram_mb ?? null }).eq("id", id);
  },
  async countReportsSince(deviceId, sinceIso) {
    const r = await db().from("repair_reports").select("id", { count: "exact", head: true }).eq("device_id", deviceId).gte("created_at", sinceIso);
    if (r.error) fail("countReportsSince");
    return r.count ?? 0;
  },
  async queuedSuggestions(deviceId, nowIso) {
    const r = await db().from("repair_suggestions").select("id, device_id, report_id, action_id, explanation, status, expires_at").eq("device_id", deviceId).in("status", ["queued", "delivered"]).gt("expires_at", nowIso).order("created_at", { ascending: true }).limit(10);
    if (r.error) fail("queuedSuggestions");
    return (r.data ?? []) as SuggestionRow[];
  },
  async markDelivered(ids, iso) {
    await db().from("repair_suggestions").update({ status: "delivered", delivered_at: iso }).in("id", ids).eq("status", "queued");
  },
  async getSuggestion(id) {
    const r = await db().from("repair_suggestions").select("id, owner_id, device_id, report_id, action_id, explanation, status, expires_at").eq("id", id).maybeSingle();
    if (r.error) fail("getSuggestion");
    return (r.data as (SuggestionRow & { owner_id: string }) | null) ?? null;
  },
  async resolveSuggestion(id, patch) {
    const r = await db().from("repair_suggestions").update(patch).eq("id", id);
    if (r.error) fail("resolveSuggestion");
  },
  async setSuggestionStatus(id, status, patch) {
    const r = await db().from("repair_suggestions").update({ status, ...(patch ?? {}) }).eq("id", id);
    if (r.error) fail("setSuggestionStatus");
  },
  async insertSuggestion(row) {
    const r = await db().from("repair_suggestions").insert(row).select("id").single();
    if (r.error || !r.data) return fail("insertSuggestion");
    return (r.data as { id: string }).id;
  },
  async openSuggestionKeys(reportId) {
    const r = await db().from("repair_suggestions").select("action_id").eq("report_id", reportId).in("status", ["proposed", "queued", "delivered"]);
    if (r.error) fail("openSuggestionKeys");
    return new Set(((r.data ?? []) as { action_id: string }[]).map((x) => x.action_id));
  },
};
