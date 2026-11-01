//! Stratum V2 support: manage a local SRI Translator Proxy (`translator_sv2`, "tProxy") as a second, visible child
//! process. The proxy listens on loopback for the Stratum V1 miner and talks Noise-encrypted Stratum V2 to the pool.
//!
//! This module only (1) validates the `[stratum_v2]` settings, (2) renders the proxy's TOML config, (3) finds the
//! proxy binary and (4) parses the share-confirmation lines the proxy logs. Spawning lives in `miner.rs` /
//! `supervisor.rs`. Nothing here connects to a network.
//!
//! The config keys written here follow `translator_sv2` 0.7.0 from `stratum-mining/sv2-apps` (see `docs/stratum.md`).

use crate::config::{Config, StratumV2Config};
use crate::safety;
use anyhow::{Context, Result};
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Binary name searched on `PATH` when `stratum_v2.translator_path` is not set.
pub const TRANSLATOR_BIN_NAME: &str = "translator_sv2";
/// Where to get the translator (printed in error messages).
pub const TPROXY_INSTALL_URL: &str = "https://github.com/stratum-mining/sv2-apps/tree/main/miner-apps/translator#installation--build";
/// The translator release whose config format and log lines this module was written and tested against.
pub const TESTED_TRANSLATOR_VERSION: &str = "translator_sv2 0.7.0 built from stratum-mining/sv2-apps commit 8e66a49 (its config schema and log lines are identical in release tag v0.8.0, which ships translator_sv2 0.6.0)";
/// Loopback only: the SV1 side of the proxy is plaintext and unauthenticated, so it is never exposed to the LAN.
pub const DOWNSTREAM_ADDRESS: &str = "127.0.0.1";
pub const DEFAULT_DOWNSTREAM_PORT: u16 = 34255;

pub fn install_hint() -> String {
    format!("install the SRI translator (`{TRANSLATOR_BIN_NAME}`): {TPROXY_INSTALL_URL} (see agent/README.md, \"Stratum V2\")")
}

// ----------------------------------------------------------------------------- validation helpers

/// Check the format of an SRI pool authority public key: base58check of a 2-byte little-endian version (1) followed by a
/// 32-byte x-only secp256k1 key (what `translator_sv2` calls `authority_pubkey`). The curve point itself is checked by
/// the translator when it starts.
pub fn validate_authority_pubkey(s: &str) -> Result<(), String> {
    let s = s.trim();
    let bytes = bs58::decode(s)
        .with_check(None)
        .into_vec()
        .map_err(|_| "is not valid base58check (typo? the checksum does not match)".to_string())?;
    match bytes.len() {
        32 => Err("decodes to a bare 32-byte key. That is the format of an SRI SECRET key; never put a secret key here, only the pool's PUBLIC authority key".into()),
        34 if bytes[..2] == [1, 0] => Ok(()),
        34 => Err("has an unsupported key version (expected 1)".into()),
        n => Err(format!("decodes to {n} bytes; an authority public key is 34 bytes (2-byte version + 32-byte key)")),
    }
}

/// `host:port` of the pool's Stratum V2 endpoint.
pub fn validate_upstream_address(s: &str) -> Result<(String, u16), String> {
    let s = s.trim();
    if s.contains("://") {
        return Err(
            "must be host:port only (no scheme). Put the pool's authority key in stratum_v2.authority_pubkey, not in the address".into()
        );
    }
    let u = url::Url::parse(&format!("tcp://{s}")).map_err(|_| "is not a valid host:port".to_string())?;
    let host = u.host_str().filter(|h| !h.is_empty()).ok_or("has no host")?;
    let port = u.port().ok_or("must include a port, e.g. pool.example.com:3333")?;
    if !matches!(u.path(), "" | "/") || !u.username().is_empty() || u.password().is_some() || u.query().is_some() {
        return Err("must be host:port only (no path, credentials or query)".into());
    }
    if port == 0 {
        return Err("port must not be 0".into());
    }
    Ok((host.to_string(), port))
}

/// Pool user identity (usually `<account>.<worker>`). ASCII, no whitespace, at most 255 bytes (an SV2 `STR0_255`).
pub fn validate_user_identity(s: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 255 {
        return Err("must be 1-255 characters".into());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '+' | ':' | '@' | '/')) {
        return Err("may only contain letters, digits and . _ - + : @ /".into());
    }
    Ok(())
}

/// The first executable called `name` on `PATH`.
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| is_executable_file(p))
}

pub fn is_executable_file(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Resolve the translator binary: the configured path, else `translator_sv2` on `PATH`.
pub fn resolve_translator(c: &StratumV2Config) -> Result<PathBuf, String> {
    match &c.translator_path {
        Some(p) if is_executable_file(p) => Ok(p.clone()),
        Some(p) if p.is_file() => {
            Err(format!("stratum_v2.translator_path {} is not executable (chmod +x it); {}", p.display(), install_hint()))
        }
        Some(p) => Err(format!("stratum_v2.translator_path {} does not exist or is not a file; {}", p.display(), install_hint())),
        None => find_in_path(TRANSLATOR_BIN_NAME).ok_or_else(|| {
            format!(
                "the translator `{TRANSLATOR_BIN_NAME}` is not installed (not found on PATH and stratum_v2.translator_path is not set); {}",
                install_hint()
            )
        }),
    }
}

// ----------------------------------------------------------------------------- config rendering

#[derive(Serialize)]
struct TproxyToml<'a> {
    downstream_address: &'a str,
    downstream_port: u16,
    max_supported_version: u16,
    min_supported_version: u16,
    downstream_extranonce2_size: u16,
    verify_payout: bool,
    aggregate_channels: bool,
    downstream_difficulty_config: DifficultyToml,
    upstreams: Vec<UpstreamToml<'a>>,
}

#[derive(Serialize)]
struct DifficultyToml {
    min_individual_miner_hashrate: f64,
    shares_per_minute: f64,
    enable_vardiff: bool,
    /// Required by translator_sv2 >= 0.5 (repo tag v0.7.0) and later; idle seconds before it re-sends a job to the miner.
    job_keepalive_interval_secs: u16,
}

#[derive(Serialize)]
struct UpstreamToml<'a> {
    address: &'a str,
    port: u16,
    authority_pubkey: &'a str,
    user_identity: &'a str,
}

/// Render the translator's TOML. Contains only public information (pool host, pool PUBLIC key, user identity).
pub fn render_config(c: &StratumV2Config, user_identity: &str) -> Result<String> {
    let addr = c.upstream_address.as_deref().context("stratum_v2.upstream_address is not set")?;
    let (host, port) = validate_upstream_address(addr).map_err(|e| anyhow::anyhow!("stratum_v2.upstream_address {e}"))?;
    let key = c.authority_pubkey.as_deref().context("stratum_v2.authority_pubkey is not set")?.trim();
    let doc = TproxyToml {
        downstream_address: DOWNSTREAM_ADDRESS,
        downstream_port: c.downstream_port,
        max_supported_version: 2,
        min_supported_version: 2,
        downstream_extranonce2_size: 4,
        verify_payout: false,
        // One local miner: a dedicated upstream channel per miner, so the pool-side worker name is `<user_identity>.minerN`.
        aggregate_channels: false,
        downstream_difficulty_config: DifficultyToml {
            min_individual_miner_hashrate: c.expected_hashrate_hs,
            shares_per_minute: c.shares_per_minute,
            enable_vardiff: true,
            job_keepalive_interval_secs: 60,
        },
        upstreams: vec![UpstreamToml { address: &host, port, authority_pubkey: key, user_identity }],
    };
    let body = toml::to_string(&doc).context("rendering the translator config")?;
    Ok(format!(
        "# Generated by btc-agent on every start; edit btc-agent's config.toml ([stratum_v2]) instead of this file.\n\
         # Contains no secrets: pool host, the pool's PUBLIC authority key and your pool user name.\n{body}"
    ))
}

/// Is something LISTENing on 127.0.0.1:`port`? Read from `/proc/net/tcp` on Linux so that checking does not open a
/// connection (the translator logs a connection that sends nothing as an error). `None` when that file is unavailable
/// (not Linux), in which case the caller falls back to a plain connect probe.
pub fn loopback_port_listening(port: u16) -> Option<bool> {
    let text = std::fs::read_to_string("/proc/net/tcp").ok()?;
    Some(proc_net_tcp_has_listener(&text, port))
}

fn proc_net_tcp_has_listener(text: &str, port: u16) -> bool {
    text.lines().skip(1).any(|l| {
        let mut f = l.split_whitespace();
        let (_, local, _, state) = (f.next(), f.next(), f.next(), f.next());
        let (Some(local), Some(state)) = (local, state) else { return false };
        let Some((ip, p)) = local.split_once(':') else { return false };
        state == "0A" && u16::from_str_radix(p, 16) == Ok(port) && matches!(ip, "0100007F" | "00000000")
    })
}

/// Write `text` to `path` atomically with mode 0600 on unix.
pub fn write_private_file(path: &Path, text: &str) -> Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("toml.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
    f.write_all(text.as_bytes()).with_context(|| format!("writing {}", tmp.display()))?;
    f.sync_all().ok();
    drop(f);
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

impl TranslatorCommand {
    /// The same shape as a miner command, so the translator runs through the same visible child-process wrapper.
    pub fn as_process_command(&self) -> crate::config::MinerCommand {
        crate::config::MinerCommand {
            program: self.program.clone(),
            args: self.args.clone(),
            display_args: self.args.clone(),
            pool_password: None,
            env: self.env.clone(),
        }
    }
}

/// What the agent will execute for the translator.
#[derive(Clone, Debug)]
pub struct TranslatorCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Extra environment (no secrets). `NO_COLOR` keeps the proxy's log lines free of escape codes.
    pub env: Vec<(String, String)>,
    pub port: u16,
    pub config_path: PathBuf,
}

impl Config {
    /// The translator command for `mode = "sv2"`; callers must have validated the config first.
    pub fn translator_command(&self, config_path: &Path) -> Result<TranslatorCommand> {
        let program = resolve_translator(&self.stratum_v2).map_err(anyhow::Error::msg)?;
        Ok(TranslatorCommand {
            program,
            args: vec!["-c".into(), config_path.display().to_string()],
            env: vec![("NO_COLOR".into(), "1".into())],
            port: self.stratum_v2.downstream_port,
            config_path: config_path.to_path_buf(),
        })
    }

    /// The pool-side user identity the translator authenticates with.
    pub fn sv2_user_identity(&self) -> Option<String> {
        self.stratum_v2.user_identity.as_deref().map(|u| self.expand_worker(u)).or_else(|| self.pool_user())
    }
}

/// All problems with the `[stratum_v2]` section when it is enabled.
pub fn problems(cfg: &Config) -> Vec<String> {
    let c = &cfg.stratum_v2;
    let mut p = Vec::new();
    for (field, v) in [
        ("stratum_v2.upstream_address", c.upstream_address.as_deref()),
        ("stratum_v2.authority_pubkey", c.authority_pubkey.as_deref()),
        ("stratum_v2.user_identity", c.user_identity.as_deref()),
        ("stratum_v2.translator_path", c.translator_path.as_deref().and_then(Path::to_str)),
    ] {
        if let Some(v) = v {
            if let Err(e) = safety::check_no_secrets(field, v) {
                p.push(e);
            }
        }
    }
    match c.upstream_address.as_deref() {
        None => p.push("stratum_v2.upstream_address is not set (the pool's Stratum V2 host:port)".into()),
        Some(a) => {
            if let Err(e) = validate_upstream_address(a) {
                p.push(format!("stratum_v2.upstream_address {e}"));
            }
        }
    }
    match c.authority_pubkey.as_deref() {
        None => p.push("stratum_v2.authority_pubkey is not set (the pool's PUBLIC authority key from the pool's own documentation)".into()),
        Some(k) => {
            if let Err(e) = validate_authority_pubkey(k) {
                p.push(format!("stratum_v2.authority_pubkey {e}"));
            }
        }
    }
    match cfg.sv2_user_identity() {
        None => p.push("set stratum_v2.user_identity (your pool account / worker name), pool.user or payout_address".into()),
        Some(u) => {
            if let Err(e) = validate_user_identity(&u) {
                p.push(format!("stratum_v2.user_identity {e}"));
            }
        }
    }
    if c.downstream_port < 1024 {
        p.push("stratum_v2.downstream_port must be between 1024 and 65535 (a non-privileged local port)".into());
    }
    if !(c.expected_hashrate_hs.is_finite() && c.expected_hashrate_hs >= 1.0) {
        p.push("stratum_v2.expected_hashrate_hs must be a number >= 1 (H/s)".into());
    }
    if !(c.shares_per_minute.is_finite() && c.shares_per_minute > 0.0 && c.shares_per_minute <= 120.0) {
        p.push("stratum_v2.shares_per_minute must be greater than 0 and at most 120".into());
    }
    if let Some(old) = &c.translator_url {
        let _ = old;
        p.push(
            "stratum_v2.translator_url was a Phase 4 placeholder and is no longer used; remove it (use stratum_v2.translator_path)".into(),
        );
    }
    if let Err(e) = resolve_translator(c) {
        p.push(e);
    }
    p
}

// ----------------------------------------------------------------------------- log parsing

/// Events read from the translator's own log. The translator accepts SV1 shares locally; only these lines mean the
/// POOL confirmed or rejected a share.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TproxyEvent {
    /// `SubmitShares.Success`: the pool accepted `n` new submits (`new_submits_accepted_count`).
    PoolAccepted(u64),
    /// `SubmitShares.Error`: the pool rejected one share.
    PoolRejected,
}

fn success_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"Received: SubmitSharesSuccess\(.*?new_submits_accepted_count=(\d+)").expect("static regex"))
}

/// Parse one translator log line. Lines that are not share confirmations yield nothing (unknown stays unknown).
pub fn parse_line(line: &str) -> Vec<TproxyEvent> {
    if let Some(c) = success_re().captures(line) {
        if let Ok(n) = c[1].parse::<u64>() {
            return vec![TproxyEvent::PoolAccepted(n)];
        }
    }
    if line.contains("Received: SubmitSharesError(") {
        return vec![TproxyEvent::PoolRejected];
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    #[test]
    fn proc_net_tcp_listener_detection() {
        let t = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 0100007F:85EF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0\n\
   1: 0100007F:1F90 0100007F:85F0 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0\n\
   2: 0A00A8C0:85F1 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1 0\n";
        assert!(super::proc_net_tcp_has_listener(t, 0x85EF));
        assert!(!super::proc_net_tcp_has_listener(t, 0x1F90), "an established connection is not a listener");
        assert!(!super::proc_net_tcp_has_listener(t, 0x85F1), "a listener on another address is not ours");
        assert!(!super::proc_net_tcp_has_listener("", 1));
    }

    use super::*;

    // Public values copied from official documentation (see docs/stratum.md).
    const BRAIINS_KEY: &str = "9awtMD5KQgvRUh2yFbjVeT7b6hjipWcAsQHd6wEhgtDT9soosna";
    const SRI_EXAMPLE_KEY: &str = "9auqWEzQDVyd2oe1JVGFLMLHZtCo2FFqZwtKA5gd9xbuEu7PH72";

    fn sv2() -> StratumV2Config {
        StratumV2Config {
            enabled: true,
            upstream_address: Some("pool.example.com:3333".into()),
            authority_pubkey: Some(SRI_EXAMPLE_KEY.into()),
            user_identity: Some("account.rig1".into()),
            ..StratumV2Config::default()
        }
    }

    #[test]
    fn real_authority_keys_have_a_valid_format() {
        assert!(validate_authority_pubkey(BRAIINS_KEY).is_ok());
        assert!(validate_authority_pubkey(SRI_EXAMPLE_KEY).is_ok());
        assert!(validate_authority_pubkey(&format!("  {BRAIINS_KEY}\n")).is_ok());
    }

    #[test]
    fn bad_authority_keys_are_rejected_with_a_reason() {
        let mut typo = BRAIINS_KEY.to_string();
        typo.replace_range(5..6, if &BRAIINS_KEY[5..6] == "D" { "E" } else { "D" });
        assert!(validate_authority_pubkey(&typo).unwrap_err().contains("base58check"));
        assert!(validate_authority_pubkey("").is_err());
        assert!(validate_authority_pubkey("not a key!").is_err());
        let short = bs58::encode([1u8, 0, 7, 7]).with_check().into_string();
        assert!(validate_authority_pubkey(&short).unwrap_err().contains("34 bytes"));
        let mut wrong_version = vec![2u8, 0];
        wrong_version.extend_from_slice(&[9u8; 32]);
        assert!(validate_authority_pubkey(&bs58::encode(wrong_version).with_check().into_string()).unwrap_err().contains("version"));
        let secret_like = bs58::encode([5u8; 32]).with_check().into_string();
        assert!(validate_authority_pubkey(&secret_like).unwrap_err().contains("SECRET"));
    }

    #[test]
    fn upstream_address_rules() {
        assert_eq!(validate_upstream_address("stratum.braiins.com:3333").unwrap(), ("stratum.braiins.com".into(), 3333));
        assert_eq!(validate_upstream_address("127.0.0.1:34254").unwrap().1, 34254);
        for bad in [
            "stratum.braiins.com",
            "stratum2+tcp://stratum.braiins.com:3333/9awt",
            "stratum+tcp://pool:3333",
            "pool.example.com:3333/path",
            "user:pw@pool.example.com:3333",
            "pool.example.com:0",
            "",
            "bad host:3333",
        ] {
            assert!(validate_upstream_address(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn user_identity_rules() {
        for ok in ["account.rig1", "sri/solo/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/rig", "a+b:c@d_e-f"] {
            assert!(validate_user_identity(ok).is_ok(), "{ok}");
        }
        for bad in ["", "has space", "quote\"d", "new\nline", &"x".repeat(256)] {
            assert!(validate_user_identity(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn rendered_toml_is_exactly_what_the_translator_expects() {
        let text = render_config(&sv2(), "account.rig1").unwrap();
        let v: toml::Value = toml::from_str(&text).unwrap();
        assert_eq!(v["downstream_address"].as_str(), Some("127.0.0.1"));
        assert_eq!(v["downstream_port"].as_integer(), Some(34255));
        assert_eq!(v["max_supported_version"].as_integer(), Some(2));
        assert_eq!(v["min_supported_version"].as_integer(), Some(2));
        assert_eq!(v["downstream_extranonce2_size"].as_integer(), Some(4));
        assert_eq!(v["verify_payout"].as_bool(), Some(false));
        assert_eq!(v["aggregate_channels"].as_bool(), Some(false));
        let d = &v["downstream_difficulty_config"];
        assert_eq!(d["min_individual_miner_hashrate"].as_float(), Some(1_000_000.0));
        assert_eq!(d["shares_per_minute"].as_float(), Some(6.0));
        assert_eq!(d["enable_vardiff"].as_bool(), Some(true));
        assert_eq!(d["job_keepalive_interval_secs"].as_integer(), Some(60));
        let ups = v["upstreams"].as_array().unwrap();
        assert_eq!(ups.len(), 1);
        assert_eq!(ups[0]["address"].as_str(), Some("pool.example.com"));
        assert_eq!(ups[0]["port"].as_integer(), Some(3333));
        assert_eq!(ups[0]["authority_pubkey"].as_str(), Some(SRI_EXAMPLE_KEY));
        assert_eq!(ups[0]["user_identity"].as_str(), Some("account.rig1"));
        // Never a monitoring endpoint or a LAN-wide listener.
        assert!(v.get("monitoring_address").is_none());
        assert!(!text.contains("0.0.0.0"));
    }

    #[test]
    fn rendering_escapes_hostile_values_instead_of_injecting_toml() {
        let mut c = sv2();
        c.authority_pubkey = Some("x\"\n[[upstreams]]\naddress=\"evil".into());
        let text = render_config(&c, "a\"b\n[x]").unwrap();
        let v: toml::Value = toml::from_str(&text).unwrap();
        assert_eq!(v["upstreams"].as_array().unwrap().len(), 1, "no injected table");
    }

    #[test]
    fn render_requires_address_and_key() {
        let mut c = sv2();
        c.upstream_address = None;
        assert!(render_config(&c, "u").is_err());
        let mut c = sv2();
        c.authority_pubkey = None;
        assert!(render_config(&c, "u").is_err());
    }

    #[test]
    fn private_file_is_written_atomically_with_mode_0600() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("tproxy.toml");
        write_private_file(&p, "a = 1\n").unwrap();
        write_private_file(&p, "a = 2\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "a = 2\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(!d.path().join("tproxy.toml.tmp").exists());
    }

    #[test]
    fn missing_translator_error_names_the_install_link() {
        let mut c = sv2();
        c.translator_path = Some("/definitely/not/here/translator_sv2".into());
        let e = resolve_translator(&c).unwrap_err();
        assert!(e.contains("does not exist") && e.contains(TPROXY_INSTALL_URL), "{e}");
    }

    #[cfg(unix)]
    #[test]
    fn translator_must_be_executable_and_is_found_when_configured() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("translator_sv2");
        std::fs::write(&p, "#!/bin/sh\n").unwrap();
        let mut c = sv2();
        c.translator_path = Some(p.clone());
        assert!(resolve_translator(&c).unwrap_err().contains("not executable"));
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(resolve_translator(&c).unwrap(), p);
    }

    #[test]
    fn parses_only_pool_confirmations() {
        let ok = "2026-10-31T20:00:00Z  INFO translator_sv2::sv2::channel_manager: Received: SubmitSharesSuccess(channel_id=1, last_sequence_number=7, new_submits_accepted_count=3, new_shares_sum=3) ✅";
        assert_eq!(parse_line(ok), vec![TproxyEvent::PoolAccepted(3)]);
        let err = "WARN translator_sv2: Received: SubmitSharesError(channel_id=1, sequence_number=8, error_code=stale-share) ❌";
        assert_eq!(parse_line(err), vec![TproxyEvent::PoolRejected]);
        // Local acceptance by the proxy is NOT a pool confirmation.
        assert!(parse_line("INFO Received mining.submit from SV1 downstream for channel id: 1").is_empty());
        assert!(parse_line("INFO Translator Proxy: listening on 127.0.0.1:34255").is_empty());
        assert!(parse_line("").is_empty());
    }

    #[test]
    fn secret_looking_values_in_new_fields_are_rejected() {
        let mut wif_payload = vec![0x80u8];
        wif_payload.extend_from_slice(&[0x22; 32]);
        let wif = bs58::encode(wif_payload).with_check().into_string();
        let xprv = format!("xp{}{}", "rv", "A".repeat(107));
        let hex = "33".repeat(32);
        for bad in [wif, xprv, hex] {
            let mut cfg = Config { stratum_v2: sv2(), ..Config::default() };
            cfg.stratum_v2.user_identity = Some(format!("acct.{bad}"));
            assert!(
                problems(&cfg).iter().any(|m| m.contains("stratum_v2.user_identity") && m.contains("private key")),
                "{:?}",
                problems(&cfg)
            );
            let mut cfg = Config { stratum_v2: sv2(), ..Config::default() };
            cfg.stratum_v2.upstream_address = Some(format!("{bad}:3333"));
            assert!(problems(&cfg).iter().any(|m| m.contains("stratum_v2.upstream_address") && m.contains("private key")));
            let mut cfg = Config { stratum_v2: sv2(), ..Config::default() };
            cfg.stratum_v2.authority_pubkey = Some(bad.clone());
            assert!(problems(&cfg).iter().any(|m| m.contains("stratum_v2.authority_pubkey")));
            let mut cfg = Config { stratum_v2: sv2(), ..Config::default() };
            cfg.stratum_v2.translator_path = Some(format!("/tmp/{bad}").into());
            assert!(problems(&cfg).iter().any(|m| m.contains("stratum_v2.translator_path") && m.contains("private key")));
        }
    }
}
