"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Panel } from "./ui";

const btnPrimary = "rounded-md bg-gradient-to-r from-electric to-neon px-3 py-1.5 text-xs font-semibold text-void disabled:opacity-50";
const btn = "rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-panel-hi disabled:opacity-40";
const btnDanger = "rounded-md border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-40";
const input = "w-28 rounded-md border border-line bg-void/60 px-2 py-1.5 text-xs text-ink";

type Msg = { ok: boolean; text: string } | null;

async function control(body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> | null; status: number }> {
  try {
    const res = await fetch("/api/admin/paper/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, data, status: res.status };
  } catch {
    return { ok: false, data: { message: "Network error." }, status: 0 };
  }
}

/** Admin-only controls (the page itself is admin-gated and so is the API). Paper money only. */
export function PaperControls({ hasRun, paused, defaults }: { hasRun: boolean; paused: boolean; defaults: { startUsd: number; feePct: number; slippagePct: number } }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [start, setStart] = useState(String(defaults.startUsd));
  const [fee, setFee] = useState(String(defaults.feePct));
  const [slip, setSlip] = useState(String(defaults.slippagePct));
  const [confirmReset, setConfirmReset] = useState(false);

  async function run(body: unknown, ok: string) {
    setBusy(true);
    setMsg(null);
    const r = await control(body);
    setBusy(false);
    if (r.ok) {
      const d = r.data ?? {};
      const extra = typeof d.status === "string" ? ` (${d.status}${typeof d.reason === "string" ? `: ${d.reason}` : ""})` : "";
      setMsg({ ok: true, text: ok + extra });
      router.refresh();
    } else {
      setMsg({ ok: false, text: String(r.data?.message ?? `Failed (HTTP ${r.status}).`) });
    }
  }

  return (
    <Panel title="Controls (admin)">
      <p className="mb-3 text-xs text-muted">These controls only change the simulation. They can never place a real order.</p>
      <div className="flex flex-wrap items-center gap-2">
        {hasRun && (
          <>
            {paused ? (
              <button className={btnPrimary} disabled={busy} onClick={() => run({ action: "resume" }, "Resumed.")}>
                Resume
              </button>
            ) : (
              <button className={btn} disabled={busy} onClick={() => run({ action: "pause" }, "Paused.")}>
                Pause
              </button>
            )}
            <button className={btn} disabled={busy} onClick={() => run({ action: "tick" }, "Tick requested.")}>
              Run tick now
            </button>
          </>
        )}
      </div>
      <div className="mt-4 border-t border-line/60 pt-4">
        <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-faint">{hasRun ? "Reset (archives this run, starts a new one)" : "Start a paper run"}</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted">
            Starting balance (USD)
            <input className={input + " mt-1 block"} inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="text-xs text-muted">
            Taker fee (%)
            <input className={input + " mt-1 block"} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
          </label>
          <label className="text-xs text-muted">
            Slippage (%)
            <input className={input + " mt-1 block"} inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={confirmReset} onChange={(e) => setConfirmReset(e.target.checked)} />
            Yes, {hasRun ? "reset" : "start"}
          </label>
          <button
            className={hasRun ? btnDanger : btnPrimary}
            disabled={busy || !confirmReset}
            onClick={() => {
              const s = Number(start);
              const f = Number(fee);
              const l = Number(slip);
              if (![s, f, l].every(Number.isFinite)) return setMsg({ ok: false, text: "Enter numbers only." });
              void run({ action: "reset", confirm: true, starting_usd: s, fee_pct: f, slippage_pct: l }, hasRun ? "Reset: new paper run started." : "Paper run started.").then(() => setConfirmReset(false));
            }}
          >
            {hasRun ? "Reset" : "Start"}
          </button>
        </div>
      </div>
      {msg && (
        <p role="status" className={"mt-3 text-xs " + (msg.ok ? "text-ok" : "text-danger")}>
          {msg.text}
        </p>
      )}
    </Panel>
  );
}
