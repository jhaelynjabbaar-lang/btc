#![allow(dead_code)]
use btc_agent::api::{Api, ApiError};
use btc_agent::commands::ServerCommand;
use btc_agent::config::{Config, MinerConfig, MinerKind, PoolConfig};
use btc_agent::telemetry::Row;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// `target/<profile>/examples/<name>` (cargo builds examples for `cargo test`).
pub fn example_path(base: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let profile_dir = exe.parent().unwrap().parent().unwrap(); // .../target/debug
    let name = if cfg!(windows) { format!("{base}.exe") } else { base.to_string() };
    let p = profile_dir.join("examples").join(name);
    assert!(p.exists(), "example {base} not built at {}; run `cargo test` (builds examples)", p.display());
    p
}

pub fn fake_miner_path() -> PathBuf {
    example_path("fake_miner")
}

pub const ADDR: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

pub fn config_with(miner_args: &[&str]) -> Config {
    Config {
        payout_address: Some(ADDR.into()),
        pool: PoolConfig { url: Some("stratum+tcp://pool.example.com:3333".into()), user: None, password: Some("hunter22".into()) },
        miner: MinerConfig {
            path: Some(fake_miner_path()),
            args: miner_args.iter().map(|s| s.to_string()).collect(),
            kind: MinerKind::Cpuminer,
            threads_flag: Some("-t".into()),
            ..MinerConfig::default()
        },
        ..Config::default()
    }
}

#[derive(Default)]
pub struct MockState {
    pub queue: Vec<ServerCommand>,
    pub acked: Vec<String>,
    pub telemetry: Vec<Vec<Row>>,
    pub polls: u32,
    pub fail_telemetry: bool,
}

#[derive(Clone, Default)]
pub struct MockApi(pub Arc<Mutex<MockState>>);

impl Api for MockApi {
    fn send_telemetry(&self, rows: &[Row], _uptime_s: u64) -> Result<(), ApiError> {
        let mut s = self.0.lock().unwrap();
        if s.fail_telemetry {
            return Err(ApiError::network("down"));
        }
        s.telemetry.push(rows.to_vec());
        Ok(())
    }
    fn poll_commands(&self) -> Result<Vec<ServerCommand>, ApiError> {
        let mut s = self.0.lock().unwrap();
        s.polls += 1;
        Ok(s.queue.clone())
    }
    fn ack(&self, ids: &[String]) -> Result<(), ApiError> {
        let mut s = self.0.lock().unwrap();
        s.acked.extend(ids.iter().cloned());
        s.queue.retain(|c| !ids.contains(&c.id));
        Ok(())
    }
}

pub fn wait_until(timeout_secs: u64, mut f: impl FnMut() -> bool) -> bool {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}
