import "server-only";
import { fetchBitcoinCoreAdvisories } from "./bitcoincore";
import { fetchGhsaBitcoin } from "./ghsa";
import { fetchNvdBitcoin } from "./nvd";
import type { Feed, IntelItem, Severity, SourceStatus } from "./types";
import { errText } from "./util";

const SEV_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, unrated: 0 };

/** Merge records describing the same vulnerability (same CVE id, or same GHSA id). */
export function mergeItems(lists: IntelItem[][]): IntelItem[] {
  const byKey = new Map<string, IntelItem>();
  const ghsaToKey = new Map<string, string>();

  for (const item of lists.flat()) {
    const key = item.cveId ?? (item.ghsaId && ghsaToKey.get(item.ghsaId)) ?? item.id;
    const have = byKey.get(key);
    if (!have) {
      byKey.set(key, { ...item, sources: [...item.sources], affected: [...item.affected], references: [...item.references] });
      if (item.ghsaId) ghsaToKey.set(item.ghsaId, key);
      continue;
    }
    // Merge into existing record.
    for (const s of item.sources) if (!have.sources.some((x) => x.url === s.url)) have.sources.push(s);
    for (const a of item.affected) if (!have.affected.includes(a)) have.affected.push(a);
    for (const r of item.references) if (!have.references.includes(r)) have.references.push(r);
    have.ghsaId ??= item.ghsaId;
    if (item.ghsaId) ghsaToKey.set(item.ghsaId, key);
    // Prefer CVSS-backed severity.
    if (item.score !== null && (have.score === null || item.sources[0]?.name === "NVD")) {
      have.score = item.score;
      have.severity = item.severity;
    } else if (have.severity === "unrated" && item.severity !== "unrated") {
      have.severity = item.severity;
    }
    // Prefer human-written titles/summaries from official advisories over NVD's first sentence.
    const official = item.sources.some((s) => s.name === "bitcoincore.org" || s.name === "GitHub Advisories");
    if (official && item.title) {
      have.title = item.title;
      if (item.summary.length >= 40) have.summary = item.summary;
    }
    have.published = [have.published, item.published].filter(Boolean).sort()[0] ?? null;
    have.modified = [have.modified, item.modified].filter(Boolean).sort().pop() ?? null;
    if (item.status === "confirmed") {
      have.status = "confirmed";
      if (official) have.statusReason = item.statusReason;
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      (b.score ?? -1) - (a.score ?? -1) ||
      (b.published ?? "").localeCompare(a.published ?? ""),
  );
}

/**
 * Live vulnerability feed. Each upstream fetch is cached for 1 hour by the Next.js data cache.
 * A failing source is reported in `sources` and never breaks the others. Nothing is persisted.
 */
export async function getFeed(): Promise<Feed> {
  const [nvd, ghsa, core] = await Promise.allSettled([fetchNvdBitcoin(), fetchGhsaBitcoin(), fetchBitcoinCoreAdvisories()]);
  const sources: SourceStatus[] = [];
  const lists: IntelItem[][] = [];

  if (nvd.status === "fulfilled") {
    lists.push(nvd.value);
    sources.push({ name: "NVD", ok: true, count: nvd.value.length });
  } else sources.push({ name: "NVD", ok: false, count: 0, error: errText(nvd.reason) });

  if (ghsa.status === "fulfilled") {
    lists.push(ghsa.value.items);
    sources.push({ name: "GitHub Advisories", ok: true, count: ghsa.value.items.length, error: ghsa.value.error });
  } else sources.push({ name: "GitHub Advisories", ok: false, count: 0, error: errText(ghsa.reason) });

  if (core.status === "fulfilled") {
    lists.push(core.value);
    sources.push({ name: "bitcoincore.org", ok: true, count: core.value.length });
  } else sources.push({ name: "bitcoincore.org", ok: false, count: 0, error: errText(core.reason) });

  return { items: mergeItems(lists), sources, generatedAt: new Date().toISOString() };
}

export function countBySeverity(items: IntelItem[]): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unrated: 0 };
  for (const i of items) c[i.severity]++;
  return c;
}
