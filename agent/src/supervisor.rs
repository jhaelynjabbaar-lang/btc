//! The main loop: owns the miner child process, parses its output, aggregates telemetry, polls commands.
//! Single-threaded apart from the miner output reader threads; time is injected only through `Instant`/`now_unix`.

use crate::api::{Api, ApiError, ErrorKind};
use crate::backoff::{Backoff, jitter, random_unit};
use crate::commands::{AgentState, Command, HandledIds, plan};
use crate::config::{Config, MinerCommand, PoolMode};
use crate::consent;
use crate::logger::{Logger, clean_line};
use crate::miner::{MinerLine, MinerProcess, Source, StopOutcome};
use crate::parse::{LineParser, MinerEvent};
use crate::paths::Paths;
use crate::poolstats::{self, PoolStatsSnapshot, PoolStatsSource, StatsErrorKind};
use crate::status::{self, StatusFile};
use crate::telemetry::{Aggregator, MAX_BUFFER_ROWS, MinerStats, TelemetryBuffer};
use crate::timeutil::{format_duration, format_hashrate, now_unix};
use crate::tproxy::{self, TproxyEvent, TranslatorCommand};
use anyhow::{Context, Result, bail};
use std::collections::VecDeque;
use std::net::{SocketAddr, TcpListener, TcpStream};
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
    /// Stratum V2: how often to probe the translator's port while waiting for it.
    pub translator_probe: Duration,
    /// Stratum V2: give up if the translator's port is not open after this long.
    pub translator_startup: Duration,
    pub translator_stop_grace: Duration,
    /// How often to poll the pool's stats API (optional `[pool_stats]`).
    pub pool_stats_poll: Duration,
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
            translator_probe: Duration::from_millis(100),
            translator_startup: Duration::from_secs(cfg.stratum_v2.startup_timeout_secs.clamp(5, 300)),
            translator_stop_grace: Duration::from_secs(5),
            pool_stats_poll: Duration::from_secs(cfg.pool_stats.poll_secs.clamp(60, 3600)),
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
    // Stratum V2: the local translator proxy, a second visible child process
    mode: PoolMode,
    translator_cmd: Option<TranslatorCommand>,
    translator: Option<MinerProcess>,
    translator_generation: u64,
    translator_tail: VecDeque<String>,
    stop_flag: Arc<AtomicBool>,
    // optional pool-reported stats (display only)
    pool_stats: Option<Box<dyn PoolStatsSource>>,
    pool_snapshot: Option<PoolStatsSnapshot>,
    next_pool_stats: Instant,
    pool_stats_backoff: Backoff,
    warned_no_worker: bool,
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

fn outcome_text(o: &StopOutcome) -> &'static str {
    match o {
        StopOutcome::AlreadyExited => "had already exited",
        StopOutcome::Graceful => "exited after SIGTERM",
        StopOutcome::Killed => "killed",
    }
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
        let mode = p.cfg.effective_mode();
        let translator_cmd = match mode {
            PoolMode::Sv2 => Some(p.cfg.translator_command(&p.paths.tproxy_config())?),
            PoolMode::Sv1 => None,
        };
        Ok(Supervisor {
            mode,
            translator_cmd,
            translator: None,
            translator_generation: 0,
            translator_tail: VecDeque::new(),
            stop_flag: Arc::new(AtomicBool::new(false)),
            pool_stats: None,
            pool_snapshot: None,
            next_pool_stats: now + Duration::from_secs(5).min(t.pool_stats_poll),
            pool_stats_backoff: Backoff::new(Duration::from_secs(60), Duration::from_secs(900)),
            warned_no_worker: false,
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

    /// Enable the optional pool-side stats poller (display only; never sent to the server).
    pub fn with_pool_stats(mut self, source: Box<dyn PoolStatsSource>) -> Self {
        self.pool_stats = Some(source);
        self
    }

    pub fn state(&self) -> AgentState {
        self.state
    }

    fn pool_host(&self) -> String {
        match self.mode {
            PoolMode::Sv2 => self.p.cfg.stratum_v2.upstream_address.clone().unwrap_or_else(|| "?".into()),
            PoolMode::Sv1 => self
                .p
                .cfg
                .pool
                .url
                .as_deref()
                .and_then(|u| url::Url::parse(u).ok())
                .map(|u| format!("{}:{}", u.host_str().unwrap_or("?"), u.port().map_or("?".into(), |p| p.to_string())))
                .unwrap_or_else(|| "?".into()),
        }
    }

    fn banner(&self, headline: &str) {
        let threads = self.p.cfg.effective_threads(self.p.logical_cpus);
        let pid = |p: Option<u32>| p.map_or(" (not running)".to_string(), |p| format!(" (pid {p})"));
        let mut lines = vec![headline.to_string()];
        match self.mode {
            PoolMode::Sv1 => {
                lines.push(format!("Miner:   {}{}", self.p.miner_cmd.program.display(), pid(self.current_miner_pid())));
                lines.push(format!("Pool:    {} (Stratum V1, direct; plaintext)   CPU threads: {}", self.pool_host(), threads));
            }
            PoolMode::Sv2 => {
                lines.push(format!(
                    "Miner:   {}{} -> {}",
                    self.p.miner_cmd.program.display(),
                    pid(self.current_miner_pid()),
                    self.p.cfg.local_translator_url()
                ));
                if let Some(t) = &self.translator_cmd {
                    lines.push(format!(
                        "Proxy:   {}{} (SRI translator; listens on {}:{} only)",
                        t.program.display(),
                        pid(self.translator.as_ref().map(|m| m.pid)),
                        tproxy::DOWNSTREAM_ADDRESS,
                        t.port
                    ));
                }
                lines.push(format!(
                    "Pool:    {} (Stratum V2, Noise-encrypted, via the proxy)   CPU threads: {}",
                    self.pool_host(),
                    threads
                ));
            }
        }
        lines.push(format!("Worker:  {}", self.p.worker_id));
        lines.push(format!("Log:     {}", self.p.log.path().display()));
        lines.push("Stop any time: press Ctrl-C. Status: `btc-agent status`.".to_string());
        self.p.log.banner(&lines);
    }

    // ------------------------------------------------------------- miner
    fn start_miner(&mut self) -> Result<()> {
        if self.miner.is_some() {
            return Ok(());
        }
        // The consent gate is re-checked every time a process is about to start.
        consent::require(&self.p.paths)?;
        if self.mode == PoolMode::Sv2 && self.translator.is_none() {
            self.start_translator()?;
        }
        self.generation += 1;
        self.stats.new_process();
        self.agg.reset_hashrate_memory();
        let cmd = &self.p.miner_cmd;
        let proc = match MinerProcess::spawn(cmd, self.tx.clone(), self.generation) {
            Ok(p) => p,
            Err(e) => {
                self.stop_translator("the miner could not be started");
                return Err(e);
            }
        };
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
            self.p.log.info(format!("miner stopped ({why}; pid {pid}; {})", outcome_text(&outcome)));
        }
        self.restart_at = None;
    }

    /// Stop everything the agent started: the miner first (it depends on the proxy), then the translator.
    fn stop_all(&mut self, why: &str) {
        self.stop_miner(why);
        self.stop_translator(why);
    }

    // ------------------------------------------------- translator (Stratum V2)
    fn start_translator(&mut self) -> Result<()> {
        let tc = self.translator_cmd.clone().context("no translator is configured (mode is not sv2)")?;
        // The port must be free first: otherwise "the port is open" would not prove that OUR proxy is listening.
        TcpListener::bind((tproxy::DOWNSTREAM_ADDRESS, tc.port)).map(drop).map_err(|e| {
            anyhow::anyhow!(
                "stratum_v2.downstream_port {} on {} is not available ({e}); is another translator or agent already using it? Pick another port",
                tc.port,
                tproxy::DOWNSTREAM_ADDRESS
            )
        })?;
        let user = self.p.cfg.sv2_user_identity().context("stratum_v2.user_identity is not set")?;
        let text = tproxy::render_config(&self.p.cfg.stratum_v2, &user)?;
        tproxy::write_private_file(&tc.config_path, &text)?;
        self.p.log.info(format!("wrote translator config {} (no secrets; mode 0600)", tc.config_path.display()));

        self.translator_generation += 1;
        self.translator_tail.clear();
        let pc = tc.as_process_command();
        let proc = MinerProcess::spawn_as(&pc, self.tx.clone(), self.translator_generation, Source::Translator)?;
        self.p.log.info(format!("starting translator: {} {}", pc.program.display(), pc.display_args.join(" ")));
        self.p.log.info(format!(
            "translator started (pid {}); waiting up to {}s for {}:{}",
            proc.pid,
            self.p.timing.translator_startup.as_secs(),
            tproxy::DOWNSTREAM_ADDRESS,
            tc.port
        ));
        self.translator = Some(proc);
        match self.wait_for_translator(&tc) {
            Ok(()) => {
                self.p.log.info(format!(
                    "translator is listening on {}:{}; the pool connection itself is reported by the translator's own log lines (TPROXY in the log file)",
                    tproxy::DOWNSTREAM_ADDRESS,
                    tc.port
                ));
                Ok(())
            }
            Err(e) => {
                self.stop_translator("it did not become ready");
                Err(e)
            }
        }
    }

    fn drain_lines(&mut self) {
        while let Ok(l) = self.rx.try_recv() {
            self.handle_line(l);
        }
    }

    fn tail_text(&self) -> String {
        if self.translator_tail.is_empty() {
            "(no output)".to_string()
        } else {
            self.translator_tail.iter().rev().take(8).rev().cloned().collect::<Vec<_>>().join(" | ")
        }
    }

    fn wait_for_translator(&mut self, tc: &TranslatorCommand) -> Result<()> {
        let addr = SocketAddr::from(([127, 0, 0, 1], tc.port));
        let timeout = self.p.timing.translator_startup;
        let deadline = Instant::now() + timeout;
        loop {
            self.drain_lines();
            if self.stop_flag.load(Ordering::SeqCst) {
                bail!("interrupted while waiting for the translator");
            }
            if let Some(status) = self.translator.as_mut().and_then(|m| m.try_wait()) {
                std::thread::sleep(Duration::from_millis(150));
                self.drain_lines();
                self.translator = None;
                bail!(
                    "the translator exited during startup ({status}). This usually means a bad pool address, authority key or clock. Last translator output: {}",
                    self.tail_text()
                );
            }
            // On Linux read the socket table (no connection: the translator logs an empty connection as an error);
            // elsewhere fall back to a plain connect probe.
            let ready = match tproxy::loopback_port_listening(tc.port) {
                Some(listening) => listening,
                None => TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok(),
            };
            if ready {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!("the translator did not open {addr} within {}s. Last translator output: {}", timeout.as_secs(), self.tail_text());
            }
            std::thread::sleep(self.p.timing.translator_probe);
        }
    }

    fn stop_translator(&mut self, why: &str) {
        if let Some(mut t) = self.translator.take() {
            let pid = t.pid;
            let outcome = t.stop(self.p.timing.translator_stop_grace);
            self.p.log.info(format!("translator stopped ({why}; pid {pid}; {})", outcome_text(&outcome)));
        }
    }

    fn check_translator_exit(&mut self, now: Instant, stopping: bool) {
        let Some(t) = self.translator.as_mut() else { return };
        let Some(status) = t.try_wait() else { return };
        let ran_for = t.started.elapsed();
        self.translator = None;
        if ran_for > Duration::from_secs(300) {
            self.restart_backoff.on_success();
        }
        if self.state == AgentState::Mining && !stopping {
            // The miner has nothing to talk to without the proxy: stop it too and restart the pair together.
            let tail = self.tail_text();
            self.stop_miner("the translator exited");
            let delay = jitter(self.restart_backoff.on_failure(), random_unit());
            self.restart_at = Some(now + delay);
            self.p.log.warn(format!(
                "translator exited unexpectedly ({status}) after {}; restarting translator and miner in {}s. Last translator output: {tail}",
                format_duration(ran_for.as_secs()),
                delay.as_secs()
            ));
        } else {
            self.p.log.info(format!("translator exited ({status})"));
        }
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
        let current = match l.source {
            Source::Miner => self.generation,
            Source::Translator => self.translator_generation,
        };
        if l.generation != current {
            return;
        }
        let text = redact(&clean_line(&l.text), self.p.miner_cmd.pool_password.as_deref());
        if text.trim().is_empty() {
            return;
        }
        match l.source {
            Source::Miner => self.handle_miner_line(&text),
            Source::Translator => self.handle_translator_line(&text),
        }
    }

    fn handle_miner_line(&mut self, text: &str) {
        let now = now_unix();
        let mut events = self.parser.parse(text);
        if self.mode == PoolMode::Sv2 {
            // Through the translator, the miner's "accepted" only means the LOCAL proxy accepted the share. Pool-confirmed
            // counts come from the translator's own log (`handle_translator_line`); only the hashrate is taken from the miner.
            events.retain(|e| matches!(e, MinerEvent::Hashrate(_)));
        }
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
            self.p.log.miner(text);
        }
    }

    fn handle_translator_line(&mut self, text: &str) {
        if self.translator_tail.len() >= 20 {
            self.translator_tail.pop_front();
        }
        self.translator_tail.push_back(text.to_string());
        let now = now_unix();
        let events = tproxy::parse_line(text);
        for ev in &events {
            let (da, dr) = match ev {
                TproxyEvent::PoolAccepted(n) => (*n, 0),
                TproxyEvent::PoolRejected => (0, 1),
            };
            self.stats.add_shares(da, dr);
            self.agg.record_shares(now, da, dr);
            self.p.log.info(format!(
                "[pool] {} (accepted so far {}, rejected {}; counted only when the pool confirms)",
                if da > 0 { format!("pool confirmed {da} share(s)") } else { "pool rejected a share".to_string() },
                self.stats.accepted.map_or("unknown".to_string(), |n| n.to_string()),
                self.stats.rejected.map_or("unknown".to_string(), |n| n.to_string()),
            ));
        }
        if !events.is_empty() {
            self.p.log.translator(text);
        } else if text.contains(" ERROR ") {
            self.p.log.error(format!("[translator] {text}"));
        } else if text.contains(" WARN ") {
            self.p.log.warn(format!("[translator] {text}"));
        } else {
            self.p.log.translator(text);
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
                self.stop_all("pause command");
                self.state = AgentState::Paused;
                self.banner("MINING IS PAUSED (server command). The agent stays running and polls for `start`.");
            }
            Command::Stop => {
                self.stop_all("stop command");
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

    // -------------------------------------------------------- pool stats
    fn poll_pool_stats(&mut self, now: Instant) {
        let Some(src) = self.pool_stats.as_ref() else { return };
        let prefix = poolstats::worker_prefix(&self.p.cfg).unwrap_or_default();
        match src.fetch(&prefix) {
            Ok(snap) => {
                self.pool_stats_backoff.on_success();
                self.next_pool_stats = now + self.p.timing.pool_stats_poll;
                if snap.workers_matched == 0 {
                    if !self.warned_no_worker {
                        self.warned_no_worker = true;
                        self.p.log.warn(format!(
                            "pool stats: the pool account lists no worker named \"{prefix}\" (or \"{prefix}.*\") yet; nothing to show"
                        ));
                    }
                } else {
                    self.warned_no_worker = false;
                }
                self.pool_snapshot = Some(snap);
            }
            Err(e) => {
                let delay = jitter(self.pool_stats_backoff.on_failure(), random_unit());
                let wait = delay.max(self.p.timing.pool_stats_poll);
                self.next_pool_stats = now + wait;
                let hint = if e.kind == StatsErrorKind::Unauthorized {
                    " (check the token in pool_stats.api_key_file and that API access is enabled for it)"
                } else {
                    ""
                };
                self.p.log.warn(format!("pool stats: {e}{hint}; retrying in {}s", wait.as_secs()));
            }
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
            mode: self.mode.label().to_string(),
            translator_running: self.translator.is_some(),
            translator_pid: self.translator.as_ref().map(|t| t.pid),
            translator_port: self.translator_cmd.as_ref().map(|t| t.port),
            pool_stats: self.pool_snapshot.clone(),
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
        let proxy = match (self.mode, self.translator.as_ref()) {
            (PoolMode::Sv1, _) => String::new(),
            (PoolMode::Sv2, Some(t)) => format!(" translator=running (pid {})", t.pid),
            (PoolMode::Sv2, None) if self.restart_at.is_some() => " translator=restarting".to_string(),
            (PoolMode::Sv2, None) => " translator=not running".to_string(),
        };
        let pool = self.pool_snapshot.as_ref().map_or(String::new(), |p| {
            format!(
                " pool_reported(shares_60m={} workers={})",
                p.shares_60m.map_or("unknown".to_string(), |n| n.to_string()),
                p.workers_matched
            )
        });
        self.p.log.info(format!(
            "[status] state={} mode={}{proxy} miner={} hashrate={} accepted={} rejected={} uptime={} telemetry_buffered={}{pool}",
            self.state.label(),
            self.mode.label(),
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
        self.stop_flag = stop.clone();
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

            self.check_translator_exit(now, stop.load(Ordering::SeqCst));
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
            if self.pool_stats.is_some() && now >= self.next_pool_stats {
                self.poll_pool_stats(now);
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

        self.p.log.info(if self.mode == PoolMode::Sv2 {
            "shutting down: stopping the miner and the translator"
        } else {
            "shutting down: stopping the miner"
        });
        self.stop_all("agent shutting down");
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
