//! A FAKE Stratum V1 miner for tests. It connects ONLY to a loopback address (it refuses any other host, so it can never
//! talk to a real pool), subscribes and authorizes, and "finds" a share on a timer for each job it is given. It prints
//! cpuminer-style lines (a hashrate that is just the `--rate` you pass, and `accepted: a/s`) so the agent's output
//! parsing can be tested.
//!
//! * Default: NO hashing. It submits the job's own fields with a counter as the nonce (fine for the fake translator).
//! * `--hash`: it really double-SHA256-hashes the block header it is given, for as long as it takes to meet the
//!   difficulty the (local, test) proxy set. This is only for the real-translator integration test against
//!   `agent/integration/sri-mock-pool`, whose difficulty is ~1e-9, so a share takes about ten hashes. It is not a miner.
//!
//! CLI (cpuminer-like): `-o stratum+tcp://127.0.0.1:PORT -u USER -p PASS [-t N] [--rate H/s] [--interval-ms MS] [--hash]`
//! Exit codes: 2 = bad arguments or non-loopback host, 5 = connection lost.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

fn sha256d(b: &[u8]) -> [u8; 32] {
    Sha256::digest(Sha256::digest(b)).into()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).filter_map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()).collect()
}

/// `diff1 / difficulty` as a 256-bit big-endian number (saturating). Approximate (f64), which is fine for a test.
fn target_from_difficulty(difficulty: f64) -> [u8; 32] {
    let t = 65535.0_f64 * 2f64.powi(208) / difficulty;
    if !t.is_finite() || t >= 2f64.powi(256) {
        return [0xff; 32];
    }
    if t < 1.0 {
        return [0; 32];
    }
    let e = t.log2().floor() as i32; // t = m * 2^(e-52)
    let shift = e - 52;
    let m = (t / 2f64.powi(shift)) as u64;
    let mut out = [0u8; 32];
    for bit in 0..64 {
        if (m >> bit) & 1 == 1 {
            let pos = bit + shift;
            if (0..256).contains(&pos) {
                out[31 - (pos / 8) as usize] |= 1 << (pos % 8);
            }
        }
    }
    out
}

struct Job {
    id: String,
    prevhash: String,
    coinb1: String,
    coinb2: String,
    branch: Vec<String>,
    version: String,
    nbits: String,
    ntime: String,
}

/// Header hash for `nonce`, as big-endian bytes (comparable to the target).
fn header_hash_be(j: &Job, extranonce1: &str, extranonce2: &str, nonce: u32) -> [u8; 32] {
    let coinbase = unhex(&format!("{}{}{}{}", j.coinb1, extranonce1, extranonce2, j.coinb2));
    let mut root = sha256d(&coinbase);
    for b in &j.branch {
        let mut cat = root.to_vec();
        cat.extend(unhex(b));
        root = sha256d(&cat);
    }
    let be32 = |h: &str| u32::from_str_radix(h, 16).unwrap_or(0).to_le_bytes();
    // SV1 sends the previous hash with each 4-byte word reversed.
    let mut prev = unhex(&j.prevhash);
    for w in prev.chunks_mut(4) {
        w.reverse();
    }
    let mut header = Vec::with_capacity(80);
    header.extend(be32(&j.version));
    header.extend(&prev);
    header.extend(root);
    header.extend(be32(&j.ntime));
    header.extend(be32(&j.nbits));
    header.extend(nonce.to_le_bytes());
    let mut h = sha256d(&header);
    h.reverse();
    h
}

fn say(s: &str) {
    println!("{s}");
    let _ = std::io::stdout().flush();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let Some(url) = get("-o").and_then(|u| url::Url::parse(&u).ok()) else {
        eprintln!("fake-sv1-miner: need -o stratum+tcp://127.0.0.1:PORT");
        std::process::exit(2);
    };
    let host = url.host_str().unwrap_or("").to_string();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1") || url.port().is_none() {
        eprintln!("fake-sv1-miner: refusing to connect to {host}: this test double only talks to loopback");
        std::process::exit(2);
    }
    let user = get("-u").unwrap_or_else(|| "fake.worker".into());
    let rate: f64 = get("--rate").and_then(|v| v.parse().ok()).unwrap_or(2500.0);
    let real_hash = args.iter().any(|a| a == "--hash");
    let interval = Duration::from_millis(get("--interval-ms").and_then(|v| v.parse().ok()).unwrap_or(300));

    say(if real_hash {
        "fake-sv1-miner: started (--hash: tiny test-difficulty hashing; loopback only)"
    } else {
        "fake-sv1-miner: started (no hashing; loopback only)"
    });
    let stream = match TcpStream::connect((host.as_str(), url.port().unwrap())) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("fake-sv1-miner: connect failed: {e}");
            std::process::exit(5);
        }
    };
    let mut w = stream.try_clone().unwrap();
    let mut r = BufReader::new(stream);
    let mut send = |v: Value| {
        let mut s = v.to_string();
        s.push('\n');
        w.write_all(s.as_bytes()).and_then(|_| w.flush()).is_ok()
    };
    if !send(json!({"id": 1, "method": "mining.subscribe", "params": ["fake-sv1-miner/0"]}))
        || !send(json!({"id": 2, "method": "mining.authorize", "params": [user, "x"]}))
    {
        std::process::exit(5);
    }

    let (mut submitted, mut accepted) = (0u64, 0u64);
    let mut extranonce2_size = 4usize;
    let mut job: Option<Job> = None;
    let mut extranonce1 = String::new();
    let mut difficulty = 1.0_f64;
    let mut nonce = 0u32;
    let mut next_share = Instant::now() + interval;
    let reader = r.get_mut().try_clone().unwrap();
    reader.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
    let mut r = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match r.read_line(&mut line) {
            Ok(0) => {
                eprintln!("fake-sv1-miner: connection closed");
                std::process::exit(5);
            }
            Ok(_) => {
                if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                    if v.get("method").and_then(|m| m.as_str()) == Some("mining.notify") {
                        if let Some(p) = v["params"].as_array() {
                            let st = |i: usize, d: &str| p.get(i).and_then(|x| x.as_str()).unwrap_or(d).to_string();
                            job = Some(Job {
                                id: st(0, ""),
                                prevhash: st(1, ""),
                                coinb1: st(2, ""),
                                coinb2: st(3, ""),
                                branch: p
                                    .get(4)
                                    .and_then(|b| b.as_array())
                                    .map(|b| b.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                                    .unwrap_or_default(),
                                version: st(5, "20000000"),
                                nbits: st(6, "1d00ffff"),
                                ntime: st(7, "00000000"),
                            });
                        }
                    } else if v.get("method").and_then(|m| m.as_str()) == Some("mining.set_difficulty") {
                        difficulty = v["params"].get(0).and_then(|d| d.as_f64()).unwrap_or(1.0);
                    } else if v.get("id").and_then(|i| i.as_u64()) == Some(1) {
                        if let Some(n) = v["result"].get(2).and_then(|n| n.as_u64()) {
                            extranonce2_size = n as usize;
                        }
                        extranonce1 = v["result"].get(1).and_then(|e| e.as_str()).unwrap_or("").to_string();
                    } else if v.get("id").and_then(|i| i.as_u64()).is_some_and(|i| i >= 100) {
                        submitted += 1;
                        let ok = v.get("result").and_then(|r| r.as_bool()).unwrap_or(false);
                        if ok {
                            accepted += 1;
                        }
                        let pct = accepted as f64 * 100.0 / submitted as f64;
                        say(&format!("thread 0: 4096 hashes, {:.2} khash/sec", rate / 1000.0 / 2.0));
                        say(&format!(
                            "[2026-10-31 16:00:00] accepted: {accepted}/{submitted} ({pct:.2}%), {:.2} khash/sec ({})",
                            rate / 1000.0,
                            if ok { "yay!!!" } else { "booooo" }
                        ));
                    }
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => std::process::exit(5),
        }
        if Instant::now() >= next_share {
            next_share = Instant::now() + interval;
            if let Some(j) = &job {
                nonce = nonce.wrapping_add(1);
                let en2 = "00".repeat(extranonce2_size);
                if real_hash {
                    let target = target_from_difficulty(difficulty);
                    let mut tries = 0u32;
                    while header_hash_be(j, &extranonce1, &en2, nonce) > target && tries < 5_000_000 {
                        nonce = nonce.wrapping_add(1);
                        tries += 1;
                    }
                }
                if !send(
                    json!({"id": 100 + submitted + nonce as u64, "method": "mining.submit", "params": [user, j.id, en2, j.ntime, format!("{nonce:08x}")]}),
                ) {
                    std::process::exit(5);
                }
            }
        }
    }
}
