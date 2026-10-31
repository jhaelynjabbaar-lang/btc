import "server-only";
import type { IntelItem } from "./types";
import { ONE_HOUR, decodeEntities, getText, stripTags, truncate } from "./util";

const SITE = "https://bitcoincore.org";

/** Official security advisories listed on bitcoincore.org/en/security-advisories/. Cached 1 h. */
export async function fetchBitcoinCoreAdvisories(revalidate = ONE_HOUR): Promise<IntelItem[]> {
  const { text } = await getText(`${SITE}/en/security-advisories/`, { revalidate });
  const items: IntelItem[] = [];
  const seen = new Set<string>();
  const re = /<article>\s*<h2><a href="([^"]+)" title="([^"]*)">[\s\S]*?<\/a><\/h2>\s*<p>([\s\S]*?)<\/p>/g;
  for (const m of text.matchAll(re)) {
    const href = m[1];
    const full = decodeEntities(m[2]);
    const cve = full.match(/CVE-\d{4}-\d{4,}/)?.[0] ?? null;
    const title = full.replace(/^CVE-\d{4}-\d{4,}\s*[-–:]\s*/, "").trim() || full;
    const url = href.startsWith("http") ? href : `${SITE}${href}`;
    const id = cve ?? url;
    if (seen.has(id)) continue;
    seen.add(id);
    const d = href.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
    items.push({
      id,
      cveId: cve,
      ghsaId: null,
      title: truncate(title, 160),
      summary: truncate(stripTags(m[3]), 900),
      severity: "unrated", // the advisory page does not state a per-item severity; NVD/GHSA data fills it in when merged
      score: null,
      published: d ? `${d[1]}-${d[2]}-${d[3]}T00:00:00Z` : null,
      modified: null,
      status: "confirmed",
      statusReason: "Official Bitcoin Core security advisory",
      affected: ["Bitcoin Core"],
      sources: [{ name: "bitcoincore.org", url }],
      references: [],
    });
  }
  if (items.length === 0) throw new Error("no advisories parsed");
  return items;
}

export type CorePost = { title: string; url: string; published: string | null; text: string };

/** Recent posts (releases, notices) from the bitcoincore.org RSS feed. Cached 1 h. */
export async function fetchBitcoinCorePosts(limit = 80, revalidate = ONE_HOUR): Promise<CorePost[]> {
  const { text } = await getText(`${SITE}/en/rss.xml`, { revalidate });
  const out: CorePost[] = [];
  for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag: string) => block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "";
    const title = stripTags(pick("title"));
    const link = decodeEntities(pick("link")).trim();
    if (!title || !link) continue;
    const pub = Date.parse(pick("pubDate"));
    out.push({
      title,
      url: link.startsWith("http") ? link : `${SITE}${link}`,
      published: Number.isNaN(pub) ? null : new Date(pub).toISOString(),
      text: truncate(stripTags(pick("description")), 700),
    });
    if (out.length >= limit) break;
  }
  return out;
}
