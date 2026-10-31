// Vercel build entrypoint: on PRODUCTION builds only, apply SQL migrations (idempotent, tracked by drizzle)
// before building the app. Sensitive Vercel env vars (DATABASE_URL) are only readable inside the build, so this
// is how the migration runs against the Neon production DB. Never prints the connection string.
import { spawnSync } from "node:child_process";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const hasDb = Boolean((process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim());
if (process.env.VERCEL_ENV === "production" && hasDb) {
  console.log("[vercel-build] production build: applying database migrations");
  run(process.execPath, ["scripts/migrate.mjs"]);
} else {
  console.log("[vercel-build] skipping migrations (not a production build or no database URL)");
}
run(process.execPath, ["scripts/check-supabase.mjs"]);
run("npx", ["next", "build"]);
