import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, forwardHeaders, returnHeaders, route } from "../../cloudflare/repair-relay/src/relay";

const UP = "https://app.example.vercel.app";
const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("repair relay allowlist", () => {
  it("forwards only the fixed method+path pairs", () => {
    expect(route("GET", "/r", UP, null)).toEqual({ ok: true, url: `${UP}/r` });
    expect(route("GET", "/api/repair/ping", UP, null).ok).toBe(true);
    expect(route("GET", "/api/repair/suggestions", UP, null).ok).toBe(true);
    expect(route("POST", "/api/repair/pair", UP, 10).ok).toBe(true);
    expect(route("POST", "/api/repair/report", UP, 10).ok).toBe(true);
    expect(route("POST", `/api/repair/suggestions/${uuid}/ack`, UP, 10).ok).toBe(true);
  });
  it("blocks admin routes, everything else, path tricks and wrong methods", () => {
    for (const p of ["/", "/api/admin/repair/paste", "/api/repair", "/api/repair/pair/", "/api/repair/../admin", "/R", "/api/repair/suggestions/x/ack", "/api/auth/session", "//evil.example"]) expect(route("GET", p, UP, null), p).toMatchObject({ ok: false, status: 404 });
    expect(route("PUT", "/r", UP, null)).toMatchObject({ ok: false, status: 405 });
    expect(route("GET", "/api/repair/pair", UP, null)).toMatchObject({ ok: false, status: 405 });
    expect(route("DELETE", "/api/repair/report", UP, 1)).toMatchObject({ ok: false, status: 405 });
  });
  it("limits POST bodies and refuses a non-https upstream", () => {
    expect(route("POST", "/api/repair/report", UP, MAX_BODY_BYTES + 1)).toMatchObject({ ok: false, status: 413 });
    expect(route("POST", "/api/repair/report", UP, null)).toMatchObject({ ok: false, status: 413 });
    expect(route("GET", "/r", "http://insecure.example", null)).toMatchObject({ ok: false, status: 500 });
    expect(route("GET", "/r", "not a url", null)).toMatchObject({ ok: false, status: 500 });
  });
  it("forwards only needed request headers and returns only safe response headers", () => {
    const h = forwardHeaders(new Headers({ authorization: "Bearer t", cookie: "a=b", "x-forwarded-for": "1.1.1.1", "content-type": "application/json", host: "x" }));
    expect([...h.keys()].sort()).toEqual(["authorization", "content-type"]);
    const r = returnHeaders(new Headers({ "set-cookie": "a=b", "content-type": "text/plain", "x-content-sha256": "ab", server: "x" }));
    expect(r.get("set-cookie")).toBeNull();
    expect(r.get("cache-control")).toBe("no-store");
    expect(r.get("x-content-sha256")).toBe("ab");
  });
});
