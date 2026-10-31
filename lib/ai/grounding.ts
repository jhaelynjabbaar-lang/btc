/**
 * Pure helpers that enforce the grounding rule on model output.
 * Rule: a claim may stay "VERIFIED" only if at least one of its sources resolves to a document that was
 * actually retrieved server-side for this request (a retrieved URL, an S-handle, or a CVE id present in
 * the retrieved data). Everything else is downgraded automatically.
 */
import type { RetrievedDoc } from "@/lib/intel/types";

export type ModelLabel = "VERIFIED" | "SPECULATION";
export type FinalLabel = "VERIFIED" | "UNVERIFIED" | "SPECULATION";

export type ModelClaim = { text: string; label: ModelLabel; sources: string[] };
export type CheckedSource = { label: string; url: string | null; retrieved: boolean; docId: string | null };
export type CheckedClaim = {
  text: string;
  label: FinalLabel;
  modelLabel: ModelLabel;
  downgraded: boolean;
  sources: CheckedSource[];
};

export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    const host = x.hostname.toLowerCase().replace(/^www\./, "");
    const path = x.pathname.replace(/\/+$/, "");
    return `${host}${path}${x.search}`;
  } catch {
    return u.trim().toLowerCase();
  }
}

export type SourceIndex = {
  byUrl: Map<string, RetrievedDoc>;
  byHandle: Map<string, RetrievedDoc>;
  byCve: Map<string, RetrievedDoc>;
};

export function buildSourceIndex(docs: RetrievedDoc[]): SourceIndex {
  const byUrl = new Map<string, RetrievedDoc>();
  const byHandle = new Map<string, RetrievedDoc>();
  const byCve = new Map<string, RetrievedDoc>();
  for (const d of docs) {
    byHandle.set(d.id.toUpperCase(), d);
    for (const u of [d.url, ...d.allowedUrls]) byUrl.set(normalizeUrl(u), d);
    // A CVE id counts only when it is backed by retrieved vulnerability data (NVD record or advisory).
    if (d.cveId && d.kind !== "post") byCve.set(d.cveId.toUpperCase(), d);
  }
  return { byUrl, byHandle, byCve };
}

export function resolveSource(raw: string, idx: SourceIndex): CheckedSource {
  const s = raw.trim();
  const handle = s.match(/^\[?(S\d{1,2})\]?$/i)?.[1]?.toUpperCase();
  if (handle) {
    const d = idx.byHandle.get(handle);
    if (d) return { label: `${d.id}: ${d.title}`, url: d.url, retrieved: true, docId: d.id };
    return { label: s, url: null, retrieved: false, docId: null };
  }
  const urlMatch = s.match(/https?:\/\/[^\s)\]>"']+/)?.[0];
  if (urlMatch) {
    const d = idx.byUrl.get(normalizeUrl(urlMatch));
    return d
      ? { label: urlMatch, url: urlMatch, retrieved: true, docId: d.id }
      : { label: urlMatch, url: urlMatch, retrieved: false, docId: null };
  }
  const cve = s.match(/CVE-\d{4}-\d{4,}/i)?.[0]?.toUpperCase();
  if (cve) {
    const d = idx.byCve.get(cve);
    return d
      ? { label: cve, url: d.url, retrieved: true, docId: d.id }
      : { label: cve, url: null, retrieved: false, docId: null };
  }
  return { label: s, url: null, retrieved: false, docId: null };
}

export function checkClaims(claims: ModelClaim[], idx: SourceIndex): CheckedClaim[] {
  return claims.map((c) => {
    const sources = c.sources.filter((s) => s.trim()).map((s) => resolveSource(s, idx));
    const grounded = sources.some((s) => s.retrieved);
    let label: FinalLabel;
    if (c.label === "SPECULATION") label = "SPECULATION";
    else if (grounded) label = "VERIFIED";
    else label = sources.length > 0 ? "UNVERIFIED" : "SPECULATION";
    return { text: c.text, label, modelLabel: c.label, downgraded: c.label === "VERIFIED" && label !== "VERIFIED", sources };
  });
}

/**
 * Make free-text (summary / report sections) safe to show: turn [S#] handles into links to the retrieved
 * document and replace any other URL that was not retrieved with a clear marker.
 */
export function groundText(text: string, idx: SourceIndex): string {
  const withHandles = text.replace(/\[(S\d{1,2})\](?!\()/gi, (m, h: string) => {
    const d = idx.byHandle.get(h.toUpperCase());
    return d ? `[${d.id}](${d.url})` : m;
  });
  // Existing markdown links, then bare URLs.
  const linked = withHandles.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (m, label: string, url: string) =>
    idx.byUrl.has(normalizeUrl(url)) ? m : `${label} (link removed: not in retrieved sources)`,
  );
  return linked.replace(/(?<![(\[])\bhttps?:\/\/[^\s)\]>"']+/g, (url) =>
    idx.byUrl.has(normalizeUrl(url)) ? url : "(link removed: not in retrieved sources)",
  );
}

export function claimStats(claims: CheckedClaim[]) {
  return {
    verified: claims.filter((c) => c.label === "VERIFIED").length,
    unverified: claims.filter((c) => c.label === "UNVERIFIED").length,
    speculation: claims.filter((c) => c.label === "SPECULATION").length,
    downgraded: claims.filter((c) => c.downgraded).length,
  };
}
