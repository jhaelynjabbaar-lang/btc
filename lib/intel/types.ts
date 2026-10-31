export type Severity = "critical" | "high" | "medium" | "low" | "unrated";
export type SourceName = "NVD" | "GitHub Advisories" | "bitcoincore.org";
export type VulnStatus = "confirmed" | "unverified";

export type SourceRef = { name: SourceName; url: string };

/** A normalized, deduplicated vulnerability / advisory record. */
export type IntelItem = {
  /** Stable key: CVE id when present, otherwise GHSA id, otherwise source-specific id. */
  id: string;
  cveId: string | null;
  ghsaId: string | null;
  title: string;
  summary: string;
  severity: Severity;
  /** CVSS base score when known (v4.0 / v3.1 / v3.0 / v2.0, in that order of preference). */
  score: number | null;
  /** ISO timestamps. */
  published: string | null;
  modified: string | null;
  /** "confirmed" = has a CVE record analyzed by NVD, or is in an official advisory; else "unverified". */
  status: VulnStatus;
  statusReason: string;
  /** Affected products when the source states them (e.g. "bitcoin bitcoin_core"). */
  affected: string[];
  sources: SourceRef[];
  /** Extra reference URLs published by the sources (real URLs from the retrieved data). */
  references: string[];
};

export type SourceStatus = {
  name: SourceName;
  ok: boolean;
  count: number;
  /** Short, safe error text when !ok or partially failed. */
  error?: string;
};

export type Feed = {
  items: IntelItem[];
  sources: SourceStatus[];
  /** Server time this feed was assembled (underlying fetches are cached up to 1 h). */
  generatedAt: string;
  /** Un-merged per-source records (server-side only; used for persistence). */
  raw?: Partial<Record<SourceName, IntelItem[]>>;
};

/** A document eligible for grounding a model answer. */
export type RetrievedDoc = {
  /** Short citation handle shown to the model and the user, e.g. "S1". */
  id: string;
  title: string;
  url: string;
  source: SourceName | "bitcoincore.org (blog/RSS)";
  kind: "vulnerability" | "advisory" | "post";
  cveId: string | null;
  text: string;
  /** All URLs a claim may cite for this doc (canonical + published references). */
  allowedUrls: string[];
  meta: string;
};
