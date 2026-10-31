#![cfg(unix)]
//! OPTIONAL integration test against the REAL Stratum Reference Implementation translator (`translator_sv2`).
//!
//! It is skipped (and says so) unless both of these are set:
//!   BTC_AGENT_REAL_TPROXY   path to a `translator_sv2` binary built from stratum-mining/sv2-apps
//!   BTC_AGENT_SRI_MOCK_POOL path to the `sri-mock-pool` binary built from `integration/sri-mock-pool`
//!
//! What runs: the agent -> the real translator (real Noise handshake, real SV2 channel open) -> `sri-mock-pool`, a LOCAL
//! TEST DOUBLE on 127.0.0.1 that generates a fresh authority key at startup. The miner is `examples/fake_sv1_miner
//! --hash`, which refuses non-loopback hosts and hashes at a difficulty of about 1e-9 (a handful of hashes per share).
//! There is no real pool, no mainnet, no real mining and no secret anywhere.
mod common;

use btc_agent::commands::{AgentState, ServerCommand};
use btc_agent::config::{Config, MinerConfig, MinerKind, PoolMode, StratumV2Config};
use btc_agent::consent;
use btc_agent::logger::Logger;
use btc_agent::paths::Paths;
use btc_agent::status;
use btc_agent::supervisor::{Params, Supervisor, Timing};
use common::*;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

struct Pool {
    child: Child,
    pubkey: String,
}
impl Drop for Pool {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn start_pool(bin: &str, port: u16, reject_every: u32) -> Pool {
    let mut child = Command::new(bin)
        .args(["--listen", &format!("127.0.0.1:{port}"), "--reject-every", &reject_every.to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("start sri-mock-pool");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let first = lines.next().expect("pool output").unwrap();
    let pubkey = first.strip_prefix("AUTHORITY_PUBKEY=").expect("pubkey line").to_string();
    // keep draining stdout so the pool never blocks on a full pipe
    std::thread::spawn(move || for _ in lines {});
    Pool { child, pubkey }
}

fn alive(pid: u32) -> bool {
    status::pid_alive(pid) && !std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| s.contains(") Z")).unwrap_or(false)
}

#[test]
fn real_translator_against_local_mock_pool() {
    let (Ok(tproxy), Ok(pool_bin)) = (std::env::var("BTC_AGENT_REAL_TPROXY"), std::env::var("BTC_AGENT_SRI_MOCK_POOL")) else {
        eprintln!("SKIPPED: set BTC_AGENT_REAL_TPROXY and BTC_AGENT_SRI_MOCK_POOL to run the real-translator test");
        return;
    };
    let (pool_port, down_port) = (free_port(), free_port());
    let pool = start_pool(&pool_bin, pool_port, 5);

    let cfg = Config {
        payout_address: Some(ADDR.into()),
        mode: Some(PoolMode::Sv2),
        miner: MinerConfig {
            path: Some(example_path("fake_sv1_miner")),
            args: ["-o", "{pool_url}", "-u", "{pool_user}", "-p", "x", "--hash", "--interval-ms", "150", "--rate", "1000"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            kind: MinerKind::Cpuminer,
            threads_flag: Some("-t".into()),
            ..MinerConfig::default()
        },
        stratum_v2: StratumV2Config {
            enabled: true,
            translator_path: Some(tproxy.into()),
            upstream_address: Some(format!("127.0.0.1:{pool_port}")),
            authority_pubkey: Some(pool.pubkey.clone()),
            user_identity: Some("mock.rig1".into()),
            downstream_port: down_port,
            expected_hashrate_hs: 1.0,
            ..StratumV2Config::default()
        },
        ..Config::default()
    };
    assert!(cfg.problems(8).is_empty(), "{:?}", cfg.problems(8));

    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("home"));
    paths.ensure_dir().unwrap();
    consent::store(&paths).unwrap();
    let miner_cmd = cfg.miner_command(8).unwrap();
    let api = MockApi::default();
    let stop = Arc::new(AtomicBool::new(false));
    let (p2, api2, stop2) = (paths.clone(), api.clone(), stop.clone());
    let timing = Timing {
        tick: Duration::from_millis(50),
        command_poll: Duration::from_millis(300),
        telemetry_flush: Duration::from_secs(3600),
        status_line: Duration::from_secs(60),
        status_file: Duration::from_millis(100),
        miner_restart_base: Duration::from_millis(500),
        miner_restart_max: Duration::from_secs(1),
        miner_stop_grace: Duration::from_secs(3),
        translator_probe: Duration::from_millis(100),
        translator_startup: Duration::from_secs(20),
        translator_stop_grace: Duration::from_secs(5),
        pool_stats_poll: Duration::from_secs(3600),
        api_backoff_base: Duration::from_secs(1),
        api_backoff_max: Duration::from_secs(2),
    };
    let handle = std::thread::spawn(move || {
        let log = Logger::new(&p2.log(), false).unwrap();
        let mut sup = Supervisor::new(Params {
            paths: p2,
            cfg,
            miner_cmd,
            worker_id: "11111111-2222-4333-8444-555555555555".into(),
            api: Box::new(api2),
            log,
            timing,
            start_state: AgentState::Mining,
            logical_cpus: 8,
        })
        .unwrap();
        sup.run(stop2)
    });
    let log = || std::fs::read_to_string(paths.log()).unwrap_or_default();

    assert!(
        wait_until(40, || status::read(&paths).is_some_and(|s| s.translator_running
            && s.miner_running
            && s.accepted_shares.unwrap_or(0) >= 4
            && s.rejected_shares.unwrap_or(0) >= 1)),
        "no pool-confirmed shares through the real translator. log:\n{}",
        log()
    );
    let s = status::read(&paths).unwrap();
    let (tp, mp) = (s.translator_pid.unwrap(), s.miner_pid.unwrap());
    assert!(alive(tp) && alive(mp));
    // The real translator's own log lines (relayed by the agent) show the pool-side worker name and the pool's replies.
    let l = log();
    assert!(l.contains("SubmitSharesSuccess") || l.contains("pool confirmed"), "{l}");
    assert!(l.contains("[pool] pool rejected a share"), "{l}");

    // pause stops both real processes and frees the port; start brings a fresh pair; Ctrl-C-style exit leaves nothing.
    api.0.lock().unwrap().queue.push(ServerCommand { id: "r1".into(), command: "pause".into() });
    assert!(
        wait_until(15, || status::read(&paths).is_some_and(|s| s.state == "paused" && !s.translator_running && !s.miner_running)),
        "{}",
        log()
    );
    assert!(wait_until(5, || !alive(tp) && !alive(mp)));
    assert!(std::net::TcpListener::bind(("127.0.0.1", down_port)).is_ok());
    api.0.lock().unwrap().queue.push(ServerCommand { id: "r2".into(), command: "start".into() });
    assert!(
        wait_until(40, || status::read(&paths).is_some_and(|s| s.translator_running && s.miner_running && s.translator_pid != Some(tp))),
        "{}",
        log()
    );
    let s2 = status::read(&paths).unwrap();
    let (tp2, mp2) = (s2.translator_pid.unwrap(), s2.miner_pid.unwrap());
    stop.store(true, Ordering::SeqCst);
    handle.join().unwrap().unwrap();
    assert!(!alive(tp2) && !alive(mp2), "exiting the agent must stop both processes");
    if std::env::var_os("BTC_AGENT_PRINT_LOG").is_some() {
        eprintln!("{}", log());
    }
    drop(pool);
}
