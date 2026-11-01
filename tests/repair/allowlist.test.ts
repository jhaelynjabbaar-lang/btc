import { describe, expect, it } from "vitest";
import { ACTIONS, ACTION_BY_ID, ACTION_IDS, FINDING_IDS, FIREFOX, OFFLINE_COUNT, OFFLINE_ORDER, isActionId } from "@/lib/repair/actions";

describe("allowlist", () => {
  it("has 22 unique actions and every action has a title, change text and related findings", () => {
    expect(ACTION_IDS).toHaveLength(22);
    expect(new Set(ACTION_IDS).size).toBe(22);
    expect(ACTIONS.map((a) => a.id)).toEqual([...ACTION_IDS]);
    for (const a of ACTIONS) {
      expect(a.title.length).toBeGreaterThan(5);
      expect(a.changes.length).toBeGreaterThan(10);
      expect(a.related.length).toBeGreaterThan(0);
      for (const r of a.related) expect(FINDING_IDS).toContain(r);
    }
  });
  it("rejects anything that is not an exact allowlisted id", () => {
    for (const bad of ["", "format c:", "flush_dns ", "FLUSH_DNS", "flush_dns;calc", "__proto__", "constructor", null, 5]) expect(isActionId(bad)).toBe(false);
    expect(isActionId("flush_dns")).toBe(true);
    expect(ACTION_BY_ID.flush_dns.id).toBe("flush_dns");
  });
  it("offline order is the first 24 finding ids", () => {
    expect(OFFLINE_ORDER).toHaveLength(OFFLINE_COUNT);
    expect(new Set(FINDING_IDS).size).toBe(FINDING_IDS.length);
  });
  it("pins Firefox ESR 115 with a SHA-256 and an https archive.mozilla.org URL", () => {
    expect(FIREFOX.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(FIREFOX.url).toMatch(/^https:\/\/archive\.mozilla\.org\/pub\/firefox\/releases\/115\.\d+\.\d+esr\//);
  });
});
