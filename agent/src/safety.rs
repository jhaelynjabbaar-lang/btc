//! Guards that keep secrets out of the config: payout addresses must be PUBLIC addresses, and anything that looks like
//! a private key, WIF, extended private key, raw 32-byte hex key or seed phrase is rejected outright.

use bech32::segwit;

/// Returns a reason when `s` looks like private key material.
pub fn looks_like_private_key(s: &str) -> Option<&'static str> {
    let lower = s.to_ascii_lowercase();
    for p in ["xprv", "yprv", "zprv", "tprv", "uprv", "vprv"] {
        if lower.contains(p) {
            return Some("extended private key (xprv/yprv/zprv/tprv)");
        }
    }
    if lower.contains("descriptor") && lower.contains("prv") {
        return Some("output descriptor containing a private key");
    }

    // Seed phrase: 12+ plain lowercase words.
    let words: Vec<&str> = s.split_whitespace().collect();
    if words.len() >= 12 && words.iter().all(|w| (3..=8).contains(&w.len()) && w.chars().all(|c| c.is_ascii_lowercase())) {
        return Some("seed phrase (12+ words)");
    }

    for tok in s.split(|c: char| !c.is_ascii_alphanumeric()) {
        let t = tok.strip_prefix("0x").unwrap_or(tok);
        if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some("raw 32-byte hex key");
        }
        if (50..=52).contains(&tok.len()) {
            if let Ok(v) = bs58::decode(tok).with_check(None).into_vec() {
                if (v.first() == Some(&0x80) || v.first() == Some(&0xef)) && (v.len() == 33 || v.len() == 34) {
                    return Some("WIF private key");
                }
            }
        }
    }
    None
}

/// Validate a PUBLIC Bitcoin address (base58check P2PKH/P2SH or bech32/bech32m segwit; mainnet or test networks).
pub fn validate_payout_address(addr: &str) -> Result<(), String> {
    let a = addr.trim();
    if let Some(why) = looks_like_private_key(a) {
        return Err(format!("this looks like a PRIVATE key ({why}). Never put private keys here: use a public receive address"));
    }
    if a.is_empty() || a.len() > 100 {
        return Err("payout address is empty or too long".into());
    }
    if let Ok(v) = bs58::decode(a).with_check(None).into_vec() {
        return match (v.first(), v.len()) {
            (Some(0x00 | 0x05 | 0x6f | 0xc4), 21) => Ok(()),
            _ => Err("not a valid public Bitcoin address (unknown base58 version byte or length)".into()),
        };
    }
    if let Ok((hrp, _ver, _prog)) = segwit::decode(a) {
        return match hrp.as_str() {
            "bc" | "tb" | "bcrt" => Ok(()),
            _ => Err("bech32 address has an unknown network prefix".into()),
        };
    }
    Err("not a valid public Bitcoin address (bad checksum or format)".into())
}

/// Reject private-key-looking material in any free-form value that is passed through to the miner.
pub fn check_no_secrets(field: &str, value: &str) -> Result<(), String> {
    match looks_like_private_key(value) {
        Some(why) => Err(format!("{field} looks like private key material ({why}); refusing to use it")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Well-known public example addresses.
    const P2PKH: &str = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
    const P2SH: &str = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
    const BECH32: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const TAPROOT: &str = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
    const TESTNET: &str = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
    // Synthetic, obviously-fake key material built at runtime (no real key literals in the repo).
    fn wif(compressed: bool) -> String {
        let mut payload = vec![0x80u8];
        payload.extend_from_slice(&[0x11; 32]);
        if compressed {
            payload.push(0x01);
        }
        bs58::encode(payload).with_check().into_string()
    }
    fn xprv() -> String {
        format!("xp{}{}", "rv", "A".repeat(107))
    }
    fn hex64() -> String {
        "11".repeat(32)
    }

    #[test]
    fn accepts_public_addresses() {
        for a in [P2PKH, P2SH, BECH32, TAPROOT, TESTNET] {
            assert!(validate_payout_address(a).is_ok(), "{a}");
        }
    }

    #[test]
    fn rejects_private_key_material() {
        let seed_phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident".to_string();
        for k in [wif(false), wif(true), xprv(), hex64(), seed_phrase] {
            let k = k.as_str();
            let e = validate_payout_address(k).unwrap_err();
            assert!(e.contains("PRIVATE"), "{k}: {e}");
            assert!(check_no_secrets("pool.user", k).is_err());
        }
    }

    #[test]
    fn rejects_garbage_and_bad_checksums() {
        for a in ["", "hello", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx"] {
            assert!(validate_payout_address(a).is_err(), "{a}");
        }
    }

    #[test]
    fn address_with_worker_suffix_is_not_flagged() {
        assert!(check_no_secrets("pool.user", &format!("{BECH32}.rig1")).is_ok());
        assert!(check_no_secrets("pool.password", "x").is_ok());
    }
}
