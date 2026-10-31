import "server-only";
import { ONE_HOUR, getJson } from "./util";

export type GhRelease = {
  tag: string;
  name: string;
  url: string;
  prerelease: boolean;
  body: string;
  publishedAt: string | null;
};

type Raw = {
  tag_name: string;
  name?: string | null;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string | null;
  published_at?: string | null;
};

/** Latest releases of a GitHub repository (default bitcoin/bitcoin). Uses GITHUB_TOKEN when present. */
export async function fetchGithubReleases(repo = "bitcoin/bitcoin", revalidate = ONE_HOUR, limit = 30): Promise<GhRelease[]> {
  const h: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  const t = process.env.GITHUB_TOKEN?.trim();
  if (t) h.authorization = `Bearer ${t}`;
  const raw = await getJson<Raw[]>(`https://api.github.com/repos/${repo}/releases?per_page=${limit}`, { headers: h, revalidate });
  return raw
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name?.trim() || r.tag_name,
      url: r.html_url,
      prerelease: Boolean(r.prerelease),
      body: (r.body ?? "").slice(0, 6000),
      publishedAt: r.published_at ?? null,
    }));
}
