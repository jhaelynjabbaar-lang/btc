import type { Device, Store, SuggestionRow } from "@/lib/repair/service";

/** In-memory Store used by the service tests. Mirrors the semantics of lib/repair/store.ts (atomic single-use code claim etc.). */
export function memoryStore() {
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const events: { kind: string; key: string; at: number }[] = [];
  const codes = new Map<string, { id: string; owner_id: string; label: string; code_hash: string; expires_at: string; used: boolean }>();
  const devices = new Map<string, Device & { token_hash: string }>();
  const reports: Record<string, unknown>[] = [];
  const sugs = new Map<string, SuggestionRow & { owner_id: string; source: string; status: string }>();
  const store: Store = {
    countEvents: async (kind, key, since) => events.filter((e) => e.kind === kind && e.key === key && e.at >= Date.parse(since)).length,
    addEvent: async (kind, key) => void events.push({ kind, key, at: Date.now() }),
    countActiveCodes: async (owner, nowIso) => [...codes.values()].filter((c) => c.owner_id === owner && !c.used && c.expires_at > nowIso).length,
    insertCode: async (r) => {
      const i = id();
      codes.set(i, { id: i, owner_id: r.owner_id, label: r.label, code_hash: r.code_hash, expires_at: r.expires_at, used: false });
      return i;
    },
    consumeCode: async (hash, nowIso) => {
      const c = [...codes.values()].find((x) => x.code_hash === hash && !x.used && x.expires_at > nowIso);
      if (!c) return null;
      c.used = true;
      return { id: c.id, owner_id: c.owner_id, label: c.label };
    },
    insertDevice: async (r) => {
      const i = id();
      devices.set(i, { id: i, owner_id: r.owner_id, name: r.name, status: "active", last_seen_at: null, token_hash: r.token_hash });
      return i;
    },
    linkCode: async () => {},
    deviceByTokenHash: async (h) => [...devices.values()].find((d) => d.token_hash === h) ?? null,
    touchDevice: async (i, iso) => void (devices.get(i)!.last_seen_at = iso),
    insertReport: async (r) => {
      reports.push(r);
      return id();
    },
    updateDeviceHost: async () => {},
    countReportsSince: async (d) => reports.filter((r) => r.device_id === d).length,
    queuedSuggestions: async (d, nowIso) => [...sugs.values()].filter((s) => s.device_id === d && s.status === "queued" && s.expires_at > nowIso),
    markDelivered: async (ids) => ids.forEach((i) => (sugs.get(i)!.status = "delivered")),
    getSuggestion: async (i) => sugs.get(i) ?? null,
    resolveSuggestion: async (i, p) => void (sugs.get(i)!.status = p.status),
    setSuggestionStatus: async (i, s) => void (sugs.get(i)!.status = s),
    insertSuggestion: async (r) => {
      const i = id();
      sugs.set(i, { id: i, owner_id: r.owner_id, device_id: r.device_id, report_id: r.report_id, action_id: r.action_id, explanation: r.explanation, status: r.status, source: r.source, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
      return i;
    },
    openSuggestionKeys: async (rid) => new Set([...sugs.values()].filter((s) => s.report_id === rid).map((s) => s.action_id)),
  };
  return { store, events, codes, devices, reports, sugs };
}
