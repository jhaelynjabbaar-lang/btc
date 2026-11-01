"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Panel } from "./ui";

type Provider = {
  id: string;
  name: string;
  slug: string | null;
  mining_policy: string;
  policy_url: string | null;
  policy_quote: string | null;
  last_verified_on: string | null;
  notes: string | null;
  adapter: string;
  pricing_url: string | null;
  written_permission_ref: string | null;
  conditions_acknowledged_at: string | null;
};
type Limit = { scope: "global" | "provider"; provider_id: string | null; period: string; limit_usd: number; enabled: boolean };
type Resource = {
  id: string;
  provider_id: string;
  label: string | null;
  instance_id: string;
  state: string;
  request_kind: string;
  adapter: string;
  cost_known: boolean;
  hourly_price_usd: number;
  price_source_url: string | null;
  price_note: string | null;
  requested_by: string | null;
  decided_by: string | null;
  created_at: string;
  state_changed_at: string;
};
type AuditRow = { id: number; occurred_at: string; actor: string; action: string; entity_type: string | null; entity_id: string | null };

const POLICY_TONE = {
  allowed: "ok",
  allowed_with_conditions: "info",
  requires_written_permission: "warn",
  prohibited: "danger",
  unknown: "muted",
} as const;
const POLICY_LABEL: Record<string, string> = {
  allowed: "Mining allowed",
  allowed_with_conditions: "Allowed with conditions",
  requires_written_permission: "Written permission required",
  prohibited: "Mining prohibited",
  unknown: "Policy unknown",
};
const STATE_TONE = { pending_approval: "warn", approved: "info", running: "ok", provisioning: "info", stopped: "muted", rejected: "danger", destroyed: "muted" } as const;

const btn = "rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-panel-hi disabled:opacity-40";
const btnPrimary = "rounded-md bg-gradient-to-r from-electric to-neon px-3 py-1.5 text-xs font-semibold text-void disabled:opacity-50";
const btnDanger = "rounded-md border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger/20 disabled:opacity-50";
const input = "rounded-md border border-line bg-void/60 px-2 py-1 text-xs text-ink placeholder:text-faint";

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

type Msg = { ok: boolean; text: string } | null;

async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> | null; status: number }> {
  try {
    const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, data, status: res.status };
  } catch {
    return { ok: false, data: { message: "Network error." }, status: 0 };
  }
}
const errText = (r: { data: Record<string, unknown> | null; status: number }) => String(r.data?.message ?? `Failed (HTTP ${r.status}).`);

/** Two-step button: first click arms it, second click within 8 s confirms. Nothing is sent on the first click. */
function Confirm({ label, confirmLabel, onConfirm, disabled, danger }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; danger?: boolean }) {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <span className="inline-flex gap-1">
      <button type="button" className={danger ? btnDanger : btnPrimary} onClick={() => { setArmed(false); onConfirm(); }}>{confirmLabel}</button>
      <button type="button" className={btn} onClick={() => setArmed(false)}>Cancel</button>
    </span>
  ) : (
    <button type="button" className={danger ? btnDanger : btn} disabled={disabled} onClick={() => { setArmed(true); setTimeout(() => setArmed(false), 8000); }}>{label}</button>
  );
}

export function CloudConsole({ killSwitchEngaged, providers, limits, resources, audit }: { killSwitchEngaged: boolean; providers: Provider[]; limits: Limit[]; resources: Resource[]; audit: AuditRow[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const refresh = () => router.refresh();

  async function run(fn: () => Promise<{ ok: boolean; text: string }>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg(await fn());
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const act = (id: string, action: string) =>
    run(async () => {
      const r = await call("POST", `/api/admin/cloud/resources/${id}`, { action, confirm: true });
      if (!r.ok) return { ok: false, text: errText(r) };
      const d = r.data ?? {};
      return { ok: true, text: `${action}: ${String(d.from)} → ${String(d.to)}${d.adapter_message ? ` — ${String(d.adapter_message)}` : ""}${d.warning ? ` (${String(d.warning)})` : ""}` };
    });

  const kill = (action: "engage" | "rearm") =>
    run(async () => {
      const r = await call("POST", "/api/admin/cloud/kill-switch", { action, confirm: true });
      if (!r.ok) return { ok: false, text: errText(r) };
      if (action === "rearm") return { ok: true, text: "Kill switch re-armed. Approvals and activations are possible again (each still needs your approval)." };
      const d = r.data ?? {};
      const manual = (d.manual_action_needed as { instanceId: string }[] | undefined) ?? [];
      return {
        ok: true,
        text: `Stopped all cloud resources: ${String(d.rejected_pending)} pending request(s) rejected, ${String(d.stopped)} active resource(s) marked stopped.${manual.length ? ` You must power off ${manual.length} machine(s) at the provider yourself (manual adapter): ${manual.map((m) => m.instanceId).join(", ")}.` : ""}${Number(d.adapter_failures) > 0 ? ` ${String(d.adapter_failures)} adapter stop call(s) failed: check the provider.` : ""}`,
      };
    });

  const pending = resources.filter((r) => r.state === "pending_approval");
  const requestable = providers.filter((p) => p.mining_policy !== "prohibited" && p.mining_policy !== "unknown");
  const limitFor = (scope: "global" | "provider", period: string, providerId?: string) =>
    limits.find((l) => l.enabled && l.scope === scope && l.period === period && (scope === "global" ? l.provider_id === null : l.provider_id === providerId))?.limit_usd;

  return (
    <div className="space-y-4">
      {msg && (
        <div role="status" className={"rounded-lg border p-3 text-sm " + (msg.ok ? "border-ok/30 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn")}>{msg.text}</div>
      )}

      <Panel title="Kill switch" badge={killSwitchEngaged ? <Badge tone="danger">ENGAGED</Badge> : <Badge tone="ok">armed, nothing stopped</Badge>}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-2xl text-sm text-muted">
            {killSwitchEngaged
              ? "Engaged: approving, activating and starting are blocked. Active resources were marked stopped and their approval revoked; pending requests were rejected."
              : "“Stop all cloud resources” rejects every pending request, marks every active resource stopped (approval revoked) and blocks approve/activate/start until you re-arm it. With the manual adapter it cannot power off a machine at the provider: you must do that yourself."}
          </p>
          {killSwitchEngaged ? (
            <Confirm label="Re-arm" confirmLabel="Confirm re-arm" onConfirm={() => void kill("rearm")} disabled={busy} />
          ) : (
            <Confirm label="Stop all cloud resources" confirmLabel="Yes, stop everything" onConfirm={() => void kill("engage")} disabled={busy} danger />
          )}
        </div>
      </Panel>

      <Panel title="Approval queue" badge={<Badge tone={pending.length ? "warn" : "muted"}>{pending.length} pending</Badge>}>
        {pending.length === 0 ? (
          <p className="text-sm text-muted">Nothing is waiting for approval. A machine you register below appears here first and does nothing until you approve it.</p>
        ) : (
          <ul className="divide-y divide-line">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <ResourceSummary r={r} provider={byId.get(r.provider_id)} />
                <span className="flex flex-wrap gap-2">
                  <Confirm label="Approve" confirmLabel="Confirm approve" onConfirm={() => void act(r.id, "approve")} disabled={busy || killSwitchEngaged} />
                  <Confirm label="Reject" confirmLabel="Confirm reject" onConfirm={() => void act(r.id, "reject")} disabled={busy} danger />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Resources" badge={<Badge>{resources.length}</Badge>}>
        {resources.length === 0 ? (
          <p className="text-sm text-muted">No cloud resources. None exist, none are provisioned, and nothing is being spent.</p>
        ) : (
          <ul className="divide-y divide-line">
            {resources.filter((r) => r.state !== "pending_approval").map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <ResourceSummary r={r} provider={byId.get(r.provider_id)} />
                <span className="flex flex-wrap gap-2">
                  {r.state === "approved" && <Confirm label="Activate" confirmLabel="Confirm activate" onConfirm={() => void act(r.id, "activate")} disabled={busy || killSwitchEngaged} />}
                  {r.state === "stopped" && <Confirm label="Start" confirmLabel="Confirm start" onConfirm={() => void act(r.id, "start")} disabled={busy || killSwitchEngaged} />}
                  {(r.state === "running" || r.state === "provisioning") && <Confirm label="Stop" confirmLabel="Confirm stop" onConfirm={() => void act(r.id, "stop")} disabled={busy} />}
                  {["approved", "running", "provisioning", "stopped"].includes(r.state) && <Confirm label="Destroy" confirmLabel="Confirm destroy" onConfirm={() => void act(r.id, "destroy")} disabled={busy} danger />}
                </span>
              </li>
            ))}
          </ul>
        )}
        <RegisterForm providers={requestable} disabled={busy || killSwitchEngaged} onDone={(m) => { setMsg(m); refresh(); }} />
      </Panel>

      <Panel title="Spend limits" badge={<Badge tone="warn">default 0 = nothing can be spent</Badge>}>
        <p className="mb-3 max-w-3xl text-xs text-muted">
          Caps are checked against the price you cited (provider-published) × 730 h/month for everything approved, provisioning or running. This is a projection, not metered billing: the provider&apos;s invoice is the source of truth.
          The hourly cap applies to each single resource. A missing cap counts as 0. Every change asks for confirmation and is written to the audit log.
        </p>
        <div className="space-y-2">
          <LimitRow label="All providers" scope="global" current={{ month: limitFor("global", "month"), hour: limitFor("global", "hour") }} disabled={busy} onDone={(m) => { setMsg(m); refresh(); }} />
          {requestable.map((p) => (
            <LimitRow key={p.id} label={p.name} scope="provider" providerId={p.id} current={{ month: limitFor("provider", "month", p.id), hour: limitFor("provider", "hour", p.id) }} disabled={busy} onDone={(m) => { setMsg(m); refresh(); }} />
          ))}
        </div>
      </Panel>

      <Panel title="Providers" badge={<Badge>{providers.length}</Badge>}>
        {providers.length === 0 ? (
          <p className="text-sm text-muted">The provider registry is empty. Apply the Phase 6 migrations.</p>
        ) : (
          <ul className="divide-y divide-line">
            {providers.map((p) => (
              <ProviderRow key={p.id} p={p} disabled={busy} onDone={(m) => { setMsg(m); refresh(); }} />
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-faint">Policies are what each provider&apos;s own terms say, re-read on the date shown. Prohibited and unknown providers are blocked from provisioning, and the block cannot be switched off from this page.</p>
      </Panel>

      <Panel title="Recent cloud audit entries" badge={<Badge>{audit.length}</Badge>}>
        {audit.length === 0 ? (
          <p className="text-sm text-muted">No cloud activity has been recorded yet.</p>
        ) : (
          <ul className="space-y-1 font-mono text-[11px] text-muted">
            {audit.map((a) => (
              <li key={a.id}>#{a.id} {new Date(a.occurred_at).toISOString().replace("T", " ").slice(0, 19)} UTC · {a.action} · {a.actor}{a.entity_id ? ` · ${a.entity_id.slice(0, 8)}` : ""}</li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ResourceSummary({ r, provider }: { r: Resource; provider?: Provider }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{r.label ?? r.instance_id}</span>
        <Badge tone={STATE_TONE[r.state as keyof typeof STATE_TONE] ?? "muted"}>{r.state.replace("_", " ")}</Badge>
        <Badge>{provider?.name ?? "provider"}</Badge>
        <Badge>{r.request_kind === "provision" ? `adapter: ${r.adapter}` : "manual"}</Badge>
      </div>
      <div className="mt-0.5 text-xs text-faint">
        {r.cost_known ? (
          <>
            Estimated {usd(r.hourly_price_usd)}/h (≈ {usd(r.hourly_price_usd * 730)}/month) from the provider&apos;s published price{" "}
            {r.price_source_url && <a className="text-electric-hi underline" href={r.price_source_url} target="_blank" rel="noreferrer noopener">source</a>}
          </>
        ) : (
          <>Estimated cost: <strong className="text-warn">unknown</strong> (no published price cited). It cannot be approved until one is.</>
        )}
        {" · "}requested by {r.requested_by ?? "?"} on {new Date(r.created_at).toISOString().slice(0, 10)}
        {r.decided_by ? ` · decided by ${r.decided_by}` : ""}
      </div>
    </div>
  );
}

function RegisterForm({ providers, disabled, onDone }: { providers: Provider[]; disabled: boolean; onDone: (m: { ok: boolean; text: string }) => void }) {
  const [providerId, setProviderId] = useState("");
  const [label, setLabel] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [price, setPrice] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const body: Record<string, unknown> = { provider_id: providerId, label, request_kind: "register_manual" };
    if (instanceId.trim()) body.instance_id = instanceId.trim();
    if (price.trim() || source.trim()) body.price = { hourly_usd: Number(price), source_url: source.trim() };
    const r = await call("POST", "/api/admin/cloud/resources", body);
    setBusy(false);
    if (r.ok) {
      setLabel(""); setInstanceId(""); setPrice(""); setSource("");
      onDone({ ok: true, text: `Request created in 'pending approval'${r.data?.cost_known ? "" : " with unknown cost"}. Nothing was bought or started.` });
    } else onDone({ ok: false, text: errText(r) });
  }

  return (
    <details className="mt-4 rounded-lg border border-line bg-void/40 p-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-electric-hi">Register a machine you provisioned yourself (manual adapter)</summary>
      <p className="mt-2 text-xs text-muted">
        This only records a machine in <em>pending approval</em>; it does not buy, create or contact anything. Add the provider&apos;s published hourly price with the link to the page you read it on, or leave both empty and the cost is recorded as unknown.
      </p>
      {providers.length === 0 ? (
        <p className="mt-2 text-xs text-warn">No provider that may be used for mining is registered.</p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <select className={input} value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label="Provider">
            <option value="">Provider…</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} — {POLICY_LABEL[p.mining_policy]}</option>)}
          </select>
          <input className={input} placeholder="Label (e.g. gpu-box-1)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
          <input className={input} placeholder="Provider's instance id (optional)" value={instanceId} onChange={(e) => setInstanceId(e.target.value)} maxLength={120} />
          <input className={input} placeholder="Published hourly price, USD (optional)" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          <input className={input + " sm:col-span-2"} placeholder="https:// link to the provider's published price (required with a price)" value={source} onChange={(e) => setSource(e.target.value)} maxLength={300} />
          <div className="sm:col-span-2">
            <button type="button" className={btnPrimary} disabled={disabled || busy || !providerId || !label.trim()} onClick={() => void submit()}>{busy ? "Creating…" : "Create pending request"}</button>
          </div>
        </div>
      )}
    </details>
  );
}

function LimitRow({ label, scope, providerId, current, disabled, onDone }: { label: string; scope: "global" | "provider"; providerId?: string; current: { month?: number; hour?: number }; disabled: boolean; onDone: (m: { ok: boolean; text: string }) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-void/40 p-3 text-sm">
      <span className="min-w-[8rem] font-medium text-ink">{label}</span>
      <LimitField label="Monthly cap" period="month" scope={scope} providerId={providerId} current={current.month} disabled={disabled} onDone={onDone} />
      <LimitField label="Hourly cap per resource" period="hour" scope={scope} providerId={providerId} current={current.hour} disabled={disabled} onDone={onDone} />
    </div>
  );
}

function LimitField({ label, period, scope, providerId, current, disabled, onDone }: { label: string; period: "hour" | "month"; scope: "global" | "provider"; providerId?: string; current?: number; disabled: boolean; onDone: (m: { ok: boolean; text: string }) => void }) {
  const [val, setVal] = useState("");
  const parsed = Number(val);
  const valid = val.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  async function save() {
    const r = await call("PUT", "/api/admin/cloud/limits", { scope, ...(providerId ? { provider_id: providerId } : {}), period, limit_usd: parsed, confirm: true });
    if (r.ok) { setVal(""); onDone({ ok: true, text: `${label} set to ${usd(parsed)} (was ${r.data?.old_usd == null ? "0, the default" : usd(Number(r.data.old_usd))}).` }); }
    else onDone({ ok: false, text: errText(r) });
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-faint">{label}: <span className="font-mono text-ink">{current === undefined ? "$0 (default)" : usd(current)}</span></span>
      <input className={input + " w-24"} placeholder="new USD" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} aria-label={`${label} new value`} />
      <Confirm label="Set" confirmLabel={valid ? `Confirm ${usd(parsed)}` : "Confirm"} onConfirm={() => void save()} disabled={disabled || !valid} />
    </div>
  );
}

function ProviderRow({ p, disabled, onDone }: { p: Provider; disabled: boolean; onDone: (m: { ok: boolean; text: string }) => void }) {
  const [ref, setRef] = useState(p.written_permission_ref ?? "");
  async function patch(body: { written_permission_ref?: string | null; conditions_acknowledged: boolean }, text: string) {
    const r = await call("PATCH", `/api/admin/cloud/providers/${p.id}`, { ...body, confirm: true });
    onDone(r.ok ? { ok: true, text } : { ok: false, text: errText(r) });
  }
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{p.name}</span>
        <Badge tone={POLICY_TONE[p.mining_policy as keyof typeof POLICY_TONE] ?? "muted"}>{POLICY_LABEL[p.mining_policy] ?? p.mining_policy}</Badge>
        {p.policy_url ? <a className="text-xs text-electric-hi underline" href={p.policy_url} target="_blank" rel="noreferrer noopener">official terms</a> : <span className="text-xs text-faint">no policy link (unverified)</span>}
        {p.pricing_url && <a className="text-xs text-electric-hi underline" href={p.pricing_url} target="_blank" rel="noreferrer noopener">pricing</a>}
        <span className="text-xs text-faint">{p.last_verified_on ? `verified ${p.last_verified_on}` : "never verified"}</span>
        <Badge>{p.adapter === "manual" ? "manual adapter" : "read-only catalogue"}</Badge>
      </div>
      {p.policy_quote && <blockquote className="mt-1.5 border-l-2 border-line-hi pl-3 text-xs text-muted">{p.policy_quote}</blockquote>}
      {p.notes && <p className="mt-1 text-xs text-faint">{p.notes}</p>}
      {p.mining_policy === "allowed_with_conditions" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {p.conditions_acknowledged_at ? <Badge tone="ok">conditions acknowledged {p.conditions_acknowledged_at.slice(0, 10)}</Badge> : <Badge tone="warn">conditions not acknowledged: blocked</Badge>}
          {p.conditions_acknowledged_at
            ? <Confirm label="Withdraw acknowledgement" confirmLabel="Confirm withdraw" onConfirm={() => void patch({ conditions_acknowledged: false }, "Acknowledgement withdrawn.")} disabled={disabled} />
            : <Confirm label="I read the conditions and will follow them" confirmLabel="Confirm acknowledgement" onConfirm={() => void patch({ conditions_acknowledged: true }, "Conditions acknowledged.")} disabled={disabled} />}
        </div>
      )}
      {p.mining_policy === "requires_written_permission" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {p.written_permission_ref ? <Badge tone="ok">permission on file</Badge> : <Badge tone="warn">no written permission recorded: blocked</Badge>}
          <input className={input + " w-64"} placeholder="Reference to the provider's written permission" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={200} />
          <Confirm label="Save reference" confirmLabel="Confirm save" onConfirm={() => void patch({ written_permission_ref: ref.trim() || null, conditions_acknowledged: false }, ref.trim() ? "Permission reference saved." : "Permission reference cleared.")} disabled={disabled} />
        </div>
      )}
    </li>
  );
}
