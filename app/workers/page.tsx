import type { Metadata } from "next";
import { AccessDisabled } from "@/components/db-states";
import { AddWorkerButton, CommandButtons } from "@/components/worker-actions";
import { Badge, PageHeader, Panel } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { ago, fmtUtc } from "@/lib/format";
import { getSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";
import { ingestUrl } from "@/lib/workers/config";

export const metadata: Metadata = { title: "Workers" };
export const dynamic = "force-dynamic";

function fmtHashrate(hs: number): string {
  if (!Number.isFinite(hs) || hs <= 0) return "0 H/s";
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let i = 0;
  let v = hs;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

const STATUS_TONE = { online: "ok", paused: "warn", pending: "muted", offline: "muted", revoked: "danger" } as const;

export default async function Page() {
  const access = await requirePageAccess("/workers");
  const header = (
    <PageHeader
      eyebrow="Agent fleet"
      title="Workers"
      subtitle="Machines you own or have authorized, enrolled with a one-time code and reporting signed one-minute telemetry through the Cloudflare ingest Worker."
    />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  if (!supabaseConfigured()) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-dashed border-line-hi/70 bg-void/40 p-6 text-sm text-muted">
          <Badge tone="warn">Supabase not configured</Badge>
          <p className="mt-3">Set <span className="font-mono text-xs">SUPABASE_URL</span> and <span className="font-mono text-xs">SUPABASE_SECRET_KEY</span> to manage workers. Nothing is shown until real data exists.</p>
        </div>
      </>
    );
  }

  const db = getSupabaseServer();
  const [workersRes, pendingRes] = await Promise.all([
    db
      .from("workers")
      .select("id, name, status, hardware_type, os, current_hashrate_hs, uptime_s, last_seen_at, software_version, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    db.from("worker_commands").select("worker_id, command").eq("status", "pending").gt("expires_at", new Date().toISOString()),
  ]);
  if (workersRes.error) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm text-warn" role="alert">
          The workers table could not be queried. Check the Supabase migrations and key.
        </div>
      </>
    );
  }
  const workers = workersRes.data ?? [];
  const pendingBy = new Map<string, string[]>();
  for (const c of pendingRes.data ?? []) pendingBy.set(c.worker_id, [...(pendingBy.get(c.worker_id) ?? []), c.command]);

  return (
    <>
      {header}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Add worker" className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <p className="max-w-lg text-sm text-muted">
              Creates a one-time enrollment code that expires in 15 minutes. Paste it into the agent together with its own Ed25519 public key; the
              private key never leaves the machine.
            </p>
            <AddWorkerButton />
          </div>
        </Panel>
        <Panel title="Ingest endpoint">
          <div className="break-all font-mono text-xs text-ink/90">{ingestUrl()}</div>
          <p className="mt-2 text-xs text-faint">Signed requests only. No mining traffic or per-share data passes through it — one-minute rollups and commands only.</p>
        </Panel>
      </div>

      <Panel title="Enrolled workers" badge={<Badge>{workers.length}</Badge>}>
        {workers.length === 0 ? (
          <p className="text-sm text-muted">No workers enrolled yet. Use “Add worker” to create an enrollment code; the worker appears here once an agent enrolls.</p>
        ) : (
          <ul className="divide-y divide-line">
            {workers.map((w) => {
              const pending = pendingBy.get(w.id) ?? [];
              return (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{w.name}</span>
                      <Badge tone={STATUS_TONE[w.status as keyof typeof STATUS_TONE] ?? "muted"}>{w.status}</Badge>
                      <Badge>{w.hardware_type}</Badge>
                      {pending.length > 0 && <Badge tone="info">pending: {pending.join(", ")}</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-faint">
                      {fmtHashrate(Number(w.current_hashrate_hs))} · last seen {w.last_seen_at ? `${ago(w.last_seen_at)} (${fmtUtc(w.last_seen_at)})` : "never"}
                      {w.os ? ` · ${w.os}` : ""}
                      {w.software_version ? ` · v${w.software_version}` : ""}
                    </div>
                  </div>
                  <CommandButtons workerId={w.id} disabled={w.status === "revoked"} />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
