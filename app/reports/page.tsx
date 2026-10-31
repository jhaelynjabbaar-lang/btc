import type { Metadata } from "next";
import Link from "next/link";
import { AccessDisabled, DatabaseNotConfigured } from "@/components/db-states";
import { Badge, PageHeader, Panel } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { getDb } from "@/lib/db/client";
import { listResearch } from "@/lib/db/repo";
import { fmtUtc } from "@/lib/format";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

type SP = Promise<{ [k: string]: string | string[] | undefined }>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const PAGE = 20;

export default async function Page({ searchParams }: { searchParams: SP }) {
  const access = await requirePageAccess("/reports");
  const header = (
    <PageHeader title="Reports" subtitle="Saved research answers and reports from the Intelligence Engine. Regenerate any past question against today's sources." />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  const db = getDb();
  if (!db) return <>{header}<DatabaseNotConfigured what="Saved reports" /></>;

  const sp = await searchParams;
  const q = one(sp.q)?.slice(0, 100) ?? "";
  const mode = one(sp.mode) === "chat" || one(sp.mode) === "report" ? (one(sp.mode) as "chat" | "report") : undefined;
  const page = Math.max(1, Math.min(1000, Number.parseInt(one(sp.page) ?? "1", 10) || 1));

  let res;
  try {
    res = await listResearch(db, { q, mode, limit: PAGE, offset: (page - 1) * PAGE });
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
  const pages = Math.max(1, Math.ceil(res.total / PAGE));
  const link = (p: number) => `/reports?${new URLSearchParams({ ...(q ? { q } : {}), ...(mode ? { mode } : {}), page: String(p) }).toString()}`;

  return (
    <>
      {header}
      <Panel title="Saved research" badge={<Badge tone="info">{res.total} saved</Badge>}>
        <form method="get" className="mb-4 flex flex-wrap gap-2">
          <input name="q" defaultValue={q} placeholder="Search questions and summaries…" aria-label="Search reports" className="min-w-0 flex-1 rounded-lg border border-line bg-void px-3 py-2 text-sm text-ink placeholder:text-faint" />
          <select name="mode" defaultValue={mode ?? ""} aria-label="Mode" className="rounded-lg border border-line bg-void px-2 py-2 text-sm text-ink">
            <option value="">All types</option>
            <option value="report">Reports</option>
            <option value="chat">Chat answers</option>
          </select>
          <button type="submit" className="rounded-lg border border-electric/50 bg-electric/10 px-3 py-2 text-sm text-electric-hi hover:bg-electric/20">Search</button>
        </form>
        {res.rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-hi/70 bg-void/40 p-4 text-sm text-muted">
            {res.total === 0 && !q && !mode ? (
              <>Nothing saved yet. Ask a question or generate a report on the <Link href="/intelligence" className="text-electric-hi underline">Intelligence Engine</Link> and it is stored here automatically.</>
            ) : "No saved research matches."}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {res.rows.map((r) => {
              const regen = `/intelligence?${new URLSearchParams({ q: r.question, mode: r.mode, auto: "1" }).toString()}`;
              return (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/reports/${r.id}`} className="line-clamp-2 text-sm font-medium text-ink hover:text-neon">{r.title || r.question}</Link>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted">{r.summary}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-faint">
                      <Badge tone={r.mode === "report" ? "info" : "muted"}>{r.mode}</Badge>
                      <span>{fmtUtc(r.createdAt)}</span>
                    </div>
                  </div>
                  <Link href={regen} className="shrink-0 rounded-lg border border-line-hi px-3 py-1.5 text-xs text-electric-hi hover:border-neon/50 hover:text-neon">Regenerate</Link>
                </li>
              );
            })}
          </ul>
        )}
        {pages > 1 && (
          <nav className="mt-4 flex items-center justify-between text-xs text-muted" aria-label="Pagination">
            {page > 1 ? <Link href={link(page - 1)} className="text-electric-hi hover:underline">← Previous</Link> : <span />}
            <span>Page {page} of {pages}</span>
            {page < pages ? <Link href={link(page + 1)} className="text-electric-hi hover:underline">Next →</Link> : <span />}
          </nav>
        )}
      </Panel>
    </>
  );
}
