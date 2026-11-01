# Windows 7 repair helper

A small, visible, **ask-first** repair tool for an old Windows 7 PC whose browsers will not open, plus an admin page (`/repair`) that reads its reports and can *suggest* fixes. Written for: Win7 SP1 x64, AMD E-300, ~2 GB RAM, IE9 (2011), PowerShell 2.0 / CLR 2.0.50727, no usable browser, no second computer.

## Safety model (what is enforced, and where)

| Rule | Enforced by |
| --- | --- |
| The server never runs anything on the PC. It can only *suggest* one of 22 fixed action ids. | The commands live inside `repair.bat`. The API only stores/returns ids (`lib/repair/actions.ts`, DB `CHECK`, zod `enum`, re-validated on poll). Unit tests + a script/TS parity test fail if the lists drift. |
| The person at the PC approves every change. | `repair.bat` prints the exact command lines and what they change, then waits for a local Y/N (`Ask`). Declined = nothing runs. Read-only checks run after one up-front consent. |
| AI is optional and boxed in. | Only NVIDIA Nemotron 3 Ultra via OpenRouter (`nvidia/nemotron-3-ultra-550b-a55b`), server-side, key in Vercel env. Output is filtered to allowlisted ids that are supported by a warn/fail finding, text is ASCII with no URLs/shell, max 5, stored as `proposed`. The admin must *queue* it; the PC still asks Y/N. The model is not called if nothing is warn/fail. IP/MAC addresses are scrubbed from the prompt. |
| No secrets in the repo, script or browser. | The script holds none. A device token is shown once at pairing and stored on the PC encrypted with Windows DPAPI (`%APPDATA%\Win7RepairHelper\device.txt`); the server stores only a SHA-256 of it. Pair codes are single-use, 15 min, salted-hash stored. |
| Abuse limits. | 8 pair attempts / 10 min / address, 40 / hour overall, 30 reports / hour / device, 1 analysis / 20 s and 12 / hour. Revoking a device kills its token immediately. |
| Admin only. | `/repair` and `/api/admin/repair/*` use the same gate as the rest of the private app (GitHub owner sign-in or Vercel SSO on previews) and same-origin checks. |
| DB access. | 5 new `repair_*` tables, RLS on, **no** anon/authenticated grants or policies; only the server's secret key touches them. |

Not a goal: remote control, background service, auto-start, or anything that runs without a visible window.

## The important TLS fact (why a browser is step one)

- Vercel's edge only accepts TLS 1.2 ECDHE-RSA with AES-GCM/ChaCha20 and TLS 1.3. Windows 7's built-in stack (SChannel) has none of those suites. **Nothing built into Win7 (IE, PowerShell 2.0/.NET, BITS, certutil, WinHTTP) can open `*.vercel.app` directly.** This was checked from outside with `openssl s_client` (handshake failure for Win7-style suites on Vercel; success on the Cloudflare relay below).
- **Firefox ESR 115** ships its own TLS and certificate store, so it can open the site (and most of the web) regardless of what Windows supports. It is the last Firefox for Windows 7. It only needs the PC clock to be roughly right.
- Windows' own TLS 1.2 is *off by default* on Win7 and PowerShell 2.0/.NET 2.0 (CLR 2.0.50727.5420) cannot ask for it without extra updates (KB3154518 + registry for .NET, KB3140245 + `DefaultSecureProtocols` for WinHTTP/BITS). The script diagnoses all of this read-only and offers the registry fixes behind Y/N, but **treat direct device-to-server reporting as best-effort**.

## Recommended path (what to do, in order)

### 1. Get Firefox ESR 115 onto the PC

Official file, verified 2026-11-01 against Mozilla's published `SHA256SUMS`:

| | |
| --- | --- |
| Version | Firefox ESR **115.44.0esr** (64-bit, en-US) |
| URL | `https://archive.mozilla.org/pub/firefox/releases/115.44.0esr/win64/en-US/Firefox%20Setup%20115.44.0esr.exe` |
| SHA-256 | `1561f9eaf625804b13c584022bcceb0baff356173a804b39b9b06cfaef875fc2` |
| Lighter 32-bit option | `.../win32/en-US/Firefox%20Setup%20115.44.0esr.exe` SHA-256 `0b48e353d0be0bd367d1f7b383ca3dd04159fb29175c416587e4ba46b23f99c6` (Mozilla lists 2 GB RAM as recommended for 64-bit; this PC has about 2 GB) |
| Checksums | `https://archive.mozilla.org/pub/firefox/releases/115.44.0esr/SHA256SUMS` |

In **Command Prompt** (no double quotes needed; adjust `PC` if the user name differs):

```
date /t
time /t
mkdir C:\Users\PC\Desktop\RepairHelper
cd /d C:\Users\PC\Desktop\RepairHelper
bitsadmin /transfer ff /download /priority foreground http://archive.mozilla.org/pub/firefox/releases/115.44.0esr/win64/en-US/Firefox%20Setup%20115.44.0esr.exe C:\Users\PC\Desktop\RepairHelper\ff.exe
certutil -hashfile ff.exe SHA256
```

Compare the printed hash with the table (character for character). Only if it matches, run `ff.exe`. If the date is years wrong, fix the clock first (`time` / `date`).

Unverified from here: whether Mozilla's server serves that file over plain `http://` to BITS (this build environment blocks plain HTTP). If the transfer errors, the SHA-256 check still protects you: use the USB route. **USB route (no network needed on the PC):** on the Chromebook/phone download the file from the URL above, check its SHA-256 (any hash tool; Chromebook: Files app has no hash, use a web hash tool or `sha256sum` in Linux/Crostini), copy to a USB stick, and run it on the PC, then run the `certutil -hashfile` line there.

`repair.bat` automates the same download (menu option 2): it tries BITS over HTTP, BITS over HTTPS, then `certutil -urlcache`, and refuses to offer the installer unless the SHA-256 matches the value pinned in the script.

### 2. Get `repair.bat` (needs a working browser, so after step 1)

In Firefox open `https://btc-woad-three.vercel.app/r`. It downloads `repair.bat`. The `/repair` admin page shows the SHA-256 of the exact file served; check it with `certutil -hashfile repair.bat SHA256`. (Windows may show a SmartScreen/antivirus prompt for an unsigned .bat; McAfee can interfere. Reading the file in Notepad first is encouraged: it is plain text.)

Right-click -> **Run as administrator** (most fixes need it; read-only checks work without).

### 3. What the script does

1. Asks once before running read-only checks (OS/SP/arch/RAM/disk, IE version and whether the IE feature is enabled, `iexplore.exe`, file associations, `DisallowRun`, IFEO `Debugger` hijacks, proxy, hosts file, DNS, ping, clock, TLS registry state, hotfixes, root certificates, reachability of the server). 29 finding ids.
2. Saves a human report and a compact JSON report on the Desktop (`RepairHelper`) and prints an **offline code** `W7-XXXX-XXXX-XXXX-C` (24 findings x 2 bits plus a check digit).
3. Menu: show suggested fixes, install Firefox, run one action by id, send report to server, **copy compact report to clipboard**, re-run checks. Every fix shows the exact command lines and a "what changes" line, then asks Y/N.
4. Everything is logged to `RepairHelper\repair-log.txt`. It installs nothing resident and exits when you close it.

### 4. Getting the result to the admin (any one of these)

1. **Paste (works with Firefox, no PC-to-server TLS needed):** menu option 5 copies the compact JSON to the clipboard. In Firefox open `/repair`, sign in, paste into "Paste a report or offline code", Add report. Then "Analyze with Nemotron" (optional) and queue suggestions. Because a pasted report has no paired device, the suggestions are not delivered automatically: the page shows `repair.bat run <id>` for the user to type, and the script still asks Y/N.
2. **Offline code:** read the code from the script window (or type it from the Chromebook/phone) into the same box. It decodes to the 24 offline findings with a check-digit typo guard.
3. **Direct pairing via the relay (best-effort, see TLS above):** admin clicks "New pairing code" (`RP-XXXXX-XXXXX`, 15 min). In the script, menu 4 asks for the code and, if the PC's TLS stack can reach the relay, trades it for a device token, uploads the report, then fetches queued suggestions and acks each result.

## Cloudflare relay (optional, additive)

`cloudflare/repair-relay` is a ~60-line Worker that forwards **only** these method+path pairs to the Vercel app and nothing else (no admin routes, query string dropped, bodies <= 16 KB, no cookies forwarded): `GET /r`, `GET /api/repair/ping`, `GET /api/repair/suggestions`, `POST /api/repair/pair`, `POST /api/repair/report`, `POST /api/repair/suggestions/<uuid>/ack`. It holds no secrets, uses no bindings or storage, and runs on the Cloudflare Free plan on `workers.dev`.

- Why it helps: Cloudflare's edge accepts the older ECDSA TLS 1.2 suites Windows 7 can speak (checked with `openssl`: ECDHE-ECDSA-AES256-SHA384 / AES128-SHA256 / AES128-SHA all negotiate).
- Limits (unverified on a real Win7 PC): the PC must have TLS 1.2 enabled for the client (see TLS section), and its certificate store must trust **ISRG Root X1** (the relay's Let's Encrypt chain ends there; the script checks for it).
- Deploy: `cd cloudflare/repair-relay && npx wrangler deploy` (or the Cloudflare API). `UPSTREAM` in `wrangler.toml` is the only setting.
- Wire it up: set `REPAIR_RELAY_URL=https://btc-repair-relay.<your-subdomain>.workers.dev` in Vercel and redeploy; `/r` then bakes that URL into the served script (https only, validated). Without it the script runs in offline/paste mode and asks for a server address if you choose "send".
- All relay traffic reaches Vercel from Cloudflare's addresses, so the per-address pairing limit is effectively shared across relay users; the global limits above still apply.

## Action allowlist

IDs: `flush_dns`, `renew_ip`, `reset_winsock`, `reset_tcpip`, `reset_winhttp_proxy`, `clear_ie_proxy`, `reset_hosts`, `resync_time`, `sfc_scan`, `chkdsk_readonly`, `enable_tls12_schannel`, `enable_tls12_winhttp`, `enable_tls12_dotnet`, `enable_ie_tls12`, `enable_ie_feature`, `reset_url_associations`, `fix_exe_association`, `clear_disallowrun`, `clear_ifeo_debugger`, `clean_user_temp`, `download_firefox`, `install_firefox`.

The title, "what it changes" text, admin/reboot flags and command lines for each are in the `$ActionTable` block of `agent/win7-repair/repair.bat`; titles, change text and flags are mirrored in `lib/repair/actions.ts` and checked equal by `tests/repair/script-parity.test.ts`. Actions that delete registry keys: `clear_disallowrun` and `clear_ifeo_debugger` first `reg export` a `.reg` backup to the Desktop (the association resets only remove this user's saved UserChoice keys, and `fix_exe_association` uses assoc/ftype); `reset_hosts` keeps `hosts.bak`; the TLS actions only add values. A reboot may be required (the `reboot` flag is shown before the Y/N). Changing the list means changing the script, TS, SQL `CHECK` and tests together; the parity test fails otherwise.

## Server pieces

- Migration: `supabase/migrations/20261101210001_repair_agent.sql` (additive; 5 tables, RLS on, all client privileges revoked).
- Device API (bearer token): `GET /api/repair/ping`, `POST /api/repair/pair`, `POST /api/repair/report`, `GET /api/repair/suggestions`, `POST /api/repair/suggestions/:id/ack`. `GET /r` serves the script.
- Admin API (private): `/api/admin/repair/{pairing-codes,paste,offline,analyze,suggestions,suggestions/:id,devices/:id}`.
- Env: `OPENROUTER_API_KEY` (already used by the app, optional here), Supabase server vars (already set), `REPAIR_RELAY_URL` (optional, public URL only).

## Verification status

Verified: unit tests (allowlist, pairing, offline code incl. cross-check with the PowerShell implementation, schemas, AI filter, service flows with an in-memory store, relay routing, script/TS/SQL parity, banned PowerShell 3+ syntax scan), PowerShell AST parse of the embedded script, lint, typecheck, migration applied and RLS/grants confirmed, the Firefox hashes against Mozilla's `SHA256SUMS`, TLS cipher behaviour of Vercel vs. the relay, relay allowlist behaviour on the deployed Worker.

**Not verified: any run on a real Windows 7 machine** (cmd quoting of the typed lines, BITS/certutil behaviour on that build, WMI/registry reads, McAfee interaction, clipboard, DPAPI token file, PC-to-relay TLS). Run `repair.bat diag` first and read the log.
