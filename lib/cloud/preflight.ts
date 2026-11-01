import { SPEND_MESSAGE, evaluateSpend, type CommittedResource, type LimitRow } from "./guard";
import { POLICY_BLOCK_MESSAGE, miningBlock, type PolicyFacts } from "./policy";
import { adapterMayAct, isActivating, nextState, type ResourceEvent, type ResourceState } from "./state";

/**
 * Everything that must be true before a resource event is sent to the database (which re-checks it all in cloud_transition).
 * Pure, so the approval workflow, the policy block and the spend guard are unit-tested together.
 */

export type PreflightInput = {
  event: ResourceEvent;
  resource: { state: ResourceState; authorization: "pending" | "authorized" | "denied" | "revoked"; id: string; provider_id: string; hourly_price_usd: number; cost_known: boolean };
  provider: PolicyFacts;
  killSwitchEngaged: boolean;
  limits: LimitRow[];
  committed: CommittedResource[];
};

export type PreflightResult =
  | { ok: true; to: ResourceState }
  | { ok: false; status: number; error: string; message: string; detail?: Record<string, unknown> };

export function preflight(i: PreflightInput): PreflightResult {
  const to = nextState(i.resource.state, i.event);
  if (to === null)
    return { ok: false, status: 409, error: "invalid_transition", message: `'${i.event}' is not allowed from state '${i.resource.state}'.` };
  if (!isActivating(i.event, i.resource.state)) return { ok: true, to };

  if (i.killSwitchEngaged)
    return { ok: false, status: 423, error: "kill_switch_engaged", message: "The kill switch is engaged. Re-arm it before approving, activating or starting anything." };
  const block = miningBlock(i.provider);
  if (block) return { ok: false, status: 403, error: block, message: POLICY_BLOCK_MESSAGE[block] };
  // An adapter may only act on something that was explicitly approved (approval is the first activating event itself).
  if (i.event !== "approve" && !adapterMayAct(i.resource.state, i.resource.authorization))
    return { ok: false, status: 409, error: "not_approved", message: "This resource has no active approval (it was never approved, or approval was revoked). Request and approve it again." };
  const spend = evaluateSpend(i.limits, i.committed, {
    id: i.resource.id,
    provider_id: i.resource.provider_id,
    hourly_price_usd: i.resource.hourly_price_usd,
    cost_known: i.resource.cost_known,
  });
  if (!spend.ok)
    return { ok: false, status: 403, error: spend.reason, message: SPEND_MESSAGE[spend.reason], detail: { capUsd: spend.capUsd, committedUsd: spend.committedUsd, requestedUsd: spend.requestedUsd } };
  return { ok: true, to };
}
