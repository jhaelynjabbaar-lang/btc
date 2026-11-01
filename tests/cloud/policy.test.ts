import { describe, expect, it } from "vitest";
import { MINING_POLICIES, miningBlock, requestBlocked, type MiningPolicy } from "@/lib/cloud/policy";

const facts = (mining_policy: MiningPolicy, ref: string | null = null, ack: string | null = null) => ({
  mining_policy,
  written_permission_ref: ref,
  conditions_acknowledged_at: ack,
});

describe("policy block", () => {
  it("allows only providers whose terms allow mining", () => {
    expect(miningBlock(facts("allowed"))).toBeNull();
  });
  it("blocks 'prohibited' always, even if someone recorded a permission or an acknowledgement", () => {
    expect(miningBlock(facts("prohibited"))).toBe("policy_prohibited");
    expect(miningBlock(facts("prohibited", "ticket-1", "2026-11-01"))).toBe("policy_prohibited");
  });
  it("blocks 'unknown' always (fail closed)", () => {
    expect(miningBlock(facts("unknown"))).toBe("policy_unknown");
    expect(miningBlock(facts("unknown", "ticket-1", "2026-11-01"))).toBe("policy_unknown");
    expect(miningBlock(facts("made_up" as MiningPolicy))).toBe("policy_unknown");
  });
  it("needs a recorded reference for 'requires_written_permission' (blank does not count)", () => {
    expect(miningBlock(facts("requires_written_permission"))).toBe("written_permission_missing");
    expect(miningBlock(facts("requires_written_permission", "   "))).toBe("written_permission_missing");
    expect(miningBlock(facts("requires_written_permission", "email 2026-11-02"))).toBeNull();
  });
  it("needs an acknowledgement for 'allowed_with_conditions'", () => {
    expect(miningBlock(facts("allowed_with_conditions"))).toBe("conditions_not_acknowledged");
    expect(miningBlock(facts("allowed_with_conditions", null, "2026-11-01T00:00:00Z"))).toBeNull();
  });
  it("does not even create a pending request for prohibited or unknown providers", () => {
    expect(requestBlocked({ mining_policy: "prohibited" })).toBe("policy_prohibited");
    expect(requestBlocked({ mining_policy: "unknown" })).toBe("policy_unknown");
    for (const p of MINING_POLICIES.filter((x) => x !== "prohibited" && x !== "unknown")) expect(requestBlocked({ mining_policy: p })).toBeNull();
  });
});
