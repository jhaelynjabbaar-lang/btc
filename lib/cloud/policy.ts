/**
 * Provider mining policy: what each provider's OWN terms say about cryptocurrency mining, and whether anything may be
 * approved or provisioned there. Pure functions (no I/O) so they are unit-tested and shared by the UI and the server.
 * The same rule is enforced again inside the database (cloud_policy_block / cloud_transition) as defense in depth.
 */

export const MINING_POLICIES = ["allowed", "allowed_with_conditions", "requires_written_permission", "prohibited", "unknown"] as const;
export type MiningPolicy = (typeof MINING_POLICIES)[number];

export const POLICY_LABEL: Record<MiningPolicy, string> = {
  allowed: "Mining allowed",
  allowed_with_conditions: "Allowed with conditions",
  requires_written_permission: "Written permission required",
  prohibited: "Mining prohibited",
  unknown: "Policy unknown",
};

export type PolicyFacts = {
  mining_policy: MiningPolicy;
  /** Owner-recorded reference to the provider's written permission (ticket id, e-mail date, ...). */
  written_permission_ref: string | null;
  /** Set when the owner confirmed they read and will follow the provider's mining conditions. */
  conditions_acknowledged_at: string | null;
};

export type PolicyBlockReason =
  | "policy_prohibited"
  | "policy_unknown"
  | "written_permission_missing"
  | "conditions_not_acknowledged";

export const POLICY_BLOCK_MESSAGE: Record<PolicyBlockReason, string> = {
  policy_prohibited: "This provider's terms prohibit cryptocurrency mining. It is blocked from provisioning.",
  policy_unknown: "This provider's mining policy has not been verified from its official terms. It is blocked until it is.",
  written_permission_missing: "This provider requires express written permission for mining. Record a reference to that permission first.",
  conditions_not_acknowledged: "This provider allows mining only under conditions. Read them and acknowledge them first.",
};

/** `null` when the provider's policy lets a resource be requested/approved/activated, otherwise the reason it is blocked. */
export function miningBlock(p: PolicyFacts): PolicyBlockReason | null {
  switch (p.mining_policy) {
    case "allowed":
      return null;
    case "allowed_with_conditions":
      return p.conditions_acknowledged_at ? null : "conditions_not_acknowledged";
    case "requires_written_permission":
      return p.written_permission_ref?.trim() ? null : "written_permission_missing";
    case "prohibited":
      return "policy_prohibited";
    default:
      // 'unknown' and anything unrecognised fail closed.
      return "policy_unknown";
  }
}

/** Prohibited and unknown providers can never even get a pending request: no row, no approval button. */
export function requestBlocked(p: Pick<PolicyFacts, "mining_policy">): PolicyBlockReason | null {
  if (p.mining_policy === "prohibited") return "policy_prohibited";
  if (!MINING_POLICIES.includes(p.mining_policy) || p.mining_policy === "unknown") return "policy_unknown";
  return null;
}
