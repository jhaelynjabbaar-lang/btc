//! Explicit, local, typed consent. `run` refuses to start without a valid record.

use crate::paths::Paths;
use crate::timeutil::{now_unix, rfc3339};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};

/// Bump when the consent text materially changes; everyone must consent again.
pub const CONSENT_VERSION: u32 = 2;

pub const CONSENT_TEXT: &str = "\
BTC NETWORK AI AGENT - WHAT THIS PROGRAM DOES
=============================================
This agent turns THIS computer into a Bitcoin mining worker for the BTC Network AI platform.

If you continue, then whenever you run `btc-agent run`:
  * It starts an existing open-source miner program (the one named in your config.toml) as a child process.
    The agent does not contain a miner.
  * That miner uses your CPU/GPU, electricity and cooling, and makes the machine warmer and louder.
  * It connects the miner to the mining pool in your config, with the pool user/password you configured.
    In Stratum V2 mode (`mode = \"sv2\"`) it ALSO starts a second open-source program as a child process, the SRI
    translator proxy (`translator_sv2`). It listens on this machine only (127.0.0.1); your miner connects to it and
    it connects to the pool over Stratum V2. The agent writes the proxy's config file (no secrets) and stops both
    programs together.
  * If you enable `[pool_stats]`, it also asks the pool's own account API for stats about your workers, using an
    API token you store in a file only you can read. Those numbers are shown locally and are never sent to the
    BTC Network AI server.
  * It sends one-minute telemetry to the BTC Network AI server: hashrate, accepted/rejected share counts as
    reported by the miner/pool, uptime, agent version. Hardware info (OS, CPU model, core count, memory, GPU name
    when detectable) is sent once, at enrollment. Nothing else is collected: no files, no browsing, no keystrokes.
  * It polls the server for start / pause / stop commands from the owner of this enrollment and obeys them.
  * It signs every request with a private key kept ONLY in a 0600 file on this machine. That key is never sent.

How you stay in control:
  * It is NEVER hidden. It runs in your terminal, prints a banner and periodic status lines, and keeps a
    plain-text log you can read. `btc-agent status` shows what it is doing. Ctrl-C stops the miner (and the translator
    proxy, if used) and the agent.
  * `btc-agent consent --revoke` withdraws consent (a running agent stops itself); `btc-agent uninstall` deletes
    the key and all local files.

What to expect honestly:
  * Mining Bitcoin on a CPU or GPU is extremely unprofitable compared with ASIC miners. Electricity will almost
    certainly cost more than anything you could earn. Accepted shares are only what the pool reports; this agent
    does not promise or estimate earnings.

Only continue if you own this machine or are explicitly authorized to run mining on it.
";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConsentRecord {
    pub version: u32,
    pub accepted_at: String,
    pub accepted_at_unix: u64,
    pub agent_version: String,
    pub answer: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConsentStatus {
    Missing,
    Outdated { recorded: u32 },
    Corrupt,
    Valid(ConsentRecord),
}

pub fn status(paths: &Paths) -> ConsentStatus {
    let Ok(text) = std::fs::read_to_string(paths.consent()) else { return ConsentStatus::Missing };
    match serde_json::from_str::<ConsentRecord>(&text) {
        Err(_) => ConsentStatus::Corrupt,
        Ok(r) if r.version != CONSENT_VERSION => ConsentStatus::Outdated { recorded: r.version },
        Ok(r) if r.answer != "yes" => ConsentStatus::Corrupt,
        Ok(r) => ConsentStatus::Valid(r),
    }
}

/// `Ok(record)` only when valid consent is stored; otherwise an error telling the user what to do.
pub fn require(paths: &Paths) -> Result<ConsentRecord> {
    match status(paths) {
        ConsentStatus::Valid(r) => Ok(r),
        ConsentStatus::Missing => {
            anyhow::bail!("no consent recorded. Run `btc-agent consent` and read what this agent does; mining will not start without it")
        }
        ConsentStatus::Outdated { recorded } => anyhow::bail!(
            "consent was recorded for version {recorded} of the consent text (now {CONSENT_VERSION}); run `btc-agent consent` again"
        ),
        ConsentStatus::Corrupt => anyhow::bail!("consent record is unreadable; run `btc-agent consent` again"),
    }
}

/// Show the text and ask the user to type `yes`. Returns whether consent was stored.
/// Only a typed `yes` (any case, surrounding spaces ignored) counts; anything else, including EOF, is a no.
pub fn prompt_and_store(paths: &Paths, input: &mut dyn BufRead, out: &mut dyn Write) -> Result<bool> {
    writeln!(out, "{CONSENT_TEXT}")?;
    write!(out, "Type \"yes\" to give consent, anything else to cancel: ")?;
    out.flush()?;
    let mut line = String::new();
    input.read_line(&mut line).context("reading answer")?;
    if !line.trim().eq_ignore_ascii_case("yes") {
        writeln!(out, "No consent recorded. Mining will not run.")?;
        return Ok(false);
    }
    store(paths)?;
    writeln!(out, "Consent recorded at {}.", rfc3339(now_unix()))?;
    Ok(true)
}

pub fn store(paths: &Paths) -> Result<ConsentRecord> {
    paths.ensure_dir()?;
    let now = now_unix();
    let rec = ConsentRecord {
        version: CONSENT_VERSION,
        accepted_at: rfc3339(now),
        accepted_at_unix: now,
        agent_version: crate::AGENT_VERSION.to_string(),
        answer: "yes".into(),
    };
    std::fs::write(paths.consent(), serde_json::to_vec_pretty(&rec)?).context("writing consent record")?;
    Ok(rec)
}

pub fn revoke(paths: &Paths) -> Result<bool> {
    match std::fs::remove_file(paths.consent()) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e).context("removing consent record"),
    }
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

    fn ask(p: &Paths, answer: &str) -> (bool, String) {
        let mut out = Vec::new();
        let ok = prompt_and_store(p, &mut Cursor::new(answer.as_bytes().to_vec()), &mut out).unwrap();
        (ok, String::from_utf8(out).unwrap())
    }

    #[test]
    fn run_gate_is_closed_without_consent() {
        let (_d, p) = setup();
        assert_eq!(status(&p), ConsentStatus::Missing);
        assert!(require(&p).unwrap_err().to_string().contains("no consent recorded"));
    }

    #[test]
    fn only_a_typed_yes_opens_the_gate_and_is_timestamped() {
        let (_d, p) = setup();
        for no in ["", "no\n", "y\n", "yes please\n", "YESS\n", "\n"] {
            let (ok, out) = ask(&p, no);
            assert!(!ok, "{no:?}");
            assert!(out.contains("No consent recorded"));
            assert!(require(&p).is_err());
        }
        let (ok, out) = ask(&p, "  YeS \n");
        assert!(ok);
        assert!(out.contains("BTC NETWORK AI AGENT"));
        let rec = require(&p).unwrap();
        assert_eq!(rec.version, CONSENT_VERSION);
        assert_eq!(rec.answer, "yes");
        assert!(rec.accepted_at.ends_with('Z') && rec.accepted_at_unix > 1_700_000_000);
    }

    #[test]
    fn outdated_corrupt_and_revoked_consent_closes_the_gate() {
        let (_d, p) = setup();
        store(&p).unwrap();
        assert!(require(&p).is_ok());

        let mut rec = require(&p).unwrap();
        rec.version = 0;
        std::fs::write(p.consent(), serde_json::to_vec(&rec).unwrap()).unwrap();
        assert!(require(&p).unwrap_err().to_string().contains("consent was recorded for version"));

        std::fs::write(p.consent(), b"{ not json").unwrap();
        assert_eq!(status(&p), ConsentStatus::Corrupt);
        assert!(require(&p).is_err());

        store(&p).unwrap();
        assert!(revoke(&p).unwrap());
        assert!(!revoke(&p).unwrap());
        assert!(require(&p).is_err());
    }

    #[test]
    fn consent_text_states_the_important_facts() {
        for needle in [
            "NEVER hidden",
            "unprofitable",
            "ASIC",
            "does not contain a miner",
            "never sent",
            "own this machine",
            "Ctrl-C",
            "--revoke",
            "uninstall",
        ] {
            assert!(CONSENT_TEXT.contains(needle), "consent text must mention {needle:?}");
        }
    }
}
