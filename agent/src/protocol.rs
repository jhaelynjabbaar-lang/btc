//! Wire protocol shared with the ingest Worker (`cloudflare/ingest-worker/src/protocol.ts` is the source of truth).
//!
//! canonical = "BTCNAI1\n" + METHOD + "\n" + PATH + "\n" + timestamp + "\n" + nonce + "\n" + sha256hex(body)
//! Headers: x-btc-worker (omitted on enroll), x-btc-timestamp, x-btc-nonce, x-btc-signature (unpadded base64url).

use crate::identity::Identity;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

pub const PROTOCOL_VERSION: &str = "BTCNAI1";

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    use std::fmt::Write;
    digest.iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

pub fn canonical_message(method: &str, path: &str, timestamp: &str, nonce: &str, body_sha256_hex: &str) -> String {
    [PROTOCOL_VERSION, &method.to_ascii_uppercase(), path, timestamp, nonce, body_sha256_hex].join("\n")
}

/// 16 random bytes, base64url (22 chars; the Worker accepts 16–64 chars of `[A-Za-z0-9_-]`).
pub fn new_nonce() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("OS randomness unavailable");
    b64url(&b)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedHeaders {
    pub worker_id: Option<String>,
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
}

pub fn sign_request(
    identity: &Identity,
    worker_id: Option<&str>,
    method: &str,
    path: &str,
    body: &[u8],
    timestamp: u64,
    nonce: &str,
) -> SignedHeaders {
    let ts = timestamp.to_string();
    let msg = canonical_message(method, path, &ts, nonce, &sha256_hex(body));
    SignedHeaders {
        worker_id: worker_id.map(str::to_string),
        timestamp: ts,
        nonce: nonce.to_string(),
        signature: identity.sign_b64url(msg.as_bytes()),
    }
}

const CROCKFORD: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Same normalization as the Worker (`normalizeEnrollCode`): case, dashes, spaces, Crockford look-alikes.
/// Returns `None` when the input is not a well-formed `BTCW-XXXXX-XXXXX-XXXXX-XXXXX` code.
pub fn normalize_enroll_code(input: &str) -> Option<String> {
    if input.len() > 64 {
        return None;
    }
    let s: String = input
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect();
    let body = s.strip_prefix("BTCW")?;
    if body.len() != 20 || !body.chars().all(|c| CROCKFORD.contains(c)) {
        return None;
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vectors {
        protocol: String,
        vectors: Vec<Vector>,
    }
    #[derive(Deserialize)]
    struct Vector {
        name: String,
        seed_hex: String,
        public_key: String,
        method: String,
        path: String,
        timestamp: String,
        nonce: String,
        body: String,
        body_sha256_hex: String,
        canonical_message: String,
        signature: String,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../tests/vectors/signing-vectors.json")).unwrap()
    }

    fn seed(hex: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    /// Vectors are produced by the Worker's own TypeScript (`gen-signing-vectors.mts`). Ed25519 is deterministic,
    /// so the Rust agent must reproduce every hash, canonical string, public key and signature byte for byte.
    #[test]
    fn matches_worker_generated_vectors() {
        let v = vectors();
        assert_eq!(v.protocol, PROTOCOL_VERSION);
        assert!(v.vectors.len() >= 4);
        for c in &v.vectors {
            let id = Identity::from_seed(seed(&c.seed_hex));
            assert_eq!(id.public_key_b64url(), c.public_key, "{}: public key", c.name);
            assert_eq!(sha256_hex(c.body.as_bytes()), c.body_sha256_hex, "{}: body hash", c.name);
            let msg = canonical_message(&c.method, &c.path, &c.timestamp, &c.nonce, &c.body_sha256_hex);
            assert_eq!(msg, c.canonical_message, "{}: canonical message", c.name);
            let h = sign_request(&id, Some("w"), &c.method, &c.path, c.body.as_bytes(), c.timestamp.parse().unwrap(), &c.nonce);
            assert_eq!(h.signature, c.signature, "{}: signature", c.name);
            assert_eq!(h.timestamp, c.timestamp);
            assert_eq!(h.nonce, c.nonce);
        }
    }

    #[test]
    fn signature_verifies_and_binds_method_and_path() {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let c = &vectors().vectors[1];
        let id = Identity::from_seed(seed(&c.seed_hex));
        let pk = VerifyingKey::from_bytes(&id.public_key_bytes()).unwrap();
        let sig_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&c.signature).unwrap();
        let sig = Signature::from_slice(&sig_bytes).unwrap();
        assert!(pk.verify(c.canonical_message.as_bytes(), &sig).is_ok());
        let other_path = c.canonical_message.replace("/v1/telemetry", "/v1/commands");
        assert!(pk.verify(other_path.as_bytes(), &sig).is_err());
        let other_method = c.canonical_message.replace("POST", "GET");
        assert!(pk.verify(other_method.as_bytes(), &sig).is_err());
    }

    #[test]
    fn canonical_uppercases_method_and_uses_newlines() {
        let m = canonical_message("post", "/v1/telemetry", "1", &"n".repeat(16), "ab");
        assert_eq!(m, format!("BTCNAI1\nPOST\n/v1/telemetry\n1\n{}\nab", "n".repeat(16)));
    }

    #[test]
    fn empty_body_hash_is_sha256_of_empty_string() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn nonce_matches_worker_shape_and_is_unique() {
        let re = regex::Regex::new(r"^[A-Za-z0-9_-]{16,64}$").unwrap();
        let (a, b) = (new_nonce(), new_nonce());
        assert!(re.is_match(&a));
        assert_ne!(a, b);
    }

    #[test]
    fn enroll_code_normalization_matches_worker_tests() {
        assert_eq!(normalize_enroll_code("btcw-abcde-fghjk-mnpqr-stvwx").as_deref(), Some("BTCWABCDEFGHJKMNPQRSTVWX"));
        assert_eq!(normalize_enroll_code("BTCW ABCDE FGHJK MNPQR STVWX").as_deref(), Some("BTCWABCDEFGHJKMNPQRSTVWX"));
        assert_eq!(normalize_enroll_code("BTCW-0123O-IL456-78912-34567").as_deref(), Some("BTCW01230114567891234567"));
        for bad in [
            "",
            "ABCD-EFGHJ-KMNPQ-RSTVW-XYZ01",
            "BTCW-ABCDE",
            "BTCW-ABCDE-FGHJK-MNPQR-STVWXY",
            "BTCW-ABCDU-FGHJK-MNPQR-STVWX",
            "BTCW-ABCD!-FGHJK-MNPQR-STVWX",
        ] {
            assert!(normalize_enroll_code(bad).is_none(), "{bad}");
        }
    }
}
