import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const batPath = path.join(root, "agent/win7-speedup/speedup.bat");
const raw = readFileSync(batPath, "latin1");
const marker = "#PS" + "START";
const ps = raw.slice(raw.indexOf(marker));

describe("speedup.bat static checks", () => {
  it("is ASCII only", () => expect(/^[\x00-\x7F]*$/.test(raw)).toBe(true));
  it("uses CRLF on every line", () => {
    expect(raw.includes("\r\n")).toBe(true);
    expect(raw.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(raw.replace(/\r\n/g, "").includes("\r")).toBe(false);
  });
  it("stays small (under 50 KB) and has the launcher + one #PSSTART marker", () => {
    expect(raw.length).toBeLessThan(50 * 1024);
    expect(raw.startsWith("@echo off\r\n")).toBe(true);
    expect(raw.split("#PSSTART").length - 1).toBe(1);
    expect(raw).toContain("iex $t.Substring($t.IndexOf('#PS'+'START'))");
    expect(raw).toContain("exit /b\r\n#PSSTART\r\n");
  });
  it("uses no PowerShell 3+ only syntax or cmdlets (the PC has PowerShell 2.0 / .NET 2.0)", () => {
    const banned: [string, RegExp][] = [
      ["ConvertTo-Json/ConvertFrom-Json", /ConvertTo-Json|ConvertFrom-Json/],
      ["JavaScriptSerializer", /JavaScriptSerializer/],
      ["Invoke-WebRequest/Invoke-RestMethod", /Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b/],
      ["[ordered]", /\[ordered\]/],
      ["[pscustomobject]", /\[pscustomobject\]/i],
      ["$PSScriptRoot", /\$PSScriptRoot/],
      ["Get-Content -Raw", /Get-Content[^|;\n]*-Raw/],
      ["Get-ChildItem -File/-Directory", /Get-ChildItem[^|;\n]*\s-(File|Directory)\b/],
      ["IsNullOrWhiteSpace", /IsNullOrWhiteSpace/],
      ["Is64BitOperatingSystem", /Is64BitOperatingSystem/],
      ["Tls12 enum name", /\bTls1[123]\b/],
      ["CIM / PS3+ modules", /Get-CimInstance|Get-FileHash|Get-NetAdapter|Resolve-DnsName|Test-NetConnection|Expand-Archive|Get-WindowsOptionalFeature|Clear-RecycleBin|Get-ScheduledTask|Get-Service|Set-Service|Get-Volume|Get-PhysicalDisk/],
      ["-in / -notin operators", /\s-(in|notin)\s/],
      ["comma-less Where-Object shorthand", /\|\s*(\?|where)\s+[A-Za-z_]/i],
      ["::new(", /::new\(/],
      ["class/enum keyword", /^\s*(class|enum)\s+\w+/m],
      ["Add-Type", /Add-Type/],
      ["null-conditional / ternary / pipeline chain", /\?\.|\?\?|\s\?\s.*\s:\s|&&|\|\|/],
      ["Get-Process -IncludeUserName", /IncludeUserName/],
      ["Write-Information / Select -Skip", /Write-Information|Select-Object[^|;\n]*-SkipLast/],
    ];
    for (const [name, re] of banned) expect(re.test(ps), name).toBe(false);
  });
  it("makes no network calls, downloads nothing and has no URLs", () => {
    expect(ps).not.toMatch(/https?:\/\/|ftp:\/\//i);
    expect(ps).not.toMatch(/Net\.|System\.Net|WebRequest|WebClient|DownloadString|DownloadFile|bitsadmin|certutil|\bcurl\b|\bwget\b|Start-BitsTransfer|nslookup|\bping\b|Send-MailMessage|TcpClient|Socket|Invoke-Expression\s+\(?\s*New-Object/i);
    expect(raw).not.toMatch(/\.vercel\.app|mozilla\.org\/pub|__RELAY_URL__/);
  });
  it("creates no scheduled tasks/services/auto-start and never touches Update, Defender, firewall or McAfee settings", () => {
    expect(ps).not.toMatch(/schtasks[^\n]*\/(create|change|delete|run|end)/i);
    expect(ps).not.toMatch(/Register-ScheduledTask|New-Service|\bsc create\b|\bsc delete\b|RunOnce|-Verb\s+RunAs|Set-MpPreference|Add-MpPreference/i);
    expect(ps).not.toMatch(/wuauserv|WinDefend|MpsSvc|mpssvc|advfirewall|netsh|DisableAntiSpyware|windowsupdate|sc (config|stop|start) ['"]?(McAfee|mfe|mcshield)/i);
    expect(ps).not.toMatch(/-WindowStyle\s+Hidden|-NoExit|Start-Process|\bstart \/b\b/i);
    // the only schtasks use is the read-only query
    for (const m of ps.matchAll(/schtasks[^\n]*/gi)) expect(m[0]).toMatch(/schtasks \/query /);
  });
  it("only changes services it names (WSearch, SysMain) and only the fixed registry lists", () => {
    const svcCmds = [...ps.matchAll(/'sc (config|stop|start) '/g)];
    expect(svcCmds.length).toBeGreaterThan(0);
    expect(ps).toMatch(/@\('WSearch', 'SysMain'\) -notcontains \$f\[0\]/);
    expect(ps).toMatch(/function RegAllowed/);
    expect(ps).toMatch(/HKLM\|Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
    // never writes to HKLM except through the journal-restore/allowlisted Run values
    expect(ps).not.toMatch(/Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Remove-Item\s+-Recurse[^\n]*\$env:USERPROFILE|reg (add|delete)/i);
  });
  it("has the safety checks from repair.bat's clean_user_temp, the Y/N gate and the null guards", () => {
    expect(ps).toMatch(/function TempPath/);
    expect(ps).toMatch(/\$t\.Length -lt 12/);
    expect(ps).toMatch(/\\\\Temp\$/);
    expect(ps).toMatch(/function Ask\(\$q\)/);
    expect(ps).toMatch(/Read-Host/);
    expect(ps).toMatch(/KeepReason/);
    for (const w of ["mcafee", "defender", "ctfmon"]) expect(ps).toContain(`'${w}'`);
    expect(ps).toMatch(/\$vn -eq \$null -or \(\[string\]\$vn\)\.Length -eq 0/);
    expect(ps).toMatch(/if \(\$gid -eq \$null -or \(\[string\]\$gid\)\.Length -eq 0\) \{ continue \}/);
  });
});

function findPwsh(): string | null {
  const candidates = [process.env.PWSH, "pwsh", path.join(homedir(), "pwsh/pwsh")].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}
const pwsh = findPwsh();

describe.skipIf(!pwsh)("PowerShell checks (pwsh available)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "speedup-"));
  const env = { ...process.env, SPEEDUP_BAT: batPath, REPAIR_BAT: path.join(root, "agent/win7-repair/repair.bat"), SPEEDUP_TMP: tmp };
  it("the embedded scripts parse without errors", () => {
    const script =
      "foreach ($f in @($env:SPEEDUP_BAT, $env:REPAIR_BAT)) { $t = [IO.File]::ReadAllText($f); $b = $t.Substring($t.IndexOf('#PS' + 'START')); $e = $null; $k = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($b, [ref]$k, [ref]$e); Write-Host ('ERRORS ' + $e.Count + ' ' + (@($e | ForEach-Object { $_.Message }) -join '; ')) }";
    const r = spawnSync(pwsh!, ["-NoProfile", "-Command", script], { encoding: "utf8", env });
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("ERRORS"));
    expect(lines).toEqual(["ERRORS 0 ", "ERRORS 0 "]);
  });
  it("pure helper functions behave (keep-list, undo journal, registry allowlist, temp cleaner, safety refusals)", () => {
    const r = spawnSync(pwsh!, ["-NoProfile", "-File", path.join(root, "tests/speedup/pure-functions.ps1")], { encoding: "utf8", env });
    const out = r.stdout + r.stderr;
    expect(out).not.toMatch(/^FAIL /m);
    expect((out.match(/^PASS /gm) ?? []).length).toBeGreaterThanOrEqual(23);
  });
  it("repair.bat menu-1 null id regression is fixed", () => {
    const r = spawnSync(pwsh!, ["-NoProfile", "-File", path.join(root, "tests/speedup/repair-null-id.ps1")], { encoding: "utf8", env });
    const out = r.stdout + r.stderr;
    expect(out).not.toMatch(/^FAIL /m);
    expect((out.match(/^PASS /gm) ?? []).length).toBe(5);
  });
});
