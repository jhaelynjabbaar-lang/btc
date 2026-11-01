import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext, renderContext } from "@/lib/analysis/context";
import { JOB_TYPES } from "@/lib/analysis/config";
import { ANALYSIS_SYSTEM_PROMPT } from "@/lib/analysis/prompt";
import { verifyItem } from "@/lib/analysis/schema";
import { buildProfitSummary } from "@/lib/profit/summary";
import { computeFinancials, confirmedFromLedger } from "@/lib/profit/math";
import { EMPTY, FULL, NOW, W1 } from "../analysis/fixtures";

const root = join(__dirname, "../..");
const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const profitFiles = [...files("lib/profit"), ...files("app/api/admin/financials"), "app/financials/page.tsx", "components/financials-console.tsx"];

describe("Phase 8 safety", () => {
  it("uses no other AI provider, no browser-exposed env var, and the token is read in exactly one place", () => {
    for (const f of profitFiles) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/xai|grok|anthropic|claude|api\.openai\.com/i);
      expect(src, f).not.toMatch(/NEXT_PUBLIC_/);
      expect(src, f).not.toMatch(/console\.(log|info|warn|error|debug)/); // nothing (and so no token) is ever logged
      expect(src, f).not.toMatch(/sb_secret_|sk-or-v1-|Bearer\s+[A-Za-z0-9]{12,}/);
      if (!f.endsWith("braiins.ts")) expect(src, f).not.toMatch(/process\.env/);
    }
  });

  it("the client component never imports server modules or reads env", () => {
    const src = readFileSync(join(root, "components/financials-console.tsx"), "utf8");
    expect(src).not.toMatch(/@\/lib\/(profit|supabase|analysis|ai|cloud)/);
    expect(src).not.toMatch(/process\.env/);
  });

  it("every financials API route is behind the admin gate and same-origin check for writes", () => {
    for (const f of files("app/api/admin/financials").filter((x) => x.endsWith("route.ts"))) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).toMatch(/adminGate\(request, true\)/);
    }
  });

  it("the page is admin-only (requirePageAccess) and the nav links to it", () => {
    expect(readFileSync(join(root, "app/financials/page.tsx"), "utf8")).toMatch(/requirePageAccess\("\/financials"\)/);
    expect(readFileSync(join(root, "lib/nav.ts"), "utf8")).toMatch(/href: "\/financials"/);
  });

  it("the profitability code never writes to cloud tables, workers or ledger rows other than imported confirmed payouts", () => {
    const src = readFileSync(join(root, "lib/profit/service.ts"), "utf8");
    expect(src).not.toMatch(/from\("(cloud_resources|spend_limits|cloud_providers|cloud_controls|workers|worker_commands)"\)\s*\.(insert|update|upsert|delete)/);
    expect(src).not.toMatch(/from\("ledger"\)\s*\.(update|upsert|delete)/);
    expect(src).not.toMatch(/kind: "estimated_reward"/); // estimates are never written to the money ledger
  });

  it("migration is additive only", () => {
    const sql = readFileSync(join(root, "supabase/migrations/20261101200001_profitability.sql"), "utf8").replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bdrop\s+(table|column|constraint|index|function|trigger)\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.(?!network_snapshots|profit_settings)/i);
    expect(sql).not.toMatch(/\b(truncate|delete\s+from|update\s+public\.)/i);
    expect(sql).not.toMatch(/\binsert\s+into\s+public\.(?!audit_log|profit_settings)/i);
    expect(sql).toMatch(/enable row level security/i);
    expect((sql.match(/create table/gi) ?? []).length).toBe(2);
  });
});

describe("AI layer gets a read-only, labelled summary (existing constraints kept)", () => {
  const fin = computeFinancials({
    workers: [{ id: W1, name: "test-rig-1", hardware_type: "cpu", status: "online" }],
    hashrates: new Map([[W1, { avgHs: 1e12, buckets: 1440, lastBucket: null }]]),
    network: { networkHashrateHs: 1e21, subsidySats: 312_500_000, avgFeeSats: 12_500_000, btcPriceUsd: 100_000 },
    settings: { electricityUsdPerKwh: null, defaultWattsPerWorker: null, workerWatts: {}, poolFeePctOverride: null },
    cloudResources: [],
    poolFeePct: 2.5,
  });
  const confirmed = confirmedFromLedger([{ id: "1", kind: "confirmed_payout", source: "pool", ref: "tx", amount_sats: 5000, occurred_at: "2026-10-31T00:00:00Z", note: null }]);
  const summary = buildProfitSummary({ financials: fin, confirmed, network: "fresh", poolConnected: false });

  it("keeps estimate and confirmed in separate labelled objects and never adds them", () => {
    expect(summary.estimate.label).toBe("Estimate");
    expect(summary.confirmed.label).toBe("Confirmed");
    expect(summary.confirmed.total_sats).toBe(5000);
    expect(summary.estimate.fleet_net_btc_per_day).toBeCloseTo(45.63e-8, 15);
    expect(summary.estimate.costs_known).toBe(false);
    expect(summary.estimate.fleet_net_usd_per_day_after_costs).toBeNull();
    expect(summary.pool_api).toBe("not_connected");
    expect(Object.keys(summary)).not.toContain("total");
    expect(JSON.stringify(summary)).not.toMatch(/profit_total|combined|grand_total/);
  });

  it("is added to the model input only when present, and does not change the job sections", () => {
    const without = buildContext(FULL, JOB_TYPES, NOW);
    const withP = buildContext({ ...FULL, profitability: summary }, JOB_TYPES, NOW);
    expect(JSON.parse(renderContext(without)).profitability).toBeUndefined();
    expect(JSON.parse(renderContext(withP)).profitability.estimate.label).toBe("Estimate");
    expect(withP.sections).toEqual(without.sections);
    expect(buildContext({ ...EMPTY, profitability: null }, JOB_TYPES, NOW).profitability).toBeUndefined();
    expect(renderContext(withP).length).toBeLessThan(9000);
  });

  it("the prompt forbids citing or copying it, mixing estimate with confirmed, or implying profit", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/"profitability"/);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/never cite it as evidence and never write any of its numbers/);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/Never add an estimate to a confirmed amount/);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/never state or imply that the fleet is or will be profitable/);
  });

  it("a recommendation that quotes a profitability number is discarded by the existing number check", () => {
    const ctx = buildContext({ ...FULL, profitability: summary }, JOB_TYPES, NOW);
    const health = ctx.sections.worker_health!;
    const w1 = health.entities.find((e) => e.stable_id === W1)!;
    const status = health.facts.find((f) => f.ref === w1.ref && f.metric === "status")!;
    const r = verifyItem(
      { type: "worker_health", severity: "info", title: "test-rig-1 earns 5000 sats", rationale: "test-rig-1 is expected to earn 4.563e-7 BTC per day.", evidence_fact_ids: [status.id], suggested_action: { kind: "none" } },
      ctx,
    );
    expect(r.ok).toBe(false);
  });
});
