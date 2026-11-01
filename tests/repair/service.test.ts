import { describe, expect, it } from "vitest";
import { ReportBody } from "@/lib/repair/schemas";
import { ackSuggestion, adminDecide, adminQueueSuggestion, analyzeReport, authenticateDevice, mintPairingCode, pairDevice, pollSuggestions, submitReport, RATE } from "@/lib/repair/service";
import { memoryStore } from "./memory-store";

const report = ReportBody.parse({ kind: "diagnostics", agent_version: "1.0.0", host: {}, findings: [{ id: "net.dns", status: "fail", value: "x" }], errors: [], action_results: [] });

async function paired(m = memoryStore()) {
  const mint = await mintPairingCode(m.store, "owner", "Acer", "me");
  if (!mint.ok) throw new Error("mint");
  const p = await pairDevice(m.store, { code: mint.code }, "1.2.3.4");
  if (!p.ok) throw new Error("pair");
  const device = (await authenticateDevice(m.store, `Bearer ${p.token}`))!;
  return { m, device, token: p.token, code: mint.code };
}

describe("repair service", () => {
  it("pairs once, then the code is dead; the token authenticates; a wrong token does not", async () => {
    const { m, device, token, code } = await paired();
    expect(device.name).toBe("Acer");
    expect(await pairDevice(m.store, { code }, "1.2.3.4")).toMatchObject({ ok: false, reason: "invalid_code" });
    expect(await authenticateDevice(m.store, "Bearer rdt_" + "A".repeat(43))).toBeNull();
    expect(await authenticateDevice(m.store, null)).toBeNull();
    expect(token.startsWith("rdt_")).toBe(true);
  });
  it("rate limits pairing guesses per address", async () => {
    const m = memoryStore();
    for (let i = 0; i < RATE.pairPerAddress.limit; i++) expect(await pairDevice(m.store, { code: "RP-AAAAA-AAAAA" }, "9.9.9.9")).toMatchObject({ reason: "invalid_code" });
    expect(await pairDevice(m.store, { code: "RP-AAAAA-AAAAA" }, "9.9.9.9")).toMatchObject({ ok: false, reason: "rate_limited" });
  });
  it("caps active pairing codes", async () => {
    const m = memoryStore();
    for (let i = 0; i < 5; i++) expect((await mintPairingCode(m.store, "o", "x", "me")).ok).toBe(true);
    expect(await mintPairingCode(m.store, "o", "x", "me")).toEqual({ ok: false, reason: "too_many_active" });
  });
  it("a revoked device cannot authenticate", async () => {
    const { m, device, token } = await paired();
    m.devices.get(device.id)!.status = "revoked";
    expect(await authenticateDevice(m.store, `Bearer ${token}`)).toBeNull();
  });
  it("limits reports per device", async () => {
    const { m, device } = await paired();
    for (let i = 0; i < RATE.reportPerDevice.limit; i++) expect((await submitReport(m.store, device, report)).ok).toBe(true);
    expect(await submitReport(m.store, device, report)).toEqual({ ok: false, reason: "rate_limited" });
  });
  it("suggestion flow: AI proposes, nothing is delivered until the admin queues it, device acks once", async () => {
    const { m, device } = await paired();
    const r = await submitReport(m.store, device, report);
    expect(r.ok).toBe(true);
    const model = async () => ({ model: "m", content: JSON.stringify({ suggestions: [{ action_id: "flush_dns", explanation: "DNS fails; clear the cache." }, { action_id: "rm_everything", explanation: "no" }] }) });
    const out = await analyzeReport(m.store, { owner: "owner", actor: "me", reportId: "00000000-0000-4000-8000-0000000000aa", deviceId: device.id, findings: [{ id: "net.dns", status: "fail", value: "x" }], host: {} }, model);
    expect(out).toMatchObject({ ok: true, created: 1, modelCalled: true });
    expect(await pollSuggestions(m.store, device)).toEqual([]); // still "proposed"
    const sid = [...m.sugs.keys()][0]!;
    expect(await adminDecide(m.store, sid, "someone-else", "queue")).toMatchObject({ ok: false, reason: "not_found" });
    expect(await adminDecide(m.store, sid, "owner", "queue")).toEqual({ ok: true });
    const polled = await pollSuggestions(m.store, device);
    expect(polled.map((p) => p.action_id)).toEqual(["flush_dns"]);
    expect(await ackSuggestion(m.store, device, sid, { outcome: "succeeded", exit_code: 0 })).toEqual({ ok: true });
    expect(await ackSuggestion(m.store, device, sid, { outcome: "failed" })).toMatchObject({ ok: false, reason: "already_resolved" });
  });
  it("never calls the model when nothing is warn/fail", async () => {
    const m = memoryStore();
    let called = false;
    const out = await analyzeReport(m.store, { owner: "o", actor: "me", reportId: "r", deviceId: null, findings: [{ id: "net.dns", status: "ok", value: "" }], host: {} }, async () => ((called = true), { content: "{}", model: "m" }));
    expect(called).toBe(false);
    expect(out).toMatchObject({ ok: true, modelCalled: false });
  });
  it("admin queueing rejects non-allowlisted actions and a missing device", async () => {
    const m = memoryStore();
    expect(await adminQueueSuggestion(m.store, "o", "me", { device_id: "d", action_id: "format_c", explanation: "x" })).toEqual({ ok: false, reason: "invalid_action" });
    expect(await adminQueueSuggestion(m.store, "o", "me", { action_id: "flush_dns", explanation: "x" })).toEqual({ ok: false, reason: "needs_device" });
  });
  it("a device cannot ack another device's suggestion", async () => {
    const a = await paired();
    const sid = (await adminQueueSuggestion(a.m.store, "owner", "me", { device_id: a.device.id, action_id: "flush_dns", explanation: "x" }))! as { ok: true; id: string };
    const other = { ...a.device, id: "other" };
    expect(await ackSuggestion(a.m.store, other, sid.id, { outcome: "succeeded" })).toMatchObject({ ok: false, reason: "not_found" });
  });
});
