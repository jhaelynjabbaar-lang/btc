import "server-only";
import { fetchBitcoinCorePosts } from "./bitcoincore";
import { getFeed } from "./feed";
import { fetchNvdCve } from "./nvd";
import type { IntelItem, RetrievedDoc } from "./types";
import { errText, truncate } from "./util";

const STOP = new Set(
  "the and for are was were with that this from what when how why does did can could would should about into over under between during after before been being have has had not but you your our their they them its it's of in on at to by as is an a or if do be we i me my any all more most some such than then there these those which who whom whose will just also very much many via using use used explain describe tell give show please bitcoin btc bug bugs issue issues vulnerability vulnerabilities security attack attacks risk risks problem work works detail detailed report".split(" "),
);

export function tokenize(q: string): string[] {
  return [...new Set(q.toLowerCase().match(/[a-z0-9][a-z0-9\-_.]{2,}/g) ?? [])]
    .map((t) => t.replace(/[.\-_]+$/, ""))
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function itemToDoc(it: IntelItem, id: string): RetrievedDoc {
  const primary = it.sources.find((s) => s.name === "bitcoincore.org") ?? it.sources.find((s) => s.name === "NVD") ?? it.sources[0];
  const allowed = [...it.sources.map((s) => s.url), ...it.references];
  if (it.cveId) allowed.push(`https://nvd.nist.gov/vuln/detail/${it.cveId}`);
  const meta = [
    it.cveId ?? it.ghsaId,
    `severity: ${it.severity}${it.score !== null ? ` (CVSS ${it.score})` : ""}`,
    it.published ? `published ${it.published.slice(0, 10)}` : null,
    `status: ${it.status}`,
    it.affected.length ? `affected: ${it.affected.join(", ")}` : null,
    `sources: ${it.sources.map((s) => s.name).join(" + ")}`,
  ]
    .filter(Boolean)
    .join(" | ");
  return {
    id,
    title: it.title,
    url: primary.url,
    source: primary.name,
    kind: it.sources.some((s) => s.name !== "NVD") && !it.cveId ? "advisory" : "vulnerability",
    cveId: it.cveId,
    text: it.summary,
    allowedUrls: allowed,
    meta,
  };
}

export type Retrieval = {
  docs: RetrievedDoc[];
  errors: string[];
};

/**
 * Retrieval-augmented grounding. Entirely server-side: scores the live (cached) feed and bitcoincore.org posts
 * against the question, and fetches any CVE ids named in the question straight from NVD.
 */
export async function retrieve(question: string, focusId?: string): Promise<Retrieval> {
  const errors: string[] = [];
  const cveIds = [...new Set((question.match(/CVE-\d{4}-\d{4,}/gi) ?? []).map((s) => s.toUpperCase()))].slice(0, 3);
  if (focusId && /^CVE-\d{4}-\d{4,}$/i.test(focusId)) cveIds.unshift(focusId.toUpperCase());

  const [feedR, postsR, ...cveR] = await Promise.allSettled([
    getFeed(),
    fetchBitcoinCorePosts(),
    ...[...new Set(cveIds)].map((id) => fetchNvdCve(id)),
  ]);

  const feed = feedR.status === "fulfilled" ? feedR.value : null;
  if (!feed) errors.push("vulnerability feed unavailable");
  else for (const s of feed.sources) if (!s.ok) errors.push(`${s.name}: ${s.error ?? "unavailable"}`);
  if (postsR.status === "rejected") errors.push(`bitcoincore.org RSS: ${errText(postsR.reason)}`);

  const pool = new Map<string, IntelItem>();
  for (const it of feed?.items ?? []) pool.set(it.id, it);
  for (const r of cveR) {
    if (r.status === "fulfilled" && r.value && !pool.has(r.value.id)) pool.set(r.value.id, r.value);
    else if (r.status === "rejected") errors.push(`NVD CVE lookup: ${errText(r.reason)}`);
  }

  const tokens = tokenize(question);
  const scored: Array<{ it: IntelItem; score: number }> = [];
  for (const it of pool.values()) {
    let score = 0;
    if (it.cveId && cveIds.includes(it.cveId)) score += 100;
    if (focusId && (it.id === focusId || it.ghsaId === focusId)) score += 100;
    const title = it.title.toLowerCase();
    const body = `${it.summary} ${it.affected.join(" ")}`.toLowerCase();
    for (const t of tokens) {
      if (title.includes(t)) score += 3;
      else if (body.includes(t)) score += 1;
    }
    // Named CVE/GHSA ids dominate; other docs must clear a higher bar when an id was named.
    const named = cveIds.length > 0 || Boolean(focusId);
    if (score >= 100 || score >= (named ? 6 : 4)) scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.it.score ?? 0) - (a.it.score ?? 0));

  const docs: RetrievedDoc[] = [];
  for (const { it } of scored.slice(0, 8)) docs.push(itemToDoc(it, `S${docs.length + 1}`));

  // bitcoincore.org posts (release notes, notices).
  if (postsR.status === "fulfilled" && tokens.length) {
    const posts = postsR.value
      .map((p) => {
        const t = p.title.toLowerCase();
        const b = p.text.toLowerCase();
        let s = cveIds.some((id) => `${p.title} ${p.text}`.toUpperCase().includes(id)) ? 100 : 0;
        for (const tok of tokens) s += t.includes(tok) ? 3 : b.includes(tok) ? 1 : 0;
        return { p, s };
      })
      .filter((x) => x.s >= (cveIds.length > 0 ? 6 : 4))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    for (const { p } of posts) {
      if (docs.some((d) => d.url === p.url)) continue;
      docs.push({
        id: `S${docs.length + 1}`,
        title: p.title,
        url: p.url,
        source: "bitcoincore.org (blog/RSS)",
        kind: "post",
        cveId: null,
        text: p.text,
        allowedUrls: [p.url],
        meta: `bitcoincore.org post${p.published ? ` | ${p.published.slice(0, 10)}` : ""}`,
      });
    }
  }
  return { docs: docs.slice(0, 10), errors };
}

/** Render retrieved docs as an untrusted, clearly delimited context block for the model. */
export function renderContext(docs: RetrievedDoc[]): string {
  if (docs.length === 0) return "(no sources were retrieved for this question)";
  return docs
    .map((d) => {
      const refs = d.allowedUrls.filter((u) => u !== d.url).slice(0, 4);
      return [
        `[${d.id}] ${truncate(d.title, 200)}`,
        `url: ${d.url}`,
        d.meta,
        truncate(d.text, 800),
        refs.length ? `published references: ${refs.join(" , ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
