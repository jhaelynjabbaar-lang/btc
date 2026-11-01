"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Panel } from "./ui";

const btnPrimary = "rounded-md bg-gradient-to-r from-electric to-neon px-3 py-1.5 text-xs font-semibold text-void disabled:opacity-50";
const btn = "rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-panel-hi disabled:opacity-40";
const input = "w-full rounded-md border border-line bg-void/60 px-2 py-1.5 text-xs text-ink placeholder:text-faint";

type Msg = { ok: boolean; text: string } | null;

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> | null; status: number }> {
  try {
    const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, data, status: res.status };
  } catch {
    return { ok: false, data: { message: "Network error." }, status: 0 };
  }
}
const errText = (r: { data: Record<string, unknown> | null; status: number }) => String(r.data?.message ?? `Failed (HTTP ${r.status}).`);

function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <p role="status" className={"text-xs " + (msg.ok ? "text-ok" : "text-danger")}>
      {msg.text}
    </p>
  );
}

export function RefreshNetworkButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        className={btn}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const r = await call("POST", "/api/admin/financials/network");
          setBusy(false);
          setMsg(r.ok ? { ok: true, text: "Refreshed from the public APIs." } : { ok: false, text: errText(r) });
          if (r.ok) router.refresh();
        }}
      >
        {busy ? "Fetching…" : "Refresh network data"}
      </button>
      <Note msg={msg} />
    </div>
  );
}

export function ImportBraiinsButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  return (
    <div className="flex flex-col gap-1">
      <button
        className={btn}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const r = await call("POST", "/api/admin/financials/braiins");
          setBusy(false);
          if (!r.ok) return setMsg({ ok: false, text: errText(r) });
          const d = r.data ?? {};
          setMsg({ ok: true, text: `Pool reported ${String(d.fetched)} payout(s): ${String(d.imported)} imported, ${String(d.alreadyImported)} already recorded.` });
          router.refresh();
        }}
      >
        {busy ? "Importing…" : "Import confirmed payouts (last 90 days)"}
      </button>
      <Note msg={msg} />
    </div>
  );
}

type WorkerLite = { id: string; name: string };
type Props = {
  electricityUsdPerKwh: number | null;
  defaultWattsPerWorker: number | null;
  workerWatts: Record<string, number>;
  poolFeePctOverride: number | null;
  poolFeeDocumentedPct: number;
  workers: WorkerLite[];
};

const toStr = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

/** Blank -> null (not entered). Anything else must be a finite non-negative number, else the field is flagged and nothing is sent. */
function parseField(v: string): { ok: true; value: number | null } | { ok: false } {
  const t = v.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? { ok: true, value: n } : { ok: false };
}

export function CostInputsForm(p: Props) {
  const router = useRouter();
  const [kwh, setKwh] = useState(toStr(p.electricityUsdPerKwh));
  const [watts, setWatts] = useState(toStr(p.defaultWattsPerWorker));
  const [fee, setFee] = useState(toStr(p.poolFeePctOverride));
  const [per, setPer] = useState<Record<string, string>>(() => Object.fromEntries(p.workers.map((w) => [w.id, toStr(p.workerWatts[w.id])])));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function save() {
    const k = parseField(kwh);
    const d = parseField(watts);
    const f = parseField(fee);
    const pw: Record<string, number> = {};
    let bad = !k.ok || !d.ok || !f.ok;
    for (const w of p.workers) {
      const r = parseField(per[w.id] ?? "");
      if (!r.ok) bad = true;
      else if (r.value !== null) pw[w.id] = r.value;
    }
    if (bad || !k.ok || !d.ok || !f.ok) return setMsg({ ok: false, text: "Every filled field must be a number of 0 or more. Leave a field blank if you do not know it." });
    setBusy(true);
    setMsg(null);
    const r = await call("PUT", "/api/admin/financials/settings", {
      electricity_usd_per_kwh: k.value,
      default_watts_per_worker: d.value,
      worker_watts: pw,
      pool_fee_pct_override: f.value,
    });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: "Saved and audited." } : { ok: false, text: errText(r) });
    if (r.ok) router.refresh();
  }

  return (
    <Panel title="Cost inputs" className="lg:col-span-3" badge={<span className="text-[11px] text-faint">blank = not entered (cost unknown, never zero)</span>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Electricity price ($ per kWh)
          <input className={input} inputMode="decimal" value={kwh} onChange={(e) => setKwh(e.target.value)} placeholder="not entered" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Default watts per worker
          <input className={input} inputMode="decimal" value={watts} onChange={(e) => setWatts(e.target.value)} placeholder="not entered" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Pool fee override (%)
          <input className={input} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder={`blank = ${p.poolFeeDocumentedPct}% (Braiins docs)`} />
        </label>
      </div>
      {p.workers.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-faint">Watts per worker (optional override of the default)</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {p.workers.map((w) => (
              <label key={w.id} className="flex flex-col gap-1 text-xs text-muted">
                <span className="truncate">{w.name}</span>
                <input className={input} inputMode="decimal" value={per[w.id] ?? ""} onChange={(e) => setPer((s) => ({ ...s, [w.id]: e.target.value }))} placeholder="use default" />
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className={btnPrimary} disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save cost inputs"}
        </button>
        <Note msg={msg} />
      </div>
      <p className="mt-3 text-[11px] text-faint">Cloud costs are not entered here: they come from the Cloud page (declared hourly price × 24 h, shown as a projection). Cloud workers do not also get an electricity line.</p>
    </Panel>
  );
}
