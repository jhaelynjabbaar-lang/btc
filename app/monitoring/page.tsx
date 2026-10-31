import type { Metadata } from "next";
import { AccessDisabled, DatabaseNotConfigured } from "@/components/db-states";
import { IngestButton } from "@/components/ingest-button";
import { Badge, PageHeader, Panel, SeverityBadge } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { getDb } from "@/lib/db/client";
import { countNewSince, getCursors, listReleases, listRuns, recentNewFindings } from "@/lib/db/repo";
import { ago, daysAgo, fmtUtc } from "@/lib/format";
import { SOURCE_KEYS } from "@/lib/monitor/ingest";

export const metadata: Metadata = { title: "Monitoring" };
export const dynamic = "force-dynamic";

const ORDER = Object.values(SOURCE_KEYS) as string[];

export default async function Page() {
  const access = await requirePageAccess("/monitoring");
  const header = (
    <PageHeader
      eyebrow="Automated public-source monitoring"
      title="Monitoring"
      subtitle="A daily job reads NVD, GitHub security advisories, bitcoincore.org (advisories and RSS) and bitcoin/bitcoin releases, stores them idempotently, and flags what is new since the last run."
    />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  const db = getDb();
  if (!db) return <>{header}<DatabaseNotConfigured what="Monitoring" /></>;

  let d;
  try {
    const [cursors, runs, fresh, rel, day] = await Promise.all([
      getCursors(db),
      listRuns(db, 8),
      recentNewFindings(db, 15),
      listReleases(db, { limit: 8 }),
      countNewSince(db, daysAgo(7)),
    ]);
    d = { cursors, runs, fresh, rel, day };
  } catch {
    return (
      <>
        {header}
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm text-warn" role="alert">
          The database is configured but could not be queried. If this is a new database, run <span className="font-mono">npm run db:migrate</span> first.
        </div>
      </>
    );
  }
  const { cursors, runs, fresh, rel, day } = d;
  const bySource = new Map(cursors.map((c) => [c.source, c]));
  const lastRun = runs[0];
  const cronSet = Boolean(process.env.CRON_SECRET);

  return (
    <>
      {header}
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Run status" className="lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 text-sm">
              <div className="text-muted">Last run: <span className="text-ink">{lastRun ? `${fmtUtc(lastRun.startedAt)} (${ago(lastRun.startedAt)}, ${lastRun.trigger})` : "never — nothing has been ingested yet"}</span></div>
              <div className="text-muted">New in the last 7 days: <span className="font-mono text-ink">{day.findings}</span> finding(s), <span className="font-mono text-ink">{day.releases}</span> release/post(s)</div>
              <div className="flex items-center gap-2 text-muted">Scheduled job: {cronSet ? <Badge tone="ok">CRON_SECRET set · daily 06:17 UTC</Badge> : <Badge tone="warn">CRON_SECRET not set — cron route refuses</Badge>}</div>
            </div>
            <IngestButton />
          </div>
          <p className="mt-4 text-xs text-faint">
            Each source&apos;s first successful run is stored as a <strong className="text-muted">baseline</strong> (so existing history is not reported as “new”). Items first seen on later runs are flagged new.
            The Vercel Hobby plan allows one cron run per day; use “Run ingest now” for an immediate refresh.
          </p>
        </Panel>
        <Panel title="Sources">
          <ul className="space-y-3 text-sm">
            {ORDER.map((name) => {
              const c = bySource.get(name);
              return (
                <li key={name} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-ink/90">{name}</div>
                    <div className="text-xs text-faint">
                      {c?.lastRunAt ? `${ago(c.lastRunAt)} · ${c.lastCount ?? 0} fetched · ${c.lastNew ?? 0} new` : "not run yet"}
                    </div>
                    {c?.lastError && <div className="text-xs text-warn">{c.lastStatus === "error" ? c.lastError : `Partial result — ${c.lastError}`}</div>}
                  </div>
                  {!c ? <Badge>never run</Badge> : c.lastStatus === "ok" ? <Badge tone="ok">ok</Badge> : <Badge tone="warn">error</Badge>}
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Recent new findings">
          {fresh.length === 0 ? (
            <p className="text-sm text-muted">Nothing new yet. After the baseline run, anything first seen by a later run appears here.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {fresh.map((f) => (
                <li key={f.id} className="flex items-start gap-3">
                  <SeverityBadge severity={f.severity} score={f.score} />
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-ink/90"><span className="font-mono text-xs text-electric-hi">{f.cveId ?? f.externalId}</span> {f.title}</div>
                    <div className="text-xs text-faint">{f.source} · first seen {fmtUtc(f.firstSeen)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Latest releases & posts">
          {rel.length === 0 ? <p className="text-sm text-muted">None ingested yet.</p> : (
            <ul className="space-y-3 text-sm">
              {rel.map((r) => (
                <li key={r.id}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 text-ink/90 hover:text-neon">{r.title}</a>
                  <div className="text-xs text-faint">
                    {r.kind === "github_release" ? (r.prerelease ? "pre-release" : "release") : "bitcoincore.org post"} · {fmtUtc(r.publishedAt)}
                    {!r.isBaseline && <> · <span className="text-ok">new</span></>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Run history" className="mt-4">
        {runs.length === 0 ? <p className="text-sm text-muted">No runs recorded.</p> : (
          <ul className="divide-y divide-line text-sm">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-muted">
                <span>{fmtUtc(r.startedAt)} · {r.trigger}</span>
                <span>{r.finishedAt ? <><span className="font-mono text-ink">{r.newCount}</span> new</> : "unfinished"}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
