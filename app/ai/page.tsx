import type { Metadata } from "next";
import { AccessDisabled } from "@/components/db-states";
import { AiConsole } from "@/components/ai-console";
import { Badge, PageHeader } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { loadAiPage } from "@/lib/analysis/server";
import { supabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "AI Control" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const access = await requirePageAccess("/ai");
  const header = (
    <PageHeader
      eyebrow="AI analysis"
      title="AI Control"
      subtitle="NVIDIA Nemotron reads compact facts from your own database and proposes recommendations. It cannot run commands, approve cloud resources, change spend limits or move money: every action needs your click and confirmation."
    />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  if (!supabaseConfigured()) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-dashed border-line-hi/70 bg-void/40 p-6 text-sm text-muted">
          <Badge tone="warn">Supabase not configured</Badge>
          <p className="mt-3">Set <span className="font-mono text-xs">SUPABASE_URL</span> and <span className="font-mono text-xs">SUPABASE_SECRET_KEY</span> to use AI analysis. Nothing is shown until real data exists.</p>
        </div>
      </>
    );
  }
  let data: Awaited<ReturnType<typeof loadAiPage>>;
  try {
    data = await loadAiPage(access.actor);
  } catch {
    return (
      <>
        {header}
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm text-warn" role="alert">
          The recommendations could not be loaded. Check that the Phase 7 migration (20261101180001_ai_analysis) was applied and the Supabase key is valid.
        </div>
      </>
    );
  }
  return (
    <>
      {header}
      <AiConsole {...data} />
    </>
  );
}
