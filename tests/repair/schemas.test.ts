import { describe, expect, it } from "vitest";
import { AckBody, PairBody, QueueBody, ReportBody } from "@/lib/repair/schemas";

const host = { os_caption: "Microsoft Windows 7 Professional", os_version: "6.1.7601", sp: 1, arch: "x64", ram_mb: 1900, disk_free_mb: 280000, ie_version: "9.0", clr: "2.0.50727.5420", ps: "2.0" };
const good = { kind: "diagnostics", agent_version: "1.0.0", host, findings: [{ id: "net.dns", status: "ok", value: "ok" }], errors: [], action_results: [] };

describe("request schemas", () => {
  it("accepts a valid report", () => expect(ReportBody.safeParse(good).success).toBe(true));
  it("rejects unknown keys, unknown finding ids, non-ASCII and oversize values", () => {
    expect(ReportBody.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(ReportBody.safeParse({ ...good, findings: [{ id: "rm -rf", status: "ok", value: "" }] }).success).toBe(false);
    expect(ReportBody.safeParse({ ...good, findings: [{ id: "net.dns", status: "ok", value: "caf\u00e9" }] }).success).toBe(false);
    expect(ReportBody.safeParse({ ...good, findings: Array.from({ length: 41 }, () => good.findings[0]) }).success).toBe(false);
  });
  it("only accepts allowlisted action ids when queueing", () => {
    expect(QueueBody.safeParse({ action_id: "flush_dns", explanation: "x" }).success).toBe(true);
    expect(QueueBody.safeParse({ action_id: "del /s /q c:\\", explanation: "x" }).success).toBe(false);
  });
  it("pair and ack bodies are strict", () => {
    expect(PairBody.safeParse({ code: "RP-AAAAA-BBBBB", x: 1 }).success).toBe(false);
    expect(AckBody.safeParse({ outcome: "succeeded", exit_code: 0 }).success).toBe(true);
    expect(AckBody.safeParse({ outcome: "hacked" }).success).toBe(false);
  });
});
