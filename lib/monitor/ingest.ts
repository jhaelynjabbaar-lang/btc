import "server-only";
import {
  finishRun,
  getCursor,
  setCursorState,
  startRun,
  upsertFindings,
  upsertReleases,
  type Db,
} from "@/lib/db/repo";
import { fetchBitcoinCoreAdvisories, fetchBitcoinCorePosts } from "@/lib/intel/bitcoincore";
import { fetchGhsaBitcoin } from "@/lib/intel/ghsa";
import { fetchNvdBitcoin, fetchNvdModified } from "@/lib/intel/nvd";
import { fetchGithubReleases } from "@/lib/intel/releases";
import type { Feed, IntelItem } from "@/lib/intel/types";
import { errText } from "@/lib/intel/util";

/** NVD caps a lastMod window at 120 days; beyond ~100 days we do a full keyword fetch instead. */
const MAX_WINDOW_MS = 100 * 24 * 3600 * 1000;
/** Re-read a few minutes before the previous cursor so nothing modified mid-run is missed (upserts are idempotent). */
const OVERLAP_MS = 5 * 60 * 1000;

export const SOURCE_KEYS = {
  nvd: "NVD",
  ghsa: "GitHub Advisories",
  core: "bitcoincore.org",
  posts: "bitcoincore.org (blog/RSS)",
  releases: "GitHub releases (bitcoin/bitcoin)",
} as const;

export type SourceResult = {
  source: string;
  ok: boolean;
  mode: "incremental" | "full";
  baseline: boolean;
  fetched: number;
  inserted: number;
  newCount: number;
  error?: string;
};

export type IngestSummary = {
  runId: string;
  trigger: "cron" | "manual";
  results: SourceResult[];
  newCount: number;
};

type Outcome = {
  fetched: number;
  inserted: number;
  newCount: number;
  mode: "incremental" | "full";
  cursor: string;
  /** Set when the source answered only in part (e.g. one of several GitHub calls was rate limited). */
  partial?: string;
};

async function runSource(
  db: Db,
  key: string,
  job: (ctx: { baseline: boolean; cursor: string | null; now: Date }) => Promise<Outcome>,
): Promise<SourceResult> {
  const now = new Date();
  const cur = await getCursor(db, key).catch(() => undefined);
  // A source is in "baseline" mode until it has completed one successful run (cursor is set only on success).
  const baseline = !cur?.cursor;
  try {
    const o = await job({ baseline, cursor: cur?.cursor ?? null, now });
    // A partial answer on a baseline run must not end the baseline: otherwise the missing items would later be
    // reported as "new". Keep the cursor unset so the next run is still a baseline run.
    const cursor = o.partial && baseline ? undefined : o.cursor;
    await setCursorState(db, key, { cursor, status: "ok", error: o.partial ?? null, count: o.fetched, newCount: o.newCount, now });
    return { source: key, ok: true, mode: o.mode, baseline, fetched: o.fetched, inserted: o.inserted, newCount: o.newCount, error: o.partial };
  } catch (e) {
    const msg = errText(e);
    // Keep the old cursor so the next run retries the same window.
    await setCursorState(db, key, { status: "error", error: msg, now }).catch(() => undefined);
    return { source: key, ok: false, mode: "full", baseline, fetched: 0, inserted: 0, newCount: 0, error: msg };
  }
}

/** Fetch every public source, upsert idempotently, and record per-source cursors, status and new-item counts. */
export async function runIngest(db: Db, trigger: "cron" | "manual"): Promise<IngestSummary> {
  const runId = await startRun(db, trigger);
  const results: SourceResult[] = [];

  results.push(
    await runSource(db, SOURCE_KEYS.nvd, async ({ baseline, cursor, now }) => {
      const since = cursor ? new Date(cursor) : null;
      const incremental = since && !Number.isNaN(since.getTime()) && now.getTime() - since.getTime() < MAX_WINDOW_MS;
      const items = incremental
        ? await fetchNvdModified(new Date(since.getTime() - OVERLAP_MS), now)
        : await fetchNvdBitcoin(0);
      const r = await upsertFindings(db, "NVD", items, { baseline, now });
      return { fetched: items.length, inserted: r.inserted, newCount: baseline ? 0 : r.inserted, mode: incremental ? "incremental" : "full", cursor: now.toISOString() };
    }),
  );

  results.push(
    await runSource(db, SOURCE_KEYS.ghsa, async ({ baseline, now }) => {
      const { items, error } = await fetchGhsaBitcoin(0);
      if (error && items.length === 0) throw new Error(error);
      const r = await upsertFindings(db, "GitHub Advisories", items, { baseline, now });
      return { fetched: items.length, inserted: r.inserted, newCount: baseline ? 0 : r.inserted, mode: "full", cursor: now.toISOString(), partial: error };
    }),
  );

  results.push(
    await runSource(db, SOURCE_KEYS.core, async ({ baseline, now }) => {
      const items = await fetchBitcoinCoreAdvisories(0);
      const r = await upsertFindings(db, "bitcoincore.org", items, { baseline, now });
      return { fetched: items.length, inserted: r.inserted, newCount: baseline ? 0 : r.inserted, mode: "full", cursor: now.toISOString() };
    }),
  );

  results.push(
    await runSource(db, SOURCE_KEYS.posts, async ({ baseline, now }) => {
      const posts = await fetchBitcoinCorePosts(80, 0);
      const r = await upsertReleases(
        db,
        posts.map((p) => ({
          kind: "bitcoincore_post" as const,
          source: SOURCE_KEYS.posts,
          externalId: p.url,
          title: p.title,
          url: p.url,
          body: p.text.slice(0, 4000),
          publishedAt: p.published,
        })),
        { baseline, now },
      );
      return { fetched: posts.length, inserted: r.inserted, newCount: baseline ? 0 : r.inserted, mode: "full", cursor: now.toISOString() };
    }),
  );

  results.push(
    await runSource(db, SOURCE_KEYS.releases, async ({ baseline, now }) => {
      const rel = await fetchGithubReleases("bitcoin/bitcoin", 0, 30);
      const r = await upsertReleases(
        db,
        rel.map((x) => ({
          kind: "github_release" as const,
          source: SOURCE_KEYS.releases,
          externalId: x.tag,
          title: x.name || x.tag,
          url: x.url,
          prerelease: x.prerelease,
          body: x.body.slice(0, 4000),
          publishedAt: x.publishedAt,
        })),
        { baseline, now },
      );
      return { fetched: rel.length, inserted: r.inserted, newCount: baseline ? 0 : r.inserted, mode: "full", cursor: now.toISOString() };
    }),
  );

  const newCount = results.reduce((a, r) => a + r.newCount, 0);
  await finishRun(db, runId, newCount, results);
  return { runId, trigger, results, newCount };
}

/**
 * Opportunistic save of a feed the vulnerabilities page already fetched (no extra upstream calls).
 * Only sources that have never been ingested are touched (as baseline), so page views can never
 * pre-empt the "new since last run" detection of the real ingest.
 */
export async function saveFeedSnapshot(db: Db, feed: Feed): Promise<void> {
  const map: [keyof NonNullable<Feed["raw"]>, string][] = [
    ["NVD", SOURCE_KEYS.nvd],
    ["GitHub Advisories", SOURCE_KEYS.ghsa],
    ["bitcoincore.org", SOURCE_KEYS.core],
  ];
  for (const [name, key] of map) {
    const items: IntelItem[] | undefined = feed.raw?.[name];
    if (!items?.length) continue;
    const cur = await getCursor(db, key);
    // Already ingested -> rows exist and the ingest owns "new" detection; skip.
    if (cur?.cursor) continue;
    await upsertFindings(db, name, items, { baseline: true });
  }
}
