import type { Metadata } from "next";
import { AccessDisabled } from "@/components/db-states";
import { RepairConsole, type DeviceRow, type ReportRow, type SuggestionView } from "@/components/repair-console";
import { PageHeader } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { getSupabaseServer, supabaseConfigured } from "@/lib/supabase/server";
import { FIREFOX } from "@/lib/repair/actions";
import { loadScript } from "@/lib/repair/script";
import { toFindingRows } from "@/lib/repair/service";
import type { SupabaseClient } from "@supabase/supabase-js";

export const metadata: Metadata = { title: "PC Repair" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const access = await requirePageAccess("/repair");
  const header = (
    <PageHeader
      eyebrow="Windows 7 repair helper"
      title="PC Repair"
      subtitle="Pair a PC, read its diagnostics, and suggest fixes from a fixed allowlist. The server never runs anything: the person at the PC sees the exact command and answers Y or N."
    />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  if (!supabaseConfigured()) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-dashed border-line-hi/70 bg-void/40 p-6 text-sm text-muted">Supabase is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY). Nothing is shown until it is.</div>
      </>
    );
  }
  const db = getSupabaseServer() as unknown as SupabaseClient;
  const [dev, rep, sug] = await Promise.all([
    db.from("repair_devices").select("id, name, status, agent_version, os_caption, arch, ram_mb, paired_at, last_seen_at").order("created_at", { ascending: false }).limit(20),
    db.from("repair_reports").select("id, device_id, source, kind, created_at, offline_code, host, findings, errors, action_results").order("created_at", { ascending: false }).limit(12),
    db.from("repair_suggestions").select("id, report_id, device_id, action_id, explanation, source, status, exit_code, result_note, created_at").order("created_at", { ascending: false }).limit(60),
  ]);
  if (dev.error || rep.error || sug.error) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm text-warn" role="alert">The repair tables could not be queried. Apply supabase/migrations/20261101210001_repair_agent.sql.</div>
      </>
    );
  }
  const reports: ReportRow[] = ((rep.data ?? []) as Array<Omit<ReportRow, "findings"> & { findings: unknown }>).map((r) => ({ ...r, findings: toFindingRows(r.findings) }));
  const { sha256 } = loadScript();
  return (
    <>
      {header}
      <RepairConsole
        devices={(dev.data ?? []) as DeviceRow[]}
        reports={reports}
        suggestions={(sug.data ?? []) as SuggestionView[]}
        scriptSha256={sha256}
        firefox={{ version: FIREFOX.version, url: FIREFOX.url, sha256: FIREFOX.sha256 }}
        relayConfigured={Boolean(process.env.REPAIR_RELAY_URL?.trim())}
      />
    </>
  );
}
