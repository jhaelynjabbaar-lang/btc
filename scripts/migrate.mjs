// Applies SQL migrations from ./drizzle to the database in DATABASE_URL (Neon).
// Usage: DATABASE_URL=... npm run db:migrate (also runs automatically on Vercel production builds via vercel-build)      (never prints the URL)
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

const url = (process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
if (!url) {
  console.error("DATABASE_URL is not set — nothing to migrate. (Awaiting Neon: connect the Neon integration to the Vercel project, then `vercel env pull` or export DATABASE_URL.)");
  process.exit(2);
}
try {
  await migrate(drizzle(neon(url)), { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
} catch (e) {
  console.error("Migration failed:", e instanceof Error ? e.message.replace(url, "<database-url>") : "unknown error");
  process.exit(1);
}
