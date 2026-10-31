#![cfg(unix)]
//! Child-process control and output parsing against the fake miner.
mod common;

use btc_agent::config::MinerKind;
use btc_agent::miner::{MinerLine, MinerProcess, StopOutcome};
use btc_agent::parse::{LineParser, MinerEvent};
use btc_agent::telemetry::MinerStats;
use common::*;
use std::sync::mpsc;
use std::time::Duration;

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
        && !std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| s.contains(") Z")).unwrap_or(true)
}

fn collect(rx: &mpsc::Receiver<MinerLine>, secs: u64, mut done: impl FnMut(&[MinerLine]) -> bool) -> Vec<MinerLine> {
    let mut lines = vec![];
    let end = std::time::Instant::now() + Duration::from_secs(secs);
    while std::time::Instant::now() < end && !done(&lines) {
        if let Ok(l) = rx.recv_timeout(Duration::from_millis(100)) {
            lines.push(l);
        }
    }
    lines
}

#[test]
fn spawns_reads_output_parses_numbers_and_stops_cleanly() {
    let cfg = config_with(&["--rate", "2000", "--interval-ms", "100", "--reject-every", "4", "-o", "{pool_url}", "-p", "{pool_password}"]);
    let cmd = cfg.miner_command(8).unwrap();
    assert!(!cmd.display_args.join(" ").contains("hunter22"));
    let (tx, rx) = mpsc::channel();
    let mut m = MinerProcess::spawn(&cmd, tx, 1).unwrap();
    let pid = m.pid;

    let lines = collect(&rx, 10, |ls| ls.iter().filter(|l| l.text.contains("accepted:")).count() >= 8);
    assert!(lines.iter().any(|l| l.text.starts_with("fake-miner: started")));
    assert!(lines.iter().any(|l| l.stderr && l.text.contains("stderr is captured")), "stderr is read too");
    assert!(lines.iter().all(|l| l.generation == 1));

    let parser = LineParser::new(&cfg.miner).unwrap();
    let mut stats = MinerStats::default();
    let mut last_hr = None;
    for l in &lines {
        for ev in parser.parse(&l.text) {
            if let (Some(h), _, _) = stats.apply(&ev, 1000) {
                last_hr = Some(h);
            }
        }
    }
    assert_eq!(last_hr, Some(2000.0), "2000 H/s printed as 2.00 khash/sec");
    assert!(stats.accepted.unwrap() >= 5);
    assert!(stats.rejected.unwrap() >= 1, "every 4th share is rejected");

    // Still running; stop it. SIGTERM kills the fake miner immediately.
    assert!(m.try_wait().is_none());
    let outcome = m.stop(Duration::from_secs(3));
    assert!(matches!(outcome, StopOutcome::Graceful | StopOutcome::Killed), "{outcome:?}");
    assert!(m.try_wait().is_some());
    #[cfg(unix)]
    assert!(!pid_alive(pid), "miner process must be gone after stop");
    assert_eq!(m.stop(Duration::from_secs(1)), StopOutcome::AlreadyExited);
}

#[test]
fn dropping_the_handle_never_orphans_the_miner() {
    let cfg = config_with(&[]);
    let (tx, _rx) = mpsc::channel();
    let m = MinerProcess::spawn(&cfg.miner_command(8).unwrap(), tx, 1).unwrap();
    let pid = m.pid;
    drop(m);
    #[cfg(unix)]
    assert!(wait_until(3, || !pid_alive(pid)));
    let _ = pid;
}

#[test]
fn detects_a_crashing_miner() {
    let cfg = config_with(&["--exit-after-ms", "200"]);
    let (tx, _rx) = mpsc::channel();
    let mut m = MinerProcess::spawn(&cfg.miner_command(8).unwrap(), tx, 1).unwrap();
    let mut status = None;
    assert!(wait_until(5, || {
        status = m.try_wait();
        status.is_some()
    }));
    assert_eq!(status.unwrap().code(), Some(3));
}

#[test]
fn silent_miner_yields_no_numbers() {
    let cfg = config_with(&["--silent", "--interval-ms", "50"]);
    let (tx, rx) = mpsc::channel();
    let mut m = MinerProcess::spawn(&cfg.miner_command(8).unwrap(), tx, 1).unwrap();
    let lines = collect(&rx, 1, |_| false);
    m.stop(Duration::from_secs(2));
    let parser = LineParser::new(&cfg.miner).unwrap();
    let events: Vec<MinerEvent> = lines.iter().flat_map(|l| parser.parse(&l.text)).collect();
    assert!(events.is_empty(), "{events:?}");
    let stats = MinerStats::default();
    assert_eq!((stats.accepted, stats.rejected, stats.current_hashrate(1)), (None, None, None));
    let _ = MinerKind::Cpuminer;
}

#[test]
fn missing_binary_is_a_clear_error() {
    let mut cfg = config_with(&[]);
    cfg.miner.path = Some("/nonexistent/miner".into());
    let (tx, _rx) = mpsc::channel();
    let err = MinerProcess::spawn(&cfg.miner_command(8).unwrap(), tx, 1).err().unwrap().to_string();
    assert!(err.contains("starting miner"), "{err}");
}
