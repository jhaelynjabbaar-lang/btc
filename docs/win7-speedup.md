# Windows 7 PC Speed-Up

A small, visible, **offline**, ask-first tool that makes an old Windows 7 PC feel faster. Separate from the repair helper ([win7-repair.md](win7-repair.md)). Written for: Acer, Win7 SP1 x64, AMD E-300, ~2 GB RAM, PowerShell 2.0 / .NET CLR 2.0, McAfee, Firefox ESR 115, IE9.

- Download: `https://btc-woad-three.vercel.app/s` (saves `speedup.bat`). Open it in Firefox ESR 115 (Windows 7 itself cannot reach `*.vercel.app`; see the TLS section of the repair doc) or copy the file over by USB. Windows/McAfee may warn about an unsigned `.bat`; it is plain text, read it in Notepad first.
- Run: double-click. For menu 6 (services, page file) right-click > **Run as administrator**.
- Source: `agent/win7-speedup/speedup.bat` (batch launcher + embedded PowerShell 2.0 after `#PSSTART`, run through `iex`, same pattern as `repair.bat`). Served by `app/s/route.ts` as an attachment with `cache-control: no-store`.

## Safety model

- **Offline.** No downloads, no network calls, nothing is sent anywhere (a test fails if `Net.*`, URLs, `bitsadmin`, `certutil`, `ping` etc. appear).
- **Scan first.** The read-only scan runs before any change is offered. Every change prints exactly what it will do (registry value, shortcut, command line) and waits for a local **Y/N**.
- **Log + undo.** Everything is logged to `Desktop\SpeedUp\log-<timestamp>.txt`. Reversible changes are written to `Desktop\SpeedUp\undo.txt` *before* they happen; startup shortcuts are moved (not deleted) into `Desktop\SpeedUp\disabled-startup\`. Menu 9 restores each change after a Y/N; restore only accepts the fixed registry values, services, GUIDs and paths this tool itself writes.
- **Never touched:** McAfee or any other security software, Windows Update, Defender, the firewall, Windows/driver startup items (listed as "kept"). No scheduled tasks, no hidden windows, no auto-start, no other registry changes, no deleting user documents.
- **Deletions that cannot be undone** are limited to temp/cache files and the Recycle Bin, each behind a size read-out and a Y/N.

## Menu

1. **Scan (read-only):** RAM free/total, top 8 programs by memory and top 5 by CPU (3-second sample), startup items (HKCU/HKLM `Run`, `Wow6432Node\Run`, both Startup folders), visual-effects setting, Aero/Basic theme, page file, disk free, temp / Firefox cache / Recycle Bin sizes, power plan, Windows Search and Superfetch state, McAfee services and scheduled tasks (only listed).
2. **Startup programs:** one at a time, Y/N. Registry values are backed up then deleted; shortcuts are moved. Security, Windows and hardware-driver items are kept. All-users items need Administrator.
3. **Visual effects:** "Adjust for best performance" for the current user (VisualFXSetting, UserPreferencesMask bit-cleared to the best-performance pattern `90 12 03 80 10 ...`, MinAnimate, DragFullWindows, TaskbarAnimations, ListviewAlphaSelect, ListviewShadow, Aero Peek) plus an optional switch to the Windows 7 Basic theme (`themecpl.dll,OpenThemeAction`). Log off/on to see everything. Undoable.
4. **Clean:** user temp (only files older than 1 hour; refuses a `TEMP` that is not under the profile and ending in `\Temp`), Firefox `cache2` (only when Firefox is closed; bookmarks/logins untouched), optional Recycle Bin (your own `$Recycle.Bin\<SID>` folder). Sizes shown first.
5. **Power plan:** High performance via `powercfg /setactive`, undo restores the previous GUID. Battery note shown.
6. **Admin only:** Windows Search and Superfetch (`SysMain`) to Manual (`sc config ... start= demand`, optional stop now), page file to system managed *only if it is disabled*. Undo restores the previous start type / page-file setting. Without elevation it just says to run as administrator.
7. **Firefox tips:** text only (few tabs, uBlock Origin, remove unused add-ons).
8. **Summary:** free RAM at first scan vs now, and the changes made. Most changes need a restart, so re-scan after rebooting for a fair comparison.
9. **Undo / restore.**

## PowerShell 2.0 notes

No PS3+ syntax or cmdlets (`-in`, `[ordered]`, `ConvertTo-Json`, `Get-CimInstance`, `Add-Type`, ...), no `JavaScriptSerializer`, WMI via `Get-WmiObject`, registry through `Microsoft.Win32.Registry`. Array-returning functions are wrapped in `@()` and `$null` entries skipped; every hashtable lookup is guarded; `$pid`-style automatic variables are avoided; function-local names are distinct (variable names are case-insensitive).

## Verification status

Verified here (Linux): file is ASCII + CRLF and under 50 KB; static scans (no PS3+ syntax, no network, no scheduled tasks/Defender/Update/firewall/McAfee changes); the embedded script parses with the PowerShell AST; pure helper logic runs under `pwsh` (keep-list, undo journal, registry/service/GUID/theme allowlists, temp walker and safety refusals); the menu 2/3/9 flows were also exercised against a mocked in-memory registry. The route tests check the attachment, no-store and CRLF.

**Not verified: any run on a real Windows 7 machine** (WMI/registry reads, `powercfg`/`sc`/`rundll32` output on that build, theme switching, Recycle Bin and Firefox cache paths, McAfee interaction, Explorer picking up visual-effect changes, SmartScreen/antivirus prompts). Start with menu 1 and read the log.
