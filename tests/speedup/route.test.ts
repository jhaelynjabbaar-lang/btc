import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/s/route";
import { normalizeScript } from "@/lib/speedup/script";

const file = readFileSync(path.join(process.cwd(), "agent/win7-speedup/speedup.bat"), "utf8");

describe("GET /s", () => {
  it("serves the speed-up script as a no-store attachment", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="speedup.bat"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toBe(normalizeScript(file).text);
    expect(body.startsWith("@echo off\r\n")).toBe(true);
    expect(body).toContain("#PS" + "START");
    expect(res.headers.get("x-content-sha256")).toBe(normalizeScript(file).sha256);
  });
  it("does not serve the repair helper", async () => {
    const body = await GET().text();
    expect(body).toContain("Win7 Speed-Up");
    expect(body).not.toContain("RepairHelper");
  });
});

describe("normalizeScript", () => {
  it("converts to CRLF without doubling and hashes the served bytes", () => {
    const a = normalizeScript("a\nb\r\nc");
    expect(a.text).toBe("a\r\nb\r\nc");
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizeScript("a\r\nb\r\nc").sha256).toBe(a.sha256);
  });
});
