import type { ReactNode } from "react";
import { STAGES, type StageKey } from "@/lib/stages";

export function PageHeader({ title, subtitle, eyebrow }: { title: string; subtitle: string; eyebrow?: string }) {
  return (
    <div className="mb-6">
      {eyebrow && <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.2em] text-neon/80">{eyebrow}</div>}
      <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{title}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>
    </div>
  );
}

export function Panel({
  title,
  badge,
  children,
  className = "",
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"flex flex-col rounded-xl border border-line bg-panel/90 p-5 " + className}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-electric-hi">{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  );
}

type Tone = "ok" | "warn" | "danger" | "muted" | "info";
const tones: Record<Tone, string> = {
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  danger: "border-danger/30 bg-danger/10 text-danger",
  muted: "border-line bg-panel-hi text-muted",
  info: "border-electric/30 bg-electric/10 text-electric-hi",
};

export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={
        "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium " + tones[tone]
      }
    >
      {children}
    </span>
  );
}

export function StageBadge({ stage }: { stage: StageKey }) {
  return <Badge tone="info">Stage {STAGES[stage]}</Badge>;
}

/** Honest placeholder for capabilities that are not built yet. Shows no numbers. */
export function NotConfigured({ stage, note, children }: { stage?: StageKey; note?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-2 rounded-lg border border-dashed border-line-hi/70 bg-void/40 p-4">
      <div className="text-sm font-medium text-ink">{note ?? (stage ? `Not configured yet — coming in Stage ${STAGES[stage]}` : "Not configured yet")}</div>
      {children && <p className="text-sm text-muted">{children}</p>}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-void/50 p-3">
      <div className="text-[11px] uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function ComingSoon({
  stage,
  title,
  planned,
}: {
  stage: StageKey;
  title: string;
  planned: string[];
}) {
  return (
    <div className="rounded-xl border border-line bg-panel/90 p-6 sm:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="warn">Not built yet</Badge>
        <StageBadge stage={stage} />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-ink">{title} is not built yet.</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        This section has no data and no functionality yet. It is planned for Stage {STAGES[stage]}. Nothing on this page
        is live.
      </p>
      <div className="mt-5 text-[11px] uppercase tracking-[0.16em] text-faint">Planned scope</div>
      <ul className="mt-2 space-y-2 text-sm text-muted">
        {planned.map((p) => (
          <li key={p} className="flex gap-2">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-neon" aria-hidden="true" />
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const sevTone: Record<string, string> = {
  critical: "border-danger/50 bg-danger/15 text-danger",
  high: "border-high/40 bg-high/10 text-high",
  medium: "border-warn/40 bg-warn/10 text-warn",
  low: "border-electric/40 bg-electric/10 text-electric-hi",
  info: "border-line-hi bg-panel-hi text-muted",
  unrated: "border-line bg-panel-hi text-faint",
};

export function SeverityBadge({ severity, score }: { severity: string; score?: number | null }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide " +
        (sevTone[severity] ?? sevTone.unrated)
      }
    >
      {severity}
      {typeof score === "number" && <span className="font-mono font-normal opacity-80">{score.toFixed(1)}</span>}
    </span>
  );
}
