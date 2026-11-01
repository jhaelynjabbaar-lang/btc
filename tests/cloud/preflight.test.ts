import { describe, expect, it } from "vitest";
import { preflight, type PreflightInput } from "@/lib/cloud/preflight";
import type { LimitRow } from "@/lib/cloud/guard";

const P = "00000000-0000-4000-8000-000000000001";
const limits: LimitRow[] = [
  { scope: "global", provider_id: null, period: "hour", limit_usd: 1, enabled: true },
  { scope: "global", provider_id: null, period: "month", limit_usd: 1000, enabled: true },
  { scope: "provider", provider_id: P, period: "month", limit_usd: 1000, enabled: true },
];
const base = (over: Partial<PreflightInput> = {}): PreflightInput => ({
  event: "approve",
  resource: { id: "r1", state: "pending_approval", authorization: "pending", provider_id: P, hourly_price_usd: 0.5, cost_known: true },
  provider: { mining_policy: "allowed", written_permission_ref: null, conditions_acknowledged_at: null },
  killSwitchEngaged: false,
  limits,
  committed: [],
  ...over,
});

describe("approval workflow preflight", () => {
  it("approves a cheap resource of an allowed provider within caps", () => {
    expect(preflight(base())).toEqual({ ok: true, to: "approved" });
  });
  it("rejects approval with default (empty) spend limits", () => {
    expect(preflight(base({ limits: [] }))).toMatchObject({ ok: false, status: 403, error: "hourly_cap_exceeded" });
  });
  it("rejects approval when the cost is unknown", () => {
    const r = base();
    r.resource.cost_known = false;
    expect(preflight(r)).toMatchObject({ ok: false, error: "cost_unknown" });
  });
  it("blocks prohibited / unknown providers", () => {
    expect(preflight(base({ provider: { mining_policy: "prohibited", written_permission_ref: "x", conditions_acknowledged_at: "x" } }))).toMatchObject({ ok: false, status: 403, error: "policy_prohibited" });
    expect(preflight(base({ provider: { mining_policy: "unknown", written_permission_ref: null, conditions_acknowledged_at: null } }))).toMatchObject({ ok: false, error: "policy_unknown" });
  });
  it("blocks while the kill switch is engaged (423), but still lets you reject or stop", () => {
    expect(preflight(base({ killSwitchEngaged: true }))).toMatchObject({ ok: false, status: 423, error: "kill_switch_engaged" });
    expect(preflight(base({ killSwitchEngaged: true, event: "reject" }))).toEqual({ ok: true, to: "rejected" });
    const running = base({ killSwitchEngaged: true, event: "stop" });
    running.resource.state = "running";
    running.resource.authorization = "authorized";
    expect(preflight(running)).toEqual({ ok: true, to: "stopped" });
  });
  it("an adapter cannot be activated for a resource that was never approved", () => {
    const r = base({ event: "activate" });
    r.resource.state = "pending_approval";
    expect(preflight(r)).toMatchObject({ ok: false, status: 409, error: "invalid_transition" });
    const revoked = base({ event: "activate" });
    revoked.resource.state = "approved";
    revoked.resource.authorization = "revoked";
    expect(preflight(revoked)).toMatchObject({ ok: false, error: "not_approved" });
  });
  it("walks the whole happy path approved → provisioning → running → stopped → running → destroyed", () => {
    const r = base({ event: "activate" });
    r.resource.state = "approved";
    r.resource.authorization = "authorized";
    expect(preflight(r)).toEqual({ ok: true, to: "provisioning" });
    r.event = "confirm_running"; r.resource.state = "provisioning";
    expect(preflight(r)).toEqual({ ok: true, to: "running" });
    r.event = "stop"; r.resource.state = "running";
    expect(preflight(r)).toEqual({ ok: true, to: "stopped" });
    r.event = "start"; r.resource.state = "stopped";
    expect(preflight(r)).toEqual({ ok: true, to: "running" });
    r.event = "destroy";
    r.resource.state = "running";
    expect(preflight(r)).toEqual({ ok: true, to: "destroyed" });
  });
  it("re-checks the policy and spend caps at activation (caps lowered after approval)", () => {
    const r = base({ event: "activate", limits: [] });
    r.resource.state = "approved";
    r.resource.authorization = "authorized";
    expect(preflight(r)).toMatchObject({ ok: false, error: "hourly_cap_exceeded" });
  });
});
