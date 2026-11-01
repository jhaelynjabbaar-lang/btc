import type { Metadata } from "next";
import { AccessDisabled } from "@/components/db-states";
import { Badge, PageHeader, Panel, Stat } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { ago, fmtUtc } from "@/lib/format";
import { loadVerification, type VerificationView } from "@/lib/verify/service";
import type { Verdict, WorkerVerification } from "@/lib/verify/verdict";
import { supabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Verification" };
export const dynamic = "force-dynamic";

const th = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-faint";
const td = "px-3 py-2 align-top text-xs text-ink";

const VERDICT: Record<Verdict, { tone: "ok" | "warn" | "danger" | "muted"; label: string }> = {
  pool_verified: { tone: "ok", label: "Pool-verified" },
  pool_stale: { tone: "warn", label: "Pool: no recent share" },
  pool_not_seen: { tone: "warn", label: "Not seen by pool" },
  pool_ambiguous: { tone: "warn", label: "Ambiguous name" },
  pool_unavailable: { tone: "muted", label: "Unverified (pool unavailable)" },
};

function Row({ r, now }: { r: WorkerVerification; now: number }) {
  const v = VERDICT[r.verdict];
  return (
    <tr className="border-t border-line/60">
      <td className="px-3 py-2 align-top text-xs font-medium text-ink">{r.name}</td>
      <td className={td}>
        <Badge tone={v.tone}>{v.label}</Badge>
        <p className="mt-1 max-w-sm text-[11px] leading-relaxed text-muted">{r.reason}</p>
        {r.agentClaimUnconfirmed && <p className="mt-1 max-w-sm text-[11px] leading-relaxed text-warn">The agent reports accepted shares, but the pool does not confirm them. Treat this worker as not verified.</p>}
      </td>
      <td className={td}>
        {r.poolWorker ? (
          <>
            <div className="font-mono text-[11px]">{r.poolWorker.name}</div>
            <div className="text-muted">state: {r.poolWorker.state}</div>
            <div className="text-muted">last accepted share: {r.poolWorker.lastShareTs ? `${ago(new Date(r.poolWorker.lastShareTs * 1000), now)} (${fmtUtc(new Date(r.poolWorker.lastShareTs * 1000))})` : "none reported"}</div>
            <div className="text-muted">shares 5m / 60m / 24h: {r.poolWorker.shares5m ?? "n/a"} / {r.poolWorker.shares60m ?? "n/a"} / {r.poolWorker.shares24h ?? "n/a"}</div>
          </>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className={td}>
        {r.agent ? (
          <>
            <div>accepted {r.agent.accepted} · rejected {r.agent.rejected}</div>
            <div className="text-muted">last {r.agent.windowMin} min, {r.agent.buckets} telemetry minute(s)</div>
          </>
        ) : (
          <span className="text-muted">no telemetry in the last 60 min</span>
        )}
        {r.agentSilent && <div className="mt-1 text-warn">Agent silent: no telemetry for over 5 minutes.</div>}
      </td>
    </tr>
  );
}

function Body({ v }: { v: VerificationView }) {
  const now = Date.parse(v.now);
  const poolBadge = !v.pool.connected ? <Badge tone="muted">Not connected</Badge> : v.pool.ok ? <Badge tone="ok">Connected</Badge> : <Badge tone="danger">Pool request failed</Badge>;
  return (
    <>
      <div className="mb-6 rounded-xl border border-warn/40 bg-warn/10 p-4 text-xs leading-relaxed text-warn" role="note">
        <strong className="font-semibold">What counts as verified.</strong> A worker is <strong>Pool-verified</strong> only when Braiins&apos; own Worker API lists a worker with the same name and reports an
        accepted share from the last 15 minutes. Numbers from the agent are shown beside it as <em>agent-reported</em> and are never treated as proof. No pool connection means nothing is verified, and
        verified shares are not earnings: only confirmed payouts (Financials) are.
      </div>
      <div className="mb-4 grid gap-4 sm:grid-cols-4">
        <Stat label="Enrolled workers" value={v.summary.total} />
        <Stat label="Pool-verified" value={v.summary.poolVerified} />
        <Stat label="Not verified" value={v.summary.notVerified} />
        <Stat label="Agent claims the pool does not confirm" value={v.summary.agentClaimsUnconfirmed} />
      </div>
      <Panel title="Workers" badge={poolBadge}>
        {v.pool.error && v.pool.connected && <p className="mb-3 text-xs text-warn">Pool error: <span className="font-mono">{v.pool.error}</span></p>}
        {!v.pool.connected && (
          <p className="mb-3 text-xs text-muted">
            Set <span className="font-mono">BRAIINS_POOL_TOKEN</span> in the Vercel dashboard (a Braiins access profile with web API access). The token is read server-side only and is never shown.
          </p>
        )}
        {v.rows.length === 0 ? (
          <p className="text-sm text-muted">No enrolled workers yet. Add one on the Workers page.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className={th}>Worker</th>
                  <th className={th}>Verdict</th>
                  <th className={th}>Pool-reported</th>
                  <th className={th}>Agent-reported (unverified)</th>
                </tr>
              </thead>
              <tbody>
                {v.rows.map((r) => (
                  <Row key={r.workerId} r={r} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {v.telemetryTruncated && <p className="mt-3 text-[11px] text-warn">Telemetry was truncated at 1000 rows; agent-reported counts may be incomplete.</p>}
      </Panel>
      {v.pool.ok && (
        <Panel title="Pool workers not linked to an enrolled worker" className="mt-4" badge={<Badge tone="muted">{v.unmatchedPool.length}</Badge>}>
          {v.unmatchedPool.length === 0 ? (
            <p className="text-sm text-muted">Every worker the pool lists matches an enrolled worker by name.</p>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted">
                The pool sees these workers, but their names match no enrolled worker. If one of them is your machine, its agent&apos;s pool worker name differs from the name it was enrolled with. They are not
                counted as verified.
              </p>
              <ul className="space-y-1 text-xs">
                {v.unmatchedPool.map((p) => (
                  <li key={p.name} className="font-mono">
                    {p.name} <span className="text-muted">· {p.state} · last accepted share {p.lastShareTs ? ago(new Date(p.lastShareTs * 1000), now) : "none"}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}
      <p className="mt-6 text-[11px] leading-relaxed text-faint">
        Source: Braiins Pool Worker API (<span className="font-mono">/accounts/workers/json/btc</span>), cached 60 s. Checked {fmtUtc(v.now)}. Response shapes follow Braiins&apos; documentation and are validated strictly; they have not
        been exercised against the live service from this repo. Details: <span className="font-mono">docs/verification.md</span>.
      </p>
    </>
  );
}

export default async function Page() {
  const access = await requirePageAccess("/verification");
  const header = (
    <PageHeader eyebrow="Proof of work" title="Verification" subtitle="Which workers the pool itself confirms. Agent-reported numbers are shown for comparison and are never treated as proof." />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  if (!supabaseConfigured()) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-dashed border-line-hi/70 bg-void/40 p-6 text-sm text-muted">
          <Badge tone="warn">Supabase not configured</Badge>
          <p className="mt-3">Set <span className="font-mono text-xs">SUPABASE_URL</span> and <span className="font-mono text-xs">SUPABASE_SECRET_KEY</span>. Nothing is shown until real data exists.</p>
        </div>
      </>
    );
  }
  let view: VerificationView;
  try {
    view = await loadVerification();
  } catch {
    return (
      <>
        {header}
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm text-warn" role="alert">
          The workers or telemetry tables could not be queried. Check the Supabase key.
        </div>
      </>
    );
  }
  return (
    <>
      {header}
      <Body v={view} />
    </>
  );
}
