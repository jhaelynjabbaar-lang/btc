# btc-agent on Windows: beginner setup guide

This guide turns a Windows 10 or 11 PC (64-bit) into a worker for the BTC Network AI dashboard. No programming knowledge
is needed. Everything is typed into a PowerShell window, one step at a time.

> **Read this first: the honest truth about money and your PC**
>
> * **A PC CPU earns roughly nothing mining Bitcoin.** The Bitcoin network does on the order of 10^20 to 10^21 hashes
>   per second (hundreds of exahashes per second) and it is run by specialised ASIC machines. A desktop CPU running
>   cpuminer-opt manages somewhere around 10 to 100 million hashes per second, roughly ten to a hundred trillion times less.
>   Your share of the network is so small that the expected payout is a tiny fraction of a cent per day, and pools only
>   pay out once your balance reaches a minimum. You will almost certainly never see a payout.
> * **It costs real money and wears the machine.** Mining makes the CPU work flat out: more electricity (typically tens
>   of watts more, so roughly a few cents to a few tens of cents per day), more heat, louder fans, and a PC that is busier for
>   everything else. Laptops get hot and drain their battery quickly.
> * So run it to **try out the BTC Network AI platform, not to make money.** Only run it on a PC you own or are
>   explicitly allowed to use for this.
>
> The agent never hides: it runs in a visible window, prints a banner and status lines, and keeps a log you can read.

## What you need

| Item | Where from |
| --- | --- |
| `btc-agent.exe` | This repository's **Releases** page: <https://github.com/jhaelynjabbaar-lang/btc/releases> (newest entry named `agent-v...`; pre-releases are marked "Pre-release"). Also download `SHA256SUMS.txt` from the same release. |
| A miner: **cpuminer-opt** by JayDDee | Only from its official page: <https://github.com/JayDDee/cpuminer-opt/releases> (see step 2) |
| A **worker code** from the dashboard | Dashboard, **Workers** page, **Add worker** (step 5) |

The agent does **not** contain a miner and this repository does **not** bundle one. You download the miner yourself from
its official site, so you know exactly what you are running.

## Step 1: make a folder and download the agent

1. Open File Explorer and create the folder **`C:\btc-agent`**.
2. From the Releases page above, download **`btc-agent.exe`** and **`SHA256SUMS.txt`** into `C:\btc-agent`.
3. Windows may show **"Windows protected your PC"** (SmartScreen) because the file is new and not code-signed. Click
   **More info**, check that the file name is `btc-agent.exe` and that you downloaded it from the Releases page of this
   repository, then click **Run anyway** when you start it later.

## Step 2: download cpuminer-opt (official release only)

* Official page: <https://github.com/JayDDee/cpuminer-opt/releases>
* Version checked when this guide was written: **v26.1** (released 2026-01-14), file **`cpuminer-opt-26.1-windows.zip`**
  (about 18 MB), direct link:
  <https://github.com/JayDDee/cpuminer-opt/releases/download/v26.1/cpuminer-opt-26.1-windows.zip>
  If a newer version has appeared on the releases page, the newest `...-windows.zip` is fine too.
* GitHub shows this SHA-256 for that v26.1 zip, so you can check your download (step 3 shows how):
  `caf59deb12831e40475c5245a76bf42f9ba2ff620065be5386b80ec55c998e9c`
* Save it into `C:\btc-agent`, right-click it, **Extract All...**, and extract into **`C:\btc-agent\cpuminer-opt`**.
  **Keep all the files together in that folder:** the `.dll` files next to the `.exe` files are needed.
* cpuminer-opt supports the `sha256d` algorithm used by Bitcoin (it is in the project's own algorithm list).
* The zip contains several programs, one per CPU generation. If you are not sure, use **`cpuminer-sse2.exe`**: it works
  on every 64-bit PC (a little slower). The project's `README.txt` says which exe suits which CPU, for example:

  | File | CPUs |
  | --- | --- |
  | `cpuminer-sse2.exe` | any 64-bit PC (safe default) |
  | `cpuminer-avx2.exe` | Intel Haswell to Comet Lake (4th to 10th gen Core) |
  | `cpuminer-avx2-sha.exe` | AMD Ryzen 1000/2000/3000 |
  | `cpuminer-avx2-sha-vaes.exe` | Intel Alder Lake and newer, AMD Ryzen 5000 |
  | `cpuminer-avx512-sha-vaes.exe` | AMD Ryzen 7000+, Intel Rocket/Ice Lake |

  If a program closes straight away or says it is unsupported, pick a more basic one.

### About antivirus warnings (please read)

Antivirus programs very often flag **any** cryptocurrency miner as a threat, even honest ones. cpuminer-opt's own README
says so. Real malware also hides under the name of miners, so stay careful:

* Download **only** from the official repository link above, never from a search ad, a video description or a
  "mirror".
* Check the SHA-256 (step 3). If it does not match, delete the file.
* If Windows Security quarantines the miner, you can allow **just that file or folder**: Windows Security, **Virus &
  threat protection**, **Protection history**, open the item, **Actions**, **Allow on device**, or add an exclusion for
  only `C:\btc-agent\cpuminer-opt`.
* **Never turn antivirus off**, and never add an exclusion for a whole drive such as `C:\`.
* Remove the exclusion again when you uninstall (step 9).

## Step 3: check the downloads (optional but recommended)

Open PowerShell in the folder (step 4) and run:

```powershell
Get-FileHash .\btc-agent.exe -Algorithm SHA256
Get-FileHash .\cpuminer-opt-26.1-windows.zip -Algorithm SHA256
```

Compare the first with the line for `btc-agent.exe` in `SHA256SUMS.txt`, and the second with the value in step 2. They
must be identical.

## Step 4: open PowerShell in the folder

Open `C:\btc-agent` in File Explorer, click the address bar, type `powershell` and press Enter. A blue window opens
already in that folder. (Or press the Windows key, type `PowerShell`, open it, and type `cd C:\btc-agent`.)

If Windows says the file is blocked, run `Unblock-File .\btc-agent.exe` once.

Use **PowerShell or Command Prompt**, not Git Bash. All commands below start with `.\` which means "this folder".

## Step 5: give consent, then enroll

1. Read what the agent does and agree by typing `yes` yourself:

   ```powershell
   .\btc-agent.exe consent
   ```

   Consent has to be typed by a person in the window. Piping or scripting a "yes" is refused on purpose. Nothing runs
   without it, and you can withdraw it any time with `.\btc-agent.exe consent --revoke`.

2. In the **dashboard**, open the **Workers** page and click **Add worker**. It shows a fresh one-time code that looks
   like `BTCW-XXXXX-XXXXX-XXXXX-XXXXX` and is valid for **15 minutes**. Don't share it.

3. Enroll this PC with that code (add a friendly name if you like):

   ```powershell
   .\btc-agent.exe enroll --code BTCW-XXXXX-XXXXX-XXXXX-XXXXX --name "Office PC"
   ```

   This creates a private key on this PC (only your Windows account can read it) and registers the PC's public key
   with the platform. It also writes a starter config file. If the code is rejected, get a new one from **Add
   worker**: codes expire and work only once.

## Step 6: edit the config file

The config file is here:

```
%LOCALAPPDATA%\BTC Network\btc-agent\config\config.toml
```

which normally means

```
C:\Users\<your Windows user name>\AppData\Local\BTC Network\btc-agent\config\config.toml
```

(`AppData` is a hidden folder in Explorer.) The easy way to open it:

```powershell
notepad "$env:LOCALAPPDATA\BTC Network\btc-agent\config\config.toml"
```

`.\btc-agent.exe status` also prints the folder ("state dir") and the log location.

Find these lines in the file and change them. **Edit the lines that are already there; don't add a second `[pool]` or
`[miner]` heading** (the file would stop working). Remove the `#` at the start of a line to turn it on.

```toml
[pool]
url = "stratum+tcp://stratum.braiins.com:3333"
user = "jhaelyngta.{worker_name}"
worker_name = "pc1"          # your worker's name: letters, digits, - and _ only, max 32
password = "x"

[miner]
path = 'C:\btc-agent\cpuminer-opt\cpuminer-sse2.exe'
args = ["-a", "sha256d", "-o", "{pool_url}", "-u", "{pool_user}", "-p", "{pool_password}", "--no-color"]

[limits]
cpu_threads = 2              # how many CPU threads the miner may use
```

What each one does:

* **`worker_name`**: the name that appears on the pool. The pool user becomes **`jhaelyngta.<name>`**, so `pc1` gives
  `jhaelyngta.pc1`. (The account part `jhaelyngta` is already filled in. It is a public name, not a secret.) If you
  leave `worker_name` out, the PC's computer name is used.
* **`path`**: the full path of the miner program you picked in step 2. **Use single quotes `'...'` for Windows paths**,
  so the backslashes are read literally. Do not use double quotes unless you write every `\` as `\\`.
* **`args`**: how to start the miner. Copy it exactly. `-a sha256d` is Bitcoin's algorithm, and the `{...}` parts are
  filled in by the agent. `--no-color` keeps cpuminer-opt's output clean in the log.
* **`cpu_threads`**: start small. The default is half of your PC's threads. Fewer threads means less heat, noise and
  slowdown of the rest of the PC. Setting this number is the main way to turn the load down.
* Leave everything else as it is. Don't paste private keys, seed phrases or `xprv` values anywhere; the agent refuses
  them.

Save the file, then check it:

```powershell
.\btc-agent.exe status
```

The `config` line should say **valid** (and show `jhaelyngta` plus your worker name's pool settings). If it lists
problems, fix each one in the file; the messages say what is wrong.

## Step 7: run it

```powershell
.\btc-agent.exe run
```

What you will see:

* A framed banner saying **`MINING IS ACTIVE ON THIS MACHINE (BTC Network AI agent)`**, with the miner path, the pool
  (`stratum.braiins.com:3333`), the number of CPU threads and the log file location.
* A `[status]` line about every minute: state (`mining`, `paused`, `stopped`), the miner's process id, **hashrate**,
  **accepted** and **rejected** shares, uptime. A value is shown as `unknown` until the miner has really reported it.
  Numbers are never invented. Don't be surprised by `accepted=0` for a long time on a CPU.
* The miner's own output goes into the log file (`agent.log` in the state folder) so the window stays readable.
* The PC's fans will probably get louder. The Task Manager shows `cpuminer-...exe` using CPU.
* After a minute or so the worker shows up as online in the dashboard.

Leave the PowerShell window open. If the window seems frozen, you probably clicked inside it (Windows pauses a console
while text is selected): press **Esc** or **Enter** once.

### How to pause or stop

* **Stop now:** click the PowerShell window and press **Ctrl-C** (Ctrl-Break works too). The agent stops the miner and
  exits. You can also simply close the window: Windows then ends the miner as well, so nothing keeps running in the
  background.
* **From the dashboard:** the platform owner can send **pause**, **start** and **stop** to a worker; the agent obeys
  within about a minute. *Pause* and *stop* both end the miner process but leave the agent window running and
  listening, so a later *start* resumes mining. Only Ctrl-C (or closing the window) exits the agent itself.
* **Start paused:** `.\btc-agent.exe run --paused` starts the agent without mining until a `start` arrives.
* **Withdraw consent:** `.\btc-agent.exe consent --revoke` makes a running agent stop itself within a minute, and `run`
  will refuse to start until you consent again.
* **Is it running?** In a second PowerShell window: `.\btc-agent.exe status`.
* The agent only runs while the window is open and the PC is awake. It does not start by itself when Windows starts.

## Step 8: if something goes wrong

| Problem | What to do |
| --- | --- |
| `consent has to be typed by a person at a terminal` | You ran it from a script or pipe. Run it in a normal PowerShell window and type `yes`. |
| `enrollment failed ... code may be wrong, already used or older than 15 minutes` | Click **Add worker** again for a fresh code and enroll right away. Also check the PC's clock is correct. |
| `miner.path ... does not exist or is not a file` | Check the path and the single quotes. Use File Explorer to confirm the exe is there. |
| The miner starts and exits again; log says `restarting` | Try a more basic exe (`cpuminer-sse2.exe`). Check that antivirus did not quarantine part of the folder. |
| `btc-agent.exe` or the miner disappears after download | Antivirus quarantined it. Restore only that item (see "About antivirus warnings"). Never turn antivirus off. |
| Connection errors to the pool | Your network may block outgoing connections to port 3333. Try another network. |
| The PC is too hot or slow | Press Ctrl-C and lower `cpu_threads` (for example `1`). |

The log is `agent.log` in the state folder (shown by `status`).

## Step 9: uninstall

1. Press **Ctrl-C** in the agent window (stop it first).
2. Remove the agent's data (private key, enrollment, config, consent, logs):

   ```powershell
   .\btc-agent.exe uninstall
   ```

   Type `yes` when asked. This deletes the folder `%LOCALAPPDATA%\BTC Network\btc-agent\config`.
3. Delete the program folder `C:\btc-agent` (this removes `btc-agent.exe` and cpuminer-opt).
4. If you added an antivirus exclusion or "allowed" item for cpuminer-opt, remove it again in Windows Security.
5. In the dashboard, ask the platform owner to **revoke the worker** on the Workers page. The platform still lists a
   worker until it is revoked; deleting the files on the PC doesn't remove it from the list.

## Good to know

* **What is sent to the platform:** one-minute telemetry (hashrate, accepted/rejected share counts as reported by the
  miner, uptime, agent version), plus hardware info (Windows version, CPU model and core count, memory, GPU name when it
  can be found) once at enrollment. Nothing else: no files, no browsing, no keystrokes. `btc-agent.exe consent` shows the
  exact text.
* **Where the private key is:** `identity.key` in the state folder above. It is created so that only your Windows user
  account can read it, and it never leaves the PC. Anyone who can sign in as you, or who has administrator rights on this
  PC, could still copy it, so only enroll PCs you control.
* **Stratum V2** (the optional encrypted pool mode with a translator program) has not been tried on Windows. This guide
  uses the standard direct mode.
* **Official downloads again:** agent: this repository's Releases page. Miner:
  <https://github.com/JayDDee/cpuminer-opt/releases>. Nothing else.
