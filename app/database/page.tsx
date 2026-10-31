import type { Metadata } from "next";
import Link from "next/link";
import { AccessDisabled, DatabaseNotConfigured } from "@/components/db-states";
import { Badge, PageHeader, Panel, SeverityBadge, Stat } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { getDb } from "@/lib/db/client";
import { findingsStats, listFindings, listReleases, listResearch, listScanRuns, tableCounts } from "@/lib/db/repo";
import { fmtDay, fmtUtc } from "@/lib/format";

export const metadata: Metadata = { title: "Database" };
export const dynamic = "force-dynamic";

type SP = Promise<{ [k: string]: string | string[] | undefined }>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const SEVS = ["critical", "high", "medium", "low", "unrated"] as const;
const PAGE = 25;

export default async function Page({ searchParams }: { searchParams: SP }) {
  const access = await requirePageAccess("/database");
  const header = (
    <PageHeader title="Database" subtitle="The research database: ingested vulnerability findings, releases, saved research and scan metadata." />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  const db = getDb();
  if (!db) return <>{header}<DatabaseNotConfigured what="The Database page" /></>;

  const sp = await searchParams;
  const q = one(sp.q)?.slice(0, 100) ?? "";
  const source = one(sp.source) ?? "";
  const severity = SEVS.find((s) => s === one(sp.severity));
  const status = one(sp.status) === "confirmed" || one(sp.status) === "unverified" ? (one(sp.status) as "confirmed" | "unverified") : undefined;
  const newOnly = one(sp.new) === "1";
  const page = Math.max(1, Math.min(1000, Number.parseInt(one(sp.page) ?? "1", 10) || 1));

  let data;
  try {
    const [counts, stats, found, research, scans, rel] = await Promise.all([
      tableCounts(db),
      findingsStats(db),
      listFindings(db, { q, source: source || undefined, severity, status, newOnly, limit: PAGE, offset: (page - 1) * PAGE }),
      listResearch(db, { limit: 5 }),
      listScanRuns(db, 5),
      listReleases(db, { limit: 5 }),
    ]);
    data = { counts, stats, found, research, scans, rel };
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
  const { counts, stats, found, research, scans, rel } = data;
  const sources = stats.bySource.map((s) => s.source).sort();
  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const cur: Record<string, string | number | undefined> = { q: q || undefined, source: source || undefined, severity, status, new: newOnly ? "1" : undefined, page, ...over };
    for (const [k, v] of Object.entries(cur)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/database?${p.toString()}`;
  };
  const pages = Math.max(1, Math.ceil(found.total / PAGE));

  return (
    <>
      {header}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Findings" value={counts.findings} />
        <Stat label="Releases / posts" value={counts.releases} />
        <Stat label="Saved research" value={counts.researchReports} />
        <Stat label="Scan runs" value={counts.scanRuns} />
        <Stat label="Ingest runs" value={counts.ingestionRuns} />
      </div>

      <Panel title="Findings" badge={<Badge tone="info">{found.total} match</Badge>} className="mb-4">
        <form method="get" className="mb-4 grid gap-2 sm:grid-cols-6">
          <input name="q" defaultValue={q} placeholder="Search title or CVE id…" aria-label="Search findings" className="rounded-lg border border-line bg-void px-3 py-2 text-sm text-ink placeholder:text-faint sm:col-span-2" />
          <select name="source" defaultValue={source} aria-label="Source" className="rounded-lg border border-line bg-void px-2 py-2 text-sm text-ink">
            <option value="">All sources</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select name="severity" defaultValue={severity ?? ""} aria-label="Severity" className="rounded-lg border border-line bg-void px-2 py-2 text-sm text-ink">
            <option value="">All severities</option>
            {SEVS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select name="status" defaultValue={status ?? ""} aria-label="Status" className="rounded-lg border border-line bg-void px-2 py-2 text-sm text-ink">
            <option value="">Any status</option>
            <option value="confirmed">confirmed</option>
            <option value="unverified">unverified</option>
          </select>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" name="new" value="1" defaultChecked={newOnly} /> New only</label>
            <button type="submit" className="ml-auto rounded-lg border border-electric/50 bg-electric/10 px-3 py-2 text-sm text-electric-hi hover:bg-electric/20">Filter</button>
          </div>
        </form>

        {found.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-hi/70 bg-void/40 p-4 text-sm text-muted">
            {counts.findings === 0
              ? "The database is connected but empty. Run the first ingest from the Monitoring page (or open Vulnerabilities, which stores the live feed)."
              : "No findings match these filters."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-faint">
                <tr><th className="pb-2 pr-3">ID</th><th className="pb-2 pr-3">Title</th><th className="pb-2 pr-3">Severity</th><th className="pb-2 pr-3">Status</th><th className="pb-2 pr-3">Source</th><th className="pb-2">First seen</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {found.rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="py-2 pr-3 font-mono text-xs text-electric-hi">{r.cveId ?? r.externalId}</td>
                    <td className="py-2 pr-3 text-ink/90">
                      <span className="line-clamp-2">{r.title}</span>
                      {!r.isBaseline && <Badge tone="ok">new</Badge>}
                    </td>
                    <td className="py-2 pr-3"><SeverityBadge severity={r.severity} score={r.score} /></td>
                    <td className="py-2 pr-3 text-xs text-muted">{r.status}</td>
                    <td className="py-2 pr-3 text-xs text-muted">{r.source}</td>
                    <td className="py-2 text-xs text-muted">{fmtDay(r.firstSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav className="mt-4 flex items-center justify-between text-xs text-muted" aria-label="Pagination">
            {page > 1 ? <Link href={qs({ page: page - 1 })} className="text-electric-hi hover:underline">← Previous</Link> : <span />}
            <span>Page {page} of {pages}</span>
            {page < pages ? <Link href={qs({ page: page + 1 })} className="text-electric-hi hover:underline">Next →</Link> : <span />}
          </nav>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Saved research" badge={<Link href="/reports" className="text-xs text-electric-hi hover:underline">All reports →</Link>}>
          {research.rows.length === 0 ? <p className="text-sm text-muted">No saved research yet.</p> : (
            <ul className="space-y-2 text-sm">
              {research.rows.map((r) => (
                <li key={r.id}><Link href={`/reports/${r.id}`} className="line-clamp-2 text-ink/90 hover:text-neon">{r.title || r.question}</Link><span className="text-xs text-faint">{r.mode} · {fmtUtc(r.createdAt)}</span></li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Latest releases & posts" badge={<Link href="/monitoring" className="text-xs text-electric-hi hover:underline">Monitoring →</Link>}>
          {rel.length === 0 ? <p className="text-sm text-muted">None ingested yet.</p> : (
            <ul className="space-y-2 text-sm">
              {rel.map((r) => (
                <li key={r.id}><a href={r.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 text-ink/90 hover:text-neon">{r.title}</a><span className="text-xs text-faint">{r.kind === "github_release" ? "release" : "post"} · {fmtDay(r.publishedAt)}</span></li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Recent scans (metadata only)">
          {scans.length === 0 ? <p className="text-sm text-muted">No scans saved yet. Submitted code is never stored.</p> : (
            <ul className="space-y-2 text-sm">
              {scans.map((s) => (
                <li key={s.id} className="text-ink/90">{s.filename ?? "pasted code"}<span className="block text-xs text-faint">{s.totalLines} lines · {s.prescanCount} pre-scan hits · {s.aiFindingCount} AI findings · {fmtUtc(s.createdAt)}</span></li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
