import "server-only";
import type { IntelItem, Severity } from "./types";
import { ONE_HOUR, SourceError, errText, getJson, truncate } from "./util";

const API = "https://api.github.com";

/** Bitcoin-ecosystem packages to look up in the GitHub global advisory database. */
const PACKAGES = [
  "bitcoinjs-lib", "bitcore-lib", "bitcore-node", "bitcoin-core", "bitcoinj", "btcd", "lnd", "electrum",
  "bitcoinlib", "python-bitcoinlib", "bip32", "bip39", "tiny-secp256k1", "bitcoin-ts", "btcpayserver",
  "eclair", "core-lightning",
];
/** Bitcoin-ecosystem repositories whose own published security advisories we read. */
const REPOS = [
  "bitcoin/bitcoin", "lightningnetwork/lnd", "btcsuite/btcd", "bitcoinjs/bitcoinjs-lib",
  "ElementsProject/lightning", "spesmilo/electrum", "btcpayserver/btcpayserver",
];

type Ghsa = {
  ghsa_id: string;
  cve_id?: string | null;
  html_url: string;
  summary?: string;
  description?: string | null;
  severity?: string | null;
  cvss?: { score?: number | null } | null;
  published_at?: string | null;
  updated_at?: string | null;
  withdrawn_at?: string | null;
  vulnerabilities?: Array<{ package?: { name?: string; ecosystem?: string } | null } | null> | null;
  references?: string[];
};

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  const t = process.env.GITHUB_TOKEN?.trim();
  if (t) h.authorization = `Bearer ${t}`;
  return h;
}

function sev(s: string | null | undefined, score: number | null): Severity {
  const v = s?.toLowerCase();
  if (v === "critical" || v === "high" || v === "medium" || v === "low") return v;
  if (v === "moderate") return "medium";
  if (score === null) return "unrated";
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
}

function toItem(a: Ghsa): IntelItem | null {
  if (a.withdrawn_at) return null;
  const score = typeof a.cvss?.score === "number" && a.cvss.score > 0 ? a.cvss.score : null;
  const cve = a.cve_id ?? null;
  const pkgs = (a.vulnerabilities ?? [])
    .map((v) => v?.package?.name)
    .filter((x): x is string => Boolean(x));
  return {
    id: cve ?? a.ghsa_id,
    cveId: cve,
    ghsaId: a.ghsa_id,
    title: truncate(a.summary || a.ghsa_id, 160),
    summary: truncate((a.description ?? a.summary ?? "").replace(/\s+/g, " ").trim(), 900),
    severity: sev(a.severity, score),
    score,
    published: a.published_at ?? null,
    modified: a.updated_at ?? null,
    status: "confirmed",
    statusReason: "Published GitHub security advisory",
    affected: [...new Set(pkgs)].slice(0, 4),
    sources: [{ name: "GitHub Advisories", url: a.html_url }],
    references: (a.references ?? []).filter((u) => /^https?:\/\//.test(u)).slice(0, 6),
  };
}

/**
 * Global advisories for Bitcoin-ecosystem packages + published advisories of key repos.
 * Works without GITHUB_TOKEN but unauthenticated GitHub allows only 60 requests/hour per IP, so
 * partial results are returned (with a note) when the limit is hit.
 */
export async function fetchGhsaBitcoin(revalidate = ONE_HOUR): Promise<{ items: IntelItem[]; error?: string }> {
  const jobs: Array<Promise<Ghsa[]>> = [
    getJson<Ghsa[]>(`${API}/advisories?per_page=100&affects=${PACKAGES.join(",")}`, { headers: headers(), revalidate }),
    ...REPOS.map((r) =>
      getJson<Ghsa[]>(`${API}/repos/${r}/security-advisories?per_page=100&state=published`, {
        headers: headers(),
        revalidate,
      }),
    ),
  ];
  const results = await Promise.allSettled(jobs);
  const items: IntelItem[] = [];
  const errors = new Set<string>();
  let okCount = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      okCount++;
      for (const a of r.value) {
        const it = toItem(a);
        if (it) items.push(it);
      }
    } else if (r.status === "rejected") {
      errors.add(r.reason instanceof SourceError && r.reason.kind === "rate_limited"
        ? "GitHub rate limit reached (set GITHUB_TOKEN for a higher limit)"
        : errText(r.reason));
    }
  }
  if (okCount === 0) throw new SourceError("unavailable", [...errors][0] ?? "no GitHub data");
  return { items, error: errors.size ? `partial: ${[...errors].join("; ")}` : undefined };
}
