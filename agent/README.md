# btc-agent: BTC Network AI worker agent (Phase 4 + Phase 5: Stratum V2)

A small Rust program that turns **a machine you own (or are explicitly authorized to use)** into a worker for the
BTC Network AI platform. It does **not** contain a miner. It runs an existing open-source miner as a **visible child
process**, reports one-minute telemetry to the platform's ingest Worker, and obeys `start` / `pause` / `stop`
commands from the platform owner.

## Read this first: be realistic about CPU / GPU mining

Bitcoin mining is dominated by ASICs that are many orders of magnitude faster and more efficient than any CPU or GPU.
**Mining Bitcoin on a CPU or GPU is extremely unprofitable.** Electricity (and wear, heat and noise) will almost
certainly cost far more than anything you could earn, and at CPU speeds you may never find a share worth paying out on
a pool. This agent exists to manage and monitor workers and to exercise the platform end to end; it does not promise or
estimate earnings, and it never shows earnings: *accepted shares mean only what the miner or pool reports.*

## What it guarantees (visibility, no stealth)

* Runs in the foreground in your terminal. **No daemonizing, no process-name disguise, no obfuscation, no hidden windows.**
* While mining it prints a banner (`MINING IS ACTIVE ON THIS MACHINE`) and a status line every 60 s
  (`state`, `hashrate`, `accepted`, `rejected`, `uptime`, buffered telemetry).
* It keeps a plain-text log (`agent.log`) and a local status file (`status.json`).
* It refuses to run without your typed `yes` (`btc-agent consent`), and stops itself if you withdraw consent.
* **Ctrl-C** (or SIGTERM) stops the miner and the agent cleanly. The miner is never left running as an orphan.
* The private key is stored only in a local `0600` file. It is never logged, printed or sent; only the public key is.
* Numbers are never invented. If the miner's hashrate or share counts cannot be read, they are `unknown` locally, and a
  minute without a known hashrate is simply not reported (see [Telemetry](#telemetry)).
* The payout address must be a **public** address; anything that looks like a private key, WIF, xprv/zprv or seed phrase
  is rejected, in the config and in the miner arguments.

## Install

You need Rust 1.85+ (`rustup` or your distro). No Docker needed.

```sh
cd agent
cargo build --release          # binary: agent/target/release/btc-agent
cargo test                     # unit + fake-miner integration tests (build also compiles the fake miner example)
cargo clippy --all-targets -- -D warnings
```

Copy `target/release/btc-agent` somewhere on your `PATH` (optional). It is a single binary with rustls built in.

Platforms: developed and tested on Linux x86_64. macOS should work (unix code path); Windows builds the non-unix code path
(miner is terminated with `kill` instead of SIGTERM, no 0600 mode) but is untested.

### The miner (bring your own)

The agent wraps an existing miner; **you install and trust the miner yourself.** A sensible first target for a CPU test
is a Stratum V1 CPU miner such as [`cpuminer-opt`](https://github.com/JayDDee/cpuminer-opt) with `-a sha256d`
(check `--help` of the build you install for the exact flags). The miner is pluggable:

| `miner.kind` | Parses | Notes |
| --- | --- | --- |
| `cpuminer` (default) | `accepted: A/T (…%), X khash/sec` lines (cpuminer, cpuminer-opt, cpuminer-multi style) | rejected = T - A; hashrate only from lines that report the total |
| `generic` | whatever you configure with `hashrate_regex`, `accepted_regex`, `rejected_regex` | no regex ⇒ that value stays `unknown`; `shares_cumulative = true` if the regex captures a running total in group 1 |

Parsing is best-effort against the miner's console output and **must be checked against your actual miner's output**
(`agent.log` contains every miner line). Reading a miner's HTTP/JSON API is future work.

## Stratum V2 (SRI translator proxy)

Background, versions, pool facts and trade-offs, each with a source link, are in [`../docs/stratum.md`](../docs/stratum.md). Short version:
Stratum V2 encrypts the link to the pool and authenticates the pool by its public authority key. Ordinary SV1 miners (cpuminer-opt, ...)
cannot speak it, so the agent runs the Stratum Reference Implementation's **translator proxy** (`translator_sv2`) as a **second visible
child process**, and points the miner at it on loopback:

```
miner --SV1 (127.0.0.1 only)--> translator_sv2 --SV2 + Noise--> pool
```

### Setup on Linux (Stratum V2)

1. **Build the translator** (no prebuilt binary is provided; Rust 1.88):

   ```sh
   rustup toolchain install 1.88.0
   git clone https://github.com/stratum-mining/sv2-apps && cd sv2-apps
   git checkout v0.8.0
   cargo build --release -p translator_sv2        # -> target/release/translator_sv2
   sudo install target/release/translator_sv2 /usr/local/bin/   # or just note the path
   ```

   Official instructions: <https://github.com/stratum-mining/sv2-apps/tree/main/miner-apps/translator#installation--build>.
2. **Install a miner you trust** (e.g. cpuminer-opt) as in "The miner (bring your own)".
3. **Get from your pool's official docs**: its Stratum V2 `host:port` and its **public authority key**, plus your account/worker name.
   (Braiins Pool publishes both; see `docs/stratum.md` for the exact values and links, and for what is *not* verified. The agent ships no
   pool defaults.)
4. **Edit `config.toml`**:

   ```toml
   payout_address = "bc1q..."                 # public address only
   mode = "sv2"

   [miner]
   path = "/usr/local/bin/cpuminer"
   args = ["-a", "sha256d", "-o", "{pool_url}", "-u", "{pool_user}", "-p", "{pool_password}"]   # {pool_url} = the proxy on 127.0.0.1

   [stratum_v2]
   enabled = true
   translator_path = "/usr/local/bin/translator_sv2"   # default: translator_sv2 on PATH
   upstream_address = "stratum.braiins.com:3333"        # example only: take yours from your pool's docs
   authority_pubkey = "9awtMD5KQgvRUh2yFbjVeT7b6hjipWcAsQHd6wEhgtDT9soosna"   # PUBLIC key; the Braiins key from its docs
   user_identity = "myaccount.rig1"                     # defaults to pool.user, then payout_address
   downstream_port = 34255                              # loopback only; must be free
   # expected_hashrate_hs = 1000000.0                   # vardiff starting hint (a CPU does far less; this is not a measurement)
   # shares_per_minute = 6.0
   # startup_timeout_secs = 30
   ```
5. `btc-agent run`. The banner lists **both** processes (`Miner:` and `Proxy:` with PIDs, and the pool line saying
   `Stratum V2, Noise-encrypted, via the proxy`); `status.json` and `btc-agent status` show `mode`, `translator_pid` and `translator_port`; the proxy's own
   output is in `agent.log` as `TPROXY` lines.

What the agent does for you:

* Validates the config up front and lists every problem at once. A missing or non-executable translator gives a clear message with the install
  link above. The authority key must be a valid key (a 32-byte/secret-key style string is refused), the upstream must be `host:port`, and
  private-key/xprv/seed-phrase look-alikes are rejected in every new field too.
* On start it writes `tproxy.toml` (0600, no secrets), checks the downstream port is free, starts the proxy, waits for its port and **only then** starts the miner. If the
  proxy fails or never listens, the miner is not started and you see why, with the proxy's last output.
* `pause`, `stop`, Ctrl-C, or a crash of either process stops **both** (miner first, then proxy); a crashed proxy takes the miner down and both are restarted with
  backoff. No orphans (covered by tests).
* **Shares are counted only when the pool confirms them.** tProxy accepts a miner's share locally first, so the miner's own "accepted" counter is not used
  in SV2 mode; the agent counts only the proxy's `SubmitSharesSuccess` / `SubmitSharesError` log lines (pinned to the translator versions in `docs/stratum.md`; if the format
  ever changes, the counters become "unknown" rather than guessed). Hashrate is still read from the miner.
* The first-run consent text (version 2) now discloses the second program; if you consented earlier you will be asked again.

If the pool is unreachable or the key is wrong, the proxy keeps retrying and logs the errors; the agent does **not** silently fall back to V1. To use V1, set
`mode = "sv1"` yourself.

### Setup on Linux (Stratum V1, the explicit fallback)

Same as before: `mode = "sv1"` (or leave it out), fill in `[pool]` (`url = "stratum+tcp://host:port"`, `user`, `password`) and `[miner]`, keep `[stratum_v2] enabled = false`.
V1 is plaintext and does not authenticate the pool; use it only where that is acceptable, or when your pool has no Stratum V2 endpoint.

### Optional: pool-side stats (Braiins Pool only)

```toml
[pool_stats]
enabled = true
provider = "braiins"
api_key_file = "/home/you/.config/btc-agent/pool-api-token"   # a file you create; the token is NOT put in config.toml
poll_secs = 300                                               # 60-3600
# worker_prefix = "myaccount.rig1"                            # default: your pool user / user_identity
```

```sh
install -m 600 /dev/null ~/.config/btc-agent/pool-api-token && $EDITOR ~/.config/btc-agent/pool-api-token   # paste the Braiins access token
```

The agent refuses a token file that is readable by group/others. The token is only ever sent to Braiins (HTTPS, no redirects), is never written to the log, `status.json`
or telemetry, and **is never sent to the platform server**. The numbers shown (`pool says: ...`) are the pool's own hashrate/share counts for your workers, labelled as
pool-reported; they are not merged into the agent's counters or telemetry. No earnings or balances are read or shown. Other pools: future work.

## Consent

```sh
btc-agent consent            # prints what the agent does, asks you to type "yes"
btc-agent consent --revoke   # withdraw consent; a running agent stops within ~a minute
```

The `yes` must be typed in a terminal (piped input is refused) and is stored in `consent.json` with a timestamp.
`btc-agent run` refuses to start without it, and re-checks it every time a miner process starts and on every status tick.

## Enroll

1. In the BTC Network AI admin UI (Workers page) create a one-time enrollment code (`BTCW-XXXXX-XXXXX-XXXXX-XXXXX`,
   valid for **15 minutes**, single use).
2. On the worker machine:

```sh
btc-agent enroll --code BTCW-XXXXX-XXXXX-XXXXX-XXXXX [--name my-rig] [--hardware-type cpu|gpu] [--server URL]
```

This generates an Ed25519 keypair locally, saves the private key to `identity.key` (mode 0600), sends the **public** key,
a signed proof of possession and your hardware info (OS, arch, CPU model, cores, memory, NVIDIA GPU name if `nvidia-smi`
is present) to `POST /v1/enroll`, and stores the returned `worker_id` in `worker.json`. It also writes a commented
`config.toml` template. The default server is `https://btc-network-ingest.btcnetworkai.workers.dev`; non-HTTPS servers
are only accepted for `localhost`. If enrollment fails, the freshly generated key is deleted. Enroll calls are rate
limited by the server (6/min/IP); do not script retries in a loop.

## Config

State directory: the OS config dir (Linux: `~/.config/btc-agent`), or `--home DIR` / `BTC_AGENT_HOME`.
Edit `config.toml`:

```toml
payout_address = "bc1q..."            # PUBLIC address only

[pool]
url = "stratum+tcp://pool.example.com:3333"   # Stratum V1; no credentials in the URL
# user = "<address>.<worker>"        # defaults to payout_address
password = "x"

[miner]
path = "/usr/local/bin/cpuminer"
args = ["-a", "sha256d", "-o", "{pool_url}", "-u", "{pool_user}", "-p", "{pool_password}"]
kind = "cpuminer"
threads_flag = "-t"                   # appends "-t <cpu_threads>" unless args contain {threads}

[limits]
cpu_threads = 2                       # default: half the logical CPUs

[timing]
command_poll_secs = 45                # clamped to 30-300 (server limit: 40 requests/min per worker)
status_line_secs = 60

# mode = "sv1" is the default and is implied by the file above. For Stratum V2 see "Stratum V2 (SRI translator proxy)" below.
```

The top-level `mode` key chooses the pool path and is **explicit, never switched automatically**: `mode = "sv1"` (default, direct
Stratum V1, plaintext) or `mode = "sv2"` (through the local SRI translator proxy). The V1 `[pool]` section is the fallback: to go back
to V1, set `mode = "sv1"` and keep `[stratum_v2] enabled = false`.

Placeholders in `args`: `{pool_url}`, `{pool_user}`, `{pool_password}`, `{payout_address}`, `{threads}`. The pool password is
redacted (`***`) in everything the agent logs, but note that it is visible to other local users in the process list
(`ps`), as with any miner started with `-p`; use a throwaway pool password.

Safety controls:

* **CPU thread cap**: `limits.cpu_threads`, passed to the miner through `{threads}` or `threads_flag`. This is the intensity
  control for CPU miners; GPU intensity flags go in `miner.args`.
* **Max temperature**: *not implemented* (future work). Reading temperatures reliably across machines is not possible
  without per-platform sensors, so `limits.max_temperature_c` is rejected with an error instead of silently doing nothing.
  Watch your temperatures yourself.
* **Only-when-idle / schedule window**: *not implemented* (nice-to-have, skipped as out of scope). Use `--paused` plus server
  commands, or just start/stop the agent yourself.

Run `btc-agent status` to see any config problems.

## Run, and how to see that it is running

```sh
btc-agent run            # starts mining immediately (after the consent/enroll/config checks)
btc-agent run --paused   # idle until the server sends `start`
```

You will see a banner and status lines like:

```
2026-10-31T20:48:19Z INFO  [status] state=mining miner=running (pid 636450) hashrate=1.85 kH/s accepted=12 rejected=3 uptime=30s telemetry_buffered=1
```

* The miner is an ordinary child process (`ps`, Task Manager, `top` show it under its own name).
* `btc-agent status` (from another terminal) shows enrollment, consent, config validity and whether the agent is running.
* Log: `<state dir>/agent.log` (rotated once at 5 MiB). Status file: `<state dir>/status.json`.
* Stop: **Ctrl-C**. A crashed miner is restarted with exponential backoff (5 s … 5 min); you will see a warning.

### Commands from the server

The agent polls `GET /v1/commands` (default every 45 s), applies each command in order and acks it (`POST /v1/commands/ack`):

| Command | Effect |
| --- | --- |
| `pause` | terminate the miner process (SIGTERM, then kill after 5 s); agent keeps running and polling |
| `stop` | terminate the miner; agent stays idle and keeps polling, so a later `start` can resume (Ctrl-C exits) |
| `start` | start the miner (consent is re-checked) |

Already-handled ids are acked again but not re-applied. Unknown commands are logged, not applied and not acked.
A command that cannot be applied (for example the miner fails to start) is left unacked and retried.

## Telemetry

Local aggregation into one `telemetry_1m` row per minute (`bucket_start` minute-aligned UTC, `avg_hashrate_hs`, `accepted`,
`rejected`; `difficulty` and `temperature_c` are never sent because they cannot be read reliably). Rows are batched into
`POST /v1/telemetry` about once a minute, together with `uptime_s` (agent process uptime) and `software_version`.

* Hashrate is the average of the readings the miner printed during that minute (a reading up to 3 minutes old carries over).
* **A minute in which the miner ran but no hashrate could be read produces no row**: the server column is NOT NULL and the agent
  will not invent a number. Accepted/rejected are the per-minute deltas of the miner's counters; if a miner never prints share
  counts they are `unknown` locally and the row carries 0 (the server has no null for them).
* A minute in which the agent was paused (miner not running) is reported as 0 H/s: a fact, not a guess. A stopped agent sends nothing.
* Network down: rows stay in a bounded in-memory buffer (120 rows = 2 hours, the Worker's batch cap; the oldest are dropped
  with a warning), and are sent as one batch on recovery. Errors use exponential backoff with jitter (5 s doubling to 5 min, honoring
  `Retry-After`). A batch the server rejects as invalid (400/413) is dropped so it cannot block later ones. The buffer is not
  persisted across restarts.
* Rate limits: about 1 telemetry request and ~1.3 command polls per minute, far below the Worker's 40/min per worker.
* Hardware info is sent once, at enrollment (the Worker has no field for it in telemetry).

## Uninstall

```sh
btc-agent uninstall          # asks you to type "yes"; --yes skips the prompt; refuses while the agent is running
```

Deletes the private key (overwritten first, best effort), enrollment, config, consent, status and logs, and removes the state
directory if nothing else is in it. It cannot delete the worker record on the server (there is no such endpoint by design):
ask the platform owner to revoke the worker on the Workers page. Your separately installed miner is not touched.
To remove the binary, delete it (and `cargo clean` the build directory).

## Wire protocol (matches `cloudflare/ingest-worker/src/protocol.ts`)

Every request except enroll carries `x-btc-worker`; all carry `x-btc-timestamp` (unix s), `x-btc-nonce` (16 random bytes, base64url) and
`x-btc-signature` (unpadded base64url Ed25519) over

```
BTCNAI1\n<METHOD>\n<PATH>\n<timestamp>\n<nonce>\n<sha256 hex of the exact body bytes>
```

(`/v1/enroll` is signed by the key being registered.) The system clock must be within 5 minutes of real time or the server
answers 401. `agent/tests/vectors/gen-signing-vectors.mts` generates `signing-vectors.json` with the Worker's own TypeScript; the
Rust tests assert byte-identical signatures.

## Testing

* `cargo test`: unit tests (signing vectors, config + secret rejection, consent gate, telemetry aggregation and buffer, command
  planning, parsing) and integration tests that run `examples/fake_miner` (prints cpuminer-style lines; no hashing, no network)
  to test spawn / parse / pause / start / stop / crash-restart / orphan-free shutdown. The fake miner is for tests only.
* Stratum V2 (Phase 5): unit tests for TOML generation, config validation, key formats, process lifecycle and pool-stats parsing;
  `tests/sv2_stack.rs` runs the two-process orchestration against `examples/fake_tproxy.rs` (a **fake** translator that speaks minimal SV1 on
  loopback and prints simulated pool lines) and `examples/fake_sv1_miner.rs` (a fake miner that refuses non-loopback hosts).
* Optional `tests/sri_real.rs`: the agent drives the **real** `translator_sv2` against `integration/sri-mock-pool`, a local test-double Stratum V2 pool
  (real Noise handshake with a key generated at runtime). It is skipped unless `BTC_AGENT_REAL_TPROXY` and `BTC_AGENT_SRI_MOCK_POOL` point to the binaries; see
  [`integration/sri-mock-pool/README.md`](integration/sri-mock-pool/README.md). No real pool is ever contacted by any test.
* A live integration test against the deployed Worker (with the fake miner, never a real miner) was run for the Phase 4 PR and
  its results are in the PR description.

## Limitations / future work

* Stratum V2 goes through SRI's translator proxy (you build and install it). Tested against the real translator only with a local mock pool: **not** against Braiins,
  DMND or any other real pool (see `docs/stratum.md`). Share counting in SV2 mode relies on the translator's log lines. Pool-side stats exist for Braiins only.
* CPU and GPU Bitcoin mining earns nearly nothing, in either mode. Stratum V2 improves security and bandwidth, not profitability.
* No temperature limit, no idle/schedule window, no miner HTTP API polling.
* No automatic start at boot (deliberately: you start it yourself, in a terminal, where you can see it).
* The agent cannot tell the server it exited; the server sees it go quiet.
