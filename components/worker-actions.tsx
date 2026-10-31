"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Minted = { code: string; expires_at: string; ttl_seconds: number; ingest_url: string };

/** "Add worker": mints a one-time enrollment code (shown once, never stored in plaintext). The route enforces admin access. */
export function AddWorkerButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint() {
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/workers/enrollment-codes", { method: "POST" });
      const data = (await res.json().catch(() => null)) as (Minted & { message?: string }) | null;
      if (!res.ok || !data?.code) setErr(data?.message ?? `Could not create a code (HTTP ${res.status}).`);
      else setMinted(data);
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function dismiss() {
    setMinted(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        onClick={() => void mint()}
        disabled={busy}
        className="rounded-lg bg-gradient-to-r from-electric to-neon px-4 py-2 text-sm font-semibold text-void disabled:opacity-50"
      >
        {busy ? "Creating code…" : "Add worker"}
      </button>
      {err && <p className="text-xs text-warn" role="alert">{err}</p>}
      {minted && (
        <div className="w-full max-w-xl rounded-xl border border-neon/40 bg-void/60 p-4" role="status">
          <div className="text-xs uppercase tracking-[0.14em] text-neon/80">One-time enrollment code — shown only now</div>
          <div className="mt-2 select-all break-all font-mono text-lg text-ink">{minted.code}</div>
          <p className="mt-2 text-xs text-muted">
            Expires in {Math.round(minted.ttl_seconds / 60)} minutes (at {new Date(minted.expires_at).toISOString().slice(11, 16)} UTC) and works once. Only its hash is stored; it cannot be shown again.
            The agent enrolls at <span className="font-mono text-ink/90">{minted.ingest_url}/v1/enroll</span> with this code and its own Ed25519 public key.
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void copy()} className="rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-panel-hi">
              {copied ? "Copied" : "Copy code"}
            </button>
            <button type="button" onClick={dismiss} className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:bg-panel-hi">
              Done — hide it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const CMDS = [
  { command: "start", label: "Start" },
  { command: "pause", label: "Pause" },
  { command: "stop", label: "Stop" },
] as const;

/** Queue a start/pause/stop command for one worker (delivered on its next signed poll). */
export function CommandButtons({ workerId, disabled }: { workerId: string; disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(command: string) {
    setBusy(command);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/workers/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worker_id: workerId, command }),
      });
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      if (res.ok) {
        setMsg({ ok: true, text: `${command} queued` });
        router.refresh();
      } else setMsg({ ok: false, text: data?.message ?? `Failed (HTTP ${res.status}).` });
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1.5">
        {CMDS.map((c) => (
          <button
            key={c.command}
            type="button"
            disabled={disabled || busy !== null}
            onClick={() => void send(c.command)}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-panel-hi disabled:opacity-40"
          >
            {busy === c.command ? "…" : c.label}
          </button>
        ))}
      </div>
      {msg && <span className={"text-[11px] " + (msg.ok ? "text-ok" : "text-warn")} role="status">{msg.text}</span>}
    </div>
  );
}
