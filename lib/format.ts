/** Deterministic date formatting (UTC, explicitly labeled) for server-rendered pages. */
export function fmtUtc(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(t.getTime())) return "—";
  return t.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function fmtDay(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(t.getTime()) ? "—" : t.toISOString().slice(0, 10);
}

export function ago(d: Date | string | null | undefined, now = Date.now()): string {
  if (!d) return "never";
  const t = (typeof d === "string" ? new Date(d) : d).getTime();
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 3600 * 1000);
