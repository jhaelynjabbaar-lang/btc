import type { Metadata } from "next";
import { after } from "next/server";
import { VulnExplorer } from "@/components/vuln-explorer";
import { Badge, PageHeader, Panel, SeverityBadge } from "@/components/ui";
import { getDb } from "@/lib/db/client";
import { saveFeedSnapshot } from "@/lib/monitor/ingest";
import { countBySeverity, getFeed } from "@/lib/intel/feed";
import type { Severity } from "@/lib/intel/types";

export const metadata: Metadata = { title: "Vulnerabilities" };
// Rendered per request; every upstream fetch is cached for 1 hour by the Next.js data cache.
export const dynamic = "force-dynamic";

const ORDER: Severity[] = ["critical", "high", "medium", "low", "unrated"];

export default async function Page() {
  const feed = await getFeed();
  // Best effort, after the response: store the feed we already fetched (only sources never ingested; as baseline).
  const db = getDb();
  if (db) after(() => saveFeedSnapshot(db, feed).catch(() => undefined));
  const counts = countBySeverity(feed.items);
  const anyOk = feed.sources.some((s) => s.ok);
  const confirmed = feed.items.filter((i) => i.status === "confirmed").length;

  return (
    <>
      <PageHeader
        eyebrow="Live feed · cached up to 1 h"
        title="Vulnerabilities"
        subtitle="Bitcoin-related CVEs and advisories from NVD, GitHub security advisories and bitcoincore.org, merged by CVE id and ranked by severity."
      />

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Panel title="Severity" className="lg:col-span-2">
          {anyOk ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div>
                <div className="font-mono text-3xl font-semibold text-ink">{feed.items.length}</div>
                <div className="text-xs text-faint">unique items · {confirmed} confirmed</div>
              </div>
              {ORDER.map((s) => (
                <div key={s} className="flex items-center gap-2">
                  <SeverityBadge severity={s} />
                  <span className="font-mono text-lg text-ink">{counts[s]}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-muted">
              <div className="font-medium text-danger">No vulnerability source could be reached.</div>
              <p className="mt-1">Nothing is shown rather than placeholder data. This page retries on the next request.</p>
            </div>
          )}
          <p className="mt-3 text-xs text-faint">
            “Confirmed” = a CVE record analyzed by NVD, or listed in an official advisory (bitcoincore.org / GitHub). “Unverified” = an
            NVD record that has not been analyzed yet. Severity is the CVSS base severity (v4.0 → v3.1 → v3.0 → v2.0); “unrated” means no
            source supplied a score. NVD matches on the keyword “bitcoin”, so a few entries may only mention Bitcoin in passing. When a database is connected, the feed is also stored (see Database and Monitoring).
          </p>
        </Panel>
        <Panel title="Sources">
          <ul className="space-y-2.5 text-sm">
            {feed.sources.map((s) => (
              <li key={s.name} className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-ink">{s.name}</div>
                  {s.error && <div className="text-xs text-warn">{s.error}</div>}
                </div>
                {s.ok ? <Badge tone={s.error ? "warn" : "ok"}>{s.count} items</Badge> : <Badge tone="danger">Unavailable</Badge>}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-faint">
            Optional server-only env vars raise rate limits: NVD_API_KEY, GITHUB_TOKEN. Fetched {feed.generatedAt.replace("T", " ").slice(0, 19)} UTC.
          </p>
        </Panel>
      </div>

      {feed.items.length > 0 && <VulnExplorer items={feed.items} />}
    </>
  );
}
