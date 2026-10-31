import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Neon Postgres over HTTP (serverless-friendly, no connection pool to manage).
 * The Vercel Marketplace Neon integration injects DATABASE_URL (and POSTGRES_URL).
 * Returns null when no database is configured so every caller can degrade gracefully.
 */
function databaseUrl(): string | null {
  const u = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
  return u || null;
}

export function dbConfigured(): boolean {
  return databaseUrl() !== null;
}

let cached: ReturnType<typeof make> | null = null;
function make(url: string) {
  return drizzle(neon(url), { schema });
}

export function getDb() {
  const url = databaseUrl();
  if (!url) return null;
  cached ??= make(url);
  return cached;
}

export type AppDb = NonNullable<ReturnType<typeof getDb>>;
