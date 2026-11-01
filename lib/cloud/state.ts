/**
 * Approval state machine for cloud_resources.state. Pure; mirrored by public.cloud_transition_allowed in the database
 * (a test compares the two tables). New resources are ALWAYS 'pending_approval'; only an explicit admin 'approve' moves
 * them forward, and a provider adapter may only act from 'approved' onward.
 */

export const RESOURCE_STATES = ["pending_approval", "approved", "rejected", "provisioning", "running", "stopped", "destroyed"] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

export const RESOURCE_EVENTS = ["approve", "reject", "activate", "confirm_running", "start", "stop", "destroy", "kill"] as const;
export type ResourceEvent = (typeof RESOURCE_EVENTS)[number];

/** Allowed (from -> to) pairs. rejected and destroyed are terminal. */
export const TRANSITIONS: ReadonlyArray<readonly [ResourceState, ResourceState]> = [
  ["pending_approval", "approved"],
  ["pending_approval", "rejected"],
  ["approved", "provisioning"],
  ["approved", "destroyed"],
  ["provisioning", "running"],
  ["provisioning", "stopped"],
  ["provisioning", "destroyed"],
  ["running", "stopped"],
  ["running", "destroyed"],
  ["stopped", "running"],
  ["stopped", "destroyed"],
];

export function transitionAllowed(from: ResourceState, to: ResourceState): boolean {
  return TRANSITIONS.some(([f, t]) => f === from && t === to);
}

const EVENT_TARGET: Record<Exclude<ResourceEvent, "kill">, ResourceState> = {
  approve: "approved",
  reject: "rejected",
  activate: "provisioning",
  confirm_running: "running",
  start: "running",
  stop: "stopped",
  destroy: "destroyed",
};

/** Where an event leads from a given state, or null when that event is not allowed there. */
export function nextState(from: ResourceState, event: ResourceEvent): ResourceState | null {
  const to: ResourceState =
    event === "kill"
      ? from === "pending_approval"
        ? "rejected"
        : from === "approved"
          ? "destroyed"
          : "stopped"
      : EVENT_TARGET[event];
  return transitionAllowed(from, to) ? to : null;
}

/** States in which money may be committed or spent; the spend guard counts these. */
export const COMMITTED_STATES: readonly ResourceState[] = ["approved", "provisioning", "running"];
/** States the kill switch acts on. */
export const KILLABLE_STATES: readonly ResourceState[] = ["pending_approval", "approved", "provisioning", "running"];

/** An adapter (provision/start/stop/destroy/status) may only act on a resource that was explicitly approved. */
export function adapterMayAct(state: ResourceState, authorization: "pending" | "authorized" | "denied" | "revoked"): boolean {
  return authorization === "authorized" && (state === "approved" || state === "provisioning" || state === "running" || state === "stopped");
}

/** Events that need a fresh pass through policy + kill switch + spend guard (they enter or re-enter an active state). */
export function isActivating(event: ResourceEvent, from: ResourceState): boolean {
  const to = nextState(from, event);
  return to === "approved" || to === "provisioning" || to === "running";
}
