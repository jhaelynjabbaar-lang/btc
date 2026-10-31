import { describe, expect, it } from "vitest";
import {
  b64urlDecode, b64urlEncode, canonicalMessage, checkTimestamp, hashEnrollCode, isValidPublicKey, normalizeEnrollCode, sha256Hex, verifyEd25519,
} from "../src/protocol";
import { NOW, newKeyPair } from "./helpers";

async function sign(kp: Awaited<ReturnType<typeof newKeyPair>>, msg: string) {
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(msg))));
}

describe("signature verification", () => {
  const msg = canonicalMessage({ method: "post", path: "/v1/telemetry", timestamp: "1", nonce: "n".repeat(16), bodySha256Hex: "ab" });

  it("builds a stable canonical message (method upper-cased, fields newline separated)", () => {
    expect(msg).toBe(`BTCNAI1\nPOST\n/v1/telemetry\n1\n${"n".repeat(16)}\nab`);
  });
  it("accepts a valid signature", async () => {
    const kp = await newKeyPair();
    expect(await verifyEd25519(kp.publicKeyB64u, await sign(kp, msg), msg)).toBe(true);
  });
  it("rejects a tampered message", async () => {
    const kp = await newKeyPair();
    const sig = await sign(kp, msg);
    expect(await verifyEd25519(kp.publicKeyB64u, sig, msg.replace("/v1/telemetry", "/v1/commands"))).toBe(false);
    expect(await verifyEd25519(kp.publicKeyB64u, sig, msg.replace("POST", "GET"))).toBe(false);
  });
  it("rejects a signature from a different key", async () => {
    const a = await newKeyPair();
    const b = await newKeyPair();
    expect(await verifyEd25519(b.publicKeyB64u, await sign(a, msg), msg)).toBe(false);
  });
  it("rejects malformed keys / signatures without throwing", async () => {
    const kp = await newKeyPair();
    const sig = await sign(kp, msg);
    expect(await verifyEd25519("short", sig, msg)).toBe(false);
    expect(await verifyEd25519(kp.publicKeyB64u, "not base64!!", msg)).toBe(false);
    expect(await verifyEd25519(kp.publicKeyB64u, sig.slice(0, 40), msg)).toBe(false);
    expect(await verifyEd25519(kp.publicKeyB64u, "", msg)).toBe(false);
  });
  it("validates public key shape", async () => {
    const kp = await newKeyPair();
    expect(isValidPublicKey(kp.publicKeyB64u)).toBe(true);
    expect(isValidPublicKey(kp.publicKeyB64u + "A")).toBe(false);
    expect(isValidPublicKey("")).toBe(false);
  });
  it("round-trips base64url and rejects padding/standard alphabet", () => {
    const bytes = new Uint8Array([0, 255, 254, 1, 2, 3]);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    expect(b64urlDecode("ab+/")).toBeNull();
    expect(b64urlDecode("abcd=")).toBeNull();
  });
});

describe("timestamp window", () => {
  const sec = Math.floor(NOW / 1000);
  it("accepts now and anything up to 5 minutes old", () => {
    expect(checkTimestamp(String(sec), NOW).ok).toBe(true);
    expect(checkTimestamp(String(sec - 299), NOW).ok).toBe(true);
    expect(checkTimestamp(String(sec - 300), NOW).ok).toBe(true);
  });
  it("rejects requests older than 5 minutes", () => {
    expect(checkTimestamp(String(sec - 301), NOW).ok).toBe(false);
    expect(checkTimestamp(String(sec - 3600), NOW).ok).toBe(false);
  });
  it("rejects timestamps too far in the future and garbage", () => {
    expect(checkTimestamp(String(sec + 61), NOW).ok).toBe(false);
    for (const bad of [null, "", "abc", "-5", "1.5", "1e9", " 1"]) expect(checkTimestamp(bad, NOW).ok).toBe(false);
  });
});

describe("enrollment codes", () => {
  it("normalizes case, dashes, spaces and Crockford look-alikes", () => {
    expect(normalizeEnrollCode("btcw-abcde-fghjk-mnpqr-stvwx")).toBe("BTCWABCDEFGHJKMNPQRSTVWX");
    expect(normalizeEnrollCode("BTCW ABCDE FGHJK MNPQR STVWX")).toBe("BTCWABCDEFGHJKMNPQRSTVWX");
    expect(normalizeEnrollCode("BTCW-0123O-IL456-78912-34567")).toBe("BTCW01230114567891234567");
  });
  it("rejects wrong prefix, length and alphabet", () => {
    for (const bad of ["", "ABCD-EFGHJ-KMNPQ-RSTVW-XYZ01", "BTCW-ABCDE", "BTCW-ABCDE-FGHJK-MNPQR-STVWXY", "BTCW-ABCDU-FGHJK-MNPQR-STVWX", "BTCW-ABCD!-FGHJK-MNPQR-STVWX"])
      expect(normalizeEnrollCode(bad)).toBeNull();
  });
  it("hashes to a fixed test vector (must match lib/workers/enrollment.ts in the Next app)", async () => {
    expect(await hashEnrollCode("BTCWABCDEFGHJKMNPQRSTVWX")).toBe(await sha256Hex("btcnai-enroll-v1:BTCWABCDEFGHJKMNPQRSTVWX"));
    expect(await hashEnrollCode("BTCWABCDEFGHJKMNPQRSTVWX")).toBe(VECTOR);
  });
});

const VECTOR = "2d5585cd855841e0752baa9c3858b682c70a53a777e9fc6e8977bcc633c5d948";
