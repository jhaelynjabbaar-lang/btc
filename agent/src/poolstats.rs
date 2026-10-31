//! Optional pool-side stats (Braiins Pool "Worker API"), for local display only.
//!
//! * Source of truth: the pool's own account API, documented at <https://academy.braiins.com/braiins-pool/monitoring>
//!   (`GET https://pool.braiins.com/accounts/workers/json/btc`, header `Pool-Auth-Token`, about one request per 5 s allowed).
//! * Everything here is **pool-reported** and labelled as such. It is never added to the agent's own accepted/rejected
//!   counters, never sent to the BTC Network AI server, and no earnings or payout figure is read or shown.
//! * The API token lives in its own file that must be readable by you only (0600). It is never part of config.toml,
//!   logs, status.json or telemetry, and is only sent to the configured pool API host.

use crate::config::Config;
use crate::safety;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

pub const BRAIINS_API_BASE: &str = "https://pool.braiins.com";
pub const BRAIINS_DOCS_URL: &str = "https://academy.braiins.com/braiins-pool/monitoring";
const WORKERS_PATH: &str = "/accounts/workers/json/btc";
const MAX_BODY: u64 = 2 * 1024 * 1024;

/// What the poller learned, as the pool reported it. `None` means the pool did not say (never invented).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PoolStatsSnapshot {
    pub provider: String,
    pub fetched_at_unix: u64,
    /// Always the same reminder, so nobody mistakes these for agent-counted numbers.
    pub source: String,
    pub workers_matched: usize,
    /// `(worker name, pool-reported state ok/low/off/dis)`.
    pub worker_states: Vec<(String, String)>,
    pub last_share_unix: Option<u64>,
    pub hash_rate_unit: Option<String>,
    pub hash_rate_5m: Option<f64>,
    pub hash_rate_60m: Option<f64>,
    pub hash_rate_24h: Option<f64>,
    /// The pool's own "active shares" counts for the last 5 min / hour / day (Braiins `shares_5m` etc.).
    pub shares_5m: Option<u64>,
    pub shares_60m: Option<u64>,
    pub shares_24h: Option<u64>,
}

pub const SOURCE_NOTE: &str = "pool-reported (Braiins Worker API); not counted by this agent; not sent to the server";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatsErrorKind {
    /// 401/403: the token is wrong or API access is not enabled for it.
    Unauthorized,
    /// 429, or the pool asked us to slow down.
    RateLimited,
    Network,
    BadResponse,
}

#[derive(Debug, Clone)]
pub struct StatsError {
    pub kind: StatsErrorKind,
    pub message: String,
}

impl std::fmt::Display for StatsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Anything that can produce a snapshot (the Braiins client, or a mock in tests).
pub trait PoolStatsSource: Send {
    fn fetch(&self, worker_prefix: &str) -> Result<PoolStatsSnapshot, StatsError>;
}

// ------------------------------------------------------------------------------------------------ config checks
fn base_url_ok(u: &str) -> Result<(), String> {
    let url = url::Url::parse(u).map_err(|_| "is not a valid URL".to_string())?;
    let host = url.host_str().unwrap_or("");
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1");
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("must be https (http is only accepted for localhost, for tests)".into()),
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return Err("must not contain credentials or a query".into());
    }
    Ok(())
}

/// Reject a token file that other local users can read (unix).
pub fn check_key_file_permissions(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!("{} is accessible by other users (mode {mode:03o}); run: chmod 600 {}", path.display(), path.display()));
        }
    }
    Ok(())
}

/// Read the token (one line). Never logs it.
pub fn read_api_key(path: &Path) -> Result<String, String> {
    check_key_file_permissions(path)?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let key = text.trim();
    if key.is_empty() || key.len() > 256 || !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err(format!("{} must contain one token (printable ASCII, at most 256 characters) and nothing else", path.display()));
    }
    safety::check_no_secrets("pool API token file", key)?;
    Ok(key.to_string())
}

/// Worker-name prefix used to pick this machine's workers out of the account's worker list.
pub fn worker_prefix(cfg: &Config) -> Option<String> {
    cfg.pool_stats.worker_prefix.clone().or_else(|| match cfg.effective_mode() {
        crate::config::PoolMode::Sv2 => cfg.sv2_user_identity(),
        crate::config::PoolMode::Sv1 => cfg.pool_user(),
    })
}

pub fn problems(cfg: &Config) -> Vec<String> {
    let c = &cfg.pool_stats;
    let mut p = Vec::new();
    if !c.enabled {
        return p;
    }
    if c.provider != "braiins" {
        p.push(format!(
            "pool_stats.provider \"{}\" is not supported: only \"braiins\" has a documented stats API ({BRAIINS_DOCS_URL}); see docs/stratum.md",
            c.provider
        ));
    }
    match &c.api_key_file {
        None => p.push("pool_stats.api_key_file is not set (a file holding your pool API token, chmod 600)".into()),
        Some(f) => {
            if let Err(e) = check_key_file_permissions(f) {
                p.push(format!("pool_stats.api_key_file: {e}"));
            }
        }
    }
    if let Some(b) = &c.base_url {
        if let Err(e) = base_url_ok(b) {
            p.push(format!("pool_stats.base_url {e}"));
        }
    }
    if worker_prefix(cfg).is_none() {
        p.push("pool_stats needs a worker name to look for: set pool_stats.worker_prefix (or pool.user / stratum_v2.user_identity)".into());
    }
    if let Some(w) = &c.worker_prefix {
        if let Err(e) = safety::check_no_secrets("pool_stats.worker_prefix", w) {
            p.push(e);
        }
    }
    p
}

// ------------------------------------------------------------------------------------------------ Braiins client
pub struct BraiinsClient {
    base: String,
    token: String,
}

impl BraiinsClient {
    pub fn new(base_url: Option<&str>, token: String) -> Result<Self, String> {
        let base = base_url.unwrap_or(BRAIINS_API_BASE).trim_end_matches('/').to_string();
        base_url_ok(&base)?;
        Ok(BraiinsClient { base, token })
    }

    /// Build from a validated config (reads the token file). `Ok(None)` when pool stats are disabled.
    pub fn from_config(cfg: &Config) -> Result<Option<Self>, String> {
        let c = &cfg.pool_stats;
        if !c.enabled {
            return Ok(None);
        }
        let file = c.api_key_file.as_deref().ok_or("pool_stats.api_key_file is not set")?;
        let token = read_api_key(file)?;
        Ok(Some(Self::new(c.base_url.as_deref(), token)?))
    }
}

impl PoolStatsSource for BraiinsClient {
    fn fetch(&self, prefix: &str) -> Result<PoolStatsSnapshot, StatsError> {
        let url = format!("{}{WORKERS_PATH}", self.base);
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).redirects(0).build();
        let resp = agent.get(&url).set("Pool-Auth-Token", &self.token).set("Accept", "application/json").call();
        let resp = match resp {
            Ok(r) => r,
            Err(ureq::Error::Status(code, _)) => {
                let kind = match code {
                    401 | 403 => StatsErrorKind::Unauthorized,
                    429 => StatsErrorKind::RateLimited,
                    _ => StatsErrorKind::BadResponse,
                };
                return Err(StatsError { kind, message: format!("pool API answered HTTP {code}") });
            }
            Err(e) => {
                // The error text names the URL and transport problem; it never contains request headers.
                return Err(StatsError {
                    kind: StatsErrorKind::Network,
                    message: format!("pool API request failed: {}", scrub(&e.to_string(), &self.token)),
                });
            }
        };
        let mut body = String::new();
        std::io::Read::read_to_string(&mut std::io::Read::take(resp.into_reader(), MAX_BODY), &mut body)
            .map_err(|e| StatsError { kind: StatsErrorKind::Network, message: format!("reading the pool API response: {e}") })?;
        parse_workers(&body, prefix, crate::timeutil::now_unix())
    }
}

fn scrub(s: &str, token: &str) -> String {
    if token.len() >= 4 { s.replace(token, "***") } else { s.to_string() }
}

// ------------------------------------------------------------------------------------------------ parsing
#[derive(Deserialize)]
struct WorkersResponse {
    btc: Option<BtcSection>,
}

#[derive(Deserialize)]
struct BtcSection {
    workers: Option<HashMap<String, RawWorker>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawWorker {
    state: Option<String>,
    last_share: Option<u64>,
    hash_rate_unit: Option<String>,
    hash_rate_5m: Option<f64>,
    hash_rate_60m: Option<f64>,
    hash_rate_24h: Option<f64>,
    shares_5m: Option<u64>,
    shares_60m: Option<u64>,
    shares_24h: Option<u64>,
}

/// `name == prefix` or `name` starts with `prefix.`
pub fn worker_matches(name: &str, prefix: &str) -> bool {
    !prefix.is_empty() && (name == prefix || name.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('.')))
}

fn sum_opt<T: Copy>(vals: &[Option<T>], add: impl Fn(T, T) -> T) -> Option<T> {
    let mut acc: Option<T> = None;
    for v in vals {
        let v = (*v)?; // one worker without the field makes the total unknown rather than a partial sum
        acc = Some(acc.map_or(v, |a| add(a, v)));
    }
    acc
}

/// Parse the Worker API response and aggregate this machine's workers. Pure, so it is unit tested with the documented sample.
pub fn parse_workers(body: &str, prefix: &str, now: u64) -> Result<PoolStatsSnapshot, StatsError> {
    let bad = |m: String| StatsError { kind: StatsErrorKind::BadResponse, message: m };
    let parsed: WorkersResponse = serde_json::from_str(body).map_err(|e| bad(format!("unexpected pool API response ({e})")))?;
    let workers = parsed.btc.and_then(|b| b.workers).ok_or_else(|| bad("pool API response has no btc.workers".into()))?;
    let mut matched: Vec<(&String, &RawWorker)> = workers.iter().filter(|(n, _)| worker_matches(n, prefix)).collect();
    matched.sort_by(|a, b| a.0.cmp(b.0));

    let mut snap = PoolStatsSnapshot {
        provider: "braiins".into(),
        fetched_at_unix: now,
        source: SOURCE_NOTE.into(),
        workers_matched: matched.len(),
        worker_states: matched.iter().map(|(n, w)| ((*n).clone(), w.state.clone().unwrap_or_else(|| "unknown".into()))).collect(),
        ..Default::default()
    };
    if matched.is_empty() {
        return Ok(snap);
    }
    snap.last_share_unix = matched.iter().filter_map(|(_, w)| w.last_share).max();
    let units: Vec<Option<&String>> = matched.iter().map(|(_, w)| w.hash_rate_unit.as_ref()).collect();
    let same_unit = units.iter().all(|u| u.is_some() && *u == units[0]);
    if same_unit {
        snap.hash_rate_unit = units[0].cloned();
        let f = |get: fn(&RawWorker) -> Option<f64>| sum_opt(&matched.iter().map(|(_, w)| get(w)).collect::<Vec<_>>(), |a, b| a + b);
        snap.hash_rate_5m = f(|w| w.hash_rate_5m);
        snap.hash_rate_60m = f(|w| w.hash_rate_60m);
        snap.hash_rate_24h = f(|w| w.hash_rate_24h);
    }
    let g =
        |get: fn(&RawWorker) -> Option<u64>| sum_opt(&matched.iter().map(|(_, w)| get(w)).collect::<Vec<_>>(), |a, b| a.saturating_add(b));
    snap.shares_5m = g(|w| w.shares_5m);
    snap.shares_60m = g(|w| w.shares_60m);
    snap.shares_24h = g(|w| w.shares_24h);
    Ok(snap)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// The sample response from the Braiins "Worker API" documentation (fictional numbers published by Braiins).
    const DOC_SAMPLE: &str = r#"{"btc":{"workers":{
        "username.worker1":{"state":"ok","last_share":1542103204,"hash_rate_unit":"Gh/s","hash_rate_scoring":15342,"hash_rate_5m":14977,"hash_rate_60m":15302,"hash_rate_24h":15351,"shares_5m":90304,"shares_60m":1125762,"shares_24h":20945364},
        "username.worker2":{"state":"low","last_share":1542103200,"hash_rate_unit":"Gh/s","hash_rate_scoring":12952,"hash_rate_5m":13001,"hash_rate_60m":12889,"hash_rate_24h":13006,"shares_5m":10,"shares_60m":20,"shares_24h":30},
        "someoneelse.rig":{"state":"ok","last_share":1,"hash_rate_unit":"Gh/s","hash_rate_5m":1,"shares_5m":999}}}}"#;

    #[test]
    fn worker_name_matching_is_exact_or_dotted_prefix() {
        assert!(worker_matches("acct.rig1", "acct.rig1"));
        assert!(worker_matches("acct.rig1.miner1", "acct.rig1"));
        assert!(!worker_matches("acct.rig10", "acct.rig1"));
        assert!(!worker_matches("acct.rig1", "acct.rig1.miner1"));
        assert!(!worker_matches("anything", ""));
    }

    #[test]
    fn parses_the_documented_sample_and_aggregates_only_matching_workers() {
        let s = parse_workers(DOC_SAMPLE, "username.worker1", 1000).unwrap();
        assert_eq!(s.workers_matched, 1);
        assert_eq!(s.worker_states, vec![("username.worker1".to_string(), "ok".to_string())]);
        assert_eq!((s.shares_5m, s.shares_60m, s.shares_24h), (Some(90304), Some(1125762), Some(20945364)));
        assert_eq!(s.hash_rate_unit.as_deref(), Some("Gh/s"));
        assert_eq!(s.hash_rate_5m, Some(14977.0));
        assert_eq!(s.last_share_unix, Some(1542103204));
        assert!(s.source.contains("not counted by this agent"));

        // Two workers under one account prefix are summed; the unrelated account is ignored.
        let s = parse_workers(DOC_SAMPLE, "username", 1000).unwrap();
        assert_eq!(s.workers_matched, 2);
        assert_eq!(s.shares_5m, Some(90304 + 10));
        assert_eq!(s.last_share_unix, Some(1542103204));
    }

    #[test]
    fn no_matching_worker_is_reported_as_zero_matches_with_no_numbers() {
        let s = parse_workers(DOC_SAMPLE, "nobody", 5).unwrap();
        assert_eq!(s.workers_matched, 0);
        assert_eq!((s.shares_5m, s.hash_rate_5m, s.last_share_unix), (None, None, None));
    }

    #[test]
    fn a_missing_field_makes_the_total_unknown_instead_of_a_partial_sum() {
        let body =
            r#"{"btc":{"workers":{"a.1":{"shares_5m":5,"hash_rate_unit":"Gh/s","hash_rate_5m":1},"a.2":{"hash_rate_unit":"Gh/s"}}}}"#;
        let s = parse_workers(body, "a", 1).unwrap();
        assert_eq!(s.workers_matched, 2);
        assert_eq!((s.shares_5m, s.hash_rate_5m), (None, None));
        // mixed units are not added together
        let body =
            r#"{"btc":{"workers":{"a.1":{"hash_rate_unit":"Gh/s","hash_rate_5m":1},"a.2":{"hash_rate_unit":"Th/s","hash_rate_5m":2}}}}"#;
        let s = parse_workers(body, "a", 1).unwrap();
        assert_eq!((s.hash_rate_unit, s.hash_rate_5m), (None, None));
    }

    #[test]
    fn garbage_responses_are_errors() {
        for body in ["", "not json", "{}", r#"{"btc":{}}"#, r#"{"btc":{"workers":[]}}"#] {
            assert_eq!(parse_workers(body, "a", 1).unwrap_err().kind, StatsErrorKind::BadResponse, "{body}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn token_file_must_be_private() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("token");
        std::fs::write(&f, "tok_123456\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        let e = read_api_key(&f).unwrap_err();
        assert!(e.contains("chmod 600"), "{e}");
        assert!(!e.contains("tok_123456"), "the token is never echoed");
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_api_key(&f).unwrap(), "tok_123456");
        std::fs::write(&f, "two words").unwrap();
        assert!(read_api_key(&f).is_err());
        assert!(read_api_key(&d.path().join("missing")).is_err());
    }

    #[test]
    fn base_url_must_be_https_except_loopback() {
        assert!(base_url_ok("https://pool.braiins.com").is_ok());
        assert!(base_url_ok("http://127.0.0.1:8080").is_ok());
        assert!(base_url_ok("http://pool.braiins.com").is_err());
        assert!(base_url_ok("https://user:pw@pool.braiins.com").is_err());
        assert!(base_url_ok("ftp://x").is_err());
    }

    #[test]
    fn config_problems_cover_provider_key_file_and_prefix() {
        let mut cfg = Config::default();
        assert!(problems(&cfg).is_empty(), "disabled means no checks");
        cfg.pool_stats.enabled = true;
        cfg.pool_stats.provider = "slush".into();
        let p = problems(&cfg);
        assert!(p.iter().any(|m| m.contains("provider")));
        assert!(p.iter().any(|m| m.contains("api_key_file is not set")));
        assert!(p.iter().any(|m| m.contains("worker name")));
    }

    /// One-shot local HTTP server standing in for the pool API (no real pool is ever contacted).
    fn serve_once(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let (status, body) = (status.to_string(), body.to_string());
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            write!(
                s,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            req
        });
        (format!("http://{addr}"), h)
    }

    #[test]
    fn client_sends_the_documented_header_to_the_documented_path_and_parses() {
        let (base, h) = serve_once("200 OK", DOC_SAMPLE);
        let c = BraiinsClient::new(Some(&base), "tok_secret_value".into()).unwrap();
        let snap = c.fetch("username.worker1").unwrap();
        let req = h.join().unwrap();
        assert!(req.starts_with("GET /accounts/workers/json/btc HTTP/1.1"), "{req}");
        assert!(req.to_ascii_lowercase().contains("pool-auth-token: tok_secret_value"), "{req}");
        assert_eq!(snap.shares_5m, Some(90304));
        let json = serde_json::to_string(&snap).unwrap();
        assert!(!json.contains("tok_secret_value"), "the token never appears in what is stored or shown");
    }

    #[test]
    fn http_errors_map_to_kinds() {
        for (status, kind) in [
            ("401 Unauthorized", StatsErrorKind::Unauthorized),
            ("429 Too Many Requests", StatsErrorKind::RateLimited),
            ("500 Internal Server Error", StatsErrorKind::BadResponse),
        ] {
            let (base, h) = serve_once(status, "{}");
            let c = BraiinsClient::new(Some(&base), "tok_secret_value".into()).unwrap();
            let e = c.fetch("x").unwrap_err();
            h.join().unwrap();
            assert_eq!(e.kind, kind, "{status}");
            assert!(!e.message.contains("tok_secret_value"));
        }
        let c = BraiinsClient::new(Some("http://127.0.0.1:9"), "tok_secret_value".into()).unwrap();
        assert_eq!(c.fetch("x").unwrap_err().kind, StatsErrorKind::Network);
    }
}
