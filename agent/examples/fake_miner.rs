//! A fake "miner" for tests and the live integration test. It performs NO hashing and connects to NOTHING:
//! it only prints cpuminer-style lines so the agent's child-process control and output parsing can be tested.
//!
//! Options (all optional):
//!   --rate <H/s>            hashrate to print (default 1500)
//!   --interval-ms <ms>      time between share lines (default 400)
//!   --reject-every <n>      every n-th share is rejected (default 0 = never)
//!   --exit-after-ms <ms>    exit with code 3 after this long (simulates a crash)
//!   --silent                print nothing about hashrate or shares (parsing must yield "unknown")
//! Unknown arguments (the agent passes pool args and `-t N`) are accepted and ignored.

use std::io::Write;
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let rate: f64 = get("--rate").and_then(|v| v.parse().ok()).unwrap_or(1500.0);
    let interval = Duration::from_millis(get("--interval-ms").and_then(|v| v.parse().ok()).unwrap_or(400));
    let reject_every: u64 = get("--reject-every").and_then(|v| v.parse().ok()).unwrap_or(0);
    let exit_after = get("--exit-after-ms").and_then(|v| v.parse::<u64>().ok()).map(Duration::from_millis);
    let silent = args.iter().any(|a| a == "--silent");

    let out = std::io::stdout();
    let say = |s: &str| {
        let mut o = out.lock();
        let _ = writeln!(o, "{s}");
        let _ = o.flush();
    };
    say("fake-miner: started (no hashing, no network)");
    eprintln!("fake-miner: stderr is captured too");

    let started = Instant::now();
    let (mut submitted, mut accepted) = (0u64, 0u64);
    loop {
        std::thread::sleep(interval);
        if exit_after.is_some_and(|d| started.elapsed() >= d) {
            say("fake-miner: simulated crash");
            std::process::exit(3);
        }
        if silent {
            continue;
        }
        submitted += 1;
        let rejected = reject_every > 0 && submitted % reject_every == 0;
        if !rejected {
            accepted += 1;
        }
        let pct = accepted as f64 * 100.0 / submitted as f64;
        say(&format!("thread 0: 4096 hashes, {:.2} khash/sec", rate / 1000.0 / 2.0));
        say(&format!(
            "[2026-10-31 16:00:00] accepted: {accepted}/{submitted} ({pct:.2}%), {:.2} khash/sec ({})",
            rate / 1000.0,
            if rejected { "booooo" } else { "yay!!!" }
        ));
    }
}
