//! TEST DOUBLE. A minimal Stratum V2 "pool" for localhost integration tests of the BTC Network AI agent.
//!
//! * Listens on a loopback address only (it refuses anything else).
//! * Generates a FRESH authority key pair at startup and prints the PUBLIC key (`AUTHORITY_PUBKEY=...`); the secret key
//!   stays in memory and is never printed or stored.
//! * Does the Noise handshake, answers SetupConnection and OpenExtendedMiningChannel, sends a fixed job and previous
//!   hash, and answers every SubmitSharesExtended with SubmitShares.Success. It validates NOTHING against any chain.
//!   `--reject-every N` answers every N-th share with SubmitShares.Error instead.
//! * Uses the Stratum Reference Implementation's own crates (`stratum-apps`) for framing, Noise and messages.

use std::io::{Read, Write};
use std::net::SocketAddr;
use std::str::FromStr;
use std::time::Duration;
use stratum_apps::{
    key_utils::{Secp256k1PublicKey, Secp256k1SecretKey},
    network_helpers::noise_connection::Connection,
    stratum_core::{
        binary_sv2::{Seq0255Owned, Sv2OptionOwned},
        common_messages_sv2::SetupConnectionSuccessOwned,
        mining_sv2::{
            NewExtendedMiningJobOwned, OpenExtendedMiningChannelSuccessOwned, SetNewPrevHashOwned, SubmitSharesErrorOwned,
            SubmitSharesSuccessOwned,
        },
        noise_sv2::Responder,
        parsers_sv2::{AnyMessage, AnyMessageOwned, CommonMessagesOwned, MiningOwned},
    },
    utils::types::OutboundFrame,
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

// Coinbase halves adapted from SRI's own translator unit tests: the scriptSig length byte is 0x22 so that an 8-byte
// extranonce (4-byte prefix + 4-byte rollable part) fits between them.
const COINBASE_PREFIX: &str = "02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff225200162f5374726174756d2056322053524920506f6f6c2f2f08";
const COINBASE_SUFFIX: &str = "feffffff0200f2052a01000000160014ebe1b7dcc293ccaa0ee743a86f89df8258c208fc0000000000000000266a24aa21a9ede2f61c3f71d1defd3fa999dfa36953755c690689799962b48bebd836974e8cf901000000";

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).expect("/dev/urandom");
    b
}

fn out(m: AnyMessageOwned) -> OutboundFrame {
    OutboundFrame::from_message(m).expect("frame")
}

fn flush() {
    std::io::stdout().flush().ok();
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |n: &str| args.iter().position(|a| a == n).and_then(|i| args.get(i + 1)).cloned();
    let listen: SocketAddr = get("--listen").unwrap_or_else(|| "127.0.0.1:34254".into()).parse().expect("--listen host:port");
    if !listen.ip().is_loopback() {
        eprintln!("sri-mock-pool: refusing to listen on {listen}: loopback only");
        std::process::exit(2);
    }
    let reject_every: u64 = get("--reject-every").and_then(|v| v.parse().ok()).unwrap_or(0);

    // Fresh authority key pair (in memory only; only the public half is printed).
    let sk = Secp256k1SecretKey::from_str(&bs58::encode(random32()).with_check().into_string()).expect("secret key");
    let pk: Secp256k1PublicKey = sk.into();
    println!("AUTHORITY_PUBKEY={pk}");
    println!("sri-mock-pool: TEST DOUBLE listening on {listen} (not a real pool; nothing is validated)");
    let listener = TcpListener::bind(listen).await.expect("bind");
    flush();

    loop {
        let (stream, peer) = listener.accept().await.expect("accept");
        println!("sri-mock-pool: connection from {peer}");
        flush();
        tokio::spawn(async move {
            let responder = Responder::from_authority_kp(&pk.into_bytes(), &sk.into_bytes(), Duration::from_secs(3600)).expect("responder");
            let Ok((rx, tx)) = Connection::accept::<OutboundFrame>(stream, responder, CancellationToken::new()).await else {
                println!("sri-mock-pool: noise handshake failed");
                flush();
                return;
            };
            println!("sri-mock-pool: noise handshake ok (initiator verified our authority key)");
            flush();
            let mut shares = 0u64;
            while let Ok(mut f) = rx.recv().await {
                let header = f.header();
                let mut payload = f.payload().to_vec();
                let parsed: Result<AnyMessage<'_>, _> = (header, payload.as_mut_slice()).try_into();
                let Ok(msg) = parsed else {
                    println!("sri-mock-pool: unparsable message type {}", header.msg_type());
                    flush();
                    continue;
                };
                match msg.into_owned() {
                    AnyMessageOwned::Common(CommonMessagesOwned::SetupConnection(s)) => {
                        println!("sri-mock-pool: SetupConnection flags={}", s.flags);
                        let m = CommonMessagesOwned::SetupConnectionSuccess(SetupConnectionSuccessOwned { used_version: 2, flags: s.flags });
                        let _ = tx.send(out(AnyMessageOwned::Common(m))).await;
                    }
                    AnyMessageOwned::Mining(MiningOwned::OpenExtendedMiningChannel(r)) => {
                        println!(
                            "sri-mock-pool: OpenExtendedMiningChannel user_identity={:?} min_extranonce_size={}",
                            String::from_utf8_lossy(r.user_identity.as_ref()),
                            r.min_extranonce_size
                        );
                        let ok = OpenExtendedMiningChannelSuccessOwned {
                            request_id: r.request_id,
                            channel_id: 9,
                            target: r.max_target.clone(),
                            extranonce_size: r.min_extranonce_size,
                            extranonce_prefix: vec![0; 4].try_into().unwrap(),
                            group_channel_id: 1,
                        };
                        let _ = tx.send(out(AnyMessageOwned::Mining(MiningOwned::OpenExtendedMiningChannelSuccess(ok)))).await;
                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as u32;
                        let job = NewExtendedMiningJobOwned {
                            channel_id: 9,
                            job_id: 1,
                            ntime_start: Sv2OptionOwned::new(None),
                            version: 0x2000_0000,
                            version_rolling_allowed: true,
                            merkle_path: Seq0255Owned::new(vec![]).unwrap(),
                            coinbase_tx_prefix: unhex(COINBASE_PREFIX).try_into().unwrap(),
                            coinbase_tx_suffix: unhex(COINBASE_SUFFIX).try_into().unwrap(),
                        };
                        let _ = tx.send(out(AnyMessageOwned::Mining(MiningOwned::NewExtendedMiningJob(job)))).await;
                        let prev = SetNewPrevHashOwned { channel_id: 9, job_id: 1, prev_hash: vec![7; 32].try_into().unwrap(), ntime_start: now, nbits: 0x207f_ffff };
                        let _ = tx.send(out(AnyMessageOwned::Mining(MiningOwned::SetNewPrevHash(prev)))).await;
                        println!("sri-mock-pool: channel opened, sent job 1 + prev hash");
                    }
                    AnyMessageOwned::Mining(MiningOwned::SubmitSharesExtended(s)) => {
                        shares += 1;
                        if reject_every > 0 && shares % reject_every == 0 {
                            println!("sri-mock-pool: share #{shares} (seq {}) REJECTED (simulated)", s.sequence_number);
                            let e = SubmitSharesErrorOwned {
                                channel_id: s.channel_id,
                                sequence_number: s.sequence_number,
                                error_code: "simulated-reject".to_string().into_bytes().try_into().unwrap(),
                            };
                            let _ = tx.send(out(AnyMessageOwned::Mining(MiningOwned::SubmitSharesError(e)))).await;
                        } else {
                            println!("sri-mock-pool: share #{shares} (seq {}) accepted (simulated; not validated)", s.sequence_number);
                            let ok = SubmitSharesSuccessOwned {
                                channel_id: s.channel_id,
                                last_sequence_number: s.sequence_number,
                                new_submits_accepted_count: 1,
                                new_shares_sum: 1,
                            };
                            let _ = tx.send(out(AnyMessageOwned::Mining(MiningOwned::SubmitSharesSuccess(ok)))).await;
                        }
                    }
                    other => {
                        println!("sri-mock-pool: ignoring message {}", format!("{other:?}").chars().take(60).collect::<String>());
                    }
                }
                flush();
            }
            println!("sri-mock-pool: connection closed");
            flush();
        });
    }
}
