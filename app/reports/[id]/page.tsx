import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AnswerView } from "@/components/answer-view";
import { AccessDisabled, DatabaseNotConfigured } from "@/components/db-states";
import { Markdown } from "@/components/markdown";
import { Badge, PageHeader, Panel } from "@/components/ui";
import type { ResearchResult } from "@/lib/ai/research";
import { requirePageAccess } from "@/lib/auth/access";
import { getDb } from "@/lib/db/client";
import { getResearch } from "@/lib/db/repo";
import { fmtUtc } from "@/lib/format";

export const metadata: Metadata = { title: "Saved report" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requirePageAccess(`/reports/${id}`);
  if ("blocked" in access) return <><PageHeader title="Saved report" subtitle="" /><AccessDisabled /></>;
  const db = getDb();
  if (!db) return <><PageHeader title="Saved report" subtitle="" /><DatabaseNotConfigured what="Saved reports" /></>;
  let row;
  try {
    row = await getResearch(db, id);
  } catch {
    notFound();
  }
  if (!row) notFound();

  const meta = (row.meta ?? {}) as Partial<{ followUps: string[]; refused: boolean; errors: string[]; retrievedAt: string; stats: ResearchResult["stats"]; usage: ResearchResult["usage"] }>;
  const claims = (Array.isArray(row.claims) ? row.claims : []) as ResearchResult["answer"]["claims"];
  const sources = (Array.isArray(row.sources) ? row.sources : []) as ResearchResult["retrieval"]["sources"];
  const stats =
    meta.stats ??
    ({
      verified: claims.filter((c) => c.label === "VERIFIED").length,
      unverified: claims.filter((c) => c.label === "UNVERIFIED").length,
      speculation: claims.filter((c) => c.label === "SPECULATION").length,
      downgraded: claims.filter((c) => c.downgraded).length,
    } as ResearchResult["stats"]);
  const result: ResearchResult = {
    model: row.model,
    mode: row.mode === "report" ? "report" : "chat",
    structured: true,
    answer: { summary: row.summary, claims, refused: Boolean(meta.refused), followUps: meta.followUps ?? [] },
    report: row.markdown ? { title: row.title ?? "Report", markdown: row.markdown } : null,
    retrieval: { sources, errors: meta.errors ?? [], retrievedAt: meta.retrievedAt ?? row.createdAt.toISOString() },
    stats,
    usage: meta.usage ?? null,
    finishReason: null,
    notice: `Saved ${fmtUtc(row.createdAt)}. Sources and claim labels are exactly as they were when the answer was generated; regenerate to check against current data.`,
  };
  const regen = `/intelligence?${new URLSearchParams({ q: row.question, mode: row.mode, auto: "1" }).toString()}`;

  return (
    <>
      <PageHeader eyebrow={`Saved ${row.mode}`} title={row.title || "Saved research"} subtitle={row.question.length > 300 ? row.question.slice(0, 300) + "…" : row.question} />
      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted">
        <Link href="/reports" className="text-electric-hi hover:underline">← All reports</Link>
        <Badge>{fmtUtc(row.createdAt)}</Badge>
        {row.userLogin && <Badge>@{row.userLogin}</Badge>}
        <Link href={regen} className="rounded-lg border border-electric/50 bg-electric/10 px-3 py-1.5 text-electric-hi hover:bg-electric/20">Regenerate from this question</Link>
      </div>
      <Panel title={row.markdown ? "Report" : "Answer"}>
        {row.markdown ? <Markdown source={row.markdown} className="text-ink/90" /> : <AnswerView result={result} />}
      </Panel>
      {row.markdown && (
        <Panel title="Claims & sources" className="mt-4">
          <AnswerView result={{ ...result, answer: { ...result.answer, summary: "" } }} />
        </Panel>
      )}
    </>
  );
}
