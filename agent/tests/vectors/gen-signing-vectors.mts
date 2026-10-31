/**
 * Generates agent/tests/vectors/signing-vectors.json using the Worker's own protocol code
 * (cloudflare/ingest-worker/src/protocol.ts) and Node's Ed25519. Ed25519 (RFC 8032) is deterministic, so the Rust agent
 * must reproduce the exact same signatures for the same seed + canonical message.
 *
 * The seeds below are PUBLIC TEST SEEDS used only for these vectors. They are never used for a real worker.
 *
 *   cd cloudflare/ingest-worker && npx tsx ../../agent/tests/vectors/gen-signing-vectors.mts > ../../agent/tests/vectors/signing-vectors.json
 */
import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { b64urlEncode, canonicalMessage, sha256Hex, verifyEd25519 } from "../../../cloudflare/ingest-worker/src/protocol.ts";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function keyFromSeed(seedHex: string) {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
}

async function publicKeyB64u(seedHex: string): Promise<string> {
  const { createPublicKey } = await import("node:crypto");
  const jwk = createPublicKey(keyFromSeed(seedHex)).export({ format: "jwk" }) as { x: string };
  return jwk.x; // JWK "x" is already unpadded base64url of the raw 32-byte key
}

const SEED_A = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SEED_B = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

const cases = [
  { name: "get-commands-empty-body", seed: SEED_A, method: "GET", path: "/v1/commands", timestamp: "1793476800", nonce: "AAECAwQFBgcICQoLDA0ODw", body: "" },
  {
    name: "post-telemetry",
    seed: SEED_A,
    method: "POST",
    path: "/v1/telemetry",
    timestamp: "1793476860",
    nonce: "dGVzdC1ub25jZS0wMDAwMDAx",
    body: '{"rows":[{"bucket_start":"2026-10-31T20:00:00Z","avg_hashrate_hs":1234.5,"accepted":3,"rejected":1}],"uptime_s":60,"software_version":"0.1.0"}',
  },
  { name: "post-commands-ack", seed: SEED_B, method: "POST", path: "/v1/commands/ack", timestamp: "1793476900", nonce: "ack_nonce-0123456789", body: '{"ids":["11111111-2222-4333-8444-555555555555"]}' },
  {
    name: "post-enroll-proof-of-possession",
    seed: SEED_B,
    method: "POST",
    path: "/v1/enroll",
    timestamp: "1793476950",
    nonce: "enroll-nonce-abcdef0123",
    body: '{"code":"BTCW-ABCDE-FGHJK-MNPQR-STVWX","public_key":"PLACEHOLDER","hardware":{"hardware_type":"cpu","os":"linux"}}',
  },
];

const out = [];
for (const c of cases) {
  const pub = await publicKeyB64u(c.seed);
  const body = c.body.replace("PLACEHOLDER", pub);
  const bodySha256Hex = await sha256Hex(body);
  const message = canonicalMessage({ method: c.method, path: c.path, timestamp: c.timestamp, nonce: c.nonce, bodySha256Hex });
  const signature = b64urlEncode(new Uint8Array(nodeSign(null, Buffer.from(message), keyFromSeed(c.seed))));
  if (!(await verifyEd25519(pub, signature, message))) throw new Error(`vector ${c.name} does not verify with the Worker's verifier`);
  out.push({ name: c.name, seed_hex: c.seed, public_key: pub, method: c.method, path: c.path, timestamp: c.timestamp, nonce: c.nonce, body, body_sha256_hex: bodySha256Hex, canonical_message: message, signature });
}
console.log(JSON.stringify({ protocol: "BTCNAI1", generated_by: "cloudflare/ingest-worker/src/protocol.ts", vectors: out }, null, 2));
