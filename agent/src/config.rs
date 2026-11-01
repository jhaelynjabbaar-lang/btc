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
    /// Worker name for the `{worker_name}` placeholder in `user` / `stratum_v2.user_identity`, e.g. `rig1`
    /// (letters, digits, `-`, `_`; max 32). Empty or unset: this machine's host name (sanitized).
    pub worker_name: Option<String>,
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

/// How the miner reaches the pool.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PoolMode {
    /// Direct Stratum V1: `pool.url` is passed to the miner. Plaintext, no pool authentication.
    #[default]
    Sv1,
    /// Stratum V2 through a local SRI Translator Proxy that the agent runs as a second visible child process.
    Sv2,
}

impl PoolMode {
    pub fn label(self) -> &'static str {
        match self {
            PoolMode::Sv1 => "sv1",
            PoolMode::Sv2 => "sv2",
        }
    }
}

/// `[stratum_v2]`: the local SRI Translator Proxy (`translator_sv2`). Used only when `mode = "sv2"`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StratumV2Config {
    /// Must be `true` for `mode = "sv2"` (and `false` for `mode = "sv1"`).
    pub enabled: bool,
    /// Path to the `translator_sv2` binary. Default: `translator_sv2` found on `PATH`.
    pub translator_path: Option<PathBuf>,
    /// The pool's Stratum V2 endpoint as `host:port` (from the pool's own documentation).
    pub upstream_address: Option<String>,
    /// The pool's PUBLIC authority key (base58check), from the pool's own documentation. Never a secret key.
    #[serde(alias = "authority_public_key")]
    pub authority_pubkey: Option<String>,
    /// Pool user / worker name sent upstream (e.g. `<account>.<worker>`). Defaults to `pool.user`, then `payout_address`.
    pub user_identity: Option<String>,
    /// Loopback port the translator listens on for the miner (the miner is pointed at `stratum+tcp://127.0.0.1:<port>`).
    pub downstream_port: u16,
    /// Starting hint for the translator's variable difficulty, in H/s of this machine (NOT a measurement).
    pub expected_hashrate_hs: f64,
    /// Target share rate the translator asks the miner for.
    pub shares_per_minute: f64,
    /// How long to wait for the translator's port to open before giving up (clamped to 5-300).
    pub startup_timeout_secs: u64,
    /// Removed Phase 4 placeholder; setting it is an error.
    pub translator_url: Option<String>,
}

impl Default for StratumV2Config {
    fn default() -> Self {
        StratumV2Config {
            enabled: false,
            translator_path: None,
            upstream_address: None,
            authority_pubkey: None,
            user_identity: None,
            downstream_port: crate::tproxy::DEFAULT_DOWNSTREAM_PORT,
            expected_hashrate_hs: 1_000_000.0,
            shares_per_minute: 6.0,
            startup_timeout_secs: 30,
            translator_url: None,
        }
    }
}

/// `[pool_stats]`: optional, read-only poll of the pool's own account API (Braiins Pool only). Local display only.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PoolStatsConfig {
    pub enabled: bool,
    /// Only `"braiins"` is implemented (the only pool whose stats API is documented in docs/stratum.md).
    pub provider: String,
    /// File holding the pool API token (one line). Must be readable by you only (chmod 600). The token is never put in
    /// config.toml, logs, status.json or telemetry, and is only ever sent to the pool's own API host.
    pub api_key_file: Option<PathBuf>,
    /// Poll interval; clamped to 60-3600 s (the pool documents about one request per 5 s as a safe maximum).
    pub poll_secs: u64,
    /// Only count workers whose name equals this or starts with `<this>.`. Default: your pool user / user_identity.
    pub worker_prefix: Option<String>,
    /// API base URL override (default `https://pool.braiins.com`); `http` is only accepted for loopback (tests).
    pub base_url: Option<String>,
}

impl Default for PoolStatsConfig {
    fn default() -> Self {
        PoolStatsConfig {
            enabled: false,
            provider: "braiins".into(),
            api_key_file: None,
            poll_secs: 300,
            worker_prefix: None,
            base_url: None,
        }
    }
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
    /// `"sv1"` (direct, default) or `"sv2"` (via the local translator proxy). If unset: `sv2` when
    /// `stratum_v2.enabled`, else `sv1`. Never switches automatically at run time.
    pub mode: Option<PoolMode>,
    pub stratum_v2: StratumV2Config,
    pub pool_stats: PoolStatsConfig,
}

/// What the agent will actually execute. `display_args` has secrets redacted and is the only form that is logged.
#[derive(Clone, Debug)]
pub struct MinerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub display_args: Vec<String>,
    pub pool_password: Option<String>,
    /// Extra environment for the child (never secrets).
    pub env: Vec<(String, String)>,
}

pub const TEMPLATE: &str = r#"# BTC Network AI agent configuration.
# Nothing here is a secret EXCEPT possibly your pool password; never put private keys, seed phrases or xprv here.
# Docs: agent/README.md and docs/stratum.md

# PUBLIC receive address only (bc1..., 1..., 3...). Private keys / WIF / xprv / seed phrases are rejected.
# payout_address = "bc1q..."

# How the miner reaches the pool. Explicit, never switched automatically:
#   "sv1" = direct Stratum V1 (uses [pool] below; plaintext, no pool authentication)   <- default
#   "sv2" = Stratum V2 through a local SRI translator proxy (uses [stratum_v2] below)
mode = "sv1"

[pool]
# Default pool: Braiins Pool (official docs: https://academy.braiins.com/braiins-pool/btc-mining-setup).
# Stratum V1 URL (mode = "sv1"), no credentials in the URL:
url = "stratum+tcp://stratum.braiins.com:3333"
# Format: userName.workerName. The account name (not a secret) is pre-filled; {worker_name} is replaced by `worker_name`
# below, or by this machine's host name when that is unset. The agent refuses to run if the worker part ends up empty.
# The agent never creates or logs in to a Braiins account.
user = "jhaelyngta.{worker_name}"
# worker_name = "rig1"                      # letters, digits, - and _ (max 32); default: this machine's host name
# password = "x"                            # Braiins accepts anything or empty

[miner]
# Path to an existing open-source miner (e.g. cpuminer-opt). The agent never writes or bundles a miner.
# path = "/usr/local/bin/cpuminer"
# Windows: use SINGLE quotes so the backslashes are taken literally (see agent/WINDOWS.md), e.g.
# path = 'C:\btc-agent\cpuminer-opt\cpuminer-avx2.exe'
# Placeholders: {pool_url} {pool_user} {pool_password} {payout_address} {threads}
# In sv2 mode {pool_url} is the translator's loopback address (stratum+tcp://127.0.0.1:<downstream_port>).
# args = ["-a", "sha256d", "-o", "{pool_url}", "-u", "{pool_user}", "-p", "{pool_password}"]
# cpuminer-opt prints colors even into a pipe; add "--no-color" to args for clean logs (the agent also strips them).
kind = "cpuminer"        # or "generic" (then set hashrate_regex / accepted_regex / rejected_regex)
threads_flag = "-t"      # appended as "-t <cpu_threads>" when args has no {threads}

[limits]
# cpu_threads = 2        # default: half of your logical CPUs
# max_temperature_c = 80 # NOT IMPLEMENTED yet (future work); setting it is an error

[timing]
command_poll_secs = 45   # 30-300
status_line_secs = 60

# Stratum V2 via a local SRI translator proxy (translator_sv2). The agent writes the proxy's config, starts it as a second
# visible child process, waits for its port, then points the miner at it. Set mode = "sv2" and enabled = true together.
# Pre-filled for Braiins Pool. Official docs: https://academy.braiins.com/braiins-pool/stratum-v2-manual
#   SV2 URL: stratum2+tcp://stratum.braiins.com:3333/9awtMD5KQgvRUh2yFbjVeT7b6hjipWcAsQHd6wEhgtDT9soosna
# (host:port, then the pool's PUBLIC authority key = the URL path). See docs/stratum.md for what is not verified (port 3333 vs 3336).
[stratum_v2]
enabled = false
# translator_path = "/usr/local/bin/translator_sv2"  # default: translator_sv2 on PATH
upstream_address = "stratum.braiins.com:3333"
authority_pubkey = "9awtMD5KQgvRUh2yFbjVeT7b6hjipWcAsQHd6wEhgtDT9soosna"
# user_identity = "<account>.<worker>"               # defaults to pool.user (see [pool]); "{worker_name}" works here too
# downstream_port = 34255                            # loopback only
# expected_hashrate_hs = 1000000.0                   # vardiff starting hint for THIS machine (not a measurement)
# shares_per_minute = 6.0

# Optional read-only stats from the pool's own account API (Braiins Pool only). Shown locally; never sent to the server.
[pool_stats]
enabled = false
# provider = "braiins"
# api_key_file = "/home/you/.config/btc-agent/pool-api-token"   # chmod 600; the token is NOT stored in this file
# poll_secs = 300
# worker_prefix = "<account>.<worker>"               # default: your pool user / user_identity
"#;

/// Placeholder for the worker part of `pool.user` / `stratum_v2.user_identity`.
pub const WORKER_PLACEHOLDER: &str = "{worker_name}";

fn valid_worker_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Explicit non-empty `worker_name` (must be valid as written), else the machine's host name with every character
/// outside `[A-Za-z0-9_-]` replaced by `-`. Errors instead of inventing a name.
pub fn resolve_worker_name(explicit: Option<&str>, host: Option<String>) -> Result<String, String> {
    if let Some(e) = explicit.map(str::trim).filter(|e| !e.is_empty()) {
        return if valid_worker_name(e) {
            Ok(e.to_string())
        } else {
            Err("pool.worker_name may only contain letters, digits, '-' and '_' (max 32 characters)".into())
        };
    }
    let h: String = host
        .unwrap_or_default()
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '-' })
        .take(32)
        .collect();
    let h = h.trim_matches('-').to_string();
    if h.is_empty() {
        Err("the worker name is empty: set pool.worker_name (this machine's host name could not be used)".into())
    } else {
        Ok(h)
    }
}

/// `Some(problem)` when the worker part (after the last `.`) of an expanded `userName.workerName` is empty.
fn empty_worker_problem(field: &str, raw: &str, expanded: &str) -> Option<String> {
    let uses_placeholder = raw.contains(WORKER_PLACEHOLDER);
    let after_dot_empty = expanded.rsplit_once('.').is_some_and(|(_, w)| w.trim().is_empty());
    (after_dot_empty || (uses_placeholder && expanded.trim().is_empty())).then(|| {
        format!("{field}: the worker part of userName.workerName is empty; set pool.worker_name or a worker name after the '.'")
    })
}

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

    /// The mode that will run: the explicit `mode`, else `sv2` if `stratum_v2.enabled`, else `sv1`.
    pub fn effective_mode(&self) -> PoolMode {
        self.mode.unwrap_or(if self.stratum_v2.enabled { PoolMode::Sv2 } else { PoolMode::Sv1 })
    }

    /// What the miner connects to in `sv2` mode: the translator's loopback listener (plaintext SV1, never exposed).
    pub fn local_translator_url(&self) -> String {
        format!("stratum+tcp://{}:{}", crate::tproxy::DOWNSTREAM_ADDRESS, self.stratum_v2.downstream_port)
    }

    /// The pool user with `{worker_name}` expanded; falls back to the payout address only when `pool.user` is unset.
    pub fn pool_user(&self) -> Option<String> {
        self.pool.user.as_deref().map(|u| self.expand_worker(u)).or_else(|| self.payout_address.clone())
    }

    /// Replace `{worker_name}` with the resolved worker name (empty when it cannot be resolved, which `problems` reports).
    pub fn expand_worker(&self, s: &str) -> String {
        if !s.contains(WORKER_PLACEHOLDER) {
            return s.to_string();
        }
        s.replace(WORKER_PLACEHOLDER, &self.worker_name().unwrap_or_default())
    }

    /// The worker part of the pool user: `pool.worker_name` if set, else this machine's host name.
    pub fn worker_name(&self) -> Option<String> {
        resolve_worker_name(self.pool.worker_name.as_deref(), sysinfo::System::host_name()).ok()
    }

    /// All problems with this config (empty = valid). Does not touch the network.
    pub fn problems(&self, logical_cpus: usize) -> Vec<String> {
        let mut p = Vec::new();

        if let Some(a) = &self.payout_address {
            if let Err(e) = safety::validate_payout_address(a) {
                p.push(format!("payout_address: {e}"));
            }
        }
        // An empty user or worker part is a placeholder the owner has not filled in: refuse to run (never guess).
        if self.pool.user.as_deref().is_some_and(|u| u.trim().is_empty()) {
            p.push("pool.user is empty: set it to your pool account and worker name as userName.workerName".into());
        }
        if self.stratum_v2.user_identity.as_deref().is_some_and(|u| u.trim().is_empty()) {
            p.push("stratum_v2.user_identity is empty: set it to userName.workerName or remove the line to use pool.user".into());
        }
        if let Err(e) = resolve_worker_name(self.pool.worker_name.as_deref(), sysinfo::System::host_name()) {
            let needed = [self.pool.user.as_deref(), self.stratum_v2.user_identity.as_deref()]
                .iter()
                .flatten()
                .any(|u| u.contains(WORKER_PLACEHOLDER));
            if needed || self.pool.worker_name.as_deref().is_some_and(|w| !w.trim().is_empty()) {
                p.push(e);
            }
        }
        for (field, raw) in [("pool.user", self.pool.user.as_deref()), ("stratum_v2.user_identity", self.stratum_v2.user_identity.as_deref())] {
            if let Some(raw) = raw.filter(|r| !r.trim().is_empty()) {
                if let Some(m) = empty_worker_problem(field, raw, &self.expand_worker(raw)) {
                    p.push(m);
                }
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

        match (self.mode, self.stratum_v2.enabled) {
            (Some(PoolMode::Sv1), true) => {
                p.push("mode = \"sv1\" conflicts with stratum_v2.enabled = true: set mode = \"sv2\" or stratum_v2.enabled = false".into())
            }
            (Some(PoolMode::Sv2), false) => p.push("mode = \"sv2\" requires stratum_v2.enabled = true".into()),
            _ => {}
        }
        match self.effective_mode() {
            PoolMode::Sv2 => p.extend(crate::tproxy::problems(self)),
            PoolMode::Sv1 => {
                p.extend(self.sv1_pool_problems());
            }
        }
        p.extend(crate::poolstats::problems(self));

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
        p
    }

    /// Problems with the direct Stratum V1 pool settings (`mode = "sv1"`).
    fn sv1_pool_problems(&self) -> Vec<String> {
        let mut p = Vec::new();
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
        p
    }

    /// Expand placeholders and build the child command. Callers must have validated the config first.
    pub fn miner_command(&self, logical_cpus: usize) -> Result<MinerCommand> {
        let program = self.miner.path.clone().context("miner.path is not set")?;
        let threads = self.effective_threads(logical_cpus).to_string();
        // sv1: the pool itself. sv2: the translator's loopback listener (the translator holds the pool address and key).
        let (pool_url, pool_user) = match self.effective_mode() {
            PoolMode::Sv1 => (self.pool.url.clone().unwrap_or_default(), self.pool_user().unwrap_or_default()),
            PoolMode::Sv2 => (self.local_translator_url(), self.sv2_user_identity().unwrap_or_default()),
        };
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
        Ok(MinerCommand {
            program,
            args,
            display_args,
            pool_password: (pool_password.len() >= 4).then_some(pool_password),
            env: Vec::new(),
        })
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
path = '{}'
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
        assert!(p.iter().any(|m| m.contains("miner.path")), "{p:?}");
        // The pool URL is pre-filled with Braiins, so it is not reported as missing.
        assert!(!p.iter().any(|m| m.contains("pool.url")), "{p:?}");
    }

    #[test]
    fn template_defaults_to_braiins_with_the_account_prefilled() {
        let c = Config::parse(TEMPLATE).unwrap();
        assert_eq!(c.pool.url.as_deref(), Some("stratum+tcp://stratum.braiins.com:3333"));
        assert_eq!(c.stratum_v2.upstream_address.as_deref(), Some("stratum.braiins.com:3333"));
        assert_eq!(c.stratum_v2.authority_pubkey.as_deref(), Some("9awtMD5KQgvRUh2yFbjVeT7b6hjipWcAsQHd6wEhgtDT9soosna"));
        assert_eq!(c.pool.user.as_deref(), Some("jhaelyngta.{worker_name}"));
        // The worker part comes from config when set...
        let mut c = c;
        c.pool.worker_name = Some("rig1".into());
        assert_eq!(c.pool_user().as_deref(), Some("jhaelyngta.rig1"));
        assert_eq!(c.sv2_user_identity().as_deref(), Some("jhaelyngta.rig1"));
        // ...and an invalid explicit worker name is refused, never silently rewritten.
        c.pool.worker_name = Some("bad name!".into());
        assert!(c.problems(8).iter().any(|m| m.contains("pool.worker_name")), "{:?}", c.problems(8));
    }

    #[test]
    fn worker_name_comes_from_config_or_the_machine_name_and_is_never_invented() {
        assert_eq!(resolve_worker_name(Some("rig1"), Some("host".into())).unwrap(), "rig1");
        assert_eq!(resolve_worker_name(None, Some("my-box.local".into())).unwrap(), "my-box-local");
        assert_eq!(resolve_worker_name(Some("  "), Some("Laptop 2".into())).unwrap(), "Laptop-2");
        assert!(resolve_worker_name(None, None).is_err());
        assert!(resolve_worker_name(None, Some("...".into())).is_err());
        assert!(resolve_worker_name(Some("a b"), Some("host".into())).is_err());
    }

    #[test]
    fn an_empty_user_or_empty_worker_part_refuses_to_run() {
        let f = fake_miner_file();
        let mut c = Config::parse(TEMPLATE).unwrap();
        c.payout_address = Some(ADDR.into());
        c.miner.path = Some(f.path().to_path_buf());
        c.pool.worker_name = Some("rig1".into());
        assert!(c.problems(8).is_empty(), "{:?}", c.problems(8));
        for bad in ["", "   ", "jhaelyngta.", "jhaelyngta. "] {
            c.pool.user = Some(bad.into());
            let p = c.problems(8);
            assert!(p.iter().any(|m| m.contains("pool.user")), "{bad:?}: {p:?}");
        }
        // An empty user must not fall back to the payout address.
        c.pool.user = Some("".into());
        assert_eq!(c.pool_user().as_deref(), Some(""));
        // Same in sv2 mode, for user_identity.
        c.pool.user = Some("jhaelyngta.{worker_name}".into());
        c.mode = Some(PoolMode::Sv2);
        c.stratum_v2.enabled = true;
        c.stratum_v2.translator_path = Some(f.path().to_path_buf());
        c.stratum_v2.user_identity = Some("jhaelyngta.".into());
        assert!(c.problems(8).iter().any(|m| m.contains("stratum_v2.user_identity")), "{:?}", c.problems(8));
        c.stratum_v2.user_identity = Some("   ".into());
        assert!(c.problems(8).iter().any(|m| m.contains("stratum_v2.user_identity is empty")));
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

    /// The config snippet in WINDOWS.md must stay valid: it is what a beginner copies.
    #[test]
    fn the_windows_guide_config_snippet_parses_and_builds_the_documented_command() {
        let md = include_str!("../WINDOWS.md");
        let start = md.find("```toml\n[pool]").expect("snippet in WINDOWS.md");
        let body = &md[start + "```toml\n".len()..];
        let snippet = &body[..body.find("```").unwrap()];
        let c = Config::parse(snippet).unwrap();
        assert_eq!(c.pool.worker_name.as_deref(), Some("pc1"));
        // The snippet only overrides lines of the generated template; merged, the user name is jhaelyngta.pc1.
        assert_eq!(c.pool.user.as_deref(), Some("jhaelyngta.{worker_name}"));
        assert_eq!(c.pool_user().as_deref(), Some("jhaelyngta.pc1"));
        assert_eq!(c.miner.path.as_deref(), Some(Path::new(r"C:\btc-agent\cpuminer-opt\cpuminer-sse2.exe")));
        assert_eq!(c.limits.cpu_threads, Some(2));
        let f = fake_miner_file();
        let mut c = c;
        // `threads_flag = "-t"` already sits in the generated template, so the guide does not repeat it.
        assert_eq!(Config::parse(TEMPLATE).unwrap().miner.threads_flag.as_deref(), Some("-t"));
        c.miner.threads_flag = Some("-t".into());
        c.miner.path = Some(f.path().to_path_buf());
        assert!(c.problems(8).is_empty(), "{:?}", c.problems(8));
        let cmd = c.miner_command(8).unwrap();
        assert_eq!(
            cmd.args,
            ["-a", "sha256d", "-o", "stratum+tcp://stratum.braiins.com:3333", "-u", "jhaelyngta.pc1", "-p", "x", "--no-color", "-t", "2"]
        );
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
        let p = c.problems(8);
        assert!(p.iter().any(|m| m.contains("max_temperature_c")));
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

    // ---------------------------------------------------------------- Phase 5: mode / Stratum V2
    #[cfg(unix)]
    const SRI_KEY: &str = "9auqWEzQDVyd2oe1JVGFLMLHZtCo2FFqZwtKA5gd9xbuEu7PH72";

    #[cfg(unix)]
    fn fake_translator_file() -> tempfile::NamedTempFile {
        use std::os::unix::fs::PermissionsExt;
        let f = tempfile::NamedTempFile::new().unwrap();
        std::fs::set_permissions(f.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        f
    }

    #[cfg(unix)]
    fn valid_sv2(miner: &Path, translator: &Path) -> Config {
        let mut c = valid(miner);
        c.mode = Some(PoolMode::Sv2);
        c.pool.url = None;
        c.stratum_v2 = StratumV2Config {
            enabled: true,
            translator_path: Some(translator.to_path_buf()),
            upstream_address: Some("pool.example.com:3333".into()),
            authority_pubkey: Some(SRI_KEY.into()),
            user_identity: Some("account.rig1".into()),
            ..StratumV2Config::default()
        };
        c
    }

    #[test]
    fn mode_defaults_to_sv1_and_is_inferred_from_enabled() {
        let c = Config::default();
        assert_eq!(c.effective_mode(), PoolMode::Sv1);
        let mut c = Config::default();
        c.stratum_v2.enabled = true;
        assert_eq!(c.effective_mode(), PoolMode::Sv2);
        c.mode = Some(PoolMode::Sv1);
        assert_eq!(c.effective_mode(), PoolMode::Sv1, "an explicit mode always wins");
    }

    #[test]
    fn mode_and_enabled_must_agree() {
        let f = fake_miner_file();
        let mut c = valid(f.path());
        c.mode = Some(PoolMode::Sv1);
        c.stratum_v2.enabled = true;
        assert!(c.problems(8).iter().any(|m| m.contains("conflicts with stratum_v2.enabled")), "{:?}", c.problems(8));
        let mut c = valid(f.path());
        c.mode = Some(PoolMode::Sv2);
        assert!(c.problems(8).iter().any(|m| m.contains("requires stratum_v2.enabled = true")));
    }

    #[test]
    fn toml_parsing_of_the_new_keys_and_the_old_placeholder_alias() {
        let c = Config::parse(
            r#"
mode = "sv2"
[stratum_v2]
enabled = true
upstream_address = "pool.example.com:3333"
authority_public_key = "abc"
downstream_port = 40000
"#,
        )
        .unwrap();
        assert_eq!(c.mode, Some(PoolMode::Sv2));
        assert_eq!(c.stratum_v2.authority_pubkey.as_deref(), Some("abc"));
        assert_eq!(c.stratum_v2.downstream_port, 40000);
        assert!(Config::parse("mode = \"sv3\"").is_err());
        assert!(Config::parse("[stratum_v2]\nbogus = 1").is_err());
        assert!(Config::parse("[pool_stats]\nbogus = 1").is_err());
    }

    #[test]
    fn the_generated_template_parses_and_defaults_to_sv1_with_everything_off() {
        let c = Config::parse(TEMPLATE).unwrap();
        assert_eq!(c.effective_mode(), PoolMode::Sv1);
        assert!(!c.stratum_v2.enabled && !c.pool_stats.enabled);
    }

    #[cfg(unix)]
    #[test]
    fn valid_sv2_config_has_no_problems_and_points_the_miner_at_the_loopback_proxy() {
        let (m, t) = (fake_miner_file(), fake_translator_file());
        let c = valid_sv2(m.path(), t.path());
        assert!(c.problems(8).is_empty(), "{:?}", c.problems(8));
        let cmd = c.miner_command(8).unwrap();
        assert_eq!(cmd.args[..4], ["-o", "stratum+tcp://127.0.0.1:34255", "-u", "account.rig1"], "{:?}", cmd.args);
        // The pool address and key are in the proxy's config, not on the miner's command line.
        let all = cmd.args.join(" ");
        assert!(!all.contains("pool.example.com") && !all.contains(SRI_KEY));
        let tc = c.translator_command(std::path::Path::new("/tmp/tproxy.toml")).unwrap();
        assert_eq!(tc.args, ["-c", "/tmp/tproxy.toml"]);
        assert_eq!(tc.port, 34255);
    }

    #[cfg(unix)]
    #[test]
    fn sv1_mode_ignores_the_stratum_v2_section_and_keeps_the_v1_command() {
        let (m, t) = (fake_miner_file(), fake_translator_file());
        let mut c = valid_sv2(m.path(), t.path());
        c.mode = Some(PoolMode::Sv1);
        c.stratum_v2.enabled = false;
        c.pool.url = Some("stratum+tcp://pool.example.com:3333".into());
        assert!(c.problems(8).is_empty(), "{:?}", c.problems(8));
        assert_eq!(c.miner_command(8).unwrap().args[..2], ["-o", "stratum+tcp://pool.example.com:3333"]);
    }

    #[test]
    fn sv2_mode_reports_every_missing_piece_with_the_install_link_for_the_translator() {
        let f = fake_miner_file();
        let mut c = valid(f.path());
        c.mode = Some(PoolMode::Sv2);
        c.stratum_v2.enabled = true;
        c.stratum_v2.translator_path = Some("/definitely/not/here/translator_sv2".into());
        c.payout_address = None;
        c.pool.user = None;
        let p = c.problems(8).join("\n");
        for needle in [
            "upstream_address is not set",
            "authority_pubkey is not set",
            "stratum_v2.user_identity",
            "does not exist",
            crate::tproxy::TPROXY_INSTALL_URL,
        ] {
            assert!(p.contains(needle), "missing {needle:?} in:\n{p}");
        }
        // pool.url is not required in sv2 mode
        assert!(!p.contains("pool.url"));
    }

    #[cfg(unix)]
    #[test]
    fn sv2_value_validation_covers_key_address_port_and_tuning() {
        let (m, t) = (fake_miner_file(), fake_translator_file());
        let base = valid_sv2(m.path(), t.path());
        type Mutator = Box<dyn Fn(&mut Config)>;
        let cases: Vec<(&str, Mutator)> = vec![
            ("authority_pubkey", Box::new(|c| c.stratum_v2.authority_pubkey = Some("9notAKey".into()))),
            ("upstream_address", Box::new(|c| c.stratum_v2.upstream_address = Some("stratum2+tcp://pool:3333/9abc".into()))),
            ("downstream_port", Box::new(|c| c.stratum_v2.downstream_port = 80)),
            ("expected_hashrate_hs", Box::new(|c| c.stratum_v2.expected_hashrate_hs = f64::NAN)),
            ("shares_per_minute", Box::new(|c| c.stratum_v2.shares_per_minute = 0.0)),
            ("translator_url", Box::new(|c| c.stratum_v2.translator_url = Some("tcp://x".into()))),
            ("user_identity", Box::new(|c| c.stratum_v2.user_identity = Some("has space".into()))),
        ];
        for (needle, f) in cases {
            let mut c = base.clone();
            f(&mut c);
            assert!(c.problems(8).iter().any(|m| m.contains(needle)), "{needle}: {:?}", c.problems(8));
        }
    }

    #[cfg(unix)]
    #[test]
    fn pool_stats_needs_a_private_token_file_and_a_supported_provider() {
        use std::os::unix::fs::PermissionsExt;
        let (m, t) = (fake_miner_file(), fake_translator_file());
        let mut c = valid_sv2(m.path(), t.path());
        let tok = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tok.path(), "tok\n").unwrap();
        std::fs::set_permissions(tok.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        c.pool_stats.enabled = true;
        c.pool_stats.api_key_file = Some(tok.path().to_path_buf());
        assert!(c.problems(8).iter().any(|m| m.contains("chmod 600")), "{:?}", c.problems(8));
        std::fs::set_permissions(tok.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(c.problems(8).is_empty(), "{:?}", c.problems(8));
        c.pool_stats.provider = "other".into();
        assert!(c.problems(8).iter().any(|m| m.contains("not supported")));
    }
}
