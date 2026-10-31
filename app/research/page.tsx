import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, Panel } from "@/components/ui";
import { TOPICS } from "@/lib/research-topics";

export const metadata: Metadata = { title: "Research" };

const href = (q: string, mode: "chat" | "report") =>
  `/intelligence?${new URLSearchParams({ q, mode, auto: "1" }).toString()}`;

export default function Page() {
  return (
    <>
      <PageHeader
        title="Research"
        subtitle="Topic presets for defensive Bitcoin security research. Each one launches a query on the Intelligence Engine, grounded on live NVD, GitHub advisory and bitcoincore.org data."
      />
      <div className="mb-4 rounded-lg border border-line bg-panel/70 px-4 py-2.5 text-xs text-muted">
        Educational and defensive framing only. Research notes and findings are not saved yet — persistence arrives with the
        database in Stage 6.
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TOPICS.map((t) => (
          <Panel key={t.slug} title={t.title}>
            <p className="flex-1 text-sm text-muted">{t.blurb}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={href(t.question, "chat")}
                className="rounded-md border border-electric/40 bg-electric/10 px-3 py-1.5 text-xs font-medium text-electric-hi hover:bg-electric/20"
              >
                Ask
              </Link>
              <Link
                href={href(t.question, "report")}
                className="rounded-md border border-neon/40 bg-neon/10 px-3 py-1.5 text-xs font-medium text-neon hover:bg-neon/20"
              >
                Detailed report
              </Link>
            </div>
          </Panel>
        ))}
      </div>
    </>
  );
}
