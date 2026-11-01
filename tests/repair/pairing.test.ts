import { describe, expect, it } from "vitest";
import { TOKEN_RE, generateDeviceToken, generatePairCode, hashDeviceToken, hashPairCode, normalizePairCode, parseBearer } from "@/lib/repair/pairing";

describe("pairing primitives", () => {
  it("generates RP-XXXXX-XXXXX codes that normalize back to themselves", () => {
    const c = generatePairCode();
    expect(c).toMatch(/^RP-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(normalizePairCode(c.toLowerCase().replace(/-/g, " "))).toBe(normalizePairCode(c));
  });
  it("rejects malformed codes", () => {
    for (const bad of ["", "RP-12", "XX-AAAAA-AAAAA", 5, null, "RP-AAAAA-AAAAA-AAAAA"]) expect(normalizePairCode(bad)).toBeNull();
  });
  it("codes are unique and hashed one way", () => {
    const set = new Set(Array.from({ length: 200 }, generatePairCode));
    expect(set.size).toBe(200);
    const h = hashPairCode(normalizePairCode(generatePairCode())!);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("tokens have the right shape, hash differently from the token, and parse from a bearer header", () => {
    const t = generateDeviceToken();
    expect(t).toMatch(TOKEN_RE);
    expect(hashDeviceToken(t)).not.toContain(t);
    expect(parseBearer(`Bearer ${t}`)).toBe(t);
    expect(parseBearer("Bearer nope")).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(`Basic ${t}`)).toBeNull();
  });
});
