import { describe, expect, it } from "vitest";
import { MAX_ACK_IDS, MAX_BATCH_ROWS, parseAck, parseEnroll, parseTelemetry } from "../src/validate";
import { NOW, newKeyPair, row } from "./helpers";

describe("telemetry validation", () => {
  const ok = (body: unknown) => parseTelemetry(body, NOW);
  it("accepts a normal batch and normalizes buckets", () => {
    const r = ok({ rows: [row(1), row(2, { difficulty: 5, temperature_c: 61.5 })], uptime_s: 100, software_version: "0.1.0" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.rows).toHaveLength(2);
      expect(r.value.rows[1]).toMatchObject({ difficulty: 5, temperature_c: 61.5 });
      expect(r.value.rows[0]?.difficulty).toBeNull();
    }
  });
  it("caps the batch size", () => {
    expect(ok({ rows: Array.from({ length: MAX_BATCH_ROWS }, (_, i) => row(i + 1)) }).ok).toBe(true);
    expect(ok({ rows: Array.from({ length: MAX_BATCH_ROWS + 1 }, (_, i) => row(i + 1)) }).ok).toBe(false);
    expect(ok({ rows: [] }).ok).toBe(false);
  });
  it("rejects bad shapes", () => {
    const bad: unknown[] = [
      null, [], "x", {}, { rows: "no" }, { rows: [row(1)], extra: 1 }, { rows: [{ ...row(1), extra: 1 }] },
      { rows: [row(1), row(1)] }, // duplicate bucket
      { rows: [{ ...row(1), bucket_start: "2026-10-31T19:59:30.000Z" }] }, // not minute aligned
      { rows: [{ ...row(1), bucket_start: "yesterday" }] },
      { rows: [row(60 * 24 * 8)] }, // older than a week
      { rows: [row(-30)] }, // future
      { rows: [row(1, { avg_hashrate_hs: -1 })] }, { rows: [row(1, { avg_hashrate_hs: "5" })] }, { rows: [row(1, { avg_hashrate_hs: Infinity })] },
      { rows: [row(1, { accepted: 1.5 })] }, { rows: [row(1, { rejected: -1 })] }, { rows: [row(1, { accepted: 2 ** 60 })] },
      { rows: [row(1, { temperature_c: 999 })] }, { rows: [row(1, { difficulty: -1 })] },
      { rows: [row(1)], uptime_s: -1 }, { rows: [row(1)], software_version: "x".repeat(33) },
    ];
    for (const b of bad) expect(ok(b).ok, JSON.stringify(b)?.slice(0, 80)).toBe(false);
  });
});

describe("enroll validation", () => {
  const code = "BTCW-ABCDE-FGHJK-MNPQR-STVWX";
  it("accepts a valid request", async () => {
    const { publicKeyB64u } = await newKeyPair();
    const r = parseEnroll({ code, public_key: publicKeyB64u, name: "rig-01", hardware: { hardware_type: "cpu", os: "linux", cpu_cores: 8, memory_mb: 16384, software_version: "0.1.0" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ code: "BTCWABCDEFGHJKMNPQRSTVWX", hardware_type: "cpu", os: "linux", name: "rig-01" });
  });
  it("rejects malformed input", async () => {
    const { publicKeyB64u } = await newKeyPair();
    const hw = { hardware_type: "cpu" };
    const bad: unknown[] = [
      null, {}, { code, public_key: publicKeyB64u }, // no hardware
      { code: "nope", public_key: publicKeyB64u, hardware: hw },
      { code, public_key: "AAAA", hardware: hw },
      { code, public_key: publicKeyB64u, hardware: { hardware_type: "quantum" } },
      { code, public_key: publicKeyB64u, hardware: { ...hw, cpu_cores: -1 } },
      { code, public_key: publicKeyB64u, hardware: { ...hw, os: "a\nb" } },
      { code, public_key: publicKeyB64u, hardware: { ...hw, surprise: 1 } },
      { code, public_key: publicKeyB64u, name: "bad/name", hardware: hw },
      { code, public_key: publicKeyB64u, extra: 1, hardware: hw },
    ];
    for (const b of bad) expect(parseEnroll(b).ok, JSON.stringify(b)?.slice(0, 80)).toBe(false);
  });
});

describe("ack validation", () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  it("dedupes ids and enforces caps", () => {
    const r = parseAck({ ids: [id, id] });
    expect(r.ok && r.value.ids).toEqual([id]);
    expect(parseAck({ ids: [] }).ok).toBe(false);
    expect(parseAck({ ids: ["x"] }).ok).toBe(false);
    expect(parseAck({ ids: Array.from({ length: MAX_ACK_IDS + 1 }, () => id) }).ok).toBe(false);
  });
});
