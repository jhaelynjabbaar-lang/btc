/**
 * Database access functions. They take the db handle as a parameter (no module-level state) so the same
 * code runs against Neon in production and against an in-memory Postgres (PGlite) in tests.
 */
import { and, desc, eq, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { IntelItem, Severity } from "@/lib/intel/types";
import {
  findings,
  ingestionCursors,
  ingestionRuns,
  releases,
  researchReports,
  scanRuns,
} from "./schema";
import type * as schemaNs from "./schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schemaNs>;

const CHUNK = 40;
const chunks = <T,>(a: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const toDate = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/* ------------------------------------------------------------------ research */

export type SavedResearchInput = {
  userLogin: string | null;
  question: string;
  mode: "chat" | "report";
  title: string | null;
  summary: string;
  claims: unknown;
  sources: unknown;
  markdown: string | null;
  model: string;
  meta: unknown;
};

export async function saveResearch(db: Db, r: SavedResearchInput): Promise<string> {
  const [row] = await db.insert(researchReports).values(r).returning({ id: researchReports.id });
  return row.id;
}

export async function listResearch(
  db: Db,
  opts: { q?: string; mode?: "chat" | "report"; limit?: number; offset?: number } = {},
) {
  const where: SQL[] = [];
  if (opts.mode) where.push(eq(researchReports.mode, opts.mode));
  if (opts.q?.trim()) {
    const p = `%${likeEscape(opts.q.trim())}%`;
    where.push(or(ilike(researchReports.question, p), ilike(researchReports.summary, p), ilike(researchReports.title, p))!);
  }
  const cond = where.length ? and(...where) : undefined;
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        id: researchReports.id,
        question: researchReports.question,
        mode: researchReports.mode,
        title: researchReports.title,
        summary: researchReports.summary,
        model: researchReports.model,
        createdAt: researchReports.createdAt,
        claims: researchReports.claims,
      })
      .from(researchReports)
      .where(cond)
      .orderBy(desc(researchReports.createdAt))
      .limit(opts.limit ?? 25)
      .offset(opts.offset ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(researchReports).where(cond),
  ]);
  return { rows, total: n };
}

export async function getResearch(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(researchReports).where(eq(researchReports.id, id)).limit(1);
  return row ?? null;
}

export async function saveScanRun(
  db: Db,
  r: {
    userLogin: string | null;
    filename: string | null;
    totalLines: number;
    prescanCount: number;
    aiFindingCount: number;
    findings: unknown;
    model: string;
  },
) {
  const [row] = await db.insert(scanRuns).values(r).returning({ id: scanRuns.id });
  return row.id;
}

export async function listScanRuns(db: Db, limit = 10) {
  return db.select().from(scanRuns).orderBy(desc(scanRuns.createdAt)).limit(limit);
}

/* ------------------------------------------------------------------ findings */

export type UpsertResult = { total: number; inserted: number; newKeys: string[] };

/** Idempotent upsert of per-source normalized items. "inserted" = rows that did not exist before. */
export async function upsertFindings(
  db: Db,
  source: string,
  items: IntelItem[],
  opts: { baseline: boolean; now?: Date },
): Promise<UpsertResult> {
  const now = opts.now ?? new Date();
  const seen = new Set<string>();
  const rows = items
    .filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)))
    .map((it) => ({
      source,
      externalId: it.id,
      cveId: it.cveId,
      title: it.title.slice(0, 500),
      severity: it.severity,
      score: it.score,
      status: it.status,
      publishedAt: toDate(it.published),
      modifiedAt: toDate(it.modified),
      payload: it,
      isBaseline: opts.baseline,
      firstSeen: now,
      lastSeen: now,
    }));
  const newKeys: string[] = [];
  for (const part of chunks(rows)) {
    const res = await db
      .insert(findings)
      .values(part)
      .onConflictDoUpdate({
        target: [findings.source, findings.externalId],
        set: {
          cveId: sql`excluded.cve_id`,
          title: sql`excluded.title`,
          severity: sql`excluded.severity`,
          score: sql`excluded.score`,
          status: sql`excluded.status`,
          publishedAt: sql`excluded.published_at`,
          modifiedAt: sql`excluded.modified_at`,
          payload: sql`excluded.payload`,
          lastSeen: sql`excluded.last_seen`,
        },
      })
      .returning({ externalId: findings.externalId, inserted: sql<boolean>`(xmax = 0)` });
    for (const r of res) if (r.inserted) newKeys.push(r.externalId);
  }
  return { total: rows.length, inserted: newKeys.length, newKeys };
}

export type FindingFilters = {
  q?: string;
  source?: string;
  severity?: Severity;
  status?: "confirmed" | "unverified";
  newOnly?: boolean;
  limit?: number;
  offset?: number;
};

const SEV_ORDER = sql`CASE ${findings.severity} WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`;

export async function listFindings(db: Db, f: FindingFilters = {}) {
  const where: SQL[] = [];
  if (f.source) where.push(eq(findings.source, f.source));
  if (f.severity) where.push(eq(findings.severity, f.severity));
  if (f.status) where.push(eq(findings.status, f.status));
  if (f.newOnly) where.push(eq(findings.isBaseline, false));
  if (f.q?.trim()) {
    const p = `%${likeEscape(f.q.trim())}%`;
    where.push(or(ilike(findings.title, p), ilike(findings.externalId, p), ilike(findings.cveId, p))!);
  }
  const cond = where.length ? and(...where) : undefined;
  const [rows, [{ n }]] = await Promise.all([
    db
      .select({
        id: findings.id,
        source: findings.source,
        externalId: findings.externalId,
        cveId: findings.cveId,
        title: findings.title,
        severity: findings.severity,
        score: findings.score,
        status: findings.status,
        publishedAt: findings.publishedAt,
        isBaseline: findings.isBaseline,
        firstSeen: findings.firstSeen,
        lastSeen: findings.lastSeen,
        payload: findings.payload,
      })
      .from(findings)
      .where(cond)
      .orderBy(desc(SEV_ORDER), desc(sql`coalesce(${findings.score}, -1)`), desc(findings.firstSeen))
      .limit(f.limit ?? 50)
      .offset(f.offset ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(findings).where(cond),
  ]);
  return { rows, total: n };
}

export async function findingsStats(db: Db) {
  const bySeverity = await db
    .select({ severity: findings.severity, n: sql<number>`count(*)::int` })
    .from(findings)
    .groupBy(findings.severity);
  const bySource = await db
    .select({ source: findings.source, n: sql<number>`count(*)::int` })
    .from(findings)
    .groupBy(findings.source);
  return { bySeverity, bySource };
}

export async function recentNewFindings(db: Db, limit = 15) {
  return db
    .select({
      id: findings.id,
      source: findings.source,
      externalId: findings.externalId,
      cveId: findings.cveId,
      title: findings.title,
      severity: findings.severity,
      score: findings.score,
      firstSeen: findings.firstSeen,
      payload: findings.payload,
    })
    .from(findings)
    .where(eq(findings.isBaseline, false))
    .orderBy(desc(findings.firstSeen))
    .limit(limit);
}

export async function countNewSince(db: Db, since: Date) {
  const [a] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(findings)
    .where(and(eq(findings.isBaseline, false), gte(findings.firstSeen, since)));
  const [b] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(releases)
    .where(and(eq(releases.isBaseline, false), gte(releases.firstSeen, since)));
  return { findings: a.n, releases: b.n };
}

/* ------------------------------------------------------------------ releases */

export type ReleaseInput = {
  kind: "github_release" | "bitcoincore_post";
  source: string;
  externalId: string;
  title: string;
  url: string;
  prerelease?: boolean;
  body?: string | null;
  publishedAt: string | null;
};

export async function upsertReleases(
  db: Db,
  items: ReleaseInput[],
  opts: { baseline: boolean; now?: Date },
): Promise<UpsertResult> {
  const now = opts.now ?? new Date();
  const seen = new Set<string>();
  const rows = items
    .filter((r) => {
      const k = `${r.source}|${r.externalId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => ({
      kind: r.kind,
      source: r.source,
      externalId: r.externalId,
      title: r.title.slice(0, 500),
      url: r.url,
      prerelease: r.prerelease ?? false,
      body: r.body ? r.body.slice(0, 6000) : null,
      publishedAt: toDate(r.publishedAt),
      isBaseline: opts.baseline,
      firstSeen: now,
      lastSeen: now,
    }));
  const newKeys: string[] = [];
  for (const part of chunks(rows)) {
    const res = await db
      .insert(releases)
      .values(part)
      .onConflictDoUpdate({
        target: [releases.source, releases.externalId],
        set: {
          title: sql`excluded.title`,
          url: sql`excluded.url`,
          prerelease: sql`excluded.prerelease`,
          body: sql`excluded.body`,
          publishedAt: sql`excluded.published_at`,
          lastSeen: sql`excluded.last_seen`,
        },
      })
      .returning({ externalId: releases.externalId, inserted: sql<boolean>`(xmax = 0)` });
    for (const r of res) if (r.inserted) newKeys.push(r.externalId);
  }
  return { total: rows.length, inserted: newKeys.length, newKeys };
}

export async function listReleases(db: Db, opts: { kind?: string; limit?: number } = {}) {
  return db
    .select()
    .from(releases)
    .where(opts.kind ? eq(releases.kind, opts.kind) : undefined)
    .orderBy(desc(sql`coalesce(${releases.publishedAt}, ${releases.firstSeen})`))
    .limit(opts.limit ?? 10);
}

/* ------------------------------------------------------------------ ingestion state */

export async function getCursors(db: Db) {
  return db.select().from(ingestionCursors);
}

export async function getCursor(db: Db, source: string) {
  const [row] = await db.select().from(ingestionCursors).where(eq(ingestionCursors.source, source)).limit(1);
  return row ?? null;
}

export async function setCursorState(
  db: Db,
  source: string,
  v: {
    /** undefined = keep existing cursor */
    cursor?: string | null;
    status: "ok" | "error";
    error?: string | null;
    count?: number | null;
    newCount?: number | null;
    now?: Date;
  },
) {
  const now = v.now ?? new Date();
  const base = {
    lastRunAt: now,
    lastStatus: v.status,
    lastError: v.error ?? null,
    lastCount: v.count ?? null,
    lastNew: v.newCount ?? null,
    updatedAt: now,
  };
  await db
    .insert(ingestionCursors)
    .values({ source, cursor: v.cursor ?? null, ...base })
    .onConflictDoUpdate({
      target: ingestionCursors.source,
      set: v.cursor === undefined ? base : { ...base, cursor: v.cursor },
    });
}

export async function startRun(db: Db, trigger: "cron" | "manual") {
  const [row] = await db.insert(ingestionRuns).values({ trigger }).returning({ id: ingestionRuns.id });
  return row.id;
}

export async function finishRun(db: Db, id: string, newCount: number, results: unknown) {
  await db.update(ingestionRuns).set({ finishedAt: new Date(), newCount, results }).where(eq(ingestionRuns.id, id));
}

export async function listRuns(db: Db, limit = 8) {
  return db.select().from(ingestionRuns).orderBy(desc(ingestionRuns.startedAt)).limit(limit);
}

export async function tableCounts(db: Db) {
  const one = async (t: typeof findings | typeof releases | typeof researchReports | typeof scanRuns | typeof ingestionRuns) =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(t))[0].n;
  const [f, r, rr, s, ir] = await Promise.all([one(findings), one(releases), one(researchReports), one(scanRuns), one(ingestionRuns)]);
  return { findings: f, releases: r, researchReports: rr, scanRuns: s, ingestionRuns: ir };
}

