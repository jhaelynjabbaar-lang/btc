#![cfg(unix)]
//! Command handling and the main loop, with a fake miner child process and a mock server.
mod common;

use btc_agent::commands::{AgentState, ServerCommand};
use btc_agent::consent;
use btc_agent::logger::Logger;
use btc_agent::paths::Paths;
use btc_agent::status;
use btc_agent::supervisor::{Params, Supervisor, Timing};
use common::*;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const WORKER: &str = "11111111-2222-4333-8444-555555555555";
const ID1: &str = "aaaaaaaa-2222-4333-8444-555555555551";
const ID2: &str = "aaaaaaaa-2222-4333-8444-555555555552";
const ID3: &str = "aaaaaaaa-2222-4333-8444-555555555553";

fn fast_timing() -> Timing {
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
        translator_startup: Duration::from_secs(5),
        translator_stop_grace: Duration::from_secs(2),
        pool_stats_poll: Duration::from_secs(3600),
        api_backoff_base: Duration::from_secs(1),
        api_backoff_max: Duration::from_secs(2),
    }
}

struct Harness {
    paths: Paths,
    _dir: tempfile::TempDir,
    api: MockApi,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<anyhow::Result<()>>>,
}

fn cmd(id: &str, c: &str) -> ServerCommand {
    ServerCommand { id: id.into(), command: c.into() }
}

fn start(miner_args: &[&str], start_state: AgentState, with_consent: bool) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("home"));
    paths.ensure_dir().unwrap();
    if with_consent {
        consent::store(&paths).unwrap();
    }
    let cfg = config_with(miner_args);
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
            timing: fast_timing(),
            start_state,
            logical_cpus: 8,
        })
        .unwrap();
        sup.run(stop2)
    });
    Harness { paths, _dir: dir, api, stop, handle: Some(handle) }
}

impl Harness {
    fn status(&self) -> Option<status::StatusFile> {
        status::read(&self.paths)
    }
    fn finish(&mut self) -> anyhow::Result<()> {
        self.stop.store(true, Ordering::SeqCst);
        self.handle.take().unwrap().join().unwrap()
    }
    fn log(&self) -> String {
        std::fs::read_to_string(self.paths.log()).unwrap_or_default()
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

fn pid_alive(pid: u32) -> bool {
    status::pid_alive(pid) && !std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| s.contains(") Z")).unwrap_or(false)
}

#[test]
fn mines_obeys_pause_start_stop_acks_each_and_stops_cleanly_on_exit() {
    let mut h = start(&["--rate", "3000", "--interval-ms", "100", "--reject-every", "3"], AgentState::Mining, true);

    // Mining: real numbers parsed from the miner's output.
    assert!(
        wait_until(10, || h.status().is_some_and(|s| s.miner_running
            && s.hashrate_hs == Some(3000.0)
            && s.accepted_shares.unwrap_or(0) >= 2
            && s.rejected_shares.unwrap_or(0) >= 1)),
        "log:\n{}",
        h.log()
    );
    let miner_pid = h.status().unwrap().miner_pid.unwrap();
    assert!(pid_alive(miner_pid));

    // pause -> miner is stopped, state paused, command acked
    h.api.0.lock().unwrap().queue.push(cmd(ID1, "pause"));
    assert!(wait_until(10, || h.status().is_some_and(|s| s.state == "paused" && !s.miner_running)), "log:\n{}", h.log());
    assert!(wait_until(5, || h.api.0.lock().unwrap().acked.contains(&ID1.to_string())));
    assert!(wait_until(3, || !pid_alive(miner_pid)), "paused means the miner process is really gone");
    assert!(h.status().unwrap().hashrate_hs.is_none(), "no stale hashrate while paused");

    // start -> a new miner process
    h.api.0.lock().unwrap().queue.push(cmd(ID2, "start"));
    assert!(
        wait_until(10, || h.status().is_some_and(|s| s.state == "mining" && s.miner_running && s.miner_pid != Some(miner_pid))),
        "log:\n{}",
        h.log()
    );
    assert!(wait_until(5, || h.api.0.lock().unwrap().acked.contains(&ID2.to_string())));

    // unknown commands are neither applied nor acked
    h.api.0.lock().unwrap().queue.push(cmd(ID3, "format-disk"));
    std::thread::sleep(Duration::from_millis(900));
    assert!(!h.api.0.lock().unwrap().acked.contains(&ID3.to_string()));
    assert_eq!(h.status().unwrap().state, "mining");
    h.api.0.lock().unwrap().queue.clear();

    // stop -> idle
    let second_pid = h.status().unwrap().miner_pid.unwrap();
    h.api.0.lock().unwrap().queue.push(cmd("aaaaaaaa-2222-4333-8444-555555555554", "stop"));
    assert!(wait_until(10, || h.status().is_some_and(|s| s.state == "stopped" && !s.miner_running)));
    assert!(wait_until(3, || !pid_alive(second_pid)));

    // back to mining, then Ctrl-C equivalent: everything stops, no orphan
    h.api.0.lock().unwrap().queue.push(cmd("aaaaaaaa-2222-4333-8444-555555555555", "start"));
    assert!(wait_until(10, || h.status().is_some_and(|s| s.miner_running)));
    let third_pid = h.status().unwrap().miner_pid.unwrap();
    h.finish().unwrap();
    assert!(!pid_alive(third_pid), "stopping the agent stops the miner");
    let s = h.status().unwrap();
    assert!(!s.running && s.state == "stopped");

    // Visibility: banner + log file are plain text.
    let log = h.log();
    assert!(log.contains("MINING IS ACTIVE ON THIS MACHINE"), "{log}");
    assert!(log.contains("MINING IS PAUSED") && log.contains("MINING STOPPED"));
    assert!(log.contains("accepted:"), "miner output is in the log");
    assert!(!log.contains("hunter22"), "pool password never reaches the log");
}

#[test]
fn start_paused_waits_for_a_server_start_command() {
    let mut h = start(&["--interval-ms", "100"], AgentState::Paused, true);
    assert!(wait_until(5, || h.status().is_some_and(|s| s.state == "paused" && !s.miner_running)));
    std::thread::sleep(Duration::from_millis(600));
    assert!(!h.status().unwrap().miner_running);
    h.api.0.lock().unwrap().queue.push(cmd(ID1, "start"));
    assert!(wait_until(10, || h.status().is_some_and(|s| s.miner_running)), "log:\n{}", h.log());
    h.finish().unwrap();
}

#[test]
fn unknown_values_stay_unknown_when_the_miner_prints_nothing_parsable() {
    let mut h = start(&["--silent"], AgentState::Mining, true);
    assert!(wait_until(5, || h.status().is_some_and(|s| s.miner_running)));
    std::thread::sleep(Duration::from_millis(800));
    let s = h.status().unwrap();
    assert_eq!((s.hashrate_hs, s.accepted_shares, s.rejected_shares), (None, None, None));
    h.finish().unwrap();
}

#[test]
fn crashed_miner_is_restarted_with_backoff_and_logged() {
    let mut h = start(&["--exit-after-ms", "300", "--interval-ms", "100"], AgentState::Mining, true);
    assert!(wait_until(15, || h.log().matches("miner started (pid").count() >= 2), "log:\n{}", h.log());
    assert!(h.log().contains("miner exited unexpectedly"));
    h.finish().unwrap();
}

#[test]
fn no_consent_means_the_miner_never_starts() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path().join("home"));
    paths.ensure_dir().unwrap();
    let cfg = config_with(&[]);
    let miner_cmd = cfg.miner_command(8).unwrap();
    let mut sup = Supervisor::new(Params {
        paths: paths.clone(),
        cfg,
        miner_cmd,
        worker_id: WORKER.into(),
        api: Box::new(MockApi::default()),
        log: Logger::new(&paths.log(), false).unwrap(),
        timing: fast_timing(),
        start_state: AgentState::Mining,
        logical_cpus: 8,
    })
    .unwrap();
    let err = sup.run(Arc::new(AtomicBool::new(false))).unwrap_err().to_string();
    assert!(err.contains("could not start the miner") && err.contains("no consent"), "{err}");
    assert!(!std::fs::read_to_string(paths.log()).unwrap().contains("miner started"));
}

#[test]
fn revoking_consent_stops_a_running_agent() {
    let mut h = start(&["--interval-ms", "100"], AgentState::Mining, true);
    // status line interval is 10s in fast_timing(); the consent re-check happens on that tick.
    assert!(wait_until(5, || h.status().is_some_and(|s| s.miner_running)));
    let pid = h.status().unwrap().miner_pid.unwrap();
    consent::revoke(&h.paths).unwrap();
    assert!(wait_until(20, || h.handle.as_ref().unwrap().is_finished()), "agent should exit after consent is revoked");
    let err = h.finish().unwrap_err().to_string();
    assert!(err.contains("consent revoked"));
    assert!(!pid_alive(pid));
}
