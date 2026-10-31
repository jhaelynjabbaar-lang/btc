//! The main loop: owns the miner child process, parses its output, aggregates telemetry, polls commands.
//! Single-threaded apart from the miner output reader threads; time is injected only through `Instant`/`now_unix`.

use crate::api::{Api, ApiError, ErrorKind};
use crate::backoff::{Backoff, jitter, random_unit};
use crate::commands::{AgentState, Command, HandledIds, plan};
use crate::config::{Config, MinerCommand};
use crate::consent;
use crate::logger::{Logger, clean_line};
use crate::miner::{MinerLine, MinerProcess, StopOutcome};
use crate::parse::{LineParser, MinerEvent};
use crate::paths::Paths;
use crate::status::{self, StatusFile};
use crate::telemetry::{Aggregator, MAX_BUFFER_ROWS, MinerStats, TelemetryBuffer};
use crate::timeutil::{format_duration, format_hashrate, now_unix};
use anyhow::{Result, bail};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Timing {
    pub tick: Duration,
    pub command_poll: Duration,
    pub telemetry_flush: Duration,
    pub status_line: Duration,
    pub status_file: Duration,
    pub miner_restart_base: Duration,
    pub miner_restart_max: Duration,
    pub miner_stop_grace: Duration,
    pub api_backoff_base: Duration,
    pub api_backoff_max: Duration,
}

impl Timing {
    pub fn from_config(cfg: &Config) -> Self {
        Timing {
            tick: Duration::from_millis(500),
            command_poll: Duration::from_secs(cfg.command_poll_secs()),
            telemetry_flush: Duration::from_secs(60),
            status_line: Duration::from_secs(cfg.timing.status_line_secs.clamp(10, 3600)),
            status_file: Duration::from_secs(10),
            miner_restart_base: Duration::from_secs(5),
            miner_restart_max: Duration::from_secs(300),
            miner_stop_grace: Duration::from_secs(5),
            api_backoff_base: Duration::from_secs(5),
            api_backoff_max: Duration::from_secs(300),
        }
    }
}

pub struct Params {
    pub paths: Paths,
    pub cfg: Config,
    pub miner_cmd: MinerCommand,
    pub worker_id: String,
    pub api: Box<dyn Api>,
    pub log: Logger,
    pub timing: Timing,
    pub start_state: AgentState,
    pub logical_cpus: usize,
}

pub struct Supervisor {
    p: Params,
    parser: LineParser,
    tx: Sender<MinerLine>,
    rx: Receiver<MinerLine>,
    state: AgentState,
    miner: Option<MinerProcess>,
    generation: u64,
    stats: MinerStats,
    agg: Aggregator,
    buffer: TelemetryBuffer,
    handled: HandledIds,
    pending_acks: Vec<String>,
    warned_unknown: HandledIds,
    started: Instant,
    started_unix: u64,
    // schedules
    next_poll: Instant,
    next_flush: Instant,
    next_status_line: Instant,
    next_status_file: Instant,
    restart_at: Option<Instant>,
    restart_backoff: Backoff,
    poll_backoff: Backoff,
    flush_backoff: Backoff,
    last_telemetry_ok: Option<u64>,
    last_poll_ok: Option<u64>,
}

fn redact(line: &str, secret: Option<&str>) -> String {
    match secret {
        Some(s) => line.replace(s, "***"),
        None => line.to_string(),
    }
}

impl Supervisor {
    pub fn new(p: Params) -> Result<Self> {
        let parser = LineParser::new(&p.cfg.miner)?;
        let (tx, rx) = mpsc::channel();
        let now = Instant::now();
        let t = p.timing.clone();
        Ok(Supervisor {
            parser,
            tx,
            rx,
            state: p.start_state,
            miner: None,
            generation: 0,
            stats: MinerStats::default(),
            agg: Aggregator::new(),
            buffer: TelemetryBuffer::new(MAX_BUFFER_ROWS),
            handled: HandledIds::default(),
            pending_acks: vec![],
            warned_unknown: HandledIds::default(),
            started: now,
            started_unix: now_unix(),
            next_poll: now + Duration::from_secs(2),
            next_flush: now + t.telemetry_flush,
            next_status_line: now + t.status_line,
            next_status_file: now,
            restart_at: None,
            restart_backoff: Backoff::new(t.miner_restart_base, t.miner_restart_max),
            poll_backoff: Backoff::new(t.api_backoff_base, t.api_backoff_max),
            flush_backoff: Backoff::new(t.api_backoff_base, t.api_backoff_max),
            last_telemetry_ok: None,
            last_poll_ok: None,
            p,
        })
    }

    pub fn state(&self) -> AgentState {
        self.state
    }

    fn pool_host(&self) -> String {
        self.p
            .cfg
            .pool
            .url
            .as_deref()
            .and_then(|u| url::Url::parse(u).ok())
            .map(|u| format!("{}:{}", u.host_str().unwrap_or("?"), u.port().map_or("?".into(), |p| p.to_string())))
            .unwrap_or_else(|| "?".into())
    }

    fn banner(&self, headline: &str) {
        let threads = self.p.cfg.effective_threads(self.p.logical_cpus);
        self.p.log.banner(&[
            headline.to_string(),
            format!("Miner:   {}", self.p.miner_cmd.program.display()),
            format!("Pool:    {} (Stratum V1)   CPU threads: {}", self.pool_host(), threads),
            format!("Worker:  {}", self.p.worker_id),
            format!("Log:     {}", self.p.log.path().display()),
            "Stop any time: press Ctrl-C. Status: `btc-agent status`.".to_string(),
        ]);
    }

    // ------------------------------------------------------------- miner
    fn start_miner(&mut self) -> Result<()> {
        if self.miner.is_some() {
            return Ok(());
        }
        // The consent gate is re-checked every time a miner process is about to start.
        consent::require(&self.p.paths)?;
        self.generation += 1;
        self.stats.new_process();
        self.agg.reset_hashrate_memory();
        let cmd = &self.p.miner_cmd;
        let proc = MinerProcess::spawn(cmd, self.tx.clone(), self.generation)?;
        self.p.log.info(format!("starting miner: {} {}", cmd.program.display(), cmd.display_args.join(" ")));
        self.p.log.info(format!("miner started (pid {})", proc.pid));
        self.miner = Some(proc);
        self.restart_at = None;
        self.banner("MINING IS ACTIVE ON THIS MACHINE (BTC Network AI agent)");
        Ok(())
    }

    fn stop_miner(&mut self, why: &str) {
        if let Some(mut m) = self.miner.take() {
            let pid = m.pid;
            let outcome = m.stop(self.p.timing.miner_stop_grace);
            self.p.log.info(format!(
                "miner stopped ({why}; pid {pid}; {})",
                match outcome {
                    StopOutcome::AlreadyExited => "had already exited",
                    StopOutcome::Graceful => "exited after SIGTERM",
                    StopOutcome::Killed => "killed",
                }
            ));
        }
        self.restart_at = None;
    }

    fn check_miner_exit(&mut self, now: Instant, stopping: bool) {
        let Some(m) = self.miner.as_mut() else { return };
        let Some(status) = m.try_wait() else { return };
        let ran_for = m.started.elapsed();
        self.miner = None;
        if ran_for > Duration::from_secs(300) {
            self.restart_backoff.on_success();
        }
        if self.state == AgentState::Mining && !stopping {
            let delay = jitter(self.restart_backoff.on_failure(), random_unit());
            self.restart_at = Some(now + delay);
            self.p.log.warn(format!(
                "miner exited unexpectedly ({status}) after {}; restarting in {}s",
                format_duration(ran_for.as_secs()),
                delay.as_secs()
            ));
        } else {
            self.p.log.info(format!("miner exited ({status})"));
        }
    }

    fn handle_line(&mut self, l: MinerLine) {
        if l.generation != self.generation {
            return;
        }
        let text = redact(&clean_line(&l.text), self.p.miner_cmd.pool_password.as_deref());
        if text.trim().is_empty() {
            return;
        }
        let now = now_unix();
        let events = self.parser.parse(&text);
        let mut share_event = false;
        for ev in &events {
            let (hr, da, dr) = self.stats.apply(ev, now);
            if let Some(h) = hr {
                self.agg.record_hashrate(now, h);
            }
            if da > 0 || dr > 0 {
                self.agg.record_shares(now, da, dr);
            }
            share_event |= matches!(
                ev,
                MinerEvent::SharesTotal { .. }
                    | MinerEvent::ShareAccepted
                    | MinerEvent::ShareRejected
                    | MinerEvent::AcceptedTotal(_)
                    | MinerEvent::RejectedTotal(_)
            );
        }
        if share_event {
            self.p.log.info(format!("[miner] {text}"));
        } else {
            self.p.log.miner(&text);
        }
    }

    // ---------------------------------------------------------- commands
    fn apply(&mut self, cmd: Command) -> Result<()> {
        match cmd {
            Command::Start => {
                let previous = self.state;
                self.state = AgentState::Mining;
                if let Err(e) = self.start_miner() {
                    self.state = previous;
                    return Err(e);
                }
            }
            Command::Pause => {
                self.stop_miner("pause command");
                self.state = AgentState::Paused;
                self.banner("MINING IS PAUSED (server command). The agent stays running and polls for `start`.");
            }
            Command::Stop => {
                self.stop_miner("stop command");
                self.state = AgentState::Stopped;
                self.banner("MINING IS STOPPED (server command). The agent is idle; Ctrl-C exits, a `start` command resumes.");
            }
        }
        Ok(())
    }

    fn flush_acks(&mut self) -> Result<(), ApiError> {
        if self.pending_acks.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = self.pending_acks.iter().take(50).cloned().collect();
        self.p.api.ack(&ids)?;
        self.pending_acks.drain(..ids.len());
        self.p.log.info(format!("acked {} command(s)", ids.len()));
        Ok(())
    }

    fn poll_commands(&mut self, now: Instant) {
        let result = self.flush_acks().and_then(|_| self.p.api.poll_commands());
        let cmds = match result {
            Ok(c) => c,
            Err(e) => {
                self.api_failed("command poll", &e, now, true);
                return;
            }
        };
        self.poll_backoff.on_success();
        self.last_poll_ok = Some(now_unix());
        self.next_poll = now + self.p.timing.command_poll;

        let pl = plan(&cmds, &self.handled);
        for id in pl.reack {
            self.pending_acks.push(id);
        }
        for (id, raw) in pl.unknown {
            if !self.warned_unknown.contains(&id) {
                self.warned_unknown.insert(&id);
                self.p.log.warn(format!("ignoring unknown server command {raw:?} (id {id}); not applied, not acked"));
            }
        }
        for (id, cmd) in pl.apply {
            self.p.log.info(format!("server command: {cmd:?} (id {id})"));
            match self.apply(cmd) {
                Ok(()) => {
                    self.handled.insert(&id);
                    self.pending_acks.push(id);
                }
                Err(e) => self.p.log.error(format!("could not apply {cmd:?}: {e:#}; leaving it unacked")),
            }
        }
        if let Err(e) = self.flush_acks() {
            self.api_failed("command ack", &e, now, true);
        }
    }

    // --------------------------------------------------------- telemetry
    fn flush_telemetry(&mut self, now: Instant) {
        if self.buffer.is_empty() {
            self.next_flush = now + self.p.timing.telemetry_flush;
            return;
        }
        let batch = self.buffer.batch(MAX_BUFFER_ROWS);
        let n = batch.len();
        let uptime = self.started.elapsed().as_secs();
        match self.p.api.send_telemetry(&batch, uptime) {
            Ok(()) => {
                self.buffer.confirm(n);
                self.flush_backoff.on_success();
                self.last_telemetry_ok = Some(now_unix());
                self.next_flush = now + self.p.timing.telemetry_flush;
                self.p.log.info(format!("telemetry: sent {n} one-minute row(s)"));
            }
            Err(e) if e.kind == ErrorKind::Rejected => {
                // The server will never accept this payload; keeping it would block every later batch.
                self.buffer.confirm(n);
                self.p.log.error(format!("telemetry batch of {n} row(s) rejected by the server ({e}); dropped"));
                self.next_flush = now + self.p.timing.telemetry_flush;
            }
            Err(e) => self.api_failed("telemetry", &e, now, false),
        }
    }

    fn api_failed(&mut self, what: &str, e: &ApiError, now: Instant, is_poll: bool) {
        let b = if is_poll { &mut self.poll_backoff } else { &mut self.flush_backoff };
        let mut delay = jitter(b.on_failure(), random_unit());
        if let Some(ra) = e.retry_after_secs {
            delay = delay.max(Duration::from_secs(ra.min(600)));
        }
        let base = if is_poll { self.p.timing.command_poll } else { self.p.timing.telemetry_flush };
        let next = now + delay.max(base);
        if is_poll {
            self.next_poll = next;
        } else {
            self.next_flush = next;
        }
        let extra = if e.kind == ErrorKind::Network && !is_poll {
            format!("; {} row(s) buffered (max {MAX_BUFFER_ROWS})", self.buffer.len())
        } else {
            String::new()
        };
        self.p.log.warn(format!("{what} failed: {e}; retrying in {}s{extra}", delay.max(base).as_secs()));
    }

    // ------------------------------------------------------------ output
    fn current_miner_pid(&self) -> Option<u32> {
        self.miner.as_ref().map(|m| m.pid)
    }

    fn snapshot(&self, running: bool) -> StatusFile {
        let now = now_unix();
        StatusFile {
            pid: std::process::id(),
            running,
            state: self.state.label().to_string(),
            started_at_unix: self.started_unix,
            updated_at_unix: now,
            worker_id: self.p.worker_id.clone(),
            miner_running: self.miner.is_some(),
            miner_pid: self.current_miner_pid(),
            hashrate_hs: if self.miner.is_some() { self.stats.current_hashrate(now) } else { None },
            accepted_shares: self.stats.accepted,
            rejected_shares: self.stats.rejected,
            telemetry_buffered: self.buffer.len(),
            last_telemetry_ok_unix: self.last_telemetry_ok,
            last_command_poll_ok_unix: self.last_poll_ok,
            agent_version: crate::AGENT_VERSION.to_string(),
        }
    }

    fn write_status_file(&self, running: bool) {
        if let Err(e) = status::write(&self.p.paths, &self.snapshot(running)) {
            self.p.log.warn(format!("could not write status file: {e:#}"));
        }
    }

    fn status_line(&self) {
        let now = now_unix();
        let opt = |v: Option<u64>| v.map_or("unknown".to_string(), |n| n.to_string());
        let miner = match self.current_miner_pid() {
            Some(pid) => format!("running (pid {pid})"),
            None if self.restart_at.is_some() => "restarting".to_string(),
            None => "not running".to_string(),
        };
        let hr = if self.miner.is_some() { self.stats.current_hashrate(now) } else { None };
        self.p.log.info(format!(
            "[status] state={} miner={} hashrate={} accepted={} rejected={} uptime={} telemetry_buffered={}",
            self.state.label(),
            miner,
            if self.miner.is_some() { format_hashrate(hr) } else { "n/a".into() },
            opt(self.stats.accepted),
            opt(self.stats.rejected),
            format_duration(self.started.elapsed().as_secs()),
            self.buffer.len(),
        ));
    }

    // -------------------------------------------------------------- loop
    /// Run until `stop` is set (Ctrl-C / SIGTERM), consent is revoked, or the miner cannot be started initially.
    pub fn run(&mut self, stop: Arc<AtomicBool>) -> Result<()> {
        self.p.log.info(format!(
            "btc-agent {} started; worker {}; initial state: {}",
            crate::AGENT_VERSION,
            self.p.worker_id,
            self.state.label()
        ));
        match self.state {
            AgentState::Mining => {
                if let Err(e) = self.start_miner() {
                    self.write_status_file(false);
                    bail!("could not start the miner: {e:#}");
                }
            }
            AgentState::Paused => {
                self.banner("AGENT RUNNING, MINING PAUSED. Waiting for a `start` command from the server (Ctrl-C exits).")
            }
            AgentState::Stopped => self.banner("AGENT RUNNING, MINING STOPPED."),
        }
        let mut result = Ok(());
        while !stop.load(Ordering::SeqCst) {
            match self.rx.recv_timeout(self.p.timing.tick) {
                Ok(l) => {
                    self.handle_line(l);
                    while let Ok(l) = self.rx.try_recv() {
                        self.handle_line(l);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {}
            }
            let now = Instant::now();
            let unix = now_unix();

            self.check_miner_exit(now, stop.load(Ordering::SeqCst));
            if self.state == AgentState::Mining && self.miner.is_none() && self.restart_at.is_some_and(|t| now >= t) {
                self.p.log.info("restarting miner after unexpected exit");
                if let Err(e) = self.start_miner() {
                    let delay = jitter(self.restart_backoff.on_failure(), random_unit());
                    self.restart_at = Some(now + delay);
                    self.p.log.error(format!("miner restart failed: {e:#}; retrying in {}s", delay.as_secs()));
                }
            }

            self.agg.observe_state(unix, self.state, self.miner.is_some());
            for row in self.agg.take_ready(unix) {
                self.buffer.push(row);
            }
            if self.buffer.dropped > 0 {
                self.p
                    .log
                    .warn(format!("telemetry buffer full: {} oldest row(s) dropped while the server was unreachable", self.buffer.dropped));
                self.buffer.dropped = 0;
            }

            if now >= self.next_poll {
                self.poll_commands(now);
            }
            if now >= self.next_flush {
                self.flush_telemetry(now);
            }
            if now >= self.next_status_line {
                self.next_status_line = now + self.p.timing.status_line;
                self.status_line();
                if consent::require(&self.p.paths).is_err() {
                    self.p.log.error("consent was revoked or is no longer valid: stopping the miner and exiting");
                    result = Err(anyhow::anyhow!("consent revoked"));
                    break;
                }
            }
            if now >= self.next_status_file {
                self.next_status_file = now + self.p.timing.status_file;
                self.write_status_file(true);
            }
        }

        self.p.log.info("shutting down: stopping the miner");
        self.stop_miner("agent shutting down");
        let unix = now_unix();
        for row in self.agg.take_ready(unix) {
            self.buffer.push(row);
        }
        if !self.buffer.is_empty() {
            let batch = self.buffer.batch(MAX_BUFFER_ROWS);
            match self.p.api.send_telemetry(&batch, self.started.elapsed().as_secs()) {
                Ok(()) => self.p.log.info(format!("telemetry: sent final {} row(s)", batch.len())),
                Err(e) => self.p.log.warn(format!("final telemetry flush failed: {e}; {} row(s) not sent", batch.len())),
            }
        }
        self.state = AgentState::Stopped;
        self.write_status_file(false);
        self.p.log.banner(&["MINING STOPPED. The BTC Network AI agent has exited.".to_string()]);
        result
    }
}
