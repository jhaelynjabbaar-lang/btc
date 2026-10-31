import type { ResearchResult } from "@/lib/ai/research";
import { Markdown } from "./markdown";
import { Badge } from "./ui";

const labelTone = { VERIFIED: "ok", UNVERIFIED: "warn", SPECULATION: "muted" } as const;

/** Renders a grounded research answer: summary, labeled claims with sources, retrieved sources, follow-ups. */
export function AnswerView({
  result,
  onFollowUp,
}: {
  result: ResearchResult;
  onFollowUp?: (q: string) => void;
}) {
  const { answer, retrieval, stats } = result;
  return (
    <div className="space-y-4">
      {answer.refused && (
        <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
          The assistant declined this request (defensive and educational use only).
        </div>
      )}
      <Markdown source={answer.summary} className="text-ink/90" />

      {answer.claims.length > 0 && (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-faint">
            Claims
            <Badge tone="ok">{stats.verified} verified</Badge>
            {stats.unverified > 0 && <Badge tone="warn">{stats.unverified} unverified</Badge>}
            <Badge>{stats.speculation} speculation</Badge>
            {stats.downgraded > 0 && <Badge tone="warn">{stats.downgraded} auto-downgraded</Badge>}
          </div>
          <ul className="space-y-2">
            {answer.claims.map((c, i) => (
              <li key={i} className="rounded-lg border border-line bg-void/50 p-3">
                <div className="flex flex-wrap items-start gap-2">
                  <Badge tone={labelTone[c.label]}>{c.label}</Badge>
                  <span className="min-w-0 flex-1 text-sm text-ink/90">{c.text}</span>
                </div>
                {c.downgraded && (
                  <div className="mt-1.5 text-xs text-warn">
                    Model said VERIFIED but cited no source retrieved for this request, so it was downgraded.
                  </div>
                )}
                {c.sources.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {c.sources.map((s, j) =>
                      s.retrieved && s.url ? (
                        <a
                          key={j}
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="max-w-full truncate rounded border border-ok/30 bg-ok/5 px-2 py-0.5 text-xs text-ok hover:bg-ok/10"
                          title="Retrieved source"
                        >
                          {s.label}
                        </a>
                      ) : (
                        <span
                          key={j}
                          className="max-w-full truncate rounded border border-line px-2 py-0.5 text-xs text-faint line-through"
                          title="Citation supplied by the model that was not among the retrieved sources"
                        >
                          {s.label}
                        </span>
                      ),
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-faint">
          Sources retrieved for this answer ({retrieval.sources.length})
        </div>
        {retrieval.sources.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing relevant was found in NVD, GitHub advisories or bitcoincore.org, so no claim can be VERIFIED.
          </p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {retrieval.sources.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5 rounded bg-electric/15 px-1.5 font-mono text-xs text-electric-hi">{s.id}</span>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="min-w-0 text-muted hover:text-neon">
                  <span className="line-clamp-2">{s.title}</span>
                  <span className="block truncate text-xs text-faint">{s.source}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {retrieval.errors.length > 0 && (
          <p className="mt-2 text-xs text-warn">Some sources were unavailable: {retrieval.errors.join("; ")}.</p>
        )}
      </div>

      {answer.followUps.length > 0 && onFollowUp && (
        <div className="flex flex-wrap gap-2">
          {answer.followUps.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onFollowUp(f)}
              className="rounded-full border border-line-hi bg-panel-hi px-3 py-1 text-left text-xs text-electric-hi hover:border-neon/50 hover:text-neon"
            >
              {f}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-faint">
        {result.notice} Model: <span className="font-mono">{result.model}</span>
        {result.usage ? ` · ${result.usage.totalTokens.toLocaleString()} tokens` : ""}
      </p>
      {result.persistence === "saved" && result.savedId && (
        <p className="text-xs text-ok">
          Saved to the research database ·{" "}
          <a href={`/reports/${result.savedId}`} className="underline hover:text-neon">open saved report</a>
        </p>
      )}
      {result.persistence === "not_configured" && (
        <p className="text-xs text-faint">Not saved — database not configured (awaiting Neon).</p>
      )}
      {result.persistence === "failed" && <p className="text-xs text-warn">The answer could not be saved to the database.</p>}
    </div>
  );
}
