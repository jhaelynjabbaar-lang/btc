import type { Metadata } from "next";
import { Badge, NotConfigured, PageHeader, Panel, SeverityBadge, Stat } from "@/components/ui";
import Link from "next/link";
import { actorForPage } from "@/lib/auth/access";
import { getDb } from "@/lib/db/client";
import { countNewSince, getCursors, listResearch, listRuns, tableCounts } from "@/lib/db/repo";
import { ago as agoFmt, daysAgo, fmtUtc } from "@/lib/format";
import { SOURCE_KEYS } from "@/lib/monitor/ingest";
import { getAiStatus, type AiStatus } from "@/lib/ai/status";
import { countBySeverity, getFeed } from "@/lib/intel/feed";
import type { Feed } from "@/lib/intel/types";
import { formatDifficulty, formatHashrate, getNetworkStatus, type NetworkStatus } from "@/lib/bitcoin-network";

export const metadata: Metadata = { title: "Dashboard" };

// Rendered per request; the mempool.space responses themselves are cached for 60s
// through the fetch data cache (see lib/bitcoin-network.ts).
export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("en-US");

function ago(seconds: number): string {
  if (seconds < 0) seconds = 0;
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

const DASH = <span className="text-faint">—</span>;

function NetworkPanel({ net }: { net: NetworkStatus }) {
  const allFailed = net.tipHeight === null && !net.latestBlock && !net.fees && !net.difficulty && !net.mempool;
  const now = net.asOf ? Date.parse(net.asOf) / 1000 : null;
  return (
    <Panel
      title="Bitcoin network status"
      className="lg:col-span-2"
      badge={
        allFailed ? (
          <Badge tone="danger">Source unavailable</Badge>
        ) : net.failed.length ? (
          <Badge tone="warn">Partial data</Badge>
        ) : (
          <Badge tone="ok">Live</Badge>
        )
      }
    >
      {allFailed ? (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-muted">
          <div className="font-medium text-danger">Could not reach mempool.space.</div>
          <p className="mt-1">No network values are shown because none could be fetched. This page retries on the next request.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Block height"
              value={net.tipHeight !== null ? nf.format(net.tipHeight) : DASH}
              hint={
                net.latestBlock && now
                  ? `Last block ${ago(now - net.latestBlock.time)} · ${nf.format(net.latestBlock.txCount)} txs${net.latestBlock.pool ? ` · ${net.latestBlock.pool}` : ""}`
                  : undefined
              }
            />
            <Stat
              label="Hashrate (est.)"
              value={net.difficulty?.hashrate != null ? formatHashrate(net.difficulty.hashrate) : DASH}
              hint="Current network estimate"
            />
            <Stat
              label="Difficulty"
              value={net.difficulty?.current != null ? formatDifficulty(net.difficulty.current) : DASH}
              hint={
                net.difficulty
                  ? `Next adjustment ${net.difficulty.estimatedChangePercent >= 0 ? "+" : ""}${net.difficulty.estimatedChangePercent.toFixed(2)}% (est.) in ${nf.format(net.difficulty.remainingBlocks)} blocks`
                  : undefined
              }
            />
            <Stat
              label="Mempool"
              value={net.mempool ? `${nf.format(net.mempool.count)} tx` : DASH}
              hint={net.mempool ? `${(net.mempool.vsize / 1e6).toFixed(1)} MvB pending` : undefined}
            />
          </div>

          <div className="mt-4">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-faint">Recommended fees (sat/vB)</div>
            {net.fees ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Fastest" value={net.fees.fastest} />
                <Stat label="~30 min" value={net.fees.halfHour} />
                <Stat label="~1 hour" value={net.fees.hour} />
                <Stat label="Economy" value={net.fees.economy} />
              </div>
            ) : (
              <p className="text-sm text-muted">Fee estimates unavailable.</p>
            )}
          </div>

          {net.difficulty && (
            <div className="mt-4">
              <div className="mb-1.5 flex justify-between text-xs text-muted">
                <span>Difficulty epoch progress</span>
                <span className="font-mono">{net.difficulty.progressPercent.toFixed(1)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-line" role="presentation">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-electric to-neon"
                  style={{ width: `${Math.min(100, Math.max(0, net.difficulty.progressPercent))}%` }}
                />
              </div>
              <div className="mt-1 text-xs text-faint">Retarget at block {nf.format(net.difficulty.nextRetargetHeight)}</div>
            </div>
          )}

          {net.failed.length > 0 && (
            <p className="mt-3 text-xs text-warn">Unavailable right now: {net.failed.join(", ")}.</p>
          )}
        </>
      )}
      <p className="mt-4 text-xs text-faint">
        Source: {net.source} (public API, fetched server-side, cached up to 60 s)
        {net.asOf ? ` · data as of ${net.asOf.replace("T", " ").slice(0, 19)} UTC` : ""}
      </p>
    </Panel>
  );
}

function AiPanel({ ai }: { ai: AiStatus }) {
  const badge = !ai.configured ? (
    <Badge tone="muted">Not configured</Badge>
  ) : ai.working ? (
    <Badge tone="ok">Working</Badge>
  ) : (
    <Badge tone="danger">Not working</Badge>
  );
  const rows: Array<[string, React.ReactNode]> = [
    ["Provider", ai.provider],
    ["Model", <span key="m" className="break-all font-mono text-xs">{ai.model}</span>],
    ["API key", ai.configured ? "Present (server-side)" : "Not set (OPENROUTER_API_KEY)"],
    [
      "Provider check",
      !ai.configured
        ? "Not run"
        : ai.working
          ? "Key accepted, model listed"
          : `Failed (${ai.error ?? "unknown"})`,
    ],
  ];
  return (
    <Panel title="AI engine status" badge={badge}>
      <dl className="space-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-4 border-b border-line/60 pb-2 last:border-0">
            <dt className="text-muted">{k}</dt>
            <dd className="text-right text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm text-muted">
        Powers <Link href="/intelligence" className="text-electric-hi hover:text-neon">Intelligence Engine</Link>, the vulnerability
        explainer and the <Link href="/scanner" className="text-electric-hi hover:text-neon">Code Scanner</Link>.
        {ai.configured ? " This check does not run a completion; no model call is made by this page." : ""}
      </p>
    </Panel>
  );
}

function VulnPanel({ feed }: { feed: Feed }) {
  const counts = countBySeverity(feed.items);
  const anyOk = feed.sources.some((s) => s.ok);
  const failed = feed.sources.filter((s) => !s.ok);
  return (
    <Panel
      title="Vulnerability statistics"
      badge={anyOk ? (failed.length ? <Badge tone="warn">Partial</Badge> : <Badge tone="ok">Live</Badge>) : <Badge tone="danger">Unavailable</Badge>}
    >
      {!anyOk ? (
        <p className="text-sm text-muted">No vulnerability source could be reached, so no counts are shown.</p>
      ) : (
        <>
          <div className="mb-3 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold text-ink">{feed.items.length}</span>
            <span className="text-xs text-faint">unique Bitcoin-related items</span>
          </div>
          <ul className="space-y-1.5">
            {(["critical", "high", "medium", "low", "unrated"] as const).map((s) => (
              <li key={s} className="flex items-center justify-between">
                <SeverityBadge severity={s} />
                <span className="font-mono text-ink">{counts[s]}</span>
              </li>
            ))}
          </ul>
          {failed.length > 0 && <p className="mt-2 text-xs text-warn">Unavailable: {failed.map((f) => f.name).join(", ")}.</p>}
          <Link href="/vulnerabilities" className="mt-3 text-xs text-electric-hi hover:text-neon">View feed →</Link>
        </>
      )}
      <p className="mt-2 text-xs text-faint">NVD + GitHub advisories + bitcoincore.org, cached up to 1 h. Stored by the monitoring ingest when a database is connected.</p>
    </Panel>
  );
}


type DbView =
  | { state: "no_db" }
  | { state: "private"; authConfigured: boolean }
  | { state: "error" }
  | {
      state: "ok";
      counts: Awaited<ReturnType<typeof tableCounts>>;
      cursors: Awaited<ReturnType<typeof getCursors>>;
      lastRun: Awaited<ReturnType<typeof listRuns>>[number] | undefined;
      fresh: Awaited<ReturnType<typeof countNewSince>>;
      reports: Awaited<ReturnType<typeof listResearch>>["rows"];
    };

/** Dashboard panels read the database only for an allowed viewer (saved research is private). */
async function loadDb(): Promise<DbView> {
  const db = getDb();
  if (!db) return { state: "no_db" };
  const actor = await actorForPage();
  if (!actor.allowed) return { state: "private", authConfigured: actor.mode === "auth" };
  try {
    const [counts, cursors, runs, fresh, reports] = await Promise.all([
      tableCounts(db),
      getCursors(db),
      listRuns(db, 1),
      countNewSince(db, daysAgo(7)),
      listResearch(db, { limit: 5 }),
    ]);
    return { state: "ok", counts, cursors, lastRun: runs[0], fresh, reports: reports.rows };
  } catch {
    return { state: "error" };
  }
}

function dbNote(v: Exclude<DbView, { state: "ok" }>) {
  if (v.state === "no_db")
    return (
      <NotConfigured note="Database not configured — awaiting Neon">
        No <span className="font-mono text-xs">DATABASE_URL</span> is set, so nothing is stored or shown here. Connect Neon and run the migration to turn this on.
      </NotConfigured>
    );
  if (v.state === "private")
    return (
      <NotConfigured note={v.authConfigured ? "Sign in to view" : "Private on this host"}>
        Stored research and monitoring data are only shown to an allowed viewer. <Link href="/signin" className="text-electric-hi hover:text-neon">Sign in</Link>
      </NotConfigured>
    );
  return (
    <NotConfigured note="Database unreachable or not migrated">
      Run <span className="font-mono text-xs">npm run db:migrate</span> and check <span className="font-mono text-xs">DATABASE_URL</span>.
    </NotConfigured>
  );
}

function MonitoringPanel({ v }: { v: DbView }) {
  return (
    <Panel title="Security monitoring overview" badge={v.state === "ok" ? (v.lastRun ? <Badge tone="ok">Live</Badge> : <Badge tone="warn">No runs yet</Badge>) : <Badge tone="warn">Awaiting data</Badge>}>
      {v.state !== "ok" ? (
        dbNote(v)
      ) : (
        <>
          <div className="mb-3 text-sm text-muted">
            Last ingest: <span className="text-ink">{v.lastRun ? `${agoFmt(v.lastRun.startedAt)} (${v.lastRun.trigger})` : "never"}</span>
          </div>
          <ul className="space-y-1.5 text-sm text-muted">
            {(Object.values(SOURCE_KEYS) as string[]).map((name) => {
              const c = v.cursors.find((x) => x.source === name);
              return (
                <li key={name} className="flex items-center justify-between gap-2">
                  <span className="truncate">{name}</span>
                  {!c ? <Badge>never run</Badge> : c.lastStatus === "ok" ? <Badge tone="ok">ok · {agoFmt(c.lastRunAt)}</Badge> : <Badge tone="warn">error</Badge>}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-faint">
            New in the last 7 days: <span className="font-mono text-ink">{v.fresh.findings}</span> finding(s), <span className="font-mono text-ink">{v.fresh.releases}</span> release/post(s).{" "}
            <Link href="/monitoring" className="text-electric-hi hover:text-neon">Details →</Link>
          </p>
        </>
      )}
    </Panel>
  );
}

function ResearchPanel({ v }: { v: DbView }) {
  return (
    <Panel title="Research activity" badge={v.state === "ok" ? <Badge tone="ok">Live</Badge> : <Badge tone="warn">Awaiting data</Badge>}>
      {v.state !== "ok" ? (
        dbNote(v)
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Saved research" value={v.counts.researchReports} />
          <Stat label="Scans run" value={v.counts.scanRuns} />
          <Stat label="Findings stored" value={v.counts.findings} />
          <Stat label="Releases / posts" value={v.counts.releases} />
        </div>
      )}
    </Panel>
  );
}

function ReportsPanel({ v }: { v: DbView }) {
  return (
    <Panel title="Recent intelligence reports" className="lg:col-span-3" badge={v.state === "ok" ? <Badge tone="ok">Live</Badge> : <Badge tone="warn">Awaiting data</Badge>}>
      {v.state !== "ok" ? (
        dbNote(v)
      ) : v.reports.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing saved yet. Ask a question or generate a report on the <Link href="/intelligence" className="text-electric-hi hover:text-neon">Intelligence Engine</Link> and it is stored here.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {v.reports.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <Link href={`/reports/${r.id}`} className="min-w-0 flex-1 truncate text-ink/90 hover:text-neon">{r.title || r.question}</Link>
              <span className="flex items-center gap-2 text-xs text-faint"><Badge tone={r.mode === "report" ? "info" : "muted"}>{r.mode}</Badge>{fmtUtc(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default async function DashboardPage() {
  const [net, ai, feed, dbv] = await Promise.all([getNetworkStatus(), getAiStatus(), getFeed(), loadDb()]);

  return (
    <>
      <PageHeader
        eyebrow="Operations overview"
        title="Bitcoin Security Intelligence"
        subtitle="Live Bitcoin network status, plus the security tooling being built stage by stage. Panels without a data source say so."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <NetworkPanel net={net} />

        <AiPanel ai={ai} />

        <MonitoringPanel v={dbv} />

        <VulnPanel feed={feed} />

        <ResearchPanel v={dbv} />

        <ReportsPanel v={dbv} />
      </div>
    </>
  );
}
