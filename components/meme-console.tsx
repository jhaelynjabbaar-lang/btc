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
    const res = await fetch("/api/admin/meme-paper/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, data, status: res.status };
  } catch {
    return { ok: false, data: { message: "Network error." }, status: 0 };
  }
}

/** Admin-only controls (the page and the API are both admin-gated). They only change the simulation; nothing can place a real order. */
export function MemeControls({ hasAccount, paused, startUsd }: { hasAccount: boolean; paused: boolean; startUsd: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [start, setStart] = useState(String(startUsd));
  const [confirmReset, setConfirmReset] = useState(false);

  async function run(body: unknown, ok: string) {
    setBusy(true);
    setMsg(null);
    const r = await control(body);
    setBusy(false);
    if (r.ok) {
      const d = r.data ?? {};
      let extra = "";
      if (typeof d.status === "string") {
        extra = ` (${d.status}`;
        if (d.status === "applied") extra += `: ${d.candidates_seen} candidates, ${d.rejected} rejected, ${Array.isArray(d.bought) ? d.bought.length : 0} bought, ${Array.isArray(d.sold) ? d.sold.length : 0} sold`;
        else if (typeof d.reason === "string") extra += `: ${d.reason}`;
        extra += ")";
      }
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
        {hasAccount && (
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
            <button className={btn} disabled={busy} onClick={() => run({ action: "tick" }, "Tick finished.")}>
              {busy ? "Running…" : "Run tick now"}
            </button>
          </>
        )}
      </div>
      <div className="mt-4 border-t border-line/60 pt-4">
        <div className="mb-2 text-[11px] uppercase tracking-[0.12em] text-faint">{hasAccount ? "Reset (archives this account, starts a new one)" : "Start a paper account"}</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted">
            Starting balance (paper USD)
            <input className={input + " mt-1 block"} inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={confirmReset} onChange={(e) => setConfirmReset(e.target.checked)} />
            Yes, {hasAccount ? "reset" : "start"}
          </label>
          <button
            className={hasAccount ? btnDanger : btnPrimary}
            disabled={busy || !confirmReset}
            onClick={() => {
              const s = Number(start);
              if (!Number.isFinite(s)) return setMsg({ ok: false, text: "Enter a number." });
              void run({ action: "reset", confirm: true, starting_usd: s }, hasAccount ? "Reset: new paper account started." : "Paper account started.").then(() => setConfirmReset(false));
            }}
          >
            {hasAccount ? "Reset" : "Start"}
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
