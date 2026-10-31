# Stratum V2 (SRI) and the BTC Network AI agent

Phase 5 of the agent (`agent/`) can reach a pool two ways:

| `mode` | Path | Encryption | Pool authenticated |
|---|---|---|---|
| `"sv1"` (default, the explicit fallback) | miner ──Stratum V1──▶ pool | none (plaintext) | no |
| `"sv2"` | miner ──SV1, loopback only──▶ **translator proxy** ──Stratum V2 (Noise)──▶ pool | yes, between proxy and pool | yes, by the pool's authority public key |

The agent never switches between them on its own. If you want V1, set `mode = "sv1"`.

**Everything marked ⚠️ UNVERIFIED below was not confirmed from an official source and must be checked by you before relying on it.**
Nothing in this repository contains a pool secret, and nothing here was tested against a real pool: all testing used local test
doubles (see [Testing](#how-this-was-tested)).

> Honest expectation: mining Bitcoin with a CPU or GPU earns effectively nothing. A modern SHA-256 ASIC does
> hundreds of terahashes per second; a CPU does a few megahashes (about a million times less). Electricity costs more than
> anything you will be credited. Run this to learn, test, or contribute to the project, not to make money.

---

## 1. State of the Stratum Reference Implementation (SRI)

Checked on 2026-10-31 (America/New_York).

| What | Where | Version / status |
|---|---|---|
| Protocol libraries ("stratum") | <https://github.com/stratum-mining/stratum> | library crates; the apps were moved out of this repo |
| Applications ("sv2-apps") | <https://github.com/stratum-mining/sv2-apps> | latest release **v0.8.0** (2026-09-17) |
| Translator proxy (**tProxy**) binary `translator_sv2` | `sv2-apps/miner-apps/translator` | crate `translator_sv2` **0.6.0** in tag v0.8.0; **0.7.0** on `main` |
| Pool (`pool_sv2`), Job Declarator Client/Server | `sv2-apps/pool-apps`, `sv2-apps/miner-apps/jd-client` | not used by this agent |
| Specification | <https://github.com/stratum-mining/sv2-spec> and <https://stratumprotocol.org> | |

* Releases: <https://github.com/stratum-mining/sv2-apps/releases>. The repository's release tag numbers (v0.8.0) are not the crate
  versions (translator_sv2 0.6.0 / 0.7.0).
* Rust: the workspace pins **Rust 1.88** (MSRV and toolchain).
* **No prebuilt tProxy binary is promised by this agent.** Build it from source (below) or use one you trust.
* tProxy is an SV1 server on its downstream side. It accepts ordinary SV1 miners (cpuminer-style) and talks Stratum V2 upstream.

### Building tProxy from source (Linux)

```sh
rustup toolchain install 1.88.0
git clone https://github.com/stratum-mining/sv2-apps
cd sv2-apps
git checkout v0.8.0            # latest release at the time of writing
cargo build --release -p translator_sv2
# binary: target/release/translator_sv2
```

Official build notes: <https://github.com/stratum-mining/sv2-apps/tree/main/miner-apps/translator#installation--build>.
On this project's build box (Rust 1.88.0, no sudo, no C++ toolchain) `translator_sv2` built cleanly from commit `8e66a49`
(`main`, 0.7.0). `pool_sv2` did **not** build there: it needs the `capnp` executable (via `bitcoin-capnp-types`) and, to run, a Bitcoin Core
+ template-provider stack, so a full SRI pool was not used for tests.

### tProxy command line

```
translator_sv2 -c /path/to/config.toml      # also: -f/--log-file
```

## 2. Configuring tProxy (the TOML the agent writes for you)

The agent generates `tproxy.toml` (mode 0600, next to its own config) on **every start** from `[stratum_v2]` in `config.toml`.
You do not have to write it. For reference, this is what it contains (keys verified against `translator_sv2` source, which has an identical
`config.rs` on `main` and in tag v0.8.0):

```toml
downstream_address = "127.0.0.1"      # the agent ALWAYS uses loopback: the SV1 side is plaintext
downstream_port = 34255
max_supported_version = 2
min_supported_version = 2
downstream_extranonce2_size = 4
verify_payout = false
aggregate_channels = false            # one channel per miner => pool-side worker "<user_identity>.miner1"

[downstream_difficulty_config]
min_individual_miner_hashrate = 1000000.0   # starting hint (H/s) for vardiff; NOT a measurement
shares_per_minute = 6.0
enable_vardiff = true
job_keepalive_interval_secs = 60            # REQUIRED by translator_sv2 (tProxy refuses to start without it)

[[upstreams]]
address = "pool.example.com"
port = 3333
authority_pubkey = "9..."                   # the pool's PUBLIC authority key (see below)
user_identity = "account.worker"
```

Notes from the source and from testing:

* `job_keepalive_interval_secs` is a required key. A config without it fails with ``missing field `job_keepalive_interval_secs```.
* `user_identity` lives **inside each `[[upstreams]]` entry**. Some READMEs still show it at the top level; that is stale.
* With `aggregate_channels = false` the pool sees the worker as `<user_identity>.minerN` (confirmed against the real translator:
  `mock.worker.miner1`). The counter `N` increments per SV1 connection, so after a restart the suffix can change.
* Optional keys the agent does not set: `supported_extensions`, `required_extensions`, `log_file`, `monitoring_address`,
  `monitoring_cache_refresh_secs`, `[miner_telemetry]`. The agent never enables tProxy's monitoring HTTP server.
* tProxy accepts a miner's share **locally** (it checks it against the target) before the pool has answered, so the miner's
  own "accepted" counter is *not* the pool's. The pool's verdict only appears in tProxy's log as
  `Received: SubmitSharesSuccess(... new_submits_accepted_count=N ...) ✅` / `Received: SubmitSharesError(...) ❌`. The agent counts
  accepted/rejected shares **only** from those lines and ignores the miner's own accepted counter in SV2 mode. These log lines
  are the only interface available, so this parsing is pinned to the versions above and is best effort; if the format changes
  the counters stay "unknown" instead of guessing.

## 3. Noise encryption and authority public keys

* Stratum V2 wraps the connection in a **Noise** handshake (`Noise_NX_Secp256k1+EllSwift_ChaChaPoly_SHA256`, per the
  [spec's Protocol Security chapter](https://github.com/stratum-mining/sv2-spec/blob/main/04-Protocol-Security.md)).
  The pool presents a certificate signed by its **authority key**; the client (tProxy) checks that signature against the
  `authority_pubkey` you configured. A wrong or missing key means a failed handshake and no connection, which is what prevents a
  man in the middle from hijacking your hashrate.
* **Key format (what the agent validates):** base58check of 34 bytes = a 2-byte little-endian version (`1`) followed by the
  32-byte x-only secp256k1 public key. It is about 51 characters starting with `9`, e.g. the Braiins key below. A string that decodes to 32 bytes
  is the *older* format or a secret-key format and is rejected: older SRI examples (such as `u95GEReV...` / `3VANf...` in
  archived configs) are stale and must not be used.
* An authority **public** key is not a secret and may sit in `config.toml`. The agent rejects anything that looks like a private key,
  WIF, xprv or seed phrase in every field, including the new ones.
* tProxy → pool is encrypted and authenticated. miner → tProxy (SV1) is **not**, which is why the agent forces `127.0.0.1`.

## 4. Pools: what is officially documented

### Braiins Pool (official docs: <https://academy.braiins.com/braiins-pool/stratum-v2-manual>)

| Item | Documented value |
|---|---|
| Stratum V2 URL | `stratum2+tcp://stratum.braiins.com:3333/9awtMD5KQgvRUh2yFbjVeT7b6hjipWcAsQHd6wEhgtDT9soosna` |
| Authority public key (the URL path) | `9awtMD5KQgvRUh2yFbjVeT7b6hjipWcAsQHd6wEhgtDT9soosna` |
| Stratum V1 URL (fallback) | `stratum+tcp://stratum.braiins.com:3333` |
| V1 backup | `stratum+tcp://stratum.braiins.com:443` ([BTC mining setup](https://academy.braiins.com/braiins-pool/btc-mining-setup)) |
| User ID | `userName.workerName` (your Braiins account name + a device name); password: anything or empty |

Sources: [Stratum V2 manual](https://academy.braiins.com/braiins-pool/stratum-v2-manual),
[BTC mining setup](https://academy.braiins.com/braiins-pool/btc-mining-setup),
[troubleshooting FAQ](https://academy.braiins.com/braiins-os/faqs/troubleshooting) (repeats the same key).

⚠️ **UNVERIFIED / ambiguous:**

* The manual says SV2 uses "default port 3336" when no port is given, while the example URL says `:3333`; the troubleshooting FAQ lists ports
  3333, 3336 and 3337. Braiins documents its V2 endpoint for *Braiins OS firmware* and standard miners; **Braiins does not
  document using SRI's `translator_sv2` against it.** It follows the same SV2 protocol and should work with the key above, but that exact
  combination was not verified by anyone here. Try `stratum.braiins.com:3333` first, and `:3336` if it does not connect.
* The agent ships with **no pool preconfigured.** You choose the pool and the account.

### DMND (official docs: <https://github.com/dmnd-pool/dmnd-client>, <https://blog.dmnd.work/build-your-own-blocks-set-up-dmnd-end-to-end/>)

DMND does **not** publish a generic "point any SV2 proxy here" endpoint and authority key in the docs found. Its documented flow is its own
`dmnd-client`: register at <https://join.dmnd.work> to get a token, run the DMND client (which talks to the pool,
needs a Bitcoin Core node and a template provider for job declaration, and uses outbound port 20000), and point standard miners at the client, e.g.
`stratum+tcp://<client-machine-ip>:32767`, with the token as the password.

* ⚠️ **No DMND SV2 pool address or authority public key is listed here, because none was found in official docs.** Do not guess one.
* Practical use with this agent: run `dmnd-client` yourself and use `mode = "sv1"` pointing at `stratum+tcp://127.0.0.1:32767`
  (the client's own V1 listener), following DMND's docs for the token. The agent treats that as an ordinary V1 pool.

### Other pools

Not researched. If a pool publishes a Stratum V2 host:port and an authority public key in its official documentation, those two values are all
`[stratum_v2]` needs.

## 5. V1 vs V2 trade-offs

| | Stratum V1 | Stratum V2 via tProxy |
|---|---|---|
| Wire encryption | none: share submissions, your user name and job data are visible on the path | Noise-encrypted to the pool |
| Pool authentication | none; a network attacker can redirect or hijack hashrate | pool proven by its authority key |
| Bandwidth | JSON text | compact binary |
| Moving parts | one process (the miner) | two processes (miner + tProxy); one more thing to install, update and trust |
| Share accounting | the miner reports what the pool said | the **proxy** accepts locally first; only the proxy's log shows the pool's verdict |
| Maturity | decades of deployment, every miner supports it | newer; fewer pools; log format and config keys have changed between releases |
| Failure modes | pool down = miner reconnects | proxy down = miner has nothing to talk to (the agent stops the miner too and restarts both) |
| Needs a miner that speaks SV2? | n/a | **no**: tProxy lets ordinary SV1 miners use V2 pools |

Neither mode changes how little CPU mining pays.

## 6. Optional pool-side stats (Braiins only)

The agent can poll **Braiins Pool's** worker API and show the pool's own numbers on your screen (`btc-agent status`).

* Endpoint: `GET https://pool.braiins.com/accounts/workers/json/btc` with header `Pool-Auth-Token: <token>`.
  Docs: <https://academy.braiins.com/braiins-pool/monitoring>. The token comes from Braiins **Settings → Access Profiles**
  (enable "Allow access to web APIs").
* The documented rate limit is roughly one request every 5 seconds; the agent's default is one every 300 seconds, and it never goes lower than 60 (`poll_secs` is clamped to 60–3600).
* **The token lives only in a local file you create, mode 0600** (the agent refuses to read it otherwise), never in `config.toml`, logs,
  `status.json` or telemetry. It is never sent to the Cloudflare Worker. The Braiins client follows no redirects and only
  uses `https` (loopback `http` is allowed for tests).
* The result is labelled as pool-reported and is **not** merged into the agent's counters or telemetry. The agent's
  accepted/rejected counters in SV2 mode come only from pool-confirmation lines in tProxy's log.
* **No earnings, balance or payout figures are read, calculated or shown.** Only hashrate and share counts the pool reports for
  workers matching your user name.
* ⚠️ UNVERIFIED: the JSON field names are taken from Braiins' documentation sample (`hash_rate_5m`, `shares_5m`, `state`, `last_share`, ...); if the
  response shape differs the agent shows "pool stats unavailable" instead of numbers.
* For any other pool (including DMND): **future work.** No other pool API was documented clearly enough to implement.

## 7. How the agent runs it

1. `btc-agent run` loads `config.toml` and validates it (startup reports every problem at once).
2. In `sv2` mode it checks the translator binary exists and is executable. If it does not, it stops with
   "translator_sv2 not found ... build it: <https://github.com/stratum-mining/sv2-apps/tree/main/miner-apps/translator#installation--build>".
3. It confirms `127.0.0.1:<downstream_port>` is free, writes `tproxy.toml` (0600), and starts `translator_sv2 -c tproxy.toml` as a visible child process.
4. It waits (default up to 30 s, `stratum_v2.startup_timeout_secs`) until the port is listening (read from `/proc/net/tcp` on Linux, so no connection is opened), then starts the miner at
   `stratum+tcp://127.0.0.1:<port>`. If the proxy dies or never listens, the miner is never started and the reason, with the proxy's last output, is logged.
5. The banner, `status.json` and the log show both processes with their PIDs. Proxy output is in the log as `TPROXY` lines.
6. `pause`, `stop` and Ctrl-C stop the miner first, then the proxy (SIGTERM, then SIGKILL after a grace period). If the proxy exits by itself, the miner is stopped too and
   both are restarted with backoff. No orphan processes are left in any of these cases (covered by tests).
7. Consent: the first-run consent text (version 2) states that a second program (the proxy) runs and what `[pool_stats]` does. Existing installs are asked again.

## How this was tested

No test mined for real or connected to a real pool.

| Layer | What | Real SRI? |
|---|---|---|
| `cargo test` unit tests | TOML generation, config validation, key-format checks (incl. the real Braiins key), process lifecycle, the `/proc/net/tcp` parser, pool stats parsing against a local mock HTTP server | no |
| `tests/sv2_stack.rs` | two-process orchestration with `examples/fake_tproxy.rs` (a FAKE translator: minimal SV1 on loopback, simulated pool lines) and `examples/fake_sv1_miner.rs` (FAKE miner) | **no, fake translator** |
| `tests/sri_real.rs` (optional, needs two env vars) | the agent drives the **real** `translator_sv2` (built from sv2-apps `8e66a49`, 0.7.0) against `agent/integration/sri-mock-pool`, a local **test-double** pool built on SRI's own `stratum-apps` crate (real Noise handshake with a fresh runtime-generated authority key, real SV2 channel open, jobs, share acks and rejects). The miner is the fake SV1 miner with `--hash`, which really double-SHA256-hashes at a difficulty of about 1e-9 | **real tProxy + real SV2/Noise, mock pool** |

Not tested: any real pool (Braiins, DMND or other), `pool_sv2` (needs capnp + Bitcoin Core), tProxy v0.8.0 as a binary (only its config schema and log strings were compared with `main`), real miners (cpuminer-opt etc.),
Braiins Worker API against the live service (tested against a local mock using the documented sample).

## 8. What you need to decide or provide

* **Pool choice** and its V2 host:port + authority key (from the pool's own docs), or use V1.
* **Account / worker name** at that pool (`user_identity`).
* **Payout address**: a public address only. The agent never needs a private key.
* **Your machine's OS and CPU**: this is documented and tested for Linux; other systems may need adjustments (and the Windows/macOS process handling is not covered by the Linux tests).
* A miner program you choose and trust (e.g. cpuminer-opt), and the tProxy binary you built.
