//! End-to-end checks of the real `btc-agent` binary that must hold on every OS (Linux and Windows CI both run them):
//! consent cannot be given through a pipe, and `run` refuses to start without consent.

use std::io::Write;
use std::process::{Command, Stdio};

fn agent(home: &std::path::Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_btc-agent"));
    c.arg("--home").arg(home).env_remove("BTC_AGENT_HOME");
    c
}

#[test]
fn piped_input_can_never_grant_consent() {
    let home = tempfile::tempdir().unwrap();
    let mut child = agent(home.path()).arg("consent").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"yes\r\nyes\n").unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(!out.status.success(), "consent through a pipe must fail");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("terminal"), "{err}");
    assert!(!home.path().join("consent.json").exists(), "no consent record may be written");
}

#[test]
fn run_refuses_without_consent_and_creates_nothing() {
    let home = tempfile::tempdir().unwrap();
    let state = home.path().join("state");
    let out = agent(&state).arg("run").stdin(Stdio::null()).output().unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("no consent recorded"), "{err}");
    assert!(!state.exists());
}

#[test]
fn status_works_on_a_fresh_machine() {
    let home = tempfile::tempdir().unwrap();
    let state = home.path().join("state");
    let out = agent(&state).arg("status").stdin(Stdio::null()).output().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("enrolled  : NO") && text.contains("consent   : NO"), "{text}");
}
