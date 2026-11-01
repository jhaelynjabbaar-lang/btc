//! Optional local status file (`status.json`), refreshed while the agent runs. Used by `btc-agent status`.

use crate::paths::Paths;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct StatusFile {
    pub pid: u32,
    pub running: bool,
    pub state: String,
    pub started_at_unix: u64,
    pub updated_at_unix: u64,
    pub worker_id: String,
    pub miner_running: bool,
    pub miner_pid: Option<u32>,
    /// `null` = unknown (never invented).
    pub hashrate_hs: Option<f64>,
    pub accepted_shares: Option<u64>,
    pub rejected_shares: Option<u64>,
    pub telemetry_buffered: usize,
    pub last_telemetry_ok_unix: Option<u64>,
    pub last_command_poll_ok_unix: Option<u64>,
    pub agent_version: String,
    /// `"sv1"` (miner talks to the pool directly) or `"sv2"` (miner -> local translator proxy -> pool over Stratum V2).
    pub mode: String,
    /// Stratum V2 mode only: the second child process.
    pub translator_running: bool,
    pub translator_pid: Option<u32>,
    /// Loopback port the translator listens on (sv2 mode).
    pub translator_port: Option<u16>,
    /// Latest pool-reported stats (optional `[pool_stats]`). Local only: never sent to the server. `null` when disabled.
    pub pool_stats: Option<crate::poolstats::PoolStatsSnapshot>,
}

pub const FRESH_SECS: u64 = 30;

pub fn write(paths: &Paths, s: &StatusFile) -> Result<()> {
    let tmp = paths.dir.join("status.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s)?).context("writing status file")?;
    std::fs::rename(&tmp, paths.status()).context("replacing status file")?;
    Ok(())
}

pub fn read(paths: &Paths) -> Option<StatusFile> {
    serde_json::from_slice(&std::fs::read(paths.status()).ok()?).ok()
}

pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        use nix::errno::Errno;
        use nix::sys::signal::kill;
        use nix::unistd::Pid;
        match kill(Pid::from_raw(pid as i32), None) {
            Ok(()) => true,
            Err(Errno::EPERM) => true,
            Err(_) => false,
        }
    }
    #[cfg(windows)]
    {
        crate::winplat::pid_alive(pid)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        true
    }
}

/// Is another agent instance currently running against this state dir?
pub fn running_instance(paths: &Paths, now: u64) -> Option<StatusFile> {
    let s = read(paths)?;
    (s.running && s.pid != std::process::id() && now.saturating_sub(s.updated_at_unix) <= FRESH_SECS && pid_alive(s.pid)).then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_running_detection() {
        let d = tempfile::tempdir().unwrap();
        let p = Paths::new(d.path());
        assert!(read(&p).is_none());
        let s = StatusFile { pid: std::process::id() + 1, running: true, updated_at_unix: 1000, hashrate_hs: None, ..Default::default() };
        write(&p, &s).unwrap();
        assert_eq!(read(&p).unwrap(), s);
        let json = std::fs::read_to_string(p.status()).unwrap();
        assert!(json.contains("\"hashrate_hs\": null"), "unknown stays null: {json}");
        // other pid does not exist (very likely) or is stale
        assert!(running_instance(&p, 1000 + FRESH_SECS + 1).is_none());
    }

    #[test]
    fn own_pid_is_never_a_conflicting_instance() {
        let d = tempfile::tempdir().unwrap();
        let p = Paths::new(d.path());
        write(&p, &StatusFile { pid: std::process::id(), running: true, updated_at_unix: 5, ..Default::default() }).unwrap();
        assert!(running_instance(&p, 6).is_none());
    }
}
