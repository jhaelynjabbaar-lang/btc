//! `config.toml`: miner binary + args, pool passthrough, safety limits. Contains no private keys (and refuses them).

use crate::parse::LineParser;
use crate::safety;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MinerKind {
    /// cpuminer / cpuminer-opt / cpuminer-multi style output (`accepted: 3/4 (75%), 1.2 khash/sec`).
    #[default]
    Cpuminer,
    /// Any miner: supply your own `hashrate_regex` / `accepted_regex` / `rejected_regex`.
    Generic,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PoolConfig {
    /// e.g. `stratum+tcp://pool.example.com:3333`. No credentials in the URL.
    pub url: Option<String>,
    /// Pool username (usually `<public payout address>.<worker name>`). Defaults to `payout_address`.
    pub user: Option<String>,
    /// Pool password (usually `x`). Passed through to the miner as configured.
    pub password: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MinerConfig {
    /// Path to the existing open-source miner binary. The agent does not ship or write a miner.
    pub path: Option<PathBuf>,
    /// Arguments. Placeholders: `{pool_url}` `{pool_user}` `{pool_password}` `{payout_address}` `{threads}`.
    pub args: Vec<String>,
    pub kind: MinerKind,
    /// If set (e.g. `-t`) and `args` has no `{threads}`, `<flag> <N>` is appended to pass the thread cap.
    pub threads_flag: Option<String>,
    pub hashrate_regex: Option<String>,
    pub accepted_regex: Option<String>,
    pub rejected_regex: Option<String>,
    /// Generic miners only: capture group 1 of accepted/rejected regex is a cumulative count instead of one share per line.
    pub shares_cumulative: bool,
}

impl Default for MinerConfig {
    fn default() -> Self {
        MinerConfig {
            path: None,
            args: Vec::new(),
            kind: MinerKind::Cpuminer,
            threads_flag: None,
            hashrate_regex: None,
            accepted_regex: None,
            rejected_regex: None,
            shares_cumulative: false,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LimitsConfig {
    /// CPU thread cap passed to the miner. Default: half the logical CPUs (at least 1).
    pub cpu_threads: Option<u32>,
    /// NOT IMPLEMENTED (future work): reading temperature is not reliable across machines. Setting this is an error
    /// so that a safety limit never silently does nothing.
    pub max_temperature_c: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TimingConfig {
    /// How often to poll `/v1/commands` (clamped to 30–300 s; the Worker allows 40 requests/min per worker).
    pub command_poll_secs: u64,
    /// How often to print a status line while running.
    pub status_line_secs: u64,
}

impl Default for TimingConfig {
    fn default() -> Self {
        TimingConfig { command_poll_secs: 45, status_line_secs: 60 }
    }
}

/// Placeholders for Phase 5 (Stratum V2 / SRI translator). Nothing here is used yet.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StratumV2Config {
    /// Must stay `false` in Phase 4.
    pub enabled: bool,
    pub translator_url: Option<String>,
    pub authority_public_key: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// PUBLIC Bitcoin address for payouts. Anything that looks like a private key is rejected.
    pub payout_address: Option<String>,
    pub pool: PoolConfig,
    pub miner: MinerConfig,
    pub limits: LimitsConfig,
    pub timing: TimingConfig,
    pub stratum_v2: StratumV2Config,
}

/// What the agent will actually execute. `display_args` has secrets redacted and is the only form that is logged.
#[derive(Clone, Debug)]
pub struct MinerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub display_args: Vec<String>,
    pub pool_password: Option<String>,
}

pub const TEMPLATE: &str = r#"# BTC Network AI agent configuration.
# Nothing here is a secret EXCEPT possibly your pool password; never put private keys, seed phrases or xprv here.
# Docs: agent/README.md

# PUBLIC receive address only (bc1..., 1..., 3...). Private keys / WIF / xprv / seed phrases are rejected.
# payout_address = "bc1q..."

[pool]
# Stratum V1 URL, no credentials in the URL:
# url = "stratum+tcp://pool.example.com:3333"
# user = "<payout address>.<worker name>"   # defaults to payout_address
# password = "x"

[miner]
# Path to an existing open-source miner (e.g. cpuminer-opt). The agent never writes or bundles a miner.
# path = "/usr/local/bin/cpuminer"
# Placeholders: {pool_url} {pool_user} {pool_password} {payout_address} {threads}
# args = ["-a", "sha256d", "-o", "{pool_url}", "-u", "{pool_user}", "-p", "{pool_password}"]
kind = "cpuminer"        # or "generic" (then set hashrate_regex / accepted_regex / rejected_regex)
threads_flag = "-t"      # appended as "-t <cpu_threads>" when args has no {threads}

[limits]
# cpu_threads = 2        # default: half of your logical CPUs
# max_temperature_c = 80 # NOT IMPLEMENTED yet (future work); setting it is an error

[timing]
command_poll_secs = 45   # 30-300
status_line_secs = 60

[stratum_v2]             # Phase 5 placeholder, must stay disabled
enabled = false
"#;

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Self> {
        toml::from_str(text).context("config.toml is invalid")
    }

    pub fn command_poll_secs(&self) -> u64 {
        self.timing.command_poll_secs.clamp(30, 300)
    }

    pub fn effective_threads(&self, logical_cpus: usize) -> u32 {
        let default = (logical_cpus / 2).max(1) as u32;
        self.limits.cpu_threads.unwrap_or(default).clamp(1, logical_cpus.max(1) as u32)
    }

    pub fn pool_user(&self) -> Option<String> {
        self.pool.user.clone().or_else(|| self.payout_address.clone())
    }

    /// All problems with this config (empty = valid). Does not touch the network.
    pub fn problems(&self, logical_cpus: usize) -> Vec<String> {
        let mut p = Vec::new();

        if let Some(a) = &self.payout_address {
            if let Err(e) = safety::validate_payout_address(a) {
                p.push(format!("payout_address: {e}"));
            }
        }
        for (field, v) in [
            ("pool.user", self.pool.user.as_deref()),
            ("pool.password", self.pool.password.as_deref()),
            ("pool.url", self.pool.url.as_deref()),
        ] {
            if let Some(v) = v {
                if let Err(e) = safety::check_no_secrets(field, v) {
                    p.push(e);
                }
            }
        }
        for (i, a) in self.miner.args.iter().enumerate() {
            if let Err(e) = safety::check_no_secrets(&format!("miner.args[{i}]"), a) {
                p.push(e);
            }
        }

        match self.pool.url.as_deref() {
            None => p.push("pool.url is not set".into()),
            Some(u) => match url::Url::parse(u) {
                Err(_) => p.push("pool.url is not a valid URL".into()),
                Ok(url) => {
                    if !matches!(url.scheme(), "stratum+tcp" | "stratum+ssl" | "stratum+tls" | "tcp" | "ssl") {
                        p.push("pool.url scheme must be stratum+tcp:// (or stratum+ssl://)".into());
                    }
                    if url.host_str().is_none() || url.port().is_none() {
                        p.push("pool.url must include a host and a port".into());
                    }
                    if !url.username().is_empty() || url.password().is_some() {
                        p.push("pool.url must not contain credentials; use pool.user / pool.password".into());
                    }
                }
            },
        }
        if self.pool_user().is_none() {
            p.push("set pool.user or payout_address".into());
        }

        match &self.miner.path {
            None => p.push("miner.path is not set".into()),
            Some(path) if !path.is_file() => p.push(format!("miner.path {} does not exist or is not a file", path.display())),
            Some(_) => {}
        }
        if let Err(e) = LineParser::new(&self.miner) {
            p.push(format!("{e:#}"));
        }
        if self.miner.threads_flag.as_deref().is_some_and(|f| f.trim().is_empty()) {
            p.push("miner.threads_flag must not be empty".into());
        }

        if let Some(t) = self.limits.cpu_threads {
            if t == 0 || t as usize > logical_cpus.max(1) {
                p.push(format!("limits.cpu_threads must be between 1 and {} (this machine's logical CPUs)", logical_cpus.max(1)));
            }
        }
        if self.limits.max_temperature_c.is_some() {
            p.push("limits.max_temperature_c is not implemented yet (temperature cannot be read reliably); remove it".into());
        }
        if self.stratum_v2.enabled {
            p.push("stratum_v2.enabled must be false: Stratum V2 is planned for Phase 5".into());
        }
        p
    }

    /// Expand placeholders and build the child command. Callers must have validated the config first.
    pub fn miner_command(&self, logical_cpus: usize) -> Result<MinerCommand> {
        let program = self.miner.path.clone().context("miner.path is not set")?;
        let threads = self.effective_threads(logical_cpus).to_string();
        let pool_url = self.pool.url.clone().unwrap_or_default();
        let pool_user = self.pool_user().unwrap_or_default();
        let pool_password = self.pool.password.clone().unwrap_or_default();
        let payout = self.payout_address.clone().unwrap_or_default();

        let expand = |s: &str, redact: bool| {
            s.replace("{pool_url}", &pool_url)
                .replace("{pool_user}", &pool_user)
                .replace("{pool_password}", if redact { "***" } else { &pool_password })
                .replace("{payout_address}", &payout)
                .replace("{threads}", &threads)
        };
        let mut args: Vec<String> = self.miner.args.iter().map(|a| expand(a, false)).collect();
        let mut display_args: Vec<String> = self.miner.args.iter().map(|a| expand(a, true)).collect();
        if let Some(flag) = &self.miner.threads_flag {
            if !self.miner.args.iter().any(|a| a.contains("{threads}")) {
                for v in [&mut args, &mut display_args] {
                    v.push(flag.clone());
                    v.push(threads.clone());
                }
            }
        }
        // A literal password typed straight into args must not reach the log either.
        if pool_password.len() >= 4 {
            for d in display_args.iter_mut() {
                *d = d.replace(&pool_password, "***");
            }
        }
        Ok(MinerCommand { program, args, display_args, pool_password: (pool_password.len() >= 4).then_some(pool_password) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDR: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

    fn valid(miner: &Path) -> Config {
        Config::parse(&format!(
            r#"
payout_address = "{ADDR}"
[pool]
url = "stratum+tcp://pool.example.com:3333"
password = "hunter22"
[miner]
path = "{}"
args = ["-o", "{{pool_url}}", "-u", "{{pool_user}}", "-p", "{{pool_password}}"]
threads_flag = "-t"
"#,
            miner.display()
        ))
        .unwrap()
    }

    fn fake_miner_file() -> tempfile::NamedTempFile {
        tempfile::NamedTempFile::new().unwrap()
    }

    #[test]
    fn template_parses_and_reports_what_is_missing() {
        let c = Config::parse(TEMPLATE).unwrap();
        let p = c.problems(8);
        assert!(p.iter().any(|m| m.contains("pool.url")));
        assert!(p.iter().any(|m| m.contains("miner.path")));
    }

    #[test]
    fn valid_config_has_no_problems_and_builds_command() {
        let f = fake_miner_file();
        let c = valid(f.path());
        assert!(c.problems(8).is_empty(), "{:?}", c.problems(8));
        let cmd = c.miner_command(8).unwrap();
        assert_eq!(cmd.args, ["-o", "stratum+tcp://pool.example.com:3333", "-u", ADDR, "-p", "hunter22", "-t", "4"]);
        // The password never appears in the loggable form.
        assert!(!cmd.display_args.join(" ").contains("hunter22"));
        assert!(cmd.display_args.join(" ").contains("-p ***"));
    }

    #[test]
    fn thread_cap_default_override_and_bounds() {
        let f = fake_miner_file();
        let mut c = valid(f.path());
        assert_eq!(c.effective_threads(8), 4);
        assert_eq!(c.effective_threads(1), 1);
        c.limits.cpu_threads = Some(2);
        assert_eq!(c.miner_command(8).unwrap().args.last().unwrap(), "2");
        c.limits.cpu_threads = Some(99);
        assert!(c.problems(8).iter().any(|m| m.contains("cpu_threads")));
        c.limits.cpu_threads = Some(0);
        assert!(c.problems(8).iter().any(|m| m.contains("cpu_threads")));
    }

    #[test]
    fn threads_placeholder_is_not_duplicated_by_flag() {
        let f = fake_miner_file();
        let mut c = valid(f.path());
        c.miner.args = vec!["--cpu-threads={threads}".into()];
        assert_eq!(c.miner_command(8).unwrap().args, ["--cpu-threads=4"]);
    }

    #[test]
    fn private_keys_are_rejected_everywhere() {
        let f = fake_miner_file();
        let mut c = valid(f.path());
        let mut payload = vec![0x80u8];
        payload.extend_from_slice(&[0x22; 32]);
        let wif = bs58::encode(payload).with_check().into_string();
        c.payout_address = Some(wif.clone());
        assert!(c.problems(8).iter().any(|m| m.contains("payout_address") && m.contains("PRIVATE")));
        c.payout_address = Some(ADDR.into());
        c.pool.user = Some(format!("{wif}.rig"));
        assert!(c.problems(8).iter().any(|m| m.contains("pool.user")));
        c.pool.user = None;
        c.miner.args.push(format!("--key={}", "33".repeat(32)));
        assert!(c.problems(8).iter().any(|m| m.contains("miner.args")));
    }

    #[test]
    fn pool_url_rules() {
        let f = fake_miner_file();
        let mut c = valid(f.path());
        for (u, needle) in [
            ("https://pool.example.com:3333", "scheme"),
            ("stratum+tcp://pool.example.com", "port"),
            ("stratum+tcp://user:pw@pool.example.com:3333", "credentials"),
            ("nonsense", "valid URL"),
        ] {
            c.pool.url = Some(u.into());
            assert!(c.problems(8).iter().any(|m| m.contains(needle)), "{u}: {:?}", c.problems(8));
        }
    }

    #[test]
    fn unsupported_safety_and_v2_settings_are_errors_not_silent_noops() {
        let f = fake_miner_file();
        let mut c = valid(f.path());
        c.limits.max_temperature_c = Some(80.0);
        c.stratum_v2.enabled = true;
        let p = c.problems(8);
        assert!(p.iter().any(|m| m.contains("max_temperature_c")));
        assert!(p.iter().any(|m| m.contains("Stratum V2")));
    }

    #[test]
    fn unknown_keys_and_missing_miner_binary_are_rejected() {
        assert!(Config::parse("bogus = 1").is_err());
        let f = fake_miner_file();
        let mut c = valid(f.path());
        c.miner.path = Some("/definitely/not/here/miner".into());
        assert!(c.problems(8).iter().any(|m| m.contains("does not exist")));
    }

    #[test]
    fn poll_interval_is_clamped_to_stay_under_rate_limits() {
        let mut c = Config::default();
        c.timing.command_poll_secs = 1;
        assert_eq!(c.command_poll_secs(), 30);
        c.timing.command_poll_secs = 99_999;
        assert_eq!(c.command_poll_secs(), 300);
    }
}
