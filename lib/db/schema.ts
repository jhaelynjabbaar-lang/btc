import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ Auth.js (Drizzle adapter) */

export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { mode: "date", withTimezone: true }),
  image: text("image"),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/* ------------------------------------------------------------------ Research */

/** A saved grounded research answer or detailed report. */
export const researchReports = pgTable(
  "research_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** GitHub login of the signed-in admin, null when auth is not configured. */
    userLogin: text("user_login"),
    question: text("question").notNull(),
    mode: text("mode").notNull(), // 'chat' | 'report'
    title: text("title"),
    summary: text("summary").notNull(),
    /** Checked claims: [{ text, label, modelLabel, downgraded, sources: [...] }] */
    claims: jsonb("claims").notNull().default([]),
    /** Retrieved sources: [{ id, title, url, source, kind, cveId }] */
    sources: jsonb("sources").notNull().default([]),
    /** Full markdown (report mode only). */
    markdown: text("markdown"),
    model: text("model").notNull(),
    /** { followUps, refused, errors, usage, stats, retrievedAt } */
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("research_reports_created_idx").on(t.createdAt)],
);

/** Metadata of code scans. Submitted code itself is never stored. */
export const scanRuns = pgTable(
  "scan_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userLogin: text("user_login"),
    filename: text("filename"),
    totalLines: integer("total_lines").notNull(),
    prescanCount: integer("prescan_count").notNull(),
    aiFindingCount: integer("ai_finding_count").notNull(),
    /** AI findings (title/severity/lines/explanation/fix) without any source code. */
    findings: jsonb("findings").notNull().default([]),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scan_runs_created_idx").on(t.createdAt)],
);

/* ------------------------------------------------------------------ Vulnerability intelligence */

/** One normalized record per (source, external id). Merged views are computed at read time. */
export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(), // 'NVD' | 'GitHub Advisories' | 'bitcoincore.org'
    externalId: text("external_id").notNull(),
    cveId: text("cve_id"),
    title: text("title").notNull(),
    severity: text("severity").notNull(), // critical|high|medium|low|unrated
    score: real("score"),
    status: text("status").notNull(), // confirmed|unverified
    publishedAt: timestamp("published_at", { withTimezone: true }),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    /** Full normalized IntelItem. */
    payload: jsonb("payload").notNull(),
    /** true when first recorded during a source's initial baseline import (not a "new" alert). */
    isBaseline: boolean("is_baseline").notNull().default(false),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("findings_source_ext_uq").on(t.source, t.externalId),
    index("findings_severity_idx").on(t.severity),
    index("findings_first_seen_idx").on(t.firstSeen),
    index("findings_cve_idx").on(t.cveId),
  ],
);

/** GitHub releases and bitcoincore.org posts. */
export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(), // 'github_release' | 'bitcoincore_post'
    source: text("source").notNull(), // e.g. 'github:bitcoin/bitcoin' | 'bitcoincore.org'
    externalId: text("external_id").notNull(), // tag name or URL
    title: text("title").notNull(),
    url: text("url").notNull(),
    prerelease: boolean("prerelease").notNull().default(false),
    body: text("body"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    isBaseline: boolean("is_baseline").notNull().default(false),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("releases_source_ext_uq").on(t.source, t.externalId),
    index("releases_published_idx").on(t.publishedAt),
  ],
);

/** Per-source ingestion state (cursor + last run summary). */
export const ingestionCursors = pgTable("ingestion_cursors", {
  source: text("source").primaryKey(),
  /** Source-specific cursor, e.g. NVD lastModified window end (ISO). */
  cursor: text("cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"), // 'ok' | 'error'
  lastError: text("last_error"),
  lastCount: integer("last_count"),
  lastNew: integer("last_new"),
});

/** One row per ingest invocation (cron or manual). */
export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trigger: text("trigger").notNull(), // 'cron' | 'manual'
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    newCount: integer("new_count").notNull().default(0),
    results: jsonb("results").notNull().default([]),
  },
  (t) => [index("ingestion_runs_started_idx").on(t.startedAt)],
);
