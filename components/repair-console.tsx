"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Panel } from "@/components/ui";
import { ACTIONS, ACTION_BY_ID, FINDING_LABEL, type FindingId, type FindingStatus } from "@/lib/repair/actions";

export type DeviceRow = { id: string; name: string; status: string; agent_version: string | null; os_caption: string | null; arch: string | null; ram_mb: number | null; paired_at: string; last_seen_at: string | null };
export type ReportRow = { id: string; device_id: string | null; source: string; kind: string; created_at: string; offline_code: string | null; host: Record<string, unknown>; findings: { id: FindingId; status: FindingStatus; value: string }[]; errors: { where: string; message: string }[]; action_results: { action_id: string; outcome: string; exit_code?: number | null }[] };
export type SuggestionView = { id: string; report_id: string | null; device_id: string | null; action_id: string; explanation: string; source: string; status: string; exit_code: number | null; result_note: string | null; created_at: string };

const TONE = { ok: "ok", warn: "warn", fail: "danger", unknown: "muted" } as const;
const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "muted" | "info"> = { proposed: "info", queued: "warn", delivered: "warn", succeeded: "ok", failed: "danger", declined: "muted", dismissed: "muted", expired: "muted" };

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { message: "Network error." } };
  }
}

export function RepairConsole(props: { devices: DeviceRow[]; reports: ReportRow[]; suggestions: SuggestionView[]; scriptSha256: string; firefox: { version: string; url: string; sha256: string }; relayConfigured: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("Acer Win7");
  const [minted, setMinted] = useState<{ code: string; ttl: number } | null>(null);
  const [paste, setPaste] = useState("");

  async function run(key: string, fn: () => Promise<{ ok: boolean; data: Record<string, unknown> }>, okText?: (d: Record<string, unknown>) => string) {
    setBusy(key);
    setMsg(null);
    const r = await fn();
    setBusy(null);
    setMsg(r.ok ? (okText ? okText(r.data) : "Done.") : String(r.data.message ?? r.data.error ?? "Failed."));
    if (r.ok) router.refresh();
    return r;
  }

  async function mint() {
    const r = await run("mint", () => post("/api/admin/repair/pairing-codes", { label }));
    if (r.ok) setMinted({ code: String(r.data.code), ttl: Number(r.data.ttl_seconds) });
  }

  async function submitPaste() {
    const t = paste.trim();
    if (!t) return;
    const isJson = t.startsWith("{");
    const r = await run("paste", () => post(isJson ? "/api/admin/repair/paste" : "/api/admin/repair/offline", isJson ? t : { code: t }), () => "Report added below.");
    if (r.ok) setPaste("");
  }

  const devName = (id: string | null) => props.devices.find((d) => d.id === id)?.name ?? null;
  const btn = "rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-panel-hi disabled:opacity-50";

  return (
    <div className="space-y-4">
      {msg && <div className="rounded-lg border border-line bg-panel/90 px-4 py-2 text-sm text-ink" role="status">{msg}</div>}

      <Panel title="Get the helper onto the PC">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>Windows 7 cannot open this site itself (its TLS lacks the ciphers Vercel requires). Install Firefox ESR 115 first, by the typed steps in <span className="font-mono text-xs">docs/win7-repair.md</span>.</li>
          <li>Firefox ESR {props.firefox.version} SHA-256: <span className="break-all font-mono text-xs text-ink">{props.firefox.sha256}</span></li>
          <li>In Firefox open <span className="font-mono text-xs text-ink">/r</span> on this site to download <span className="font-mono text-xs">repair.bat</span>. SHA-256 of that exact file: <span className="break-all font-mono text-xs text-ink">{props.scriptSha256}</span> (<span className="font-mono text-xs">certutil -hashfile repair.bat SHA256</span>).</li>
          <li>Right-click repair.bat, Run as administrator. It asks before every change. Choose 5 to copy its report, then paste it below.</li>
        </ol>
        <p className="mt-2 text-xs text-faint">Direct reporting from the PC needs a relay Windows 7 can reach: {props.relayConfigured ? "REPAIR_RELAY_URL is set." : "REPAIR_RELAY_URL is not set (offline code and paste still work)."}</p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Pair a PC (relay mode)">
          <p className="text-sm text-muted">Creates a one-time code (15 minutes). The script trades it for a per-device token; only hashes are stored.</p>
          <div className="mt-3 flex gap-2">
            <input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} className="min-w-0 flex-1 rounded-md border border-line bg-void/60 px-3 py-1.5 text-sm text-ink" aria-label="Device label" />
            <button type="button" disabled={busy === "mint" || label.trim().length === 0} onClick={() => void mint()} className={btn}>{busy === "mint" ? "Creating…" : "New pairing code"}</button>
          </div>
          {minted && (
            <div className="mt-3 rounded-lg border border-neon/40 bg-void/60 p-3" role="status">
              <div className="select-all font-mono text-lg text-ink">{minted.code}</div>
              <p className="mt-1 text-xs text-muted">Shown once. Expires in {Math.round(minted.ttl / 60)} minutes.</p>
              <button type="button" className={btn + " mt-2"} onClick={() => setMinted(null)}>Hide</button>
            </div>
          )}
        </Panel>
        <Panel title="Paste a report or offline code">
          <p className="text-sm text-muted">Paste the compact report copied by the script (starts with <span className="font-mono text-xs">{"{"}</span>), or type the offline code <span className="font-mono text-xs">W7-XXXX-XXXX-XXXX-C</span>.</p>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={3} maxLength={20000} className="mt-3 w-full rounded-md border border-line bg-void/60 px-3 py-1.5 font-mono text-xs text-ink" aria-label="Report or code" />
          <button type="button" disabled={busy === "paste" || paste.trim().length === 0} onClick={() => void submitPaste()} className={btn + " mt-2"}>{busy === "paste" ? "Adding…" : "Add report"}</button>
        </Panel>
      </div>

      <Panel title="Devices" badge={<Badge>{props.devices.length}</Badge>}>
        {props.devices.length === 0 ? (
          <p className="text-sm text-muted">No paired devices yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {props.devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <span className="font-medium text-ink">{d.name}</span> <Badge tone={d.status === "active" ? "ok" : "danger"}>{d.status}</Badge>
                  <div className="text-xs text-faint">{[d.os_caption, d.arch, d.ram_mb ? `${d.ram_mb} MB` : null, d.agent_version ? `agent ${d.agent_version}` : null].filter(Boolean).join(" · ") || "no report yet"} · last seen {d.last_seen_at ?? "never"}</div>
                </div>
                {d.status === "active" && <button type="button" className={btn} disabled={busy === d.id} onClick={() => { if (window.confirm(`Revoke ${d.name}? Its token stops working immediately.`)) void run(d.id, () => post(`/api/admin/repair/devices/${d.id}`, { revoke: true }), () => "Device revoked."); }}>Revoke</button>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {props.reports.map((r) => {
        const bad = r.findings.filter((f) => f.status === "warn" || f.status === "fail");
        const sugs = props.suggestions.filter((s) => s.report_id === r.id);
        return (
          <Panel key={r.id} title={`Report · ${r.source.replace("_", " ")}`} badge={<Badge tone={bad.length ? "warn" : "ok"}>{bad.length} need attention</Badge>}>
            <div className="text-xs text-faint">{r.created_at} · {devName(r.device_id) ?? "no paired device"}{r.offline_code ? ` · ${r.offline_code}` : ""}</div>
            <ul className="mt-2 space-y-1 text-sm">
              {r.findings.filter((f) => f.status !== "ok").map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2"><Badge tone={TONE[f.status]}>{f.status}</Badge><span className="text-ink">{FINDING_LABEL[f.id]}</span><span className="text-xs text-muted">{f.value}</span></li>
              ))}
              {r.findings.length > 0 && <li className="text-xs text-faint">{r.findings.filter((f) => f.status === "ok").length} checks ok</li>}
            </ul>
            {r.errors.length > 0 && <ul className="mt-2 text-xs text-warn">{r.errors.map((e, i) => <li key={i}>{e.where}: {e.message}</li>)}</ul>}
            {r.action_results.length > 0 && <div className="mt-2 text-xs text-muted">Actions on the PC: {r.action_results.map((a) => `${a.action_id} → ${a.outcome}`).join(", ")}</div>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={btn} disabled={busy === r.id || bad.length === 0} onClick={() => void run(r.id, () => post("/api/admin/repair/analyze", { report_id: r.id }), (d) => String(d.note ?? "Analysis done."))}>{busy === r.id ? "Analyzing…" : "Analyze with Nemotron (optional)"}</button>
              {r.device_id && (
                <select className="rounded-md border border-line bg-void/60 px-2 py-1.5 text-xs text-ink" aria-label="Suggest an action" defaultValue="" onChange={(e) => { const id = e.target.value; e.target.value = ""; if (id) void run(r.id + id, () => post("/api/admin/repair/suggestions", { device_id: r.device_id, report_id: r.id, action_id: id, explanation: `Suggested by the administrator: ${ACTION_BY_ID[id as keyof typeof ACTION_BY_ID].title}.` }), () => "Queued for the PC. It will ask Y/N."); }}>
                  <option value="">Suggest an action…</option>
                  {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
              )}
            </div>
            {sugs.length > 0 && (
              <ul className="mt-3 divide-y divide-line border-t border-line">
                {sugs.map((s) => (
                  <li key={s.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><Badge tone={STATUS_TONE[s.status] ?? "muted"}>{s.status}</Badge><span className="font-mono text-xs text-ink">{s.action_id}</span><Badge>{s.source}</Badge></div>
                    <p className="mt-1 text-xs text-muted">{s.explanation}</p>
                    {s.status === "proposed" && (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {s.device_id ? <button type="button" className={btn} disabled={busy === s.id} onClick={() => void run(s.id, () => post(`/api/admin/repair/suggestions/${s.id}`, { decision: "queue" }), () => "Queued. The PC will show it and ask Y/N.")}>Queue for PC</button> : <span className="text-xs text-faint">On the PC run: <span className="font-mono text-ink">repair.bat run {s.action_id}</span></span>}
                        <button type="button" className={btn} disabled={busy === s.id} onClick={() => void run(s.id, () => post(`/api/admin/repair/suggestions/${s.id}`, { decision: "dismiss" }), () => "Dismissed.")}>Dismiss</button>
                      </div>
                    )}
                    {s.result_note && <p className="text-xs text-faint">{s.result_note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
