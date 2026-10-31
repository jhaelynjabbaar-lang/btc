//! BTC Network AI worker agent (Phase 4).
//!
//! A consent-based, fully visible agent: it wraps an existing open-source miner as a child process, reports
//! one-minute telemetry to the ingest Worker and obeys start/pause/stop commands. It never hides itself.

pub mod api;
pub mod backoff;
pub mod cmd;
pub mod commands;
pub mod config;
pub mod consent;
pub mod hardware;
pub mod identity;
pub mod logger;
pub mod miner;
pub mod parse;
pub mod paths;
pub mod protocol;
pub mod safety;
pub mod status;
pub mod supervisor;
pub mod telemetry;
pub mod timeutil;

/// Version string reported to the server (`software_version`, max 32 chars).
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Production ingest Worker (not a secret). Overridable with `enroll --server`.
pub const DEFAULT_SERVER_URL: &str = "https://btc-network-ingest.btcnetworkai.workers.dev";
