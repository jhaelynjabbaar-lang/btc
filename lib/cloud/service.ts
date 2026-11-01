import "server-only";
import { z } from "zod";
import { getSupabaseServer } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import { getAdapter } from "./adapters";
import { manualAdapter } from "./adapters/manual";
import { AdapterUnsupportedError, type CloudAdapter, type Offer, type OfferFilter } from "./adapters/types";
import { SPEND_MESSAGE, type LimitRow } from "./guard";
import { POLICY_BLOCK_MESSAGE, requestBlocked, type MiningPolicy } from "./policy";
import { preflight } from "./preflight";
import { COMMITTED_STATES, type ResourceEvent, type ResourceState } from "./state";

/**
 * Server-side orchestration for the cloud module. Every mutation goes through a SECURITY-INVOKER database function
 * (cloud_request_resource, cloud_transition, cloud_set_kill_switch, ...) that changes state AND writes audit_log in one
 * transaction and re-checks policy, kill switch and spend caps. This file adds the same checks up front for clear errors,
 * and is the only place an adapter is invoked, always AFTER the database accepted an approved transition.
 */

export type CloudActor = { login: string | null };
export const ownerIdFor = (a: CloudActor) => (a.login ?? "owner").toLowerCase();
const actorName = (a: CloudActor) => a.login ?? "owner";

export type Fail = { ok: false; status: number; error: string; message: string; detail?: Record<string, unknown> };
export type Ok<T extends object = object> = { ok: true } & T;
const fail = (status: number, error: string, message: string, detail?: Record<string, unknown>): Fail => ({ ok: false, status, error, message, detail });

const RpcResult = z.looseObject({ ok: z.boolean(), reason: z.string().optional() });
type Rpc = z.infer<typeof RpcResult>;

const REASON_MESSAGE: Record<string, [number, string]> = {
  ...(Object.fromEntries(Object.entries(POLICY_BLOCK_MESSAGE).map(([k, v]) => [k, [403, v]])) as Record<string, [number, string]>),
  ...(Object.fromEntries(Object.entries(SPEND_MESSAGE).map(([k, v]) => [k, [403, v]])) as Record<string, [number, string]>),
  kill_switch_engaged: [423, "The kill switch is engaged. Re-arm it before approving, activating or starting anything."],
  not_found: [404, "Not found."],
  provider_not_found: [404, "Provider not found."],
  invalid_transition: [409, "That action is not allowed from the resource's current state."],
  not_approved: [409, "This resource has no active approval (it was never approved, or approval was revoked). Request and approve it again."],
  duplicate_instance: [409, "That instance id is already registered for this provider."],
  invalid_limit: [400, "Invalid limit."],
  invalid_scope: [400, "A provider limit needs a provider; a global limit must not have one."],
  conditions_not_acknowledged: [403, POLICY_BLOCK_MESSAGE.conditions_not_acknowledged],
};

function rpcFail(r: Rpc): Fail {
  const reason = r.reason ?? "failed";
  const [status, message] = REASON_MESSAGE[reason] ?? [500, "The operation failed."];
  const rest: Record<string, unknown> = { ...r };
  delete rest.ok;
  delete rest.reason;
  return fail(status, reason, message, rest);
}

async function rpc(name: string, args: Record<string, unknown>): Promise<Rpc> {
  const db = getSupabaseServer();
  // The generated Database type lists these functions; the dynamic name keeps one small wrapper for all of them.
  const { data, error } = await (db.rpc as unknown as (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>)(name, args);
  if (error) throw new Error(`rpc ${name} failed`);
  return RpcResult.parse(data);
}

async function audit(actor: string, action: string, entityType: string, entityId: string, details: Json) {
  await getSupabaseServer().from("audit_log").insert({ actor, action, entity_type: entityType, entity_id: entityId, details });
}

// ----------------------------------------------------------------------------------------------- reads
export type ProviderRow = Awaited<ReturnType<typeof loadProviders>>[number];
export type ResourceRow = Awaited<ReturnType<typeof loadResources>>[number];

async function loadProviders() {
  const r = await getSupabaseServer().from("cloud_providers").select("*").order("name");
  if (r.error) throw new Error("providers query failed");
  return r.data ?? [];
}
async function loadResources(owner: string) {
  const r = await getSupabaseServer().from("cloud_resources").select("*").eq("owner_id", owner).order("created_at", { ascending: false }).limit(200);
  if (r.error) throw new Error("resources query failed");
  return r.data ?? [];
}
async function loadLimits(owner: string): Promise<LimitRow[]> {
  const r = await getSupabaseServer().from("spend_limits").select("scope, provider_id, period, limit_usd, enabled").eq("owner_id", owner);
  if (r.error) throw new Error("limits query failed");
  return (r.data ?? []).map((l) => ({ scope: l.scope as LimitRow["scope"], provider_id: l.provider_id, period: l.period as LimitRow["period"], limit_usd: Number(l.limit_usd), enabled: l.enabled }));
}
async function killSwitchEngaged(owner: string): Promise<boolean> {
  const r = await getSupabaseServer().from("cloud_controls").select("kill_switch_engaged").eq("owner_id", owner).maybeSingle();
  if (r.error) throw new Error("controls query failed");
  return r.data?.kill_switch_engaged ?? false;
}

export async function snapshot(actor: CloudActor) {
  const owner = ownerIdFor(actor);
  const db = getSupabaseServer();
  const [providers, resources, limits, killed, auditRes] = await Promise.all([
    loadProviders(),
    loadResources(owner),
    loadLimits(owner),
    killSwitchEngaged(owner),
    db.from("audit_log").select("id, occurred_at, actor, action, entity_type, entity_id").like("action", "cloud%").order("id", { ascending: false }).limit(15),
  ]);
  return { owner, providers, resources, limits, killSwitchEngaged: killed, audit: auditRes.data ?? [] };
}

export async function listOffers(slug: string, filter: OfferFilter): Promise<Ok<{ offers: Offer[]; adapter: string }> | Fail> {
  const providers = await loadProviders();
  const p = providers.find((x) => x.slug === slug);
  if (!p) return fail(404, "provider_not_found", "Unknown provider.");
  const adapter = getAdapter(p.adapter);
  if (!adapter.capabilities.listOffers || p.adapter === "manual") return { ok: true, offers: [], adapter: adapter.id };
  // Policy applies to looking at offers too only in the sense that prohibited/unknown providers are never queried.
  const blocked = requestBlocked({ mining_policy: p.mining_policy as MiningPolicy });
  if (blocked) return fail(403, blocked, POLICY_BLOCK_MESSAGE[blocked]);
  try {
    return { ok: true, offers: await adapter.listOffers(filter), adapter: adapter.id };
  } catch {
    return fail(502, "provider_unreachable", "The provider's public catalogue could not be read right now.");
  }
}

// ----------------------------------------------------------------------------------------------- writes
export type RequestInput = {
  provider_id: string;
  label: string;
  instance_id?: string;
  request_kind: "register_manual" | "provision";
  capacity?: Record<string, string | number | boolean>;
  price?: { hourly_usd: number; source_url: string; note?: string };
  offer_id?: string;
};

/** Creates a cloud_resources row in state pending_approval. Never calls a provider except the read-only public catalogue for a price. */
export async function requestResource(input: RequestInput, actor: CloudActor): Promise<Ok<{ id: string; costKnown: boolean }> | Fail> {
  const owner = ownerIdFor(actor);
  const provider = (await loadProviders()).find((p) => p.id === input.provider_id);
  if (!provider) return fail(404, "provider_not_found", "Provider not found.");

  const provisioning = getAdapter(provider.adapter);
  if (input.request_kind === "provision" && !provisioning.capabilities.provision)
    return fail(422, "adapter_cannot_provision", `There is no provisioning adapter for ${provider.name}. Provision the machine yourself at the provider and register it (register_manual).`);
  const adapter: CloudAdapter = input.request_kind === "provision" ? provisioning : manualAdapter;

  let hourly: number | null = null;
  let source: string | null = null;
  let note: string | null = input.price?.note ?? null;
  if (input.offer_id && provisioning.capabilities.listOffers && provider.adapter !== "manual") {
    const blocked = requestBlocked({ mining_policy: provider.mining_policy as MiningPolicy });
    if (!blocked) {
      try {
        const est = await provisioning.estimateCost({ offerId: input.offer_id });
        hourly = est.hourlyUsd;
        source = est.sourceUrl;
        note = est.note;
      } catch {
        /* price stays unknown */
      }
    }
  } else if (input.price) {
    const est = await adapter.estimateCost({ citedHourlyUsd: input.price.hourly_usd, citedSourceUrl: input.price.source_url });
    hourly = est.hourlyUsd;
    source = est.sourceUrl;
    note = est.hourlyUsd === null ? est.note : (input.price.note ?? est.note);
  }

  const res = await rpc("cloud_request_resource", {
    p_owner: owner,
    p_provider: provider.id,
    p_label: input.label,
    p_instance_id: input.instance_id ?? null,
    p_request_kind: input.request_kind,
    p_capacity: (input.capacity ?? {}) as Json,
    p_hourly: hourly,
    p_cost_known: hourly !== null && source !== null,
    p_price_source_url: source,
    p_price_note: note,
    p_actor: actorName(actor),
  });
  if (!res.ok) return rpcFail(res);
  return { ok: true, id: String(res.id), costKnown: hourly !== null && source !== null };
}

export type ActionInput = { id: string; action: Exclude<ResourceEvent, "kill" | "confirm_running">; note?: string };

/** Moves one resource through the approval state machine; adapters only act after an approved transition was recorded. */
export async function actOnResource(input: ActionInput, actor: CloudActor): Promise<Ok<{ from: string; to: string; adapterMessage?: string; warning?: string }> | Fail> {
  const owner = ownerIdFor(actor);
  const db = getSupabaseServer();
  const found = await db.from("cloud_resources").select("*").eq("id", input.id).eq("owner_id", owner).maybeSingle();
  if (found.error) throw new Error("resource query failed");
  const r = found.data;
  if (!r) return fail(404, "not_found", "Resource not found.");
  const from = r.state as ResourceState;

  // --- pre-flight (the database repeats all of this inside cloud_transition) ---
  const provider = (await loadProviders()).find((p) => p.id === r.provider_id);
  if (!provider) return fail(404, "provider_not_found", "Provider not found.");
  const committedRows = (await loadResources(owner)).filter((x) => (COMMITTED_STATES as readonly string[]).includes(x.state));
  const pre = preflight({
    event: input.action,
    resource: {
      id: r.id,
      state: from,
      authorization: r.authorization_status as "pending" | "authorized" | "denied" | "revoked",
      provider_id: r.provider_id,
      hourly_price_usd: Number(r.hourly_price_usd),
      cost_known: r.cost_known,
    },
    provider: {
      mining_policy: provider.mining_policy as MiningPolicy,
      written_permission_ref: provider.written_permission_ref,
      conditions_acknowledged_at: provider.conditions_acknowledged_at,
    },
    killSwitchEngaged: await killSwitchEngaged(owner),
    limits: await loadLimits(owner),
    committed: committedRows.map((x) => ({ id: x.id, provider_id: x.provider_id, hourly_price_usd: Number(x.hourly_price_usd) })),
  });
  if (!pre.ok) return fail(pre.status, pre.error, pre.message, pre.detail);

  const tr = await rpc("cloud_transition", { p_id: r.id, p_event: input.action, p_actor: actorName(actor), p_note: input.note ?? null });
  if (!tr.ok) return rpcFail(tr);
  const to = String(tr.to);
  const out: { from: string; to: string; adapterMessage?: string; warning?: string } = { from, to };

  // --- adapter: only after the database accepted the transition, and never for approve/reject ---
  if (input.action === "approve" || input.action === "reject") return { ok: true, ...out };
  const adapter = r.request_kind === "provision" ? getAdapter(r.adapter) : manualAdapter;
  const ref = { id: r.id, instanceId: r.instance_id, providerSlug: String(provider.slug ?? "") };
  try {
    if (input.action === "activate") {
      const res = await adapter.provision(ref);
      const run = await rpc("cloud_transition", { p_id: r.id, p_event: "confirm_running", p_actor: actorName(actor), p_note: res.message });
      if (!run.ok) return rpcFail(run);
      return { ok: true, from, to: "running", adapterMessage: res.message };
    }
    if (input.action === "start") return { ok: true, ...out, adapterMessage: (await adapter.start(ref)).message };
    if (input.action === "stop") return { ok: true, ...out, adapterMessage: (await adapter.stop(ref)).message };
    if (input.action === "destroy") return { ok: true, ...out, adapterMessage: (await adapter.destroy(ref)).message };
  } catch (e) {
    const msg = e instanceof AdapterUnsupportedError ? e.message : "The provider adapter failed.";
    if (input.action === "activate" || input.action === "start") {
      // Fail safe: never leave a resource recorded as active when the adapter could not start it.
      await rpc("cloud_transition", { p_id: r.id, p_event: "stop", p_actor: actorName(actor), p_note: `adapter failed: ${msg}`.slice(0, 200) });
      return fail(502, "adapter_failed", `${msg} The resource was moved to 'stopped'.`);
    }
    await audit(actorName(actor), "cloud_resource.adapter_failed", "cloud_resource", r.id, { action: input.action, message: msg });
    return { ok: true, ...out, warning: `${msg} The state was recorded; check the provider.` };
  }
  return { ok: true, ...out };
}

/** "Stop all cloud resources": engage the kill switch, reject pending requests, stop everything active (DB first, adapter after). */
export async function killAll(actor: CloudActor): Promise<Ok<{ rejectedPending: number; stopped: number; manualActionNeeded: { id: string; instanceId: string; message: string }[]; adapterFailures: number }> | Fail> {
  const res = await rpc("cloud_set_kill_switch", { p_owner: ownerIdFor(actor), p_engage: true, p_actor: actorName(actor) });
  if (!res.ok) return rpcFail(res);
  const targets = z.array(z.looseObject({ id: z.string(), adapter: z.string(), instance_id: z.string().optional() })).parse(res.needs_adapter_stop ?? []);
  const manualActionNeeded: { id: string; instanceId: string; message: string }[] = [];
  let adapterFailures = 0;
  for (const t of targets) {
    try {
      const out = await getAdapter(t.adapter).stop({ id: t.id, instanceId: t.instance_id ?? "", providerSlug: "" });
      if (out.manual) manualActionNeeded.push({ id: t.id, instanceId: t.instance_id ?? "", message: out.message });
    } catch (e) {
      adapterFailures += 1;
      await audit(actorName(actor), "cloud_resource.adapter_failed", "cloud_resource", t.id, { action: "kill", message: e instanceof Error ? e.message.slice(0, 200) : "failed" });
    }
  }
  return { ok: true, rejectedPending: Number(res.rejected_pending ?? 0), stopped: targets.length, manualActionNeeded, adapterFailures };
}

export async function rearmKillSwitch(actor: CloudActor): Promise<Ok | Fail> {
  const res = await rpc("cloud_set_kill_switch", { p_owner: ownerIdFor(actor), p_engage: false, p_actor: actorName(actor) });
  return res.ok ? { ok: true } : rpcFail(res);
}

export async function setSpendLimit(b: { scope: "global" | "provider"; provider_id?: string; period: "hour" | "month"; limit_usd: number }, actor: CloudActor): Promise<Ok<{ oldUsd: number | null; newUsd: number }> | Fail> {
  const res = await rpc("cloud_set_spend_limit", {
    p_owner: ownerIdFor(actor), p_scope: b.scope, p_provider: b.provider_id ?? null, p_period: b.period, p_limit: b.limit_usd, p_actor: actorName(actor),
  });
  if (!res.ok) return rpcFail(res);
  return { ok: true, oldUsd: res.old_usd === null || res.old_usd === undefined ? null : Number(res.old_usd), newUsd: Number(res.new_usd) };
}

export async function setProviderAttestation(providerId: string, b: { written_permission_ref?: string | null; conditions_acknowledged: boolean }, actor: CloudActor): Promise<Ok | Fail> {
  const res = await rpc("cloud_set_provider_attestation", {
    p_provider: providerId, p_permission_ref: b.written_permission_ref ?? null, p_acknowledge: b.conditions_acknowledged, p_actor: actorName(actor),
  });
  return res.ok ? { ok: true } : rpcFail(res);
}
