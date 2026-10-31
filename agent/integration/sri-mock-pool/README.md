# sri-mock-pool — a TEST DOUBLE, not a pool

A minimal Stratum V2 "pool" used only by `agent/tests/sri_real.rs` to exercise the **real** SRI translator proxy
(`translator_sv2`) on this machine without touching any real pool.

* Listens on loopback only (refuses any other address).
* Generates a **fresh authority key pair every start** and prints only the public half (`AUTHORITY_PUBKEY=...`). The secret
  key lives in memory and is never printed or stored, so nothing sensitive is in this repository.
* Real Noise handshake, `SetupConnection`, `OpenExtendedMiningChannel` (echoing the translator's own `max_target`), a fixed job
  and previous hash, and `SubmitShares.Success` for every share (or `.Error` for every N-th with `--reject-every N`).
  It validates nothing against any chain and pays nothing.
* Built with SRI's own crates (`stratum-apps`, so framing, Noise and message types are SRI's, not re-implemented).

## Build (Linux, Rust 1.88)

It depends on the `stratum-apps` crate by relative path, so build it inside a checkout of
[`stratum-mining/sv2-apps`](https://github.com/stratum-mining/sv2-apps) (tested with commit `8e66a49`, translator_sv2 0.7.0):

```sh
git clone https://github.com/stratum-mining/sv2-apps && cd sv2-apps
cp -r /path/to/btc/agent/integration/sri-mock-pool ./mock-pool
# add "mock-pool" to the `members = [...]` list in the workspace Cargo.toml, then:
cargo build --release -p translator_sv2 -p sri-mock-pool
```

(`pool_sv2` itself needs `capnp` and a Bitcoin Core template provider, so it is not used here.)

## Run the agent's real-translator test

```sh
cd /path/to/btc/agent
BTC_AGENT_REAL_TPROXY=/path/to/sv2-apps/target/release/translator_sv2 \
BTC_AGENT_SRI_MOCK_POOL=/path/to/sv2-apps/target/release/sri-mock-pool \
cargo test --test sri_real -- --nocapture
# add BTC_AGENT_PRINT_LOG=1 to print the agent's log (banner, relayed translator lines, pool-confirmed counts)
```

Without those two variables the test prints `SKIPPED` and passes, so a plain `cargo test` never needs SRI.
