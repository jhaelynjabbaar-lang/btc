import { describe, expect, it } from "vitest";
import { KillSwitchBody, ProviderAttestationBody, RequestResourceBody, ResourceActionBody, SpendLimitBody } from "@/lib/cloud/schemas";

const id = "11111111-1111-4111-8111-111111111111";

describe("API schemas", () => {
  it("requires explicit confirmation for every mutating admin action", () => {
    expect(ResourceActionBody.safeParse({ action: "approve" }).success).toBe(false);
    expect(ResourceActionBody.safeParse({ action: "approve", confirm: false }).success).toBe(false);
    expect(ResourceActionBody.safeParse({ action: "approve", confirm: true }).success).toBe(true);
    expect(KillSwitchBody.safeParse({ action: "engage" }).success).toBe(false);
    expect(KillSwitchBody.safeParse({ action: "engage", confirm: true }).success).toBe(true);
    expect(ProviderAttestationBody.safeParse({ conditions_acknowledged: true }).success).toBe(false);
  });
  it("rejects unknown actions and extra keys", () => {
    expect(ResourceActionBody.safeParse({ action: "kill", confirm: true }).success).toBe(false);
    expect(ResourceActionBody.safeParse({ action: "approve", confirm: true, extra: 1 }).success).toBe(false);
  });
  it("spend limits: non-negative, provider scope needs provider_id, global must not have one", () => {
    expect(SpendLimitBody.safeParse({ scope: "global", period: "month", limit_usd: 50, confirm: true }).success).toBe(true);
    expect(SpendLimitBody.safeParse({ scope: "global", period: "month", limit_usd: -1, confirm: true }).success).toBe(false);
    expect(SpendLimitBody.safeParse({ scope: "provider", period: "hour", limit_usd: 1, confirm: true }).success).toBe(false);
    expect(SpendLimitBody.safeParse({ scope: "provider", provider_id: id, period: "hour", limit_usd: 1, confirm: true }).success).toBe(true);
    expect(SpendLimitBody.safeParse({ scope: "global", provider_id: id, period: "hour", limit_usd: 1, confirm: true }).success).toBe(false);
    expect(SpendLimitBody.safeParse({ scope: "global", period: "day", limit_usd: 1, confirm: true }).success).toBe(false);
  });
  it("resource requests: a price needs an https source link", () => {
    const ok = { provider_id: id, label: "box", price: { hourly_usd: 0.4, source_url: "https://example.com/pricing" } };
    expect(RequestResourceBody.safeParse(ok).success).toBe(true);
    expect(RequestResourceBody.safeParse({ provider_id: id, label: "box" }).success).toBe(true); // unknown cost is allowed to be requested
    expect(RequestResourceBody.safeParse({ ...ok, price: { hourly_usd: 0.4 } }).success).toBe(false);
    expect(RequestResourceBody.safeParse({ ...ok, price: { hourly_usd: 0.4, source_url: "http://example.com" } }).success).toBe(false);
    expect(RequestResourceBody.safeParse({ ...ok, price: { hourly_usd: -1, source_url: "https://example.com" } }).success).toBe(false);
    expect(RequestResourceBody.safeParse({ ...ok, provider_id: "nope" }).success).toBe(false);
    expect(RequestResourceBody.safeParse({ ...ok, label: "  " }).success).toBe(false);
  });
});
