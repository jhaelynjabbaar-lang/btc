#![cfg(unix)]
//! Stratum V2 orchestration: the agent runs a translator proxy and a miner as two visible child processes.
//!
//! Test doubles only (see `examples/fake_tproxy.rs`, `examples/fake_sv1_miner.rs`): the "translator" is a fake that
//! speaks minimal Stratum V1 on loopback and never contacts a pool, and the "miner" does no hashing and refuses
//! non-loopback hosts. Nothing here mines or connects to a real pool.
mod common;

use btc_agent::commands::{AgentState, ServerCommand};
use btc_agent::config::{Config, MinerConfig, MinerKind, PoolConfig, PoolMode, PoolStatsConfig, StratumV2Config};
use btc_agent::consent;
use btc_agent::logger::Logger;
use btc_agent::paths::Paths;
use btc_agent::poolstats::{PoolStatsSnapshot, PoolStatsSource, SOURCE_NOTE, StatsError};
use btc_agent::status;
use btc_agent::supervisor::{Params, Supervisor, Timing};
use common::*;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const WORKER: &str = "11111111-2222-4333-8444-555555555555";
// Public key from the SRI README example (not a secret; the fake translator never uses it).
const KEY: &str = "9auqWEzQDVyd2oe1JVGFLMLHZtCo2FFqZwtKA5gd9xbuEu7PH72";

fn timing(startup_secs: u64) -> Timing {
    Timing {
        tick: Duration::from_millis(50),
        command_poll: Duration::from_millis(300),
        telemetry_flush: Duration::from_secs(3600),
        status_line: Duration::from_secs(10),
        status_file: Duration::from_millis(100),
        miner_restart_base: Duration::from_millis(200),
        miner_restart_max: Duration::from_millis(400),
        miner_stop_grace: Duration::from_secs(2),
        translator_probe: Duration::from_millis(50),
        translator_startup: Duration::from_secs(startup_secs),
        translator_stop_grace: Duration::from_secs(2),
        pool_stats_poll: Duration::from_millis(300),
        api_backoff_base: Duration::from_secs(1),
        api_backoff_max: Duration::from_secs(2),
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// An executable wrapper that sets the fake translator's test knobs, then `exec`s it (so the tracked pid IS the proxy).
fn wrapper(dir: &Path, env: &[(&str, &str)]) -> PathBuf {
    let p = dir.join("translator_sv2");
    let exports: String = env.iter().fold(String::new(), |mut acc, (k, v)| {
        acc.push_str(&format!("export {k}={v}\n"));
        acc
    });
    std::fs::write(&p, format!("#!/bin/sh\n{exports}exec {} \"$@\"\n", example_path("fake_tproxy").display())).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

fn sv2_config(translator: PathBuf, port: u16, miner_extra: &[&str]) -> Config {
    let mut args: Vec<String> = ["-o", "{pool_url}", "-u", "{pool_user}", "-p", "{pool_password}"].iter().map(|s| s.to_string()).collect();
    args.extend(miner_extra.iter().map(|s| s.to_string()));
    Config {
        payout_address: Some(ADDR.into()),
        mode: Some(PoolMode::Sv2),
        pool: PoolConfig { url: None, user: None, worker_name: None, password: Some("hunter22".into()) },
        miner: MinerConfig {
            path: Some(example_path("fake_sv1_miner")),
            args,
            kind: MinerKind::Cpuminer,
            threads_flag: Some("-t".into()),
            ..MinerConfig::default()
        },
        stratum_v2: StratumV2Config {
            enabled: true,
            translator_path: Some(translator),
            upstream_address: Some("pool.example.invalid:3333".into()),
            authority_pubkey: Some(KEY.into()),
            user_identity: Some("account.rig1".into()),
            downstream_port: port,
            ..StratumV2Config::default()
        },
        ..Config::default()
    }
}

struct Harness {
    paths: Paths,
    _dir: tempfile::TempDir,
    api: MockApi,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<anyhow::Result<()>>>,
}

fn start_in(dir: tempfile::TempDir, cfg: Config, timing: Timing, state: AgentState, pool: Option<Box<dyn PoolStatsSource>>) -> Harness {
    let paths = Paths::new(dir.path().join("home"));
    paths.ensure_dir().unwrap();
    consent::store(&paths).unwrap();
    assert!(cfg.problems(8).is_empty(), "{:?}", cfg.problems(8));
    let miner_cmd = cfg.miner_command(8).unwrap();
    let api = MockApi::default();
    let stop = Arc::new(AtomicBool::new(false));
    let (p2, api2, stop2) = (paths.clone(), api.clone(), stop.clone());
    let handle = std::thread::spawn(move || {
        let log = Logger::new(&p2.log(), false).unwrap();
        let mut sup = Supervisor::new(Params {
            paths: p2,
            cfg,
            miner_cmd,
            worker_id: WORKER.into(),
            api: Box::new(api2),
            log,
            timing,
            start_state: state,
            logical_cpus: 8,
        })
        .unwrap();
        if let Some(p) = pool {
            sup = sup.with_pool_stats(p);
        }
        sup.run(stop2)
    });
    Harness { paths, _dir: dir, api, stop, handle: Some(handle) }
}

impl Harness {
    fn status(&self) -> Option<status::StatusFile> {
        status::read(&self.paths)
    }
    fn log(&self) -> String {
        std::fs::read_to_string(self.paths.log()).unwrap_or_default()
    }
    fn finish(&mut self) -> anyhow::Result<()> {
        self.stop.store(true, Ordering::SeqCst);
        self.handle.take().unwrap().join().unwrap()
    }
    fn both_running(&self) -> Option<(u32, u32)> {
        let s = self.status()?;
        (s.translator_running && s.miner_running).then(|| (s.translator_pid.unwrap(), s.miner_pid.unwrap()))
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn alive(pid: u32) -> bool {
    status::pid_alive(pid) && !std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| s.contains(") Z")).unwrap_or(false)
}

fn cmd(id: &str, c: &str) -> ServerCommand {
    ServerCommand { id: id.into(), command: c.into() }
}

#[test]
fn two_visible_processes_pool_confirmed_shares_pause_start_stop_and_no_orphans() {
    let d = tempfile::tempdir().unwrap();
    let port = free_port();
    // Every 4th share is rejected by the (simulated) pool, yet the fake miner is told "accepted" for all of them by
    // the local proxy, exactly like the real translator: only the translator's pool lines may feed the counters.
    let tp = wrapper(d.path(), &[("FAKE_TPROXY_REJECT_EVERY", "4")]);
    let cfg = sv2_config(tp, port, &["--rate", "3000", "--interval-ms", "100"]);
    let mut h = start_in(d, cfg, timing(10), AgentState::Mining, None);

    assert!(
        wait_until(15, || h.status().is_some_and(|s| s.mode == "sv2"
            && s.translator_running
            && s.miner_running
            && s.translator_port == Some(port)
            && s.hashrate_hs == Some(3000.0)
            && s.accepted_shares.unwrap_or(0) >= 3
            && s.rejected_shares.unwrap_or(0) >= 1)),
        "log:\n{}",
        h.log()
    );
    let (tproxy_pid, miner_pid) = h.both_running().unwrap();
    assert!(alive(tproxy_pid) && alive(miner_pid) && tproxy_pid != miner_pid);

    // The generated proxy config: private file, points at loopback, holds no secret.
    let cfg_path = h.paths.tproxy_config();
    let text = std::fs::read_to_string(&cfg_path).unwrap();
    assert_eq!(std::fs::metadata(&cfg_path).unwrap().permissions().mode() & 0o777, 0o600);
    assert!(text.contains("downstream_address = \"127.0.0.1\"") && text.contains(&format!("downstream_port = {port}")));
    assert!(text.contains(KEY) && text.contains("account.rig1") && !text.contains("hunter22"));

    // Both processes are in the banner and the log, in start order: translator ready before the miner starts.
    let log = h.log();
    let ready = log.find("translator is listening on 127.0.0.1").expect("translator readiness logged");
    let miner_start = log.find("starting miner:").expect("miner start logged");
    assert!(ready < miner_start, "the miner must start only after the translator's port is open:\n{log}");
    assert!(log.contains("Proxy:   ") && log.contains(&format!("(pid {tproxy_pid})")), "{log}");
    assert!(log.contains("Miner:   ") && log.contains(&format!("(pid {miner_pid})")), "{log}");
    assert!(log.contains(&format!("-> stratum+tcp://127.0.0.1:{port}")), "{log}");
    assert!(log.contains("Stratum V2, Noise-encrypted, via the proxy"), "{log}");
    assert!(log.contains("[pool] pool confirmed 1 share(s)") && log.contains("[pool] pool rejected a share"), "{log}");
    assert!(!log.contains("hunter22"), "the pool password never reaches the log");
    // The miner's own "accepted: n/n" lines (local-proxy acceptance) did not become the agent's counters.
    let s = h.status().unwrap();
    assert!(s.rejected_shares.unwrap() >= 1, "the miner reported 0 rejections; only pool lines can produce this");

    // pause: both processes end, nothing is left behind.
    h.api.0.lock().unwrap().queue.push(cmd("a1", "pause"));
    assert!(wait_until(10, || h.status().is_some_and(|s| s.state == "paused" && !s.translator_running && !s.miner_running)), "{}", h.log());
    assert!(wait_until(5, || !alive(tproxy_pid) && !alive(miner_pid)), "pause must stop both processes");
    assert!(h.log().contains("translator stopped (pause command") && h.log().contains("miner stopped (pause command"));
    assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(), "the proxy's port is released");

    // start: a fresh pair comes up (new pids), again translator first.
    h.api.0.lock().unwrap().queue.push(cmd("a2", "start"));
    assert!(wait_until(15, || h.both_running().is_some()), "{}", h.log());
    let (t2, m2) = h.both_running().unwrap();
    assert!(t2 != tproxy_pid && m2 != miner_pid);

    // stop: idle again.
    h.api.0.lock().unwrap().queue.push(cmd("a3", "stop"));
    assert!(wait_until(10, || !alive(t2) && !alive(m2)));
    assert!(wait_until(5, || h.status().is_some_and(|s| s.state == "stopped" && !s.translator_running && !s.miner_running)));

    // start once more, then exit the agent the way Ctrl-C does (the stop flag): both children must be gone.
    h.api.0.lock().unwrap().queue.push(cmd("a4", "start"));
    assert!(wait_until(15, || h.both_running().is_some()), "{}", h.log());
    let (t3, m3) = h.both_running().unwrap();
    h.finish().unwrap();
    assert!(!alive(t3) && !alive(m3), "exiting the agent must stop both processes");
    let end = h.status().unwrap();
    assert!(!end.running && !end.translator_running && !end.miner_running);
    assert!(h.log().contains("shutting down: stopping the miner and the translator"));
    assert_eq!(h.api.0.lock().unwrap().acked.len(), 4);
}

#[test]
fn translator_crash_takes_the_miner_down_and_both_are_restarted() {
    let d = tempfile::tempdir().unwrap();
    let tp = wrapper(d.path(), &[("FAKE_TPROXY_EXIT_AFTER_MS", "1500")]);
    let cfg = sv2_config(tp, free_port(), &["--interval-ms", "100"]);
    let mut h = start_in(d, cfg, timing(10), AgentState::Mining, None);
    assert!(wait_until(10, || h.both_running().is_some()), "{}", h.log());
    let (t1, m1) = h.both_running().unwrap();
    // The proxy dies by itself ~1.5 s after it listens: the miner must not keep running against nothing.
    assert!(wait_until(10, || h.log().contains("translator exited unexpectedly")), "{}", h.log());
    assert!(wait_until(5, || !alive(t1) && !alive(m1)), "miner stopped together with its proxy");
    assert!(h.log().contains("miner stopped (the translator exited"));
    // ...and the pair is started again after the backoff, with new pids.
    assert!(wait_until(10, || h.both_running().is_some_and(|(t, m)| t != t1 && m != m1)), "{}", h.log());
    assert!(h.log().contains("restarting miner after unexpected exit"));
    let (t2, m2) = h.both_running().unwrap();
    h.finish().unwrap();
    assert!(!alive(t2) && !alive(m2));
}

#[test]
fn a_translator_that_never_listens_fails_startup_cleanly() {
    let d = tempfile::tempdir().unwrap();
    let tp = wrapper(d.path(), &[("FAKE_TPROXY_NEVER_LISTEN", "1")]);
    let cfg = sv2_config(tp, free_port(), &[]);
    let mut h = start_in(d, cfg, timing(2), AgentState::Mining, None);
    let err = h.handle.take().unwrap().join().unwrap().unwrap_err().to_string();
    assert!(err.contains("could not start the miner") && err.contains("did not open 127.0.0.1"), "{err}");
    assert!(err.contains("fake-tproxy: started"), "the translator's own output is shown: {err}");
    let log = h.log();
    let pid: u32 = log.split("translator started (pid ").nth(1).unwrap().split(')').next().unwrap().parse().unwrap();
    assert!(wait_until(5, || !alive(pid)), "the stuck translator was stopped");
    assert!(!log.contains("starting miner:"), "the miner is never started without a ready translator:\n{log}");
    assert!(!h.status().unwrap().running);
}

#[test]
fn a_translator_that_exits_during_startup_reports_why() {
    let d = tempfile::tempdir().unwrap();
    let tp = wrapper(d.path(), &[("FAKE_TPROXY_FAIL_START", "1")]);
    let mut h = start_in(d, sv2_config(tp, free_port(), &[]), timing(10), AgentState::Mining, None);
    let err = h.handle.take().unwrap().join().unwrap().unwrap_err().to_string();
    assert!(err.contains("exited during startup") && err.contains("InvalidCertificate"), "{err}");
    assert!(!h.log().contains("starting miner:"));
}

#[test]
fn a_busy_port_is_reported_before_anything_is_spawned() {
    let d = tempfile::tempdir().unwrap();
    let port = free_port();
    let _squatter = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    let tp = wrapper(d.path(), &[]);
    let mut h = start_in(d, sv2_config(tp, port, &[]), timing(10), AgentState::Mining, None);
    let err = h.handle.take().unwrap().join().unwrap().unwrap_err().to_string();
    assert!(err.contains("downstream_port") && err.contains("not available"), "{err}");
    assert!(!h.log().contains("translator started"), "{}", h.log());
}

#[test]
fn start_paused_spawns_nothing_until_start_and_the_banner_says_so() {
    let d = tempfile::tempdir().unwrap();
    let tp = wrapper(d.path(), &[]);
    let mut h = start_in(d, sv2_config(tp, free_port(), &[]), timing(10), AgentState::Paused, None);
    assert!(wait_until(5, || h.status().is_some_and(|s| s.running && s.mode == "sv2")));
    let s = h.status().unwrap();
    assert!(!s.translator_running && !s.miner_running && s.translator_pid.is_none());
    assert!(h.log().contains("MINING PAUSED"));
    h.api.0.lock().unwrap().queue.push(cmd("b1", "start"));
    assert!(wait_until(15, || h.both_running().is_some()), "{}", h.log());
    h.finish().unwrap();
}

struct FixedStats;
impl PoolStatsSource for FixedStats {
    fn fetch(&self, prefix: &str) -> Result<PoolStatsSnapshot, StatsError> {
        assert_eq!(prefix, "account.rig1", "the worker prefix is the configured user identity");
        Ok(PoolStatsSnapshot {
            provider: "braiins".into(),
            fetched_at_unix: btc_agent::timeutil::now_unix(),
            source: SOURCE_NOTE.into(),
            workers_matched: 1,
            shares_60m: Some(1234),
            ..Default::default()
        })
    }
}

#[test]
fn pool_reported_stats_are_shown_locally_but_never_become_agent_counters_or_telemetry() {
    let d = tempfile::tempdir().unwrap();
    let tp = wrapper(d.path(), &[]);
    let mut cfg = sv2_config(tp, free_port(), &["--interval-ms", "100"]);
    cfg.pool_stats = PoolStatsConfig { enabled: false, ..PoolStatsConfig::default() };
    let mut h = start_in(d, cfg, timing(10), AgentState::Mining, Some(Box::new(FixedStats)));
    assert!(wait_until(15, || h.status().is_some_and(|s| s.pool_stats.is_some() && s.accepted_shares.unwrap_or(0) >= 2)), "{}", h.log());
    let s = h.status().unwrap();
    let p = s.pool_stats.unwrap();
    assert_eq!((p.shares_60m, p.workers_matched), (Some(1234), 1));
    assert!(p.source.contains("not counted by this agent"));
    assert_ne!(s.accepted_shares, Some(1234), "pool-reported numbers are not mixed into the agent's own counters");
    h.finish().unwrap();
    // Nothing from the pool stats reaches the server: the mock server only ever received telemetry rows.
    let rows = h.api.0.lock().unwrap().telemetry.clone();
    assert!(!format!("{rows:?}").contains("1234"));
}
