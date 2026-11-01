//! A FAKE Stratum V2 translator proxy for tests. It is NOT the SRI translator, performs no Stratum V2, no Noise
//! encryption and makes NO connection to any pool: it only reads the config file the agent generated, listens on the
//! configured loopback port and speaks just enough Stratum V1 (subscribe, authorize, set_difficulty, notify, submit)
//! for a fake SV1 miner to talk to it. For every submitted share it prints the log line the real translator prints
//! when a pool confirms a share (`Received: SubmitSharesSuccess(...)`), SIMULATED, so the agent's parsing and
//! orchestration can be tested end to end.
//!
//! CLI: `fake_tproxy -c <config.toml> [-f <log file>]` (like `translator_sv2`).
//! Test knobs (environment):
//!   FAKE_TPROXY_START_DELAY_MS   sleep this long before listening
//!   FAKE_TPROXY_NEVER_LISTEN=1   run forever without listening (startup timeout test)
//!   FAKE_TPROXY_FAIL_START=1     print an error and exit 1 (bad config / key test)
//!   FAKE_TPROXY_EXIT_AFTER_MS    exit with code 4 this long after listening (crash test)
//!   FAKE_TPROXY_REJECT_EVERY=n   every n-th share is answered with a simulated pool rejection

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

fn log(level: &str, module: &str, msg: &str) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("{now}  {level} {module}: {msg}");
    let _ = std::io::stdout().flush();
}

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok().and_then(|v| v.parse().ok())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cfg_path = args
        .iter()
        .position(|a| a == "-c" || a == "--config")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "translator-config.toml".into());
    let text = match std::fs::read_to_string(&cfg_path) {
        Ok(t) => t,
        Err(e) => {
            log("ERROR", "translator_sv2", &format!("cannot read config {cfg_path}: {e}"));
            std::process::exit(1);
        }
    };
    let cfg: toml::Value = match toml::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            log("ERROR", "translator_sv2", &format!("invalid config: {e}"));
            std::process::exit(1);
        }
    };
    let get_str = |k: &str| cfg.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let (Some(addr), Some(port)) = (get_str("downstream_address"), cfg.get("downstream_port").and_then(|v| v.as_integer())) else {
        log("ERROR", "translator_sv2", "config is missing downstream_address / downstream_port");
        std::process::exit(1);
    };
    let Some(up) = cfg.get("upstreams").and_then(|v| v.as_array()).and_then(|a| a.first()) else {
        log("ERROR", "translator_sv2", "config has no [[upstreams]]");
        std::process::exit(1);
    };
    let up_s = |k: &str| up.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    log("INFO", "translator_sv2", "fake-tproxy: started (TEST DOUBLE: no Stratum V2, no pool connection)");
    log(
        "INFO",
        "translator_sv2",
        &format!(
            "fake-tproxy: upstream {}:{} user_identity {} (not contacted)",
            up_s("address"),
            up.get("port").and_then(|v| v.as_integer()).unwrap_or(0),
            up_s("user_identity")
        ),
    );
    if std::env::var("FAKE_TPROXY_FAIL_START").is_ok() {
        log("ERROR", "translator_sv2", "fake-tproxy: simulated startup failure (InvalidCertificate)");
        std::process::exit(1);
    }
    if let Some(ms) = env_u64("FAKE_TPROXY_START_DELAY_MS") {
        std::thread::sleep(Duration::from_millis(ms));
    }
    if std::env::var("FAKE_TPROXY_NEVER_LISTEN").is_ok() {
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
    let listener = match TcpListener::bind(format!("{addr}:{port}")) {
        Ok(l) => l,
        Err(e) => {
            log("ERROR", "translator_sv2", &format!("Failed to bind to {addr}:{port}: {e}"));
            std::process::exit(1);
        }
    };
    log("INFO", "translator_sv2::sv1::sv1_server", &format!("Translator Proxy: listening on {addr}:{port}"));

    if let Some(ms) = env_u64("FAKE_TPROXY_EXIT_AFTER_MS") {
        let started = Instant::now();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms).saturating_sub(started.elapsed()));
            log("ERROR", "translator_sv2", "fake-tproxy: simulated crash");
            std::process::exit(4);
        });
    }
    let reject_every = env_u64("FAKE_TPROXY_REJECT_EVERY").unwrap_or(0);
    let seq = Arc::new(AtomicU64::new(0));
    for stream in listener.incoming().flatten() {
        let seq = seq.clone();
        std::thread::spawn(move || serve(stream, seq, reject_every));
    }
}

fn send(w: &mut TcpStream, v: Value) -> bool {
    let mut s = v.to_string();
    s.push('\n');
    w.write_all(s.as_bytes()).and_then(|_| w.flush()).is_ok()
}

fn serve(stream: TcpStream, seq: Arc<AtomicU64>, reject_every: u64) {
    let Ok(mut w) = stream.try_clone() else { return };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(600)));
    let mut r = BufReader::new(stream);
    let mut line = String::new();
    let mut job = 0u64;
    loop {
        line.clear();
        match r.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        match msg.get("method").and_then(|m| m.as_str()).unwrap_or("") {
            "mining.subscribe" => {
                if !send(
                    &mut w,
                    json!({"id": id, "result": [[["mining.set_difficulty", "1"], ["mining.notify", "1"]], "00000001", 4], "error": null}),
                ) {
                    return;
                }
            }
            "mining.authorize" => {
                job += 1;
                let ok = send(&mut w, json!({"id": id, "result": true, "error": null}))
                    && send(&mut w, json!({"id": null, "method": "mining.set_difficulty", "params": [1]}))
                    && send(
                        &mut w,
                        json!({"id": null, "method": "mining.notify", "params": [
                            format!("job{job}"), "00".repeat(32), "01000000", "ffffffff", [], "20000000", "1d00ffff", "5f5e1000", true]}),
                    );
                if !ok {
                    return;
                }
            }
            "mining.submit" => {
                let n = seq.fetch_add(1, Ordering::SeqCst) + 1;
                let rejected = reject_every > 0 && n % reject_every == 0;
                // Like the real translator, the SV1 side is answered locally (always true here)...
                if !send(&mut w, json!({"id": id, "result": true, "error": null})) {
                    return;
                }
                log("INFO", "translator_sv2::sv1::sv1_server", "Received mining.submit from SV1 downstream for channel id: 1");
                // ...and the pool's verdict arrives later as a separate log line (SIMULATED here).
                if rejected {
                    log(
                        "WARN",
                        "translator_sv2::sv2::channel_manager",
                        &format!("Received: SubmitSharesError(channel_id=1, sequence_number={n}, error_code=simulated-reject) ❌"),
                    );
                } else {
                    log(
                        "INFO",
                        "translator_sv2::sv2::channel_manager",
                        &format!(
                            "Received: SubmitSharesSuccess(channel_id=1, last_sequence_number={n}, new_submits_accepted_count=1, new_shares_sum=1) ✅"
                        ),
                    );
                }
            }
            _ => {
                if !send(&mut w, json!({"id": id, "result": true, "error": null})) {
                    return;
                }
            }
        }
    }
}
