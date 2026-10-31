import { defineConfig } from "drizzle-kit";

// Used by `npm run db:generate` (no database needed) and `npm run db:migrate` (needs DATABASE_URL).
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
});
