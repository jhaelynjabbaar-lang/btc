/**
 * Spend guard. Pure and deterministic; the database enforces the same rule in public.cloud_spend_check.
 *
 * Rules:
 *  - Every cap defaults to 0. A missing or disabled limit row means 0, so nothing can be approved until the owner sets limits.
 *  - A resource whose hourly price is UNKNOWN can never pass (no cap can be checked against an unknown cost).
 *  - Per-resource hourly cap: the smallest enabled 'hour' limit that applies (global, or that provider's) must be >= the hourly price.
 *  - Monthly caps: committed + requested, projected as hourly price x 730 h, over resources that are approved, provisioning or
 *    running, must stay within BOTH the global monthly cap and the provider's monthly cap.
 *  This is a projection from declared prices, not metered billing: the provider's invoice is the source of truth.
 */

export const HOURS_PER_MONTH = 730;
const MICRO = 10_000; // work in 1e-4 USD integers to avoid float drift

export type LimitRow = { scope: "global" | "provider"; provider_id: string | null; period: "hour" | "day" | "month"; limit_usd: number; enabled: boolean };
export type CommittedResource = { id: string; provider_id: string; hourly_price_usd: number };
export type SpendCandidate = { id?: string; provider_id: string; hourly_price_usd: number; cost_known: boolean };

export type SpendDecision =
  | { ok: true }
  | {
      ok: false;
      reason: "cost_unknown" | "hourly_cap_exceeded" | "global_monthly_cap_exceeded" | "provider_monthly_cap_exceeded";
      capUsd?: number;
      committedUsd?: number;
      requestedUsd?: number;
    };

const micro = (usd: number) => Math.round(usd * MICRO);
const usd = (m: number) => m / MICRO;

export function evaluateSpend(limits: LimitRow[], committed: CommittedResource[], c: SpendCandidate): SpendDecision {
  if (!c.cost_known) return { ok: false, reason: "cost_unknown" };
  const live = limits.filter((l) => l.enabled);
  const hourly = micro(c.hourly_price_usd);

  const hourCaps = live.filter((l) => l.period === "hour" && (l.scope === "global" || l.provider_id === c.provider_id)).map((l) => micro(l.limit_usd));
  const capHour = hourCaps.length ? Math.min(...hourCaps) : 0;
  if (hourly > capHour) return { ok: false, reason: "hourly_cap_exceeded", capUsd: usd(capHour), requestedUsd: c.hourly_price_usd };

  const others = committed.filter((r) => r.id !== c.id);
  const monthlyOf = (h: number) => h * HOURS_PER_MONTH;
  const maxOf = (rows: LimitRow[]) => (rows.length ? Math.max(...rows.map((l) => micro(l.limit_usd))) : 0);
  const capGlobal = maxOf(live.filter((l) => l.period === "month" && l.scope === "global"));
  const capProvider = maxOf(live.filter((l) => l.period === "month" && l.scope === "provider" && l.provider_id === c.provider_id));
  const usedGlobal = others.reduce((s, r) => s + monthlyOf(micro(r.hourly_price_usd)), 0);
  const usedProvider = others.filter((r) => r.provider_id === c.provider_id).reduce((s, r) => s + monthlyOf(micro(r.hourly_price_usd)), 0);
  const requested = monthlyOf(hourly);

  if (usedGlobal + requested > capGlobal)
    return { ok: false, reason: "global_monthly_cap_exceeded", capUsd: usd(capGlobal), committedUsd: usd(usedGlobal), requestedUsd: usd(requested) };
  if (usedProvider + requested > capProvider)
    return { ok: false, reason: "provider_monthly_cap_exceeded", capUsd: usd(capProvider), committedUsd: usd(usedProvider), requestedUsd: usd(requested) };
  return { ok: true };
}

export const SPEND_MESSAGE: Record<Exclude<SpendDecision, { ok: true }>["reason"], string> = {
  cost_unknown: "The hourly price is unknown, so no spend cap can be checked. Cite the provider's published price to proceed.",
  hourly_cap_exceeded: "The hourly price is above the per-resource hourly cap (default 0).",
  global_monthly_cap_exceeded: "This would push committed spend above the global monthly cap (default 0).",
  provider_monthly_cap_exceeded: "This would push committed spend above this provider's monthly cap (default 0).",
};
