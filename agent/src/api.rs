//! HTTP client for the ingest Worker: signed requests, error classification.

use crate::commands::{CommandsResponse, ServerCommand};
use crate::identity::Identity;
use crate::protocol::{SignedHeaders, new_nonce, sign_request};
use crate::telemetry::{Row, batch_body};
use crate::timeutil::now_unix;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    /// DNS / connect / timeout: retry with backoff, keep buffering.
    Network,
    /// 401: bad signature, replay, unknown/revoked worker, or clock skew > 5 min.
    Unauthorized,
    /// 429.
    RateLimited,
    /// 400 / 413 / 415: the server will never accept this exact payload.
    Rejected,
    /// 5xx and anything else.
    Server,
}

#[derive(Debug)]
pub struct ApiError {
    pub kind: ErrorKind,
    pub status: Option<u16>,
    pub retry_after_secs: Option<u64>,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(s) => write!(f, "{} (HTTP {s})", self.message),
            None => write!(f, "{}", self.message),
        }
    }
}
impl std::error::Error for ApiError {}

impl ApiError {
    pub fn from_status(status: u16, retry_after: Option<u64>) -> ApiError {
        let (kind, message) = match status {
            401 => (
                ErrorKind::Unauthorized,
                "unauthorized: signature rejected, worker revoked/unknown, or system clock is off by more than 5 minutes",
            ),
            429 => (ErrorKind::RateLimited, "rate limited by the server"),
            400 | 413 | 415 => (ErrorKind::Rejected, "request rejected by the server"),
            _ => (ErrorKind::Server, "server error"),
        };
        ApiError { kind, status: Some(status), retry_after_secs: retry_after, message: message.into() }
    }

    pub fn network(msg: impl Into<String>) -> ApiError {
        ApiError { kind: ErrorKind::Network, status: None, retry_after_secs: None, message: msg.into() }
    }
}

/// What the supervisor needs from the server. Implemented by [`HttpApi`] and by test doubles.
pub trait Api {
    fn send_telemetry(&self, rows: &[Row], uptime_s: u64) -> Result<(), ApiError>;
    fn poll_commands(&self) -> Result<Vec<ServerCommand>, ApiError>;
    fn ack(&self, ids: &[String]) -> Result<(), ApiError>;
}

/// `https://…` only, except loopback hosts (local development). No path, query or credentials.
pub fn validate_server_url(raw: &str) -> Result<String> {
    let u = url::Url::parse(raw).context("server URL is not a valid URL")?;
    let host = u.host_str().context("server URL has no host")?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    match u.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => bail!("server URL must be https:// (http:// is only allowed for localhost)"),
    }
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() || !matches!(u.path(), "" | "/")
    {
        bail!("server URL must be just scheme://host[:port] (no path, query or credentials)");
    }
    Ok(raw.trim_end_matches('/').to_string())
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirects(0)
        .user_agent(&format!("btc-agent/{}", crate::AGENT_VERSION))
        .build()
}

fn classify(e: ureq::Error) -> ApiError {
    match e {
        ureq::Error::Status(code, resp) => {
            let retry = resp.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok());
            ApiError::from_status(code, retry)
        }
        ureq::Error::Transport(t) => ApiError::network(format!("network error: {}", t.kind())),
    }
}

fn read_json(resp: ureq::Response) -> Result<Value, ApiError> {
    let mut s = String::new();
    resp.into_reader().take(256 * 1024).read_to_string(&mut s).map_err(|_| ApiError::network("failed reading response"))?;
    serde_json::from_str(&s).map_err(|_| ApiError {
        kind: ErrorKind::Server,
        status: None,
        retry_after_secs: None,
        message: "server returned invalid JSON".into(),
    })
}

fn send(
    agent: &ureq::Agent,
    base: &str,
    method: &str,
    path: &str,
    headers: &SignedHeaders,
    body: Option<&[u8]>,
) -> Result<Value, ApiError> {
    let mut req = agent
        .request(method, &format!("{base}{path}"))
        .set("x-btc-timestamp", &headers.timestamp)
        .set("x-btc-nonce", &headers.nonce)
        .set("x-btc-signature", &headers.signature);
    if let Some(w) = &headers.worker_id {
        req = req.set("x-btc-worker", w);
    }
    let resp = match body {
        Some(b) => req.set("content-type", "application/json").send_bytes(b),
        None => req.call(),
    }
    .map_err(classify)?;
    read_json(resp)
}

pub struct EnrollResult {
    pub worker_id: String,
    pub name: Option<String>,
}

/// `POST /v1/enroll`, signed with the key being registered (proof of possession). `hardware` is the object
/// produced by `HardwareInfo::to_enroll_json`.
pub fn enroll(base: &str, identity: &Identity, code: &str, name: Option<&str>, hardware: Value) -> Result<EnrollResult, ApiError> {
    let mut body = json!({ "code": code, "public_key": identity.public_key_b64url(), "hardware": hardware });
    if let Some(n) = name {
        body["name"] = json!(n);
    }
    let bytes = serde_json::to_vec(&body).expect("enroll body serializes");
    let headers = sign_request(identity, None, "POST", "/v1/enroll", &bytes, now_unix(), &new_nonce());
    let v = send(&agent(), base, "POST", "/v1/enroll", &headers, Some(&bytes))?;
    let worker_id = v["worker_id"].as_str().map(str::to_string).ok_or_else(|| ApiError {
        kind: ErrorKind::Server,
        status: None,
        retry_after_secs: None,
        message: "enroll response had no worker_id".into(),
    })?;
    Ok(EnrollResult { worker_id, name: v["name"].as_str().map(str::to_string) })
}

pub struct HttpApi {
    base: String,
    worker_id: String,
    identity: Arc<Identity>,
    agent: ureq::Agent,
}

impl HttpApi {
    pub fn new(base: &str, worker_id: &str, identity: Arc<Identity>) -> Self {
        HttpApi { base: base.trim_end_matches('/').to_string(), worker_id: worker_id.to_string(), identity, agent: agent() }
    }

    fn signed(&self, method: &str, path: &str, body: Option<&[u8]>) -> Result<Value, ApiError> {
        let headers = sign_request(&self.identity, Some(&self.worker_id), method, path, body.unwrap_or(&[]), now_unix(), &new_nonce());
        send(&self.agent, &self.base, method, path, &headers, body)
    }
}

impl Api for HttpApi {
    fn send_telemetry(&self, rows: &[Row], uptime_s: u64) -> Result<(), ApiError> {
        let body = batch_body(rows, uptime_s, crate::AGENT_VERSION);
        self.signed("POST", "/v1/telemetry", Some(&body)).map(|_| ())
    }

    fn poll_commands(&self) -> Result<Vec<ServerCommand>, ApiError> {
        let v = self.signed("GET", "/v1/commands", None)?;
        let parsed: CommandsResponse = serde_json::from_value(v).map_err(|_| ApiError {
            kind: ErrorKind::Server,
            status: None,
            retry_after_secs: None,
            message: "unexpected commands response".into(),
        })?;
        Ok(parsed.commands)
    }

    fn ack(&self, ids: &[String]) -> Result<(), ApiError> {
        let body = serde_json::to_vec(&json!({ "ids": ids })).expect("ack body serializes");
        self.signed("POST", "/v1/commands/ack", Some(&body)).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    #[test]
    fn server_url_validation() {
        assert_eq!(
            validate_server_url("https://btc-network-ingest.btcnetworkai.workers.dev/").unwrap(),
            "https://btc-network-ingest.btcnetworkai.workers.dev"
        );
        assert!(validate_server_url("http://127.0.0.1:8787").is_ok());
        assert!(validate_server_url("http://localhost:8787").is_ok());
        for bad in ["http://example.com", "ftp://x", "https://u:p@example.com", "https://example.com/v1", "https://example.com?x=1", "nope"]
        {
            assert!(validate_server_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn status_classification() {
        assert_eq!(ApiError::from_status(401, None).kind, ErrorKind::Unauthorized);
        assert_eq!(ApiError::from_status(429, Some(7)).retry_after_secs, Some(7));
        assert_eq!(ApiError::from_status(400, None).kind, ErrorKind::Rejected);
        assert_eq!(ApiError::from_status(413, None).kind, ErrorKind::Rejected);
        assert_eq!(ApiError::from_status(503, None).kind, ErrorKind::Server);
        assert_eq!(ApiError::network("x").kind, ErrorKind::Network);
    }

    /// One-shot local HTTP server: records the raw request and answers with the given status/body.
    fn serve_once(status: &'static str, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                head.push_str(&line);
            }
            let mut b = vec![0u8; len];
            r.read_exact(&mut b).unwrap();
            head.push_str("\r\n");
            head.push_str(&String::from_utf8(b).unwrap());
            write!(
                s,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            head
        });
        (format!("http://{addr}"), h)
    }

    #[test]
    fn signed_requests_carry_the_workers_headers_and_signature_covers_the_exact_body() {
        let id = Arc::new(Identity::from_seed([7; 32]));
        let (url, h) = serve_once("200 OK", r#"{"commands":[{"id":"11111111-2222-4333-8444-555555555555","command":"pause"}]}"#);
        let api = HttpApi::new(&url, "11111111-2222-4333-8444-555555555555", id.clone());
        let cmds = api.poll_commands().unwrap();
        assert_eq!(cmds, vec![ServerCommand { id: "11111111-2222-4333-8444-555555555555".into(), command: "pause".into() }]);
        let req = h.join().unwrap().to_ascii_lowercase();
        assert!(req.starts_with("get /v1/commands http/1.1"));
        for hdr in ["x-btc-worker: 11111111-2222-4333-8444-555555555555", "x-btc-timestamp:", "x-btc-nonce:", "x-btc-signature:"] {
            assert!(req.contains(hdr), "missing {hdr}\n{req}");
        }
        assert!(!req.contains("authorization"), "no bearer tokens");
    }

    #[test]
    fn telemetry_post_sends_json_and_maps_errors() {
        let id = Arc::new(Identity::from_seed([7; 32]));
        let (url, h) = serve_once("429 Too Many Requests", r#"{"error":"rate_limited"}"#);
        let api = HttpApi::new(&url, "11111111-2222-4333-8444-555555555555", id);
        let row = Row {
            bucket_unix: 1_793_476_800,
            bucket_start: "2026-10-31T20:00:00Z".into(),
            avg_hashrate_hs: 10.0,
            accepted: 1,
            rejected: 0,
            difficulty: None,
            temperature_c: None,
        };
        let err = api.send_telemetry(&[row], 60).unwrap_err();
        assert_eq!(err.kind, ErrorKind::RateLimited);
        let req = h.join().unwrap();
        assert!(req.to_ascii_lowercase().contains("content-type: application/json"));
        assert!(req.contains(r#""bucket_start":"2026-10-31T20:00:00Z""#) && req.contains(r#""uptime_s":60"#));
    }

    #[test]
    fn connection_failure_is_a_network_error() {
        let id = Arc::new(Identity::from_seed([7; 32]));
        // port 9 on loopback: nothing listens
        let api = HttpApi::new("http://127.0.0.1:9", "11111111-2222-4333-8444-555555555555", id);
        assert_eq!(api.poll_commands().unwrap_err().kind, ErrorKind::Network);
    }
}
