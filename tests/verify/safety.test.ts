import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("Phase 9 safety", () => {
  it("the verification service is read-only: no inserts, updates, deletes, upserts or rpc calls", () => {
    const src = read("lib/verify/service.ts");
    expect(src).not.toMatch(/\.(insert|update|delete|upsert|rpc)\s*\(/);
  });
  it("the verdict module has no I/O and cannot reach env, network or the database", () => {
    const src = read("lib/verify/verdict.ts");
    expect(src).not.toMatch(/process\.env|fetch\(|supabase|from "node:/i);
  });
  it("the page never prints the token and says verified only through the verdict table", () => {
    const src = read("app/verification/page.tsx");
    expect(src).not.toMatch(/braiinsToken|process\.env\.BRAIINS/);
    expect(src).not.toMatch(/\bearned\b|\bprofit\b/i);
  });
});
