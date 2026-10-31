import Link from "next/link";
import { Badge } from "./ui";

/** Honest state shown wherever data would come from Postgres but DATABASE_URL is not set. */
export function DatabaseNotConfigured({ what }: { what: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line-hi/70 bg-void/40 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">Database not configured</Badge>
        <Badge>awaiting Neon</Badge>
      </div>
      <h2 className="mt-3 text-base font-semibold text-ink">{what} needs the research database.</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        No <span className="font-mono text-xs">DATABASE_URL</span> is set, so nothing is stored and nothing is shown here — no placeholder
        numbers. The app itself works normally; the moment a Postgres database is connected this page fills with real data.
      </p>
      <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-muted">
        <li>Connect a Neon Postgres store to the Vercel project (Storage → Neon), or set <span className="font-mono text-xs">DATABASE_URL</span>.</li>
        <li>Run <span className="font-mono text-xs">npm run db:migrate</span> once to create the tables.</li>
        <li>Open <Link href="/monitoring" className="text-electric-hi underline">Monitoring</Link> and run the first ingest.</li>
      </ol>
    </div>
  );
}

/** Shown on a host where protected features are disabled until real sign-in is configured. */
export function AccessDisabled() {
  return (
    <div className="rounded-xl border border-line bg-panel/90 p-6">
      <Badge tone="warn">Disabled on this host</Badge>
      <h2 className="mt-3 text-base font-semibold text-ink">Sign-in is not configured here.</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        This section is private. It is available on Vercel preview hosts behind Vercel SSO, on localhost, or on any host once GitHub sign-in is configured.
        See <Link href="/signin" className="text-electric-hi underline">/signin</Link> for the setup.
      </p>
    </div>
  );
}
