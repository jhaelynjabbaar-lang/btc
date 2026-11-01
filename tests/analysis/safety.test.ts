import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactDeep, redactString } from "@/lib/analysis/redact";

const root = join(__dirname, "../..");
const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const analysisFiles = [...files("lib/analysis"), ...files("app/api/admin/ai"), ...files("app/api/cron/ai-analysis"), "components/ai-console.tsx", "app/ai/page.tsx"];

describe("Phase 7 safety", () => {
  it("uses no other AI provider and no browser-exposed env var", () => {
    for (const f of analysisFiles) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/xai|grok|anthropic|claude|api\.openai\.com/i);
      expect(src, f).not.toMatch(/NEXT_PUBLIC_/);
    }
  });

  it("the client component never imports server modules or reads env", () => {
    const src = readFileSync(join(root, "components/ai-console.tsx"), "utf8");
    expect(src).not.toMatch(/@\/lib\/(analysis|ai|supabase)/);
    expect(src).not.toMatch(/process\.env/);
  });

  it("the AI code path has no write access to money, limits, resources or providers", () => {
    for (const f of analysisFiles.filter((x) => x.endsWith(".ts") || x.endsWith(".tsx"))) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/from\("(cloud_resources|spend_limits|ledger|cloud_providers|cloud_controls|workers|worker_commands)"\)\s*\.(insert|update|upsert|delete)/);
      expect(src, f).not.toMatch(/cloud_(transition|request_resource|set_spend_limit|set_kill_switch)|move_money|send_money/);
    }
  });

  it("does not mangle long snake_case signal and metric names", () => {
    for (const name of ["committed_resources_but_provider_monthly_cap_is_0", "projected_monthly_committed_usd_known_prices_only", "recorded_cloud_expenses_last_30d_usd"]) expect(redactString(name)).toBe(name);
  });

  it("redacts credential-shaped strings", () => {
    const k = "sk-or-v1-" + "a".repeat(40);
    expect(redactString(`key ${k} and sb_secret_abcDEF123456`)).toBe("key [redacted] and [redacted]");
    expect(redactString("tok " + "Ab3".repeat(15))).toBe("tok [redacted]");
    expect(redactString("postgres://user:pw@host/db")).toBe("[redacted]");
    expect(redactDeep({ api_key: "x", authorization: "Bearer abc", fine: "hashrate", n: 1, nested: { password: "p", ok: [1, "a"] } })).toEqual({ fine: "hashrate", n: 1, nested: { ok: [1, "a"] } });
  });
});
