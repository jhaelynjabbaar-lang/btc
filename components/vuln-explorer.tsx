"use client";

import { useMemo, useState } from "react";
import { askResearch } from "@/lib/client/api";
import type { ResearchResult } from "@/lib/ai/research";
import type { IntelItem, Severity, SourceName } from "@/lib/intel/types";
import { AnswerView } from "./answer-view";
import { Badge, SeverityBadge } from "./ui";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "unrated"];
const SOURCES: SourceName[] = ["NVD", "GitHub Advisories", "bitcoincore.org"];
const PAGE = 25;

type Explain = { loading: boolean; result?: ResearchResult; error?: string };

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        "rounded-full border px-3 py-1 text-xs transition-colors " +
        (active ? "border-neon/50 bg-neon/10 text-neon" : "border-line text-muted hover:border-line-hi hover:text-ink")
      }
    >
      {children}
    </button>
  );
}

export function VulnExplorer({ items }: { items: IntelItem[] }) {
  const [sev, setSev] = useState<Set<Severity>>(new Set());
  const [src, setSrc] = useState<Set<SourceName>>(new Set());
  const [status, setStatus] = useState<"all" | "confirmed" | "unverified">("all");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const [explain, setExplain] = useState<Record<string, Explain>>({});

  const toggle = <T,>(set: Set<T>, v: T, setter: (s: Set<T>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    setter(n);
    setShown(PAGE);
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(
      (i) =>
        (sev.size === 0 || sev.has(i.severity)) &&
        (src.size === 0 || i.sources.some((s) => src.has(s.name))) &&
        (status === "all" || i.status === status) &&
        (!needle || `${i.id} ${i.title} ${i.summary} ${i.affected.join(" ")}`.toLowerCase().includes(needle)),
    );
  }, [items, sev, src, status, q]);

  async function run(item: IntelItem) {
    setExplain((e) => ({ ...e, [item.id]: { loading: true } }));
    const ident = item.cveId ?? item.ghsaId ?? undefined;
    try {
      const result = await askResearch({
        messages: [
          {
            role: "user",
            content: `Explain the impact and recommended remediation for ${item.cveId ?? item.ghsaId ?? "this advisory"}: ${item.title}. Cover who is affected, the realistic impact, which versions/fixes apply, and defensive mitigations.`,
          },
        ],
        mode: "chat",
        focus: ident && /^(CVE-\d{4}-\d{4,}|GHSA(-[a-z0-9]{4}){3})$/i.test(ident) ? ident : undefined,
      });
      setExplain((e) => ({ ...e, [item.id]: { loading: false, result } }));
    } catch (err) {
      setExplain((e) => ({ ...e, [item.id]: { loading: false, error: err instanceof Error ? err.message : "Request failed." } }));
    }
  }

  return (
    <div>
      <div className="mb-4 space-y-3 rounded-xl border border-line bg-panel/90 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 text-[11px] uppercase tracking-wider text-faint">Severity</span>
          {SEVERITIES.map((s) => (
            <Chip key={s} active={sev.has(s)} onClick={() => toggle(sev, s, setSev)}>{s}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 text-[11px] uppercase tracking-wider text-faint">Source</span>
          {SOURCES.map((s) => (
            <Chip key={s} active={src.has(s)} onClick={() => toggle(src, s, setSrc)}>{s}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 text-[11px] uppercase tracking-wider text-faint">Status</span>
          {(["all", "confirmed", "unverified"] as const).map((s) => (
            <Chip key={s} active={status === s} onClick={() => { setStatus(s); setShown(PAGE); }}>{s}</Chip>
          ))}
          <div className="ml-auto w-full sm:w-64">
            <label htmlFor="vq" className="sr-only">Search</label>
            <input
              id="vq"
              value={q}
              onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
              placeholder="Search id, title, product…"
              className="w-full rounded-lg border border-line bg-void/70 px-3 py-1.5 text-sm text-ink placeholder:text-faint focus:border-neon/60 focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div className="mb-2 text-xs text-muted" aria-live="polite">
        Showing {Math.min(shown, filtered.length)} of {filtered.length} matching ({items.length} total), ranked by severity then CVSS.
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-hi/70 p-6 text-sm text-muted">No items match these filters.</div>
      ) : (
        <ul className="space-y-2">
          {filtered.slice(0, shown).map((i) => {
            const isOpen = open === i.id;
            const ex = explain[i.id];
            return (
              <li key={i.id} className="rounded-xl border border-line bg-panel/90">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : i.id)}
                  aria-expanded={isOpen}
                  className="flex w-full flex-col gap-2 p-4 text-left sm:flex-row sm:items-start"
                >
                  <div className="flex shrink-0 flex-wrap items-center gap-2 sm:w-44 sm:flex-col sm:items-start">
                    <SeverityBadge severity={i.severity} score={i.score} />
                    <Badge tone={i.status === "confirmed" ? "ok" : "warn"}>{i.status}</Badge>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-neon">{i.cveId ?? i.ghsaId ?? i.id}</div>
                    <div className="mt-0.5 text-sm font-medium text-ink">{i.title}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
                      {i.published && <span>Published {i.published.slice(0, 10)}</span>}
                      {i.sources.map((s) => <span key={s.url}>{s.name}</span>)}
                    </div>
                  </div>
                </button>
                {isOpen && (
                  <div className="space-y-3 border-t border-line px-4 py-4 text-sm">
                    <p className="text-muted">{i.summary}</p>
                    <div className="text-xs text-muted">
                      <span className="text-faint">Status basis: </span>{i.statusReason}
                      {i.affected.length > 0 && (<><span className="text-faint"> · Affected: </span>{i.affected.join(", ")}</>)}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {i.sources.map((s) => (
                        <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="rounded border border-ok/30 bg-ok/5 px-2 py-0.5 text-xs text-ok hover:bg-ok/10">
                          {s.name} ↗
                        </a>
                      ))}
                      {i.references.slice(0, 3).map((r) => (
                        <a key={r} href={r} target="_blank" rel="noopener noreferrer" className="max-w-xs truncate rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-ink">
                          {r.replace(/^https?:\/\//, "")}
                        </a>
                      ))}
                    </div>
                    <button
                      type="button"
                      disabled={ex?.loading}
                      onClick={() => void run(i)}
                      className="rounded-lg bg-gradient-to-r from-electric to-neon px-4 py-2 text-xs font-semibold text-void disabled:opacity-50"
                    >
                      {ex?.loading ? "Analyzing…" : ex?.result ? "Re-run explanation" : "Explain impact & remediation"}
                    </button>
                    {ex?.error && <div className="text-sm text-danger" role="alert">{ex.error}</div>}
                    {ex?.loading && <div className="text-sm text-muted" role="status">Retrieving sources, then asking the model… (10–30 s)</div>}
                    {ex?.result && (
                      <div className="rounded-lg border border-line bg-void/40 p-4">
                        <AnswerView result={ex.result} />
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {shown < filtered.length && (
        <div className="mt-4 text-center">
          <button type="button" onClick={() => setShown((n) => n + PAGE)} className="rounded-lg border border-line-hi px-4 py-2 text-sm text-electric-hi hover:border-neon/50 hover:text-neon">
            Show {Math.min(PAGE, filtered.length - shown)} more
          </button>
        </div>
      )}
    </div>
  );
}
