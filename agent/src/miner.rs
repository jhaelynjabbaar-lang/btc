//! The miner (and, in Stratum V2 mode, the local translator proxy) is an existing open-source program run as a visible
//! child process. This module only starts it, reads its output line by line, and stops it (SIGTERM, then kill on unix;
//! `taskkill /T /F` on Windows, which also ends anything the child started). It never hides the process: on Windows it
//! shares the agent's own console window.

use crate::config::MinerCommand;
use anyhow::{Context, Result};
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

/// Which child process a line came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Miner,
    Translator,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Miner => "miner",
            Source::Translator => "translator",
        }
    }
}

/// A line of child output tagged with the process generation, so output from a replaced process is ignored.
#[derive(Debug)]
pub struct MinerLine {
    pub source: Source,
    pub generation: u64,
    pub stderr: bool,
    pub text: String,
}

const MAX_LINE: usize = 8 * 1024;

pub struct MinerProcess {
    child: Child,
    pub pid: u32,
    pub generation: u64,
    pub started: Instant,
}

fn spawn_reader<R: Read + Send + 'static>(mut r: R, tx: Sender<MinerLine>, source: Source, generation: u64, stderr: bool) {
    std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(256);
        let mut chunk = [0u8; 4096];
        let flush = |buf: &mut Vec<u8>, tx: &Sender<MinerLine>| -> bool {
            if buf.is_empty() {
                return true;
            }
            let text = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            tx.send(MinerLine { source, generation, stderr, text }).is_ok()
        };
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    flush(&mut buf, &tx);
                    return;
                }
                Ok(n) => {
                    for &b in &chunk[..n] {
                        if b == b'\n' || b == b'\r' {
                            if !flush(&mut buf, &tx) {
                                return;
                            }
                        } else if buf.len() < MAX_LINE {
                            buf.push(b);
                        }
                    }
                }
            }
        }
    });
}

impl MinerProcess {
    /// Start the miner with stdin closed and stdout/stderr piped into `tx`. No window hiding, no renaming.
    pub fn spawn(cmd: &MinerCommand, tx: Sender<MinerLine>, generation: u64) -> Result<Self> {
        Self::spawn_as(cmd, tx, generation, Source::Miner)
    }

    /// Same as [`spawn`](Self::spawn) for either child (`Source::Translator` for the SV2 translator proxy).
    pub fn spawn_as(cmd: &MinerCommand, tx: Sender<MinerLine>, generation: u64, source: Source) -> Result<Self> {
        let mut command = Command::new(&cmd.program);
        command
            .args(&cmd.args)
            .envs(cmd.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Own process group (NOT a hidden window: the child still prints into this console). A Ctrl-C in the console
            // then reaches only the agent, which stops its children itself in an orderly way.
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            command.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }
        let mut child = command.spawn().with_context(|| format!("starting {} {}", source.label(), cmd.program.display()))?;
        let pid = child.id();
        if let Some(o) = child.stdout.take() {
            spawn_reader(o, tx.clone(), source, generation, false);
        }
        if let Some(e) = child.stderr.take() {
            spawn_reader(e, tx, source, generation, true);
        }
        Ok(MinerProcess { child, pid, generation, started: Instant::now() })
    }

    /// `Some(status)` once the process has exited.
    pub fn try_wait(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Ask the miner to stop (SIGTERM on unix), wait up to `grace`, then kill it. Always reaps the child.
    pub fn stop(&mut self, grace: Duration) -> StopOutcome {
        if self.try_wait().is_some() {
            return StopOutcome::AlreadyExited;
        }
        #[cfg(unix)]
        {
            use nix::sys::signal::{Signal, kill};
            use nix::unistd::Pid;
            let _ = kill(Pid::from_raw(self.pid as i32), Signal::SIGTERM);
            let deadline = Instant::now() + grace;
            while Instant::now() < deadline {
                if self.try_wait().is_some() {
                    return StopOutcome::Graceful;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        #[cfg(not(unix))]
        let _ = grace;
        #[cfg(windows)]
        {
            // The whole tree, so a miner started through a wrapper (.bat / launcher) does not leave a worker behind.
            let _ = crate::winplat::kill_process_tree(self.pid);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        StopOutcome::Killed
    }
}

impl Drop for MinerProcess {
    /// Never leave an orphaned child behind, even on panic.
    fn drop(&mut self) {
        if self.try_wait().is_none() {
            #[cfg(windows)]
            let _ = crate::winplat::kill_process_tree(self.pid);
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StopOutcome {
    AlreadyExited,
    Graceful,
    Killed,
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::sync::mpsc::{RecvTimeoutError, channel};

    fn cmd(program: &str, args: &[&str]) -> MinerCommand {
        MinerCommand {
            program: program.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            display_args: Vec::new(),
            pool_password: None,
            env: Vec::new(),
        }
    }

    #[test]
    fn stop_ends_the_child_and_its_pid_is_gone() {
        let (tx, _rx) = channel();
        let mut p = MinerProcess::spawn(&cmd("ping.exe", &["-n", "60", "127.0.0.1"]), tx, 1).unwrap();
        assert!(crate::status::pid_alive(p.pid), "child should be running");
        let pid = p.pid;
        assert_eq!(p.stop(Duration::from_secs(2)), StopOutcome::Killed);
        assert!(!crate::status::pid_alive(pid), "child must be gone after stop");
    }

    #[test]
    fn stop_kills_the_whole_tree_so_no_orphan_keeps_the_output_pipe_open() {
        let (tx, rx) = channel();
        // cmd.exe starts ping.exe as a grandchild that inherits the pipes; if it survived, the readers would never see EOF.
        let mut p = MinerProcess::spawn(&cmd("cmd.exe", &["/C", "ping -n 60 127.0.0.1"]), tx, 1).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        p.stop(Duration::from_secs(2));
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) if Instant::now() > deadline => panic!("an orphaned grandchild still holds the pipe"),
                _ => {}
            }
        }
    }

    #[test]
    fn job_object_can_be_created_and_is_idempotent() {
        // The test process itself is put in a kill-on-close job; it must keep running normally afterwards.
        crate::winplat::kill_children_with_agent().unwrap();
        crate::winplat::kill_children_with_agent().unwrap();
        let (tx, _rx) = channel();
        let mut p = MinerProcess::spawn(&cmd("cmd.exe", &["/C", "exit 0"]), tx, 1).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let _ = p.stop(Duration::from_secs(1));
    }
}
