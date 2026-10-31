"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Summary = { newCount: number; results: Array<{ source: string; ok: boolean; fetched: number; newCount: number; baseline: boolean; error?: string }> };

/** "Run ingest now" for a signed-in admin (the route enforces access; this is only the trigger). */
export function IngestButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/ingest", { method: "POST" });
      const data = (await res.json().catch(() => null)) as (Summary & { message?: string }) | null;
      if (!res.ok || !data) {
        setMsg({ ok: false, text: data?.message ?? `Ingest failed (HTTP ${res.status}).` });
      } else {
        const failed = data.results.filter((r) => !r.ok).length;
        const base = data.results.filter((r) => r.baseline && r.ok).length;
        setMsg({
          ok: failed === 0,
          text: `${data.newCount} new item(s). ${data.results.length - failed}/${data.results.length} sources ok${base ? `; ${base} recorded as baseline (first run)` : ""}.`,
        });
        router.refresh();
      }
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="rounded-lg bg-gradient-to-r from-electric to-neon px-4 py-2 text-sm font-semibold text-void disabled:opacity-50"
      >
        {busy ? "Ingesting…" : "Run ingest now"}
      </button>
      {msg && (
        <p className={"text-xs " + (msg.ok ? "text-ok" : "text-warn")} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
