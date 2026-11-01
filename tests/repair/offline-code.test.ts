import { describe, expect, it } from "vitest";
import { OFFLINE_ORDER, type FindingId, type FindingStatus } from "@/lib/repair/actions";
import { decodeOfflineCode, encodeOfflineCode } from "@/lib/repair/offline-code";

// The same vectors are produced by the PowerShell OfflineCode function in agent/win7-repair/repair.bat
// (verified with PowerShell 7 while developing; see docs/win7-repair.md).
describe("offline code", () => {
  it("all ok", () => {
    const all = Object.fromEntries(OFFLINE_ORDER.map((i) => [i, "ok"])) as Record<FindingId, FindingStatus>;
    expect(encodeOfflineCode(all)).toBe("W7-5555-5555-5555-6");
  });
  it("mixed vector", () => {
    expect(encodeOfflineCode({ "os.version": "ok", "os.sp1": "fail", "hw.ram": "warn", "hw.disk": "unknown" })).toBe("W7-7800-0000-0000-7");
  });
  it("round trips and tolerates typing noise", () => {
    const code = encodeOfflineCode({ "os.version": "ok", "os.sp1": "fail", "hw.ram": "warn" });
    const d = decodeOfflineCode(code.toLowerCase().replace(/-/g, " "));
    expect(d.ok && d.statuses["os.sp1"]).toBe("fail");
    expect(d.ok && d.statuses["hw.ram"]).toBe("warn");
  });
  it("detects a typo via the check digit and rejects garbage", () => {
    expect(decodeOfflineCode("W7-7800-0000-0001-7")).toEqual({ ok: false, reason: "checksum" });
    expect(decodeOfflineCode("hello")).toEqual({ ok: false, reason: "format" });
    expect(decodeOfflineCode("W7-ZZZZ-0000-0000-7")).toEqual({ ok: false, reason: "format" });
  });
});
