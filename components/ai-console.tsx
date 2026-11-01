"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Panel } from "./ui";

type Evidence = { ref: string; name: string; metric: string; value: string | number | boolean | null; unit?: string };
type Action = { kind: "none" } | { kind: "review_cloud" } | { kind: "worker_command"; worker_id: string; worker_name: string; command: string };
type Rec = {
  id: string;
  type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  rationale: string;
  evidence: Evidence[];
  action: Action;
  status: "proposed" | "accepted" | "dismissed";
  model: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};
type LastRun = { at: string; status: "completed" | "failed" | "started"; modelCalled: boolean | null; created: number | null; discarded: number | null; note?: string } | null;

const SEV_TONE = { info: "info", warning: "warn", critical: "danger" } as const;
const SEV_LABEL = { info: "Info", warning: "Warning", critical: "Critical" } as const;
const TYPE_LABEL: Record<string, string> = { worker_health: "Worker health", efficiency: "Efficiency", cloud_spend: "Cloud & spend" };
const STATUS_TONE = { proposed: "info", accepted: "ok", dismissed: "muted" } as const;

const btn = "rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-panel-hi disabled:opacity-40";
const btnPrimary = "rounded-md bg-gradient-to-r from-electric to-neon px-3 py-1.5 text-xs font-semibold text-void disabled:opacity-50";

const utc = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");

async function post(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { ok: res.ok, status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { ok: false, status: 0, data: { message: "Network error." } };
  }
}

function fmtValue(e: Evidence): string {
  if (e.value === null) return "no data";
  return `${typeof e.value === "number" ? e.value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(e.value)}${e.unit ? ` ${e.unit}` : ""}`;
}

function RecCard({ rec, onDone }: { rec: Rec; onDone: (m: string) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = rec.status === "proposed";
  const wc = rec.action.kind === "worker_command" ? rec.action : null;

  async function decide(decision: "accept" | "dismiss") {
    setBusy(true);
    setErr(null);
    const r = await post(`/api/admin/ai/recommendations/${rec.id}`, decision === "accept" ? { decision, confirm: true } : { decision });
    setBusy(false);
    setArmed(false);
    if (!r.ok) return setErr(String(r.data?.message ?? `Failed (HTTP ${r.status}).`));
    onDone(decision === "accept" ? (wc ? `Accepted. A ${wc.command} command was queued for ${wc.worker_name || "the worker"}.` : "Accepted. Nothing was executed.") : "Dismissed.");
    router.refresh();
  }

  return (
    <li className="rounded-xl border border-line bg-void/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEV_TONE[rec.severity]}>{SEV_LABEL[rec.severity]}</Badge>
        <Badge tone="muted">{TYPE_LABEL[rec.type] ?? rec.type}</Badge>
        <Badge tone={STATUS_TONE[rec.status]}>{rec.status}</Badge>
        <span className="ml-auto text-[11px] text-faint">{utc(rec.created_at)}{rec.model ? ` · ${rec.model}` : ""}</span>
      </div>
      <h3 className="mt-2 text-sm font-semibold text-ink">{rec.title}</h3>
      <p className="mt-1 text-sm text-muted">{rec.rationale}</p>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-electric-hi">Evidence ({rec.evidence.length} metrics the model was given)</summary>
        <table className="mt-2 w-full text-left">
          <tbody>
            {rec.evidence.map((e, i) => (
              <tr key={`${e.ref}-${e.metric}-${i}`} className="border-t border-line/60">
                <td className="py-1 pr-3 text-muted">{e.name}</td>
                <td className="py-1 pr-3 font-mono text-faint">{e.metric}</td>
                <td className="py-1 font-mono text-ink">{fmtValue(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-faint">Suggested action:</span>
        {rec.action.kind === "none" && <span className="text-muted">none (information only)</span>}
        {wc && <span className="font-mono text-ink">{wc.command} worker “{wc.worker_name || wc.worker_id.slice(0, 8)}”</span>}
        {rec.action.kind === "review_cloud" && (
          <Link href="/cloud" className="text-neon underline">Review on the Cloud page →</Link>
        )}
      </div>

      {open ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {armed ? (
            <>
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => void decide("accept")}>
                {busy ? "Working…" : wc ? `Confirm: queue “${wc.command}” command` : "Confirm accept"}
              </button>
              <button type="button" className={btn} disabled={busy} onClick={() => setArmed(false)}>Cancel</button>
              <span className="text-[11px] text-warn">{wc ? "This queues a real worker command. The worker receives it on its next signed poll." : "Marks it reviewed. Nothing is executed."}</span>
            </>
          ) : (
            <>
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => setArmed(true)}>Accept…</button>
              <button type="button" className={btn} disabled={busy} onClick={() => void decide("dismiss")}>Dismiss</button>
            </>
          )}
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-faint">{rec.status === "accepted" ? "Accepted" : "Dismissed"} by {rec.decided_by ?? "admin"} · {utc(rec.decided_at)}</p>
      )}
      {err && <p className="mt-2 text-xs text-warn" role="alert">{err}</p>}
    </li>
  );
}

export function AiConsole({ recs, lastRun, model, configured }: { recs: Rec[]; lastRun: LastRun; model: string; configured: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const proposed = recs.filter((r) => r.status === "proposed");
  const decided = recs.filter((r) => r.status !== "proposed");

  async function run() {
    setBusy(true);
    setMsg(null);
    const r = await post("/api/admin/ai/analyze");
    setBusy(false);
    if (!r.ok) setMsg({ ok: false, text: String(r.data?.message ?? `Failed (HTTP ${r.status}).`) });
    else {
      const d = r.data ?? {};
      setMsg({ ok: true, text: `${String(d.note ?? "Done.")}${Number(d.discarded) > 0 ? ` ${String(d.discarded)} model suggestion(s) failed validation and were discarded.` : ""}` });
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        title="Analysis"
        badge={<Badge tone={configured ? "ok" : "warn"}>{configured ? "Provider configured" : "Provider not configured"}</Badge>}
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <dl className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="text-[11px] uppercase tracking-wider text-faint">Model</dt><dd className="font-mono text-xs text-ink">{model}</dd></div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-faint">Last run</dt>
              <dd className="text-xs text-ink">
                {lastRun ? (
                  <>
                    {utc(lastRun.at)} · {lastRun.status}
                    {lastRun.modelCalled === false && " · model not called"}
                    {lastRun.created !== null && ` · ${lastRun.created} new`}
                    {lastRun.discarded ? ` · ${lastRun.discarded} discarded` : ""}
                  </>
                ) : (
                  "never run"
                )}
              </dd>
              {lastRun?.note && <dd className="text-[11px] text-muted">{lastRun.note}</dd>}
            </div>
          </dl>
          <div className="flex flex-col items-end gap-1">
            <button type="button" className={btnPrimary} disabled={busy || !configured} onClick={() => void run()}>
              {busy ? "Analyzing…" : "Run analysis"}
            </button>
            <span className="text-[11px] text-faint">One manual run per minute. Read-only on your data.</span>
          </div>
        </div>
        {msg && <p className={"mt-3 text-xs " + (msg.ok ? "text-ok" : "text-warn")} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      </Panel>

      <Panel title="Proposed" badge={<Badge tone="info">{proposed.length}</Badge>}>
        {proposed.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line-hi/70 bg-void/40 p-4 text-sm text-muted">
            {recs.length === 0
              ? "No recommendations yet. Run an analysis: if there are no workers, telemetry or cloud records, or no metric crosses a threshold, the model is not called and nothing is invented."
              : "Nothing is waiting for a decision."}
          </div>
        ) : (
          <ul className="space-y-3">{proposed.map((r) => <RecCard key={r.id} rec={r} onDone={(t) => setMsg({ ok: true, text: t })} />)}</ul>
        )}
      </Panel>

      {decided.length > 0 && (
        <Panel title="Decided" badge={<Badge tone="muted">{decided.length}</Badge>}>
          <ul className="space-y-3">{decided.map((r) => <RecCard key={r.id} rec={r} onDone={() => undefined} />)}</ul>
        </Panel>
      )}
    </div>
  );
}
