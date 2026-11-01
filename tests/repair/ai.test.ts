import { describe, expect, it } from "vitest";
import { buildPrompt, cleanExplanation, filterAiOutput, scrub, type FindingRow } from "@/lib/repair/ai";

const findings: FindingRow[] = [
  { id: "net.dns", status: "fail", value: "no answer" },
  { id: "time.skew", status: "warn", value: "3 years" },
  { id: "hw.ram", status: "ok", value: "2048" },
];
const wrap = (s: unknown[]) => JSON.stringify({ suggestions: s });

describe("AI output filter", () => {
  it("keeps allowlisted actions supported by a warn/fail finding", () => {
    const r = filterAiOutput(wrap([{ action_id: "flush_dns", explanation: "DNS lookups fail, so clear the resolver cache." }]), findings);
    expect(r.ok && r.valid.map((v) => v.action_id)).toEqual(["flush_dns"]);
  });
  it("drops invented ids, shell text, and actions unsupported by findings", () => {
    const r = filterAiOutput(
      wrap([
        { action_id: "format_disk", explanation: "x" },
        { action_id: "flush_dns", explanation: "run cmd /c del c:\\ and curl http://evil.example" },
        { action_id: "sfc_scan", explanation: "Scan system files." }, // no related finding is warn/fail
        { action_id: "resync_time", explanation: "The clock is years off, which breaks HTTPS checks." },
        { action_id: "resync_time", explanation: "again" },
      ]),
      findings,
    );
    expect(r.ok && r.valid.map((v) => v.action_id)).toEqual(["resync_time"]);
    expect(r.ok && r.discarded.map((d) => d.reason)).toEqual(["not_allowlisted", "unsafe_or_empty_text", "not_supported_by_findings", "duplicate"].slice(0, 3).concat(["duplicate"]));
  });
  it("rejects non-JSON and wrong shape", () => {
    expect(filterAiOutput("sure! run format c:", findings)).toEqual({ ok: false, reason: "no_json" });
    expect(filterAiOutput('{"suggestions":"flush_dns"}', findings)).toEqual({ ok: false, reason: "bad_shape" });
  });
  it("cleans explanation text", () => {
    expect(cleanExplanation("")).toBeNull();
    expect(cleanExplanation("see https://x.example")).toBeNull();
    expect(cleanExplanation("a".repeat(500))!.length).toBeLessThanOrEqual(300);
  });
  it("scrubs IP/MAC addresses from the model prompt", () => {
    expect(scrub("gw 192.168.1.1 mac aa:bb:cc:dd:ee:ff")).not.toMatch(/192\.168|aa:bb/);
    const p = JSON.stringify(buildPrompt([{ id: "net.gateway", status: "ok", value: "172.20.10.1" }], {}));
    expect(p).not.toContain("172.20.10.1");
  });
});
