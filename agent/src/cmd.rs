//! Implementations of the CLI subcommands (kept in the library so they can be tested).

use crate::api::{self, ErrorKind, HttpApi, validate_server_url};
use crate::commands::AgentState;
use crate::config::{Config, PoolMode, TEMPLATE};
use crate::consent::{self, ConsentStatus};
use crate::hardware;
use crate::identity::Identity;
use crate::logger::Logger;
use crate::paths::Paths;
use crate::protocol::normalize_enroll_code;
use crate::status;
use crate::supervisor::{Params, Supervisor, Timing};
use crate::timeutil::{format_duration, format_hashrate, now_unix, rfc3339};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerRecord {
    pub worker_id: String,
    pub name: Option<String>,
    pub server_url: String,
    pub hardware_type: String,
    pub enrolled_at: String,
}

pub fn load_worker(paths: &Paths) -> Result<WorkerRecord> {
    let text =
        std::fs::read_to_string(paths.worker_json()).context("this machine is not enrolled yet: run `btc-agent enroll --code <CODE>`")?;
    serde_json::from_str(&text).context("worker.json is corrupt")
}

// ------------------------------------------------------------------- enroll
pub struct EnrollArgs<'a> {
    pub code: &'a str,
    pub server: &'a str,
    pub name: Option<&'a str>,
    pub hardware_type: &'a str,
    pub force: bool,
}

pub fn enroll(paths: &Paths, a: EnrollArgs, out: &mut dyn Write) -> Result<WorkerRecord> {
    let code =
        normalize_enroll_code(a.code).context("that does not look like an enrollment code (expected BTCW-XXXXX-XXXXX-XXXXX-XXXXX)")?;
    let server = validate_server_url(a.server)?;
    if !matches!(a.hardware_type, "cpu" | "gpu") {
        bail!("--hardware-type must be cpu or gpu");
    }
    if let Some(n) = a.name {
        let ok = n.len() <= 63
            && n.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
            && n.chars().all(|c| c.is_ascii_alphanumeric() || " ._-".contains(c));
        if !ok {
            bail!("--name must start with a letter or digit and use only letters, digits, space, '.', '_' or '-' (max 63 chars)");
        }
    }
    if paths.worker_json().exists() || paths.identity_key().exists() {
        if !a.force {
            bail!(
                "already enrolled (state in {}). Use `btc-agent uninstall` first, or pass --force to replace this identity",
                paths.dir.display()
            );
        }
        writeln!(out, "--force: replacing the previous identity. The old worker record stays on the server until its owner revokes it.")?;
        secure_remove(&paths.identity_key())?;
        let _ = std::fs::remove_file(paths.worker_json());
    }

    paths.ensure_dir()?;
    let hw = hardware::detect();
    let identity = Identity::generate();
    identity.save_new(&paths.identity_key())?;
    writeln!(
        out,
        "Generated a new Ed25519 identity. The private key stays in {} (private, mode 0600) and is never sent.",
        paths.identity_key().display()
    )?;
    writeln!(out, "Hardware: {}", hw.summary())?;

    let hw_json = hw.to_enroll_json(a.hardware_type, crate::AGENT_VERSION);
    let res = match api::enroll(&server, &identity, &code, a.name, hw_json) {
        Ok(r) => r,
        Err(e) => {
            let _ = secure_remove(&paths.identity_key());
            let hint = match e.kind {
                ErrorKind::Unauthorized => {
                    " (the code may be wrong, already used or older than 15 minutes, or this machine's clock is off; ask for a new code)"
                }
                ErrorKind::RateLimited => " (too many attempts; wait a minute)",
                _ => "",
            };
            bail!("enrollment failed: {e}{hint}. The new local key was discarded.");
        }
    };

    let rec = WorkerRecord {
        worker_id: res.worker_id,
        name: res.name,
        server_url: server,
        hardware_type: a.hardware_type.to_string(),
        enrolled_at: rfc3339(now_unix()),
    };
    std::fs::write(paths.worker_json(), serde_json::to_vec_pretty(&rec)?).context("saving worker.json")?;
    if !paths.config().exists() {
        std::fs::write(paths.config(), TEMPLATE).context("writing config.toml")?;
    }
    writeln!(out, "Enrolled. Worker id: {}", rec.worker_id)?;
    writeln!(
        out,
        "Next steps:\n  1. edit {} (miner path, pool, PUBLIC payout address)\n  2. btc-agent consent\n  3. btc-agent run",
        paths.config().display()
    )?;
    Ok(rec)
}

// ------------------------------------------------------------------- consent
pub fn consent_cmd(paths: &Paths, revoke: bool, input: &mut dyn BufRead, out: &mut dyn Write, interactive: bool) -> Result<()> {
    if revoke {
        if consent::revoke(paths)? {
            writeln!(
                out,
                "Consent withdrawn. `btc-agent run` will refuse to start, and a running agent will stop itself within a minute."
            )?;
        } else {
            writeln!(out, "No consent was recorded.")?;
        }
        return Ok(());
    }
    if !interactive {
        bail!("consent has to be typed by a person at a terminal (stdin is not a terminal)");
    }
    consent::prompt_and_store(paths, input, out)?;
    Ok(())
}

// -------------------------------------------------------------------- status
pub fn status_cmd(paths: &Paths, out: &mut dyn Write) -> Result<()> {
    let now = now_unix();
    writeln!(out, "BTC Network AI agent {}", crate::AGENT_VERSION)?;
    writeln!(out, "  state dir : {}", paths.dir.display())?;
    match load_worker(paths) {
        Ok(w) => writeln!(out, "  enrolled  : yes, worker {} on {} (since {})", w.worker_id, w.server_url, w.enrolled_at)?,
        Err(_) => writeln!(out, "  enrolled  : NO (run `btc-agent enroll --code <CODE>`)")?,
    }
    match Identity::load(&paths.identity_key()) {
        Ok(_) => writeln!(out, "  key       : present, permissions OK (private key never leaves this machine)")?,
        Err(e) => writeln!(out, "  key       : {e:#}")?,
    }
    match consent::status(paths) {
        ConsentStatus::Valid(r) => writeln!(out, "  consent   : yes, recorded {} (text v{})", r.accepted_at, r.version)?,
        ConsentStatus::Missing => writeln!(out, "  consent   : NO, mining will not start (run `btc-agent consent`)")?,
        ConsentStatus::Outdated { recorded } => {
            writeln!(out, "  consent   : OUTDATED (recorded v{recorded}); run `btc-agent consent` again")?
        }
        ConsentStatus::Corrupt => writeln!(out, "  consent   : unreadable; run `btc-agent consent` again")?,
    }
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    match Config::load(&paths.config()) {
        Err(e) => writeln!(out, "  config    : {e:#}")?,
        Ok(c) => {
            let problems = c.problems(cpus);
            if problems.is_empty() {
                let (host, via) = match c.effective_mode() {
                    PoolMode::Sv1 => (
                        c.pool
                            .url
                            .as_deref()
                            .and_then(|u| url::Url::parse(u).ok())
                            .and_then(|u| u.host_str().map(str::to_string))
                            .unwrap_or_default(),
                        "Stratum V1, direct".to_string(),
                    ),
                    PoolMode::Sv2 => (
                        c.stratum_v2.upstream_address.clone().unwrap_or_default(),
                        format!("Stratum V2 via local translator on 127.0.0.1:{}", c.stratum_v2.downstream_port),
                    ),
                };
                writeln!(
                    out,
                    "  config    : valid (mode {}, pool {host} [{via}], miner {}, {} thread(s))",
                    c.effective_mode().label(),
                    c.miner.path.as_ref().map(|p| p.display().to_string()).unwrap_or_default(),
                    c.effective_threads(cpus)
                )?;
            } else {
                writeln!(out, "  config    : {} problem(s) in {}:", problems.len(), paths.config().display())?;
                for p in problems {
                    writeln!(out, "              - {p}")?;
                }
            }
        }
    }
    match status::read(paths) {
        Some(s) if s.running && now.saturating_sub(s.updated_at_unix) <= status::FRESH_SECS && status::pid_alive(s.pid) => {
            writeln!(
                out,
                "  agent     : RUNNING (pid {}), state {}, up {}",
                s.pid,
                s.state,
                format_duration(now.saturating_sub(s.started_at_unix))
            )?;
            writeln!(
                out,
                "  miner     : {}",
                match s.miner_pid {
                    Some(p) => format!("running (pid {p})"),
                    None => "not running".into(),
                }
            )?;
            if s.mode == "sv2" {
                writeln!(
                    out,
                    "  translator: {} (listens on 127.0.0.1:{})",
                    match s.translator_pid {
                        Some(p) => format!("running (pid {p})"),
                        None => "not running".into(),
                    },
                    s.translator_port.map_or("?".to_string(), |p| p.to_string())
                )?;
            }
            let n = |v: Option<u64>| v.map_or("unknown".to_string(), |x| x.to_string());
            writeln!(
                out,
                "  mining    : hashrate {}, accepted {}, rejected {} ({})",
                format_hashrate(s.hashrate_hs),
                n(s.accepted_shares),
                n(s.rejected_shares),
                if s.mode == "sv2" { "shares counted only when the pool confirms them" } else { "as reported by the miner" }
            )?;
            if let Some(p) = &s.pool_stats {
                let n = |v: Option<u64>| v.map_or("unknown".to_string(), |x| x.to_string());
                writeln!(
                    out,
                    "  pool says : {} worker(s) matched, shares last 5m/60m/24h {}/{}/{}, last share {} ({}s ago when fetched; {})",
                    p.workers_matched,
                    n(p.shares_5m),
                    n(p.shares_60m),
                    n(p.shares_24h),
                    p.last_share_unix.map_or("unknown".to_string(), |t| format!("{}s ago", now.saturating_sub(t))),
                    now.saturating_sub(p.fetched_at_unix),
                    p.source
                )?;
            }
            writeln!(
                out,
                "  telemetry : {} row(s) buffered; last upload {}",
                s.telemetry_buffered,
                s.last_telemetry_ok_unix.map_or("never".into(), |t| format!("{}s ago", now.saturating_sub(t)))
            )?;
        }
        Some(s) => writeln!(
            out,
            "  agent     : not running (last seen {} ago, state was {})",
            format_duration(now.saturating_sub(s.updated_at_unix)),
            s.state
        )?,
        None => writeln!(out, "  agent     : not running")?,
    }
    writeln!(out, "  log       : {}", paths.log().display())?;
    Ok(())
}

// --------------------------------------------------------------------- run
pub fn run_cmd(paths: &Paths, start_paused: bool) -> Result<()> {
    consent::require(paths)?;
    let worker = load_worker(paths)?;
    let identity = Identity::load(&paths.identity_key())?;
    let cfg = Config::load(&paths.config()).context("run `btc-agent enroll` first, then edit config.toml")?;
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let problems = cfg.problems(cpus);
    if !problems.is_empty() {
        let list: Vec<String> = problems.iter().map(|p| format!("  - {p}")).collect();
        bail!("config problems in {}:\n{}", paths.config().display(), list.join("\n"));
    }
    if let Some(other) = status::running_instance(paths, now_unix()) {
        bail!("another btc-agent is already running for this config (pid {})", other.pid);
    }
    let miner_cmd = cfg.miner_command(cpus)?;
    let log = Logger::new(&paths.log(), true).context("opening the log file")?;
    let hw = hardware::detect();
    log.info(format!("hardware: {}", hw.summary()));

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        ctrlc::set_handler(move || stop.store(true, Ordering::SeqCst)).context("installing the Ctrl-C handler")?;
    }
    let api = HttpApi::new(&worker.server_url, &worker.worker_id, Arc::new(identity));
    let pool_stats = crate::poolstats::BraiinsClient::from_config(&cfg).map_err(|e| anyhow::anyhow!("pool_stats: {e}"))?;
    let mut sup = Supervisor::new(Params {
        paths: paths.clone(),
        timing: Timing::from_config(&cfg),
        cfg,
        miner_cmd,
        worker_id: worker.worker_id,
        api: Box::new(api),
        log,
        start_state: if start_paused { AgentState::Paused } else { AgentState::Mining },
        logical_cpus: cpus,
    })?;
    if let Some(c) = pool_stats {
        sup = sup.with_pool_stats(Box::new(c));
    }
    sup.run(stop)
}

// ---------------------------------------------------------------- uninstall
fn secure_remove(path: &std::path::Path) -> Result<()> {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.is_file() {
            // Best effort: overwrite before unlinking (not a guarantee on journaling / SSD storage).
            let _ = std::fs::write(path, vec![0u8; meta.len() as usize]);
        }
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("deleting {}", path.display())),
    }
}

pub fn uninstall_cmd(paths: &Paths, yes: bool, input: &mut dyn BufRead, out: &mut dyn Write) -> Result<bool> {
    if let Some(r) = status::running_instance(paths, now_unix()) {
        bail!("the agent is running (pid {}); stop it with Ctrl-C first", r.pid);
    }
    if !paths.dir.exists() {
        writeln!(out, "Nothing to uninstall: {} does not exist.", paths.dir.display())?;
        return Ok(false);
    }
    if !yes {
        writeln!(
            out,
            "This permanently deletes this machine's agent identity (private key), enrollment, config, consent and logs in {}.",
            paths.dir.display()
        )?;
        write!(out, "Type \"yes\" to continue: ")?;
        out.flush()?;
        let mut line = String::new();
        input.read_line(&mut line)?;
        if !line.trim().eq_ignore_ascii_case("yes") {
            writeln!(out, "Cancelled; nothing was deleted.")?;
            return Ok(false);
        }
    }
    let _ = secure_remove(&paths.identity_key());
    for f in paths.all_files() {
        secure_remove(&f)?;
    }
    let _ = std::fs::remove_file(paths.dir.join("status.json.tmp"));
    match std::fs::remove_dir(&paths.dir) {
        Ok(()) => {}
        Err(_) => writeln!(out, "Note: {} still contains files that are not the agent's; they were left alone.", paths.dir.display())?,
    }
    writeln!(out, "Uninstalled: local keys, config, consent and logs deleted.")?;
    writeln!(
        out,
        "The server still lists this worker; ask the platform owner to revoke it on the Workers page. The miner program you installed separately is untouched."
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn setup() -> (tempfile::TempDir, Paths) {
        let d = tempfile::tempdir().unwrap();
        let p = Paths::new(d.path().join("home"));
        (d, p)
    }

    #[test]
    fn run_refuses_without_consent_before_touching_anything() {
        let (_d, p) = setup();
        let err = run_cmd(&p, false).unwrap_err().to_string();
        assert!(err.contains("no consent recorded"), "{err}");
        assert!(!p.dir.exists(), "refusing must not create state");
    }

    #[test]
    fn run_refuses_when_consented_but_not_enrolled() {
        let (_d, p) = setup();
        consent::store(&p).unwrap();
        let err = run_cmd(&p, false).unwrap_err().to_string();
        assert!(err.contains("not enrolled"), "{err}");
    }

    #[test]
    fn consent_cmd_needs_a_terminal_and_supports_revoke() {
        let (_d, p) = setup();
        let mut out = Vec::new();
        let err = consent_cmd(&p, false, &mut Cursor::new(b"yes\n".to_vec()), &mut out, false).unwrap_err();
        assert!(err.to_string().contains("terminal"));
        assert!(consent::require(&p).is_err(), "piped input must not grant consent");
        consent_cmd(&p, false, &mut Cursor::new(b"yes\n".to_vec()), &mut out, true).unwrap();
        assert!(consent::require(&p).is_ok());
        consent_cmd(&p, true, &mut Cursor::new(vec![]), &mut out, false).unwrap();
        assert!(consent::require(&p).is_err());
    }

    #[test]
    fn enroll_validates_before_creating_a_key() {
        let (_d, p) = setup();
        let mut out = Vec::new();
        let base = EnrollArgs {
            code: "BTCW-ABCDE-FGHJK-MNPQR-STVWX",
            server: "https://example.invalid",
            name: None,
            hardware_type: "cpu",
            force: false,
        };
        for bad in [
            EnrollArgs { code: "garbage", ..base_clone(&base) },
            EnrollArgs { server: "http://example.com", ..base_clone(&base) },
            EnrollArgs { hardware_type: "asic", ..base_clone(&base) },
            EnrollArgs { name: Some("-bad name"), ..base_clone(&base) },
        ] {
            assert!(enroll(&p, bad, &mut out).is_err());
            assert!(!p.identity_key().exists());
        }
    }

    fn base_clone<'a>(b: &EnrollArgs<'a>) -> EnrollArgs<'a> {
        EnrollArgs { code: b.code, server: b.server, name: b.name, hardware_type: b.hardware_type, force: b.force }
    }

    #[test]
    fn failed_enrollment_discards_the_new_key() {
        let (_d, p) = setup();
        let mut out = Vec::new();
        // loopback port 9: connection refused
        let args = EnrollArgs {
            code: "BTCW-ABCDE-FGHJK-MNPQR-STVWX",
            server: "http://127.0.0.1:9",
            name: None,
            hardware_type: "cpu",
            force: false,
        };
        let err = enroll(&p, args, &mut out).unwrap_err().to_string();
        assert!(err.contains("enrollment failed"), "{err}");
        assert!(!p.identity_key().exists() && !p.worker_json().exists());
        let shown = String::from_utf8(out).unwrap();
        assert!(!shown.contains("BTCW-ABCDE"), "the code is never echoed");
    }

    #[test]
    fn uninstall_deletes_everything_after_typed_yes_and_cancels_otherwise() {
        let (_d, p) = setup();
        p.ensure_dir().unwrap();
        Identity::generate().save_new(&p.identity_key()).unwrap();
        for f in [p.worker_json(), p.config(), p.consent(), p.log()] {
            std::fs::write(f, "x").unwrap();
        }
        let mut out = Vec::new();
        assert!(!uninstall_cmd(&p, false, &mut Cursor::new(b"no\n".to_vec()), &mut out).unwrap());
        assert!(p.identity_key().exists());
        assert!(uninstall_cmd(&p, false, &mut Cursor::new(b"yes\n".to_vec()), &mut out).unwrap());
        assert!(!p.dir.exists(), "state dir is removed when only agent files were in it");
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("revoke"), "tells the user the server-side record needs revoking");
    }

    #[test]
    fn uninstall_leaves_foreign_files_alone() {
        let (_d, p) = setup();
        p.ensure_dir().unwrap();
        std::fs::write(p.config(), "x").unwrap();
        std::fs::write(p.dir.join("mine.txt"), "keep").unwrap();
        uninstall_cmd(&p, true, &mut Cursor::new(vec![]), &mut Vec::new()).unwrap();
        assert!(p.dir.join("mine.txt").exists() && !p.config().exists());
    }

    #[test]
    fn status_reports_missing_pieces_without_failing() {
        let (_d, p) = setup();
        let mut out = Vec::new();
        status_cmd(&p, &mut out).unwrap();
        let t = String::from_utf8(out).unwrap();
        assert!(t.contains("enrolled  : NO") && t.contains("consent   : NO") && t.contains("not running"), "{t}");
    }
}
