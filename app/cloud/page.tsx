import type { Metadata } from "next";
import { AccessDisabled } from "@/components/db-states";
import { CloudConsole } from "@/components/cloud-console";
import { Badge, PageHeader } from "@/components/ui";
import { requirePageAccess } from "@/lib/auth/access";
import { snapshot } from "@/lib/cloud/service";
import { supabaseConfigured } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Cloud" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const access = await requirePageAccess("/cloud");
  const header = (
    <PageHeader
      eyebrow="Cloud providers"
      title="Cloud"
      subtitle="Provider mining policies from each provider's own terms, hard spend caps (default 0), and an approval step for every machine. Nothing is bought, provisioned or activated without your explicit approval."
    />
  );
  if ("blocked" in access) return <>{header}<AccessDisabled /></>;
  if (!supabaseConfigured()) {
    return (
      <>
        {header}
        <div className="rounded-xl border border-dashed border-line-hi/70 bg-void/40 p-6 text-sm text-muted">
          <Badge tone="warn">Supabase not configured</Badge>
          <p className="mt-3">Set <span className="font-mono text-xs">SUPABASE_URL</span> and <span className="font-mono text-xs">SUPABASE_SECRET_KEY</span> to use the cloud module. Nothing is shown until real data exists.</p>
        </div>
      </>
    );
  }
  let data: Awaited<ReturnType<typeof snapshot>>;
  try {
    data = await snapshot(access.actor);
  } catch {
    return (
      <>
        {header}
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-5 text-sm text-warn" role="alert">
          The cloud tables could not be queried. Check that the Phase 6 migrations were applied and the Supabase key is valid.
        </div>
      </>
    );
  }
  return (
    <>
      {header}
      <CloudConsole
        killSwitchEngaged={data.killSwitchEngaged}
        providers={data.providers.map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          mining_policy: p.mining_policy,
          policy_url: p.policy_url,
          policy_quote: p.policy_quote,
          last_verified_on: p.last_verified_on,
          notes: p.notes,
          adapter: p.adapter,
          pricing_url: p.pricing_url,
          written_permission_ref: p.written_permission_ref,
          conditions_acknowledged_at: p.conditions_acknowledged_at,
        }))}
        limits={data.limits}
        resources={data.resources.map((r) => ({
          id: r.id,
          provider_id: r.provider_id,
          label: r.label,
          instance_id: r.instance_id,
          state: r.state,
          request_kind: r.request_kind,
          adapter: r.adapter,
          cost_known: r.cost_known,
          hourly_price_usd: Number(r.hourly_price_usd),
          price_source_url: r.price_source_url,
          price_note: r.price_note,
          requested_by: r.requested_by,
          decided_by: r.decided_by,
          created_at: r.created_at,
          state_changed_at: r.state_changed_at,
        }))}
        audit={data.audit}
      />
    </>
  );
}
