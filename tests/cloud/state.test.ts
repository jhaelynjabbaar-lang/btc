import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESOURCE_EVENTS, RESOURCE_STATES, TRANSITIONS, adapterMayAct, isActivating, nextState, transitionAllowed } from "@/lib/cloud/state";

describe("approval state machine", () => {
  it("starts at pending_approval and only approve/reject leave it", () => {
    expect(nextState("pending_approval", "approve")).toBe("approved");
    expect(nextState("pending_approval", "reject")).toBe("rejected");
    for (const e of ["activate", "confirm_running", "start", "stop", "destroy"] as const) expect(nextState("pending_approval", e)).toBeNull();
  });
  it("cannot reach provisioning or running without passing through approved", () => {
    expect(transitionAllowed("pending_approval", "provisioning")).toBe(false);
    expect(transitionAllowed("pending_approval", "running")).toBe(false);
    expect(nextState("approved", "activate")).toBe("provisioning");
    expect(nextState("provisioning", "confirm_running")).toBe("running");
  });
  it("rejected and destroyed are terminal", () => {
    for (const t of ["rejected", "destroyed"] as const) for (const e of RESOURCE_EVENTS) expect(nextState(t, e)).toBeNull();
  });
  it("supports stop/start/destroy on active resources", () => {
    expect(nextState("running", "stop")).toBe("stopped");
    expect(nextState("stopped", "start")).toBe("running");
    expect(nextState("stopped", "destroy")).toBe("destroyed");
    expect(nextState("approved", "destroy")).toBe("destroyed");
  });
  it("kill maps each state to a legal, safe destination", () => {
    expect(nextState("pending_approval", "kill")).toBe("rejected");
    expect(nextState("approved", "kill")).toBe("destroyed");
    expect(nextState("provisioning", "kill")).toBe("stopped");
    expect(nextState("running", "kill")).toBe("stopped");
    expect(nextState("stopped", "kill")).toBeNull(); // already stopped: nothing to do
  });
  it("only entering an active state counts as 'activating' (needs policy + spend + kill-switch checks)", () => {
    expect(isActivating("approve", "pending_approval")).toBe(true);
    expect(isActivating("activate", "approved")).toBe(true);
    expect(isActivating("start", "stopped")).toBe(true);
    expect(isActivating("stop", "running")).toBe(false);
    expect(isActivating("reject", "pending_approval")).toBe(false);
    expect(isActivating("destroy", "running")).toBe(false);
  });
  it("an adapter may act only on an explicitly approved resource", () => {
    expect(adapterMayAct("pending_approval", "pending")).toBe(false);
    expect(adapterMayAct("pending_approval", "authorized")).toBe(false);
    expect(adapterMayAct("rejected", "denied")).toBe(false);
    expect(adapterMayAct("approved", "authorized")).toBe(true);
    expect(adapterMayAct("running", "authorized")).toBe(true);
    expect(adapterMayAct("stopped", "revoked")).toBe(false);
    expect(adapterMayAct("running", "revoked")).toBe(false);
  });
  it("matches the SQL cloud_transition_allowed table in the migration exactly", () => {
    const sql = readFileSync("supabase/migrations/20261101140001_cloud_module.sql", "utf8");
    const body = sql.slice(sql.indexOf("function public.cloud_transition_allowed"));
    const block = body.slice(0, body.indexOf("$$;", body.indexOf("as $$")));
    const pairs = [...block.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    expect(pairs).toEqual(TRANSITIONS.map(([f, t]) => `${f}>${t}`).sort());
    for (const s of RESOURCE_STATES) expect(sql).toContain(`'${s}'`);
  });
});
