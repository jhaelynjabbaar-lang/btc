import "server-only";
import type { IntelItem, Severity } from "./types";
import { ONE_HOUR, getJson, truncate } from "./util";

const BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";

type NvdMetric = {
  cvssData?: { baseScore?: number; baseSeverity?: string };
  baseSeverity?: string;
};
type NvdCve = {
  id: string;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  descriptions?: Array<{ lang: string; value: string }>;
  metrics?: Record<string, NvdMetric[]>;
  references?: Array<{ url: string }>;
  configurations?: Array<{ nodes?: Array<{ cpeMatch?: Array<{ criteria?: string }> }> }>;
};
type NvdResponse = { totalResults: number; vulnerabilities: Array<{ cve: NvdCve }> };

function headers(): Record<string, string> {
  const key = process.env.NVD_API_KEY?.trim();
  return key ? { apikey: key } : {};
}

function toSeverity(s: string | undefined, score: number | null): Severity {
  const v = s?.toLowerCase();
  if (v === "critical" || v === "high" || v === "medium" || v === "low") return v;
  if (score === null) return "unrated";
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "unrated";
}

export function normalizeNvd(c: NvdCve): IntelItem | null {
  const desc = c.descriptions?.find((d) => d.lang === "en")?.value ?? "";
  if (c.vulnStatus === "Rejected" || /^\*\* REJECT \*\*/.test(desc)) return null;

  let score: number | null = null;
  let sev: string | undefined;
  for (const k of ["cvssMetricV40", "cvssMetricV31", "cvssMetricV30", "cvssMetricV2"]) {
    const m = c.metrics?.[k]?.[0];
    if (m?.cvssData?.baseScore !== undefined) {
      score = m.cvssData.baseScore;
      sev = m.cvssData.baseSeverity ?? m.baseSeverity;
      break;
    }
  }

  const products = new Set<string>();
  for (const cfg of c.configurations ?? [])
    for (const n of cfg.nodes ?? [])
      for (const m of n.cpeMatch ?? []) {
        const p = m.criteria?.split(":");
        if (p && p.length > 4) products.add(`${p[3]} ${p[4]}`);
      }

  const analyzed = !["Received", "Awaiting Analysis", "Undergoing Analysis"].includes(c.vulnStatus ?? "");
  const firstSentence = desc.split(/(?<=\.)\s/)[0] ?? desc;
  return {
    id: c.id,
    cveId: c.id,
    ghsaId: null,
    title: truncate(firstSentence || c.id, 140),
    summary: truncate(desc, 900),
    severity: toSeverity(sev, score),
    score,
    published: c.published ? `${c.published}Z` : null,
    modified: c.lastModified ? `${c.lastModified}Z` : null,
    status: analyzed ? "confirmed" : "unverified",
    statusReason: analyzed
      ? `CVE record in NVD (status: ${c.vulnStatus ?? "published"})`
      : `NVD has not finished analyzing this CVE yet (status: ${c.vulnStatus})`,
    affected: [...products].slice(0, 4),
    sources: [{ name: "NVD", url: `https://nvd.nist.gov/vuln/detail/${c.id}` }],
    references: (c.references ?? []).map((r) => r.url).filter((u) => /^https?:\/\//.test(u)).slice(0, 6),
  };
}

/** All NVD CVEs matching keyword "bitcoin" (a superset of the Bitcoin Core CPE match). Cached 1 h. */
export async function fetchNvdBitcoin(revalidate = ONE_HOUR): Promise<IntelItem[]> {
  const data = await getJson<NvdResponse>(`${BASE}?keywordSearch=bitcoin&resultsPerPage=500`, {
    headers: headers(),
    revalidate,
  });
  return data.vulnerabilities.map((v) => normalizeNvd(v.cve)).filter((x): x is IntelItem => x !== null);
}

/** One CVE by id (used to ground questions about a CVE not in the keyword feed). Cached 24 h. */
export async function fetchNvdCve(cveId: string): Promise<IntelItem | null> {
  if (!/^CVE-\d{4}-\d{4,}$/.test(cveId)) return null;
  const data = await getJson<NvdResponse>(`${BASE}?cveId=${cveId}`, { headers: headers(), revalidate: 24 * ONE_HOUR });
  const c = data.vulnerabilities[0]?.cve;
  return c ? normalizeNvd(c) : null;
}

/** NVD timestamps are "YYYY-MM-DDTHH:mm:ss.SSS" (UTC, no zone suffix). */
export const nvdTime = (d: Date) => d.toISOString().replace("Z", "");

/**
 * Incremental fetch: bitcoin-keyword CVEs modified in [since, until]. NVD limits a window to 120 days,
 * so callers fall back to a full fetch when the cursor is older than that. Never cached.
 */
export async function fetchNvdModified(since: Date, until: Date): Promise<IntelItem[]> {
  const q = `keywordSearch=bitcoin&lastModStartDate=${encodeURIComponent(nvdTime(since))}&lastModEndDate=${encodeURIComponent(nvdTime(until))}&resultsPerPage=500`;
  const data = await getJson<NvdResponse>(`${BASE}?${q}`, { headers: headers(), revalidate: 0 });
  return data.vulnerabilities.map((v) => normalizeNvd(v.cve)).filter((x): x is IntelItem => x !== null);
}
