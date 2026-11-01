@echo off
rem ======================================================================================================
rem  Win7 Repair Helper (agent/win7-repair/repair.bat)  -  batch launcher + embedded PowerShell 2.0 code.
rem  Visible window, no background service, no auto-start. Read-only checks after ONE consent; every change
rem  shows the exact command and waits for a local Y/N. The server can only SUGGEST ids from the fixed list
rem  below; the commands themselves are inside this file. Log + report go to Desktop\RepairHelper\.
rem  Usage:  repair.bat            (menu)        repair.bat diag          (checks + report, no menu)
rem          repair.bat run <id>   (one listed action, still asks Y/N)
rem ======================================================================================================
setlocal
title Win7 Repair Helper
set "RA_SELF=%~f0"
set "RA_ARGS=%*"
set "RA_PS=powershell"
if exist "%windir%\sysnative\WindowsPowerShell\v1.0\powershell.exe" set "RA_PS=%windir%\sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%RA_PS%" -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:RA_SELF);iex $t.Substring($t.IndexOf('#PS'+'START'))"
echo.
echo Finished. Press any key to close this window.
pause >nul
exit /b
#PSSTART
$ErrorActionPreference = 'Continue'
$Ver = '1.0'
$Relay = '__RELAY_URL__'
if ($Relay -like '__*') { $Relay = '' }
$FfVersion = '115.44.0esr'
$FfUrlHttps = 'https://archive.mozilla.org/pub/firefox/releases/115.44.0esr/win64/en-US/Firefox%20Setup%20115.44.0esr.exe'
$FfUrlHttp = 'http://archive.mozilla.org/pub/firefox/releases/115.44.0esr/win64/en-US/Firefox%20Setup%20115.44.0esr.exe'
$FfSha256 = '1561f9eaf625804b13c584022bcceb0baff356173a804b39b9b06cfaef875fc2'
$Desktop = [Environment]::GetFolderPath('Desktop'); if (-not $Desktop) { $Desktop = $env:USERPROFILE }
$Dir = Join-Path $Desktop 'RepairHelper'
if (-not (Test-Path $Dir)) { [void](New-Item -ItemType Directory -Path $Dir) }
$LogFile = Join-Path $Dir 'repair-log.txt'
$FfFile = Join-Path $Dir 'Firefox-ESR-115-Setup.exe'
$StateDir = Join-Path $env:APPDATA 'Win7RepairHelper'
$TokFile = Join-Path $StateDir 'device.txt'
$Findings = New-Object System.Collections.ArrayList
$Errors = New-Object System.Collections.ArrayList
$Results = New-Object System.Collections.ArrayList
$StatusMap = @{}
$Host0 = @{}
$script:IsAdmin = $false

# ---- fixed allowlist: id|needs_admin|restart|live_output|related findings|title|what it changes|commands (;; separated, leading - = ignore failure)
$ActionTable = @'
flush_dns|0|0|0|net.dns|Flush DNS cache|Empties the DNS resolver cache. Nothing is deleted from disk.|ipconfig /flushdns
renew_ip|1|0|0|net.ip,net.gateway|Release and renew IP address|Drops the current IPv4 lease and asks the router for a new one. The connection drops for a few seconds.|ipconfig /release ;; ipconfig /renew
reset_winsock|1|1|0|net.internet,net.dns,net.adapter|Reset Winsock catalog|Resets the Winsock network catalog to defaults (removes broken network filters). Restart required.|netsh winsock reset
reset_tcpip|1|1|0|net.ip,net.gateway,net.internet|Reset TCP/IP stack|Rewrites TCP/IP registry settings to defaults and writes a log. Static IP settings are cleared. Restart required.|netsh int ip reset %TEMP%\ra-ipreset.log
reset_winhttp_proxy|1|0|0|net.proxy_winhttp|Reset WinHTTP proxy|Removes the system-wide WinHTTP proxy setting.|netsh winhttp reset proxy
clear_ie_proxy|0|0|0|net.proxy_wininet|Clear Internet Explorer proxy|Turns off the current user's IE/WinINET proxy and removes the proxy server and auto-config script values.|reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f ;; -reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /f ;; -reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL /f
reset_hosts|1|0|0|net.hosts|Reset hosts file|Saves the hosts file as hosts.bak and replaces it with the default (comment-only) file.|-copy /y %windir%\System32\drivers\etc\hosts %windir%\System32\drivers\etc\hosts.bak ;; echo # Default hosts file restored by Win7 Repair Helper. Backup: hosts.bak>%windir%\System32\drivers\etc\hosts
resync_time|1|0|0|time.skew|Resynchronize clock|Starts the Windows Time service if needed and asks the time server for the correct time.|-net start w32time ;; w32tm /resync /force
sfc_scan|1|0|1|ie.present,browser.exe_assoc,browser.assoc|System File Checker (sfc /scannow)|Scans protected system files and repairs damaged ones from the Windows component store. Can take 15+ minutes.|sfc /scannow
chkdsk_readonly|1|0|1|hw.disk|Disk check (read-only)|Scans the C: drive for errors without fixing anything.|chkdsk %SystemDrive%
enable_tls12_schannel|1|1|0|tls.schannel12,tls.client_probe|Enable TLS 1.2 in Windows (SChannel client)|Adds two registry values so Windows can use TLS 1.2 as a client. Restart required.|reg add "HKLM\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client" /v Enabled /t REG_DWORD /d 1 /f ;; reg add "HKLM\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client" /v DisabledByDefault /t REG_DWORD /d 0 /f
enable_tls12_winhttp|1|1|0|tls.winhttp_default,tls.hotfix,tls.client_probe|Make TLS 1.2 the default in WinHTTP|Adds the WinHTTP DefaultSecureProtocols registry value (only effective after Windows update KB3140245). Restart required.|reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings\WinHttp" /v DefaultSecureProtocols /t REG_DWORD /d 0xA80 /f ;; -reg add "HKLM\SOFTWARE\Wow6432Node\Microsoft\Windows\CurrentVersion\Internet Settings\WinHttp" /v DefaultSecureProtocols /t REG_DWORD /d 0xA80 /f
enable_tls12_dotnet|1|0|0|tls.dotnet,tls.client_probe|Make .NET use system TLS defaults|Adds .NET Framework registry values (SystemDefaultTlsVersions, SchUseStrongCrypto) so .NET programs can use TLS 1.2.|-reg add "HKLM\SOFTWARE\Microsoft\.NETFramework\v2.0.50727" /v SystemDefaultTlsVersions /t REG_DWORD /d 1 /f /reg:64 ;; -reg add "HKLM\SOFTWARE\Microsoft\.NETFramework\v2.0.50727" /v SystemDefaultTlsVersions /t REG_DWORD /d 1 /f /reg:32 ;; -reg add "HKLM\SOFTWARE\Microsoft\.NETFramework\v4.0.30319" /v SystemDefaultTlsVersions /t REG_DWORD /d 1 /f /reg:64 ;; -reg add "HKLM\SOFTWARE\Microsoft\.NETFramework\v4.0.30319" /v SchUseStrongCrypto /t REG_DWORD /d 1 /f /reg:64 ;; -reg add "HKLM\SOFTWARE\Microsoft\.NETFramework\v4.0.30319" /v SystemDefaultTlsVersions /t REG_DWORD /d 1 /f /reg:32 ;; -reg add "HKLM\SOFTWARE\Microsoft\.NETFramework\v4.0.30319" /v SchUseStrongCrypto /t REG_DWORD /d 1 /f /reg:32
enable_ie_tls12|0|0|0|tls.schannel12|Enable TLS 1.2 for Internet Explorer|Sets the current user's Internet Explorer SecureProtocols value to TLS 1.0 + 1.1 + 1.2.|reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v SecureProtocols /t REG_DWORD /d 0xA80 /f
enable_ie_feature|1|1|1|ie.feature,ie.present|Turn on the Internet Explorer Windows feature|Uses DISM to enable the Internet Explorer optional feature if it was turned off. Restart may be required.|dism /online /Enable-Feature /FeatureName:{IEFEATURE} /NoRestart
reset_url_associations|0|0|0|browser.assoc|Reset default-browser links for this user|Removes this user's saved default-program choices for http, https, .htm and .html so Windows asks again.|-reg delete "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice" /f ;; -reg delete "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice" /f ;; -reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.htm\UserChoice" /f ;; -reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.html\UserChoice" /f
fix_exe_association|1|0|0|browser.exe_assoc|Repair the .exe file association|Restores the standard .exe association and open command (assoc/ftype).|assoc .exe=exefile ;; ftype exefile="%1" %*
clear_disallowrun|0|0|0|browser.policy|Remove 'run only allowed programs' policy|Backs up the Explorer policy keys to your Desktop, then removes the DisallowRun block list.|-reg export "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" "%USERPROFILE%\Desktop\ra-backup-hkcu-explorer-policy.reg" /y ;; -reg export "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer" "%USERPROFILE%\Desktop\ra-backup-hklm-explorer-policy.reg" /y ;; -reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun" /f ;; -reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun" /f ;; -reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" /v DisallowRun /t REG_DWORD /d 0 /f ;; -reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer" /v DisallowRun /t REG_DWORD /d 0 /f
clear_ifeo_debugger|1|0|0|browser.policy|Remove program-launch hijacks for browsers|Backs up the Image File Execution Options key to your Desktop, then removes any Debugger value for iexplore, firefox, chrome and msedge.|-reg export "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options" "%USERPROFILE%\Desktop\ra-backup-ifeo.reg" /y ;; -reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\iexplore.exe" /v Debugger /f /reg:64 ;; -reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\iexplore.exe" /v Debugger /f /reg:32 ;; -reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\firefox.exe" /v Debugger /f /reg:64 ;; -reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\firefox.exe" /v Debugger /f /reg:32 ;; -reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\chrome.exe" /v Debugger /f /reg:64 ;; -reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\chrome.exe" /v Debugger /f /reg:32 ;; -reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\msedge.exe" /v Debugger /f /reg:64 ;; -reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\msedge.exe" /v Debugger /f /reg:32
clean_user_temp|0|0|0|hw.disk|Delete temporary files|Deletes files inside your own TEMP folder to free disk space. Files in use are skipped.|-del /q /f /s "%TEMP%\*" ;; -for /d %i in ("%TEMP%\*") do rd /s /q "%i"
download_firefox|0|0|0|ie.present,ie.feature,browser.assoc,browser.policy,browser.exe_assoc,tls.client_probe|Download Firefox ESR 115|Looks for a USB copy first, otherwise downloads the official installer to the RepairHelper folder on your Desktop and checks its SHA-256 against the value built into the script. Does not install it.|@download
install_firefox|0|0|0|ie.present,ie.feature,browser.assoc,browser.policy,browser.exe_assoc,tls.client_probe|Install Firefox ESR 115|Starts the checked Firefox installer (normal windows, you click through it).|@install
'@
#OFFLINE_ORDER os.version,os.sp1,hw.ram,hw.disk,net.adapter,net.ip,net.gateway,net.internet,net.dns,net.proxy_wininet,net.proxy_winhttp,net.hosts,time.skew,tls.schannel12,tls.winhttp_default,tls.dotnet,tls.hotfix,tls.client_probe,tls.root_certs,ie.present,ie.feature,browser.assoc,browser.exe_assoc,browser.policy
$OfflineOrder = 'os.version,os.sp1,hw.ram,hw.disk,net.adapter,net.ip,net.gateway,net.internet,net.dns,net.proxy_wininet,net.proxy_winhttp,net.hosts,time.skew,tls.schannel12,tls.winhttp_default,tls.dotnet,tls.hotfix,tls.client_probe,tls.root_certs,ie.present,ie.feature,browser.assoc,browser.exe_assoc,browser.policy'.Split(',')
$Actions = @{}
foreach ($line in ($ActionTable -split "`n")) {
  $line = $line.Trim(); if ($line.Length -eq 0) { continue }
  $p = $line.Split('|')
  $Actions[$p[0]] = @{ id = $p[0]; admin = ($p[1] -eq '1'); reboot = ($p[2] -eq '1'); live = ($p[3] -eq '1'); related = $p[4].Split(','); title = $p[5]; changes = $p[6]; cmds = ($p[7] -split ' ;; ') }
}
$ActionIds = @($Actions.Keys | Sort-Object)

# ---- helpers
function Log($m) { try { [IO.File]::AppendAllText($LogFile, ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m + "`r`n")) } catch { } }
function Say($m, $c) { if ($c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m }; Log $m }
function Clean($s, $max) { if ($s -eq $null) { return '' }; $t = ([string]$s) -replace '[^\x20-\x7E]', ' '; $t = ($t -replace '\s+', ' ').Trim(); if ($t.Length -gt $max) { $t = $t.Substring(0, $max) }; return $t }
function AddErr($where, $msg) { [void]$Errors.Add(@{ where = (Clean $where 40); message = (Clean $msg 200) }); Log ('ERROR ' + $where + ': ' + $msg) }
function AddF($id, $status, $value) {
  $StatusMap[$id] = $status
  [void]$Findings.Add(@{ id = $id; status = $status; value = (Clean $value 120) })
  $col = 'Gray'; $tag = '  ?   '
  if ($status -eq 'ok') { $col = 'Green'; $tag = '  ok  ' } elseif ($status -eq 'warn') { $col = 'Yellow'; $tag = ' WARN ' } elseif ($status -eq 'fail') { $col = 'Red'; $tag = ' FAIL ' }
  Write-Host ('[' + $tag + '] ' + $id + ' : ' + (Clean $value 100)) -ForegroundColor $col
  Log ('finding ' + $id + ' ' + $status + ' ' + $value)
}
function Ask($q) { $a = Read-Host ($q + ' [Y/N]'); return ($a -eq 'y' -or $a -eq 'Y' -or $a -eq 'yes' -or $a -eq 'YES') }
function RegGet($path, $name) { try { $o = Get-ItemProperty -Path $path -ErrorAction Stop; return $o.$name } catch { return $null } }
function RegDefault($path) { try { return (Get-Item -Path $path -ErrorAction Stop).GetValue('') } catch { return $null } }
function PingHost($h) { try { $r = (New-Object Net.NetworkInformation.Ping).Send($h, 2500); return ($r.Status.ToString() -eq 'Success') } catch { return $false } }
function Sha256File($path) { $sha = New-Object Security.Cryptography.SHA256Managed; $fs = [IO.File]::OpenRead($path); try { $h = $sha.ComputeHash($fs) } finally { $fs.Close() }; return (([BitConverter]::ToString($h)) -replace '-', '').ToLower() }
function JStr($v) { $t = [string]$v; $sb = New-Object System.Text.StringBuilder; foreach ($ch in $t.ToCharArray()) { $c = [int]$ch; if ($ch -eq [char]34) { [void]$sb.Append([char]92); [void]$sb.Append([char]34) } elseif ($ch -eq [char]92) { [void]$sb.Append([char]92); [void]$sb.Append([char]92) } elseif ($c -lt 32 -or $c -gt 126) { [void]$sb.Append(('\u{0:x4}' -f $c)) } else { [void]$sb.Append($ch) } }; return ([string][char]34) + $sb.ToString() + ([string][char]34) }
function Json($o) { if ($o -eq $null) { return 'null' }; $b = $o; if ($b -is [System.Management.Automation.PSObject]) { $b = $b.PSObject.BaseObject }; if ($b -is [bool]) { if ($b) { return 'true' } else { return 'false' } }; if ($b -is [int] -or $b -is [long] -or $b -is [double] -or $b -is [decimal] -or $b -is [single] -or $b -is [uint32] -or $b -is [uint64] -or $b -is [int16] -or $b -is [byte]) { return ([string]$b).Replace(',', '.') }; if ($b -is [string] -or $b -is [char]) { return (JStr $b) }; if ($b -is [System.Collections.IDictionary]) { $parts = @(); foreach ($k in $b.Keys) { $parts += ((JStr $k) + ':' + (Json $b[$k])) }; return '{' + ($parts -join ',') + '}' }; if ($b -is [System.Collections.IEnumerable]) { $parts = @(); foreach ($x in $b) { $parts += (Json $x) }; return '[' + ($parts -join ',') + ']' }; return (JStr $b) }
function UnJson($t) { Add-Type -AssemblyName System.Web.Extensions; $s = New-Object System.Web.Script.Serialization.JavaScriptSerializer; return $s.DeserializeObject($t) }
function HotFixes { try { return @(Get-HotFix -ErrorAction Stop | ForEach-Object { $_.HotFixId }) } catch { return @() } }

function OfflineCode {
  $map = @{ unknown = 0; ok = 1; warn = 2; fail = 3 }
  $hex = ''; $hd = '0123456789ABCDEF'
  for ($j = 0; $j -lt 12; $j++) {
    $a = 0; $b = 0
    $sa = $StatusMap[$OfflineOrder[2 * $j]]; if ($sa) { $a = $map[$sa] }
    $sb = $StatusMap[$OfflineOrder[2 * $j + 1]]; if ($sb) { $b = $map[$sb] }
    $hex += $hd[($a * 4) + $b]
  }
  $sum = 0; for ($i = 0; $i -lt 12; $i++) { $sum += $hd.IndexOf($hex[$i]) * ($i + 1) }
  return ('W7-' + $hex.Substring(0, 4) + '-' + $hex.Substring(4, 8 - 4) + '-' + $hex.Substring(8, 4) + '-' + $hd[$sum % 16])
}

# ---- diagnostics (read-only)
function Diagnose {
  Say 'Running read-only checks (nothing is changed)...' 'Cyan'
  $os = $null; try { $os = Get-WmiObject Win32_OperatingSystem } catch { AddErr 'wmi.os' $_.Exception.Message }
  $arch = 'x86'
  if ($os) {
    $sp = [int]$os.ServicePackMajorVersion; if ($os.OSArchitecture -like '64*') { $arch = 'x64' }
    $Host0.os_caption = (Clean $os.Caption 80); $Host0.os_version = (Clean $os.Version 40); $Host0.sp = $sp; $Host0.arch = $arch
    $st = 'ok'; if (-not ([string]$os.Version).StartsWith('6.1')) { $st = 'warn' }
    AddF 'os.version' $st ($os.Caption + ' ' + $os.Version + ' SP' + $sp + ' ' + $arch)
    if ($sp -ge 1) { AddF 'os.sp1' 'ok' ('Service Pack ' + $sp) } else { AddF 'os.sp1' 'fail' 'Service Pack 1 is not installed' }
    $ramMb = [int]($os.TotalVisibleMemorySize / 1024); $freeMb = [int]($os.FreePhysicalMemory / 1024); $Host0.ram_mb = $ramMb
    $st = 'ok'; if ($ramMb -lt 1024) { $st = 'warn' }
    AddF 'hw.ram' $st ($ramMb.ToString() + ' MB total, ' + $freeMb + ' MB free')
  } else { AddF 'os.version' 'unknown' 'WMI unavailable'; AddF 'os.sp1' 'unknown' ''; AddF 'hw.ram' 'unknown' '' }
  $Host0.arch = $arch
  try {
    $d = Get-WmiObject Win32_LogicalDisk -Filter "DeviceID='C:'"; $fm = [int64]($d.FreeSpace / 1MB); $Host0.disk_free_mb = $fm
    $st = 'ok'; if ($fm -lt 5120) { $st = 'warn' }; if ($fm -lt 1024) { $st = 'fail' }
    AddF 'hw.disk' $st ($fm.ToString() + ' MB free on C:')
  } catch { AddF 'hw.disk' 'unknown' $_.Exception.Message }

  $cfg = @()
  try { $cfg = @(Get-WmiObject Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True') } catch { AddErr 'wmi.net' $_.Exception.Message }
  if ($cfg.Count -gt 0) { AddF 'net.adapter' 'ok' (Clean $cfg[0].Description 60) } else { AddF 'net.adapter' 'fail' 'no enabled network adapter with IP settings' }
  $ip = $null; $gw = $null
  if ($cfg.Count -gt 0) {
    foreach ($c in $cfg) { foreach ($a in @($c.IPAddress)) { if ($a -match '^\d+\.\d+\.\d+\.\d+$' -and -not $ip) { $ip = $a; if ($c.DefaultIPGateway) { $gw = @($c.DefaultIPGateway)[0] } } } }
  }
  if (-not $ip) { AddF 'net.ip' 'fail' 'no IPv4 address' } elseif ($ip.StartsWith('169.254.')) { AddF 'net.ip' 'fail' ('self-assigned address ' + $ip + ' (no DHCP)') } else { AddF 'net.ip' 'ok' $ip }
  if ($gw) { if (PingHost $gw) { AddF 'net.gateway' 'ok' ('gateway ' + $gw + ' answers ping') } else { AddF 'net.gateway' 'fail' ('gateway ' + $gw + ' does not answer') } } else { AddF 'net.gateway' 'fail' 'no default gateway' }
  if ((PingHost '8.8.8.8') -or (PingHost '1.1.1.1')) { AddF 'net.internet' 'ok' 'public IP answers ping' } else { AddF 'net.internet' 'fail' 'no answer from 8.8.8.8 / 1.1.1.1' }
  try { $r = [Net.Dns]::GetHostAddresses('archive.mozilla.org'); if (@($r).Count -gt 0) { AddF 'net.dns' 'ok' 'archive.mozilla.org resolves' } else { AddF 'net.dns' 'fail' 'no result' } } catch { AddF 'net.dns' 'fail' 'name lookup failed' }

  $is = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  $pe = RegGet $is 'ProxyEnable'; $ps = RegGet $is 'ProxyServer'; $ac = RegGet $is 'AutoConfigURL'
  if ($pe -eq 1 -or $ac) { AddF 'net.proxy_wininet' 'warn' ('proxy on: ' + $ps + ' ' + $ac) } else { AddF 'net.proxy_wininet' 'ok' 'no proxy set' }
  try { $w = (& netsh winhttp show proxy 2>&1 | Out-String); if ($w -match 'Direct access') { AddF 'net.proxy_winhttp' 'ok' 'direct access' } else { AddF 'net.proxy_winhttp' 'warn' ($w -replace '\s+', ' ') } } catch { AddF 'net.proxy_winhttp' 'unknown' '' }
  try {
    $hp = Join-Path $env:windir 'System32\drivers\etc\hosts'
    $ent = @(Get-Content $hp -ErrorAction Stop | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim().Length -gt 0 -and $_ -notmatch '^\s*(127\.0\.0\.1|::1)\s+localhost\s*$' })
    $sus = @($ent | Where-Object { $_ -match 'mozilla|microsoft|windowsupdate|google|vercel|firefox|chrome' })
    if ($sus.Count -gt 0) { AddF 'net.hosts' 'fail' ($sus.Count.ToString() + ' entries redirect browser/update sites') } elseif ($ent.Count -gt 0) { AddF 'net.hosts' 'warn' ($ent.Count.ToString() + ' custom entries') } else { AddF 'net.hosts' 'ok' 'default' }
  } catch { AddF 'net.hosts' 'unknown' 'cannot read hosts' }

  # plain HTTP + clock (Microsoft's own connectivity test file)
  $skew = $null
  try {
    $rq = [Net.WebRequest]::Create('http://www.msftncsi.com/ncsi.txt'); $rq.Timeout = 8000; $rq.UserAgent = 'Microsoft NCSI'
    $rs = $rq.GetResponse(); $sr = New-Object IO.StreamReader($rs.GetResponseStream()); $body = $sr.ReadToEnd(); $sr.Close()
    $dh = [DateTime]::Parse($rs.Headers['Date']).ToUniversalTime(); $skew = [int](((Get-Date).ToUniversalTime() - $dh).TotalMinutes); $rs.Close()
    if ($body -like 'Microsoft NCSI*') { AddF 'net.http_plain' 'ok' 'plain HTTP works' } else { AddF 'net.http_plain' 'warn' 'HTTP reply was altered (captive portal or filter?)' }
  } catch { AddF 'net.http_plain' 'fail' (Clean $_.Exception.Message 90) }
  if ($skew -ne $null) { $a = [Math]::Abs($skew); $st = 'ok'; if ($a -gt 5) { $st = 'warn' }; if ($a -gt 1440) { $st = 'fail' }; AddF 'time.skew' $st ('clock off by about ' + $skew + ' min (local minus real)') }
  elseif ((Get-Date).Year -lt 2025) { AddF 'time.skew' 'fail' ('clock says year ' + (Get-Date).Year) } else { AddF 'time.skew' 'unknown' 'could not compare (no HTTP)' }

  # TLS state
  $sch = 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client'
  $en = RegGet $sch 'Enabled'; $dd = RegGet $sch 'DisabledByDefault'
  if ($en -eq 0) { AddF 'tls.schannel12' 'fail' 'TLS 1.2 client is disabled' } elseif ($dd -eq 0) { AddF 'tls.schannel12' 'ok' 'TLS 1.2 client enabled' } else { AddF 'tls.schannel12' 'warn' 'TLS 1.2 client off by default (Windows 7 default)' }
  $wh = RegGet 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings\WinHttp' 'DefaultSecureProtocols'
  if ($wh -ne $null -and (($wh -band 0x800) -ne 0)) { AddF 'tls.winhttp_default' 'ok' ('DefaultSecureProtocols=0x' + $wh.ToString('X')) } else { AddF 'tls.winhttp_default' 'warn' 'TLS 1.2 not default in WinHTTP' }
  $rel = RegGet 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' 'Release'
  $sd = RegGet 'HKLM:\SOFTWARE\Microsoft\.NETFramework\v2.0.50727' 'SystemDefaultTlsVersions'
  if ($sd -eq 1) { AddF 'tls.dotnet' 'ok' '.NET 2.0/3.5 uses system TLS defaults' } elseif ($rel -ge 378389) { AddF 'tls.dotnet' 'warn' ('.NET 4.5+ present (release ' + $rel + ') but PowerShell 2 runs on .NET 2') } else { AddF 'tls.dotnet' 'warn' '.NET 2.0/3.5 only: no TLS 1.2 for PowerShell' }
  $hf = HotFixes
  $has3140245 = ($hf -contains 'KB3140245'); $has3154518 = ($hf -contains 'KB3154518')
  if ($has3140245) { AddF 'tls.hotfix' 'ok' 'KB3140245 installed' } else { AddF 'tls.hotfix' 'warn' ('KB3140245 missing' + $(if ($has3154518) { ', KB3154518 present' } else { ', KB3154518 missing' })) }
  if (($hf -contains 'KB3033929') -or ($hf -contains 'KB4474419') -or ($hf -contains 'KB4490628')) { AddF 'sys.sha2' 'ok' 'SHA-2 update installed' } else { AddF 'sys.sha2' 'warn' 'KB3033929/KB4474419 not found' }
  # can this PowerShell open TLS 1.2 to a Windows 7-compatible site?
  $m = 'default'
  try { [Net.ServicePointManager]::SecurityProtocol = [Enum]::ToObject([Net.SecurityProtocolType], 3072); $m = 'TLS1.2 flag accepted' } catch { $m = '.NET refuses TLS 1.2 flag' }
  try { $rq = [Net.WebRequest]::Create('https://archive.mozilla.org/'); $rq.Method = 'HEAD'; $rq.Timeout = 10000; $rs = $rq.GetResponse(); $rs.Close(); AddF 'tls.client_probe' 'ok' ($m + '; HTTPS to mozilla.org works') }
  catch { $e = $_.Exception; $msg = $e.Message; if ($e.InnerException) { $msg = $msg + ' / ' + $e.InnerException.Message }; AddF 'tls.client_probe' 'fail' ($m + '; ' + (Clean $msg 70)) }
  try {
    $store = New-Object Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine'); $store.Open('ReadOnly'); $subs = @($store.Certificates | ForEach-Object { $_.Subject }); $store.Close()
    $hasIsrg = @($subs | Where-Object { $_ -like '*ISRG Root X1*' }).Count -gt 0
    if ($hasIsrg) { AddF 'tls.root_certs' 'ok' 'ISRG Root X1 present' } else { AddF 'tls.root_certs' 'warn' 'ISRG Root X1 (Lets Encrypt) not installed; Windows may fetch it by itself' }
  } catch { AddF 'tls.root_certs' 'unknown' (Clean $_.Exception.Message 80) }

  # IE / browser launch problems
  $iex = Join-Path $env:ProgramFiles 'Internet Explorer\iexplore.exe'
  if (Test-Path $iex) { AddF 'ie.present' 'ok' ('iexplore.exe ' + (Get-Item $iex).VersionInfo.FileVersion) } else { AddF 'ie.present' 'fail' 'iexplore.exe missing' }
  $Host0.ie_version = ''; try { $Host0.ie_version = (Clean ((Get-Item $iex).VersionInfo.ProductVersion) 20) } catch { }
  if ($script:IsAdmin) {
    $fn = 'Internet-Explorer-Optional-amd64'; if ($arch -eq 'x86') { $fn = 'Internet-Explorer-Optional-x86' }
    try { $o = (& dism /online /Get-FeatureInfo /FeatureName:$fn 2>&1 | Out-String); if ($o -match 'State : Enabled') { AddF 'ie.feature' 'ok' 'enabled' } elseif ($o -match 'State : (\w+)') { AddF 'ie.feature' 'fail' ('state ' + $matches[1]) } else { AddF 'ie.feature' 'unknown' 'could not read' } } catch { AddF 'ie.feature' 'unknown' '' }
  } else { AddF 'ie.feature' 'unknown' 'needs Administrator to read' }
  $bad = New-Object System.Collections.ArrayList
  foreach ($proto in @('http', 'https', '.htm', '.html')) {
    $cmd = $null
    if ($proto.StartsWith('.')) { $pid0 = RegDefault ('Registry::HKEY_CLASSES_ROOT\' + $proto); if ($pid0) { $cmd = RegDefault ('Registry::HKEY_CLASSES_ROOT\' + $pid0 + '\shell\open\command') } } else { $cmd = RegDefault ('Registry::HKEY_CLASSES_ROOT\' + $proto + '\shell\open\command') }
    if (-not $cmd) { [void]$bad.Add($proto + ' has no open command') } elseif ($cmd -match '^"?([^"]+?\.exe)') { $exe1 = [Environment]::ExpandEnvironmentVariables($matches[1]); if ($exe1 -like '*\*' -and -not (Test-Path $exe1)) { [void]$bad.Add($proto + ' opens a missing program') } }
  }
  if ($bad.Count -gt 0) { AddF 'browser.assoc' 'fail' (@($bad.ToArray()) -join '; ') } else { AddF 'browser.assoc' 'ok' 'web links point to an existing program' }
  $ea = RegDefault 'Registry::HKEY_CLASSES_ROOT\.exe'; $ec = RegDefault 'Registry::HKEY_CLASSES_ROOT\exefile\shell\open\command'
  if ($ea -eq 'exefile' -and $ec -eq '"%1" %*') { AddF 'browser.exe_assoc' 'ok' 'standard' } else { AddF 'browser.exe_assoc' 'fail' ('.exe=' + $ea + ' cmd=' + $ec) }
  $pol = New-Object System.Collections.ArrayList
  foreach ($root in @('HKCU:', 'HKLM:')) { $dr = RegGet ($root + '\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer') 'DisallowRun'; if ($dr -eq 1) { [void]$pol.Add($root + ' DisallowRun on') } }
  foreach ($exe in @('iexplore.exe', 'firefox.exe', 'chrome.exe', 'msedge.exe')) {
    foreach ($base in @('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\', 'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\')) {
      $dbg = RegGet ($base + $exe) 'Debugger'; if ($dbg) { [void]$pol.Add($exe + ' hijacked by Debugger ' + (Clean $dbg 40)) }
    }
  }
  if ((RegGet 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Safer\CodeIdentifiers' 'DefaultLevel') -eq 0) { [void]$pol.Add('Software Restriction Policy disallows by default') }
  if ($pol.Count -gt 0) { AddF 'browser.policy' 'fail' (@($pol.ToArray()) -join '; ') } else { AddF 'browser.policy' 'ok' 'no program-blocking policy found' }

  # extras
  try { $sv = Get-WmiObject Win32_Service -Filter "Name='wuauserv'"; if ($sv.StartMode -eq 'Disabled') { AddF 'sys.update_service' 'warn' 'Windows Update service disabled' } else { AddF 'sys.update_service' 'ok' ($sv.StartMode + ', ' + $sv.State) } } catch { AddF 'sys.update_service' 'unknown' '' }
  $clr = 'PS ' + $PSVersionTable.PSVersion.ToString() + ' CLR ' + $PSVersionTable.CLRVersion.ToString(); $Host0.ps = (Clean $PSVersionTable.PSVersion.ToString() 10); $Host0.clr = (Clean $PSVersionTable.CLRVersion.ToString() 40)
  AddF 'sys.clr' 'ok' $clr
  if ($Relay) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Enum]::ToObject([Net.SecurityProtocolType], 3072) } catch { }
    try { $r = Http 'GET' ($Relay + '/api/repair/ping') $null $null; if ($r.code -eq 200) { AddF 'net.server' 'ok' 'report server answers' } else { AddF 'net.server' 'fail' ('HTTP ' + $r.code) } } catch { AddF 'net.server' 'fail' (Clean $_.Exception.Message 90) }
  } else { AddF 'net.server' 'unknown' 'no server address configured (offline mode)' }
}

function Http($method, $url, $body, $token) {
  $r = [Net.WebRequest]::Create($url); $r.Method = $method; $r.Timeout = 20000; $r.UserAgent = 'Win7RepairHelper/' + $Ver
  if ($token) { $r.Headers.Add('Authorization', 'Bearer ' + $token) }
  if ($body -ne $null) { $b = [Text.Encoding]::UTF8.GetBytes($body); $r.ContentType = 'application/json'; $r.ContentLength = $b.Length; $s = $r.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close() }
  $resp = $null
  try { $resp = $r.GetResponse() } catch [Net.WebException] { $resp = $_.Exception.Response; if ($resp -eq $null) { throw } }
  $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $txt = $sr.ReadToEnd(); $sr.Close()
  return @{ code = [int]$resp.StatusCode; text = $txt }
}

# ---- report
function BuildReport($kind) {
  return @{ kind = $kind; agent_version = $Ver; host = $Host0; findings = $Findings; errors = $Errors; action_results = $Results }
}
function WriteReport {
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $txt = New-Object System.Collections.ArrayList
  [void]$txt.Add('Win7 Repair Helper report ' + $stamp + ' (agent ' + $Ver + ')')
  [void]$txt.Add('Host: ' + $Host0.os_caption + ' ' + $Host0.os_version + ' SP' + $Host0.sp + ' ' + $Host0.arch + ', RAM ' + $Host0.ram_mb + ' MB')
  foreach ($f in $Findings) { [void]$txt.Add(('{0,-5} {1,-20} {2}' -f $f.status, $f.id, $f.value)) }
  foreach ($e in $Errors) { [void]$txt.Add('ERROR ' + $e.where + ': ' + $e.message) }
  foreach ($a in $Results) { [void]$txt.Add('ACTION ' + $a.action_id + ' -> ' + $a.outcome + ' exit=' + $a.exit_code) }
  [void]$txt.Add('Offline code: ' + (OfflineCode))
  $f1 = Join-Path $Dir ('report-' + $stamp + '.txt'); $f2 = Join-Path $Dir ('report-' + $stamp + '.json')
  [IO.File]::WriteAllText($f1, (@($txt.ToArray()) -join "`r`n") + "`r`n")
  [IO.File]::WriteAllText($f2, (Json (BuildReport 'diagnostics')))
  $script:LastJson = $f2
  Say ('Report saved: ' + $f1) 'Cyan'
  Say ('Compact copy for the website: ' + $f2) 'Cyan'
}

# ---- actions (allowlist only)
function ShowAction($a) {
  Say '' $null
  Say ('ACTION  ' + $a.id + ' : ' + $a.title) 'Cyan'
  Say ('Changes : ' + $a.changes) $null
  $need = ''; if ($a.admin) { $need = 'needs Administrator. ' }; if ($a.reboot) { $need += 'Restart needed afterwards.' }
  if ($need) { Say ('Note    : ' + $need) 'Yellow' }
  Say 'Exact command(s) that will run (each through cmd.exe):' $null
  foreach ($c in $a.cmds) { if ($c -eq '@download') { Say '    [1] bitsadmin over plain HTTP, [2] bitsadmin over HTTPS, [3] certutil over HTTPS - each checked against the built-in SHA-256' 'White' } elseif ($c -eq '@install') { Say ('    "' + $FfFile + '"   (the checked Firefox installer; you click through it)') 'White' } else { Say ('    ' + $c) 'White' } }
}
function RunCmd($line, $live) {
  $ignore = $false; if ($line.StartsWith('-')) { $ignore = $true; $line = $line.Substring(1) }
  $line = $line.Replace('{IEFEATURE}', $(if ($Host0.arch -eq 'x86') { 'Internet-Explorer-Optional-x86' } else { 'Internet-Explorer-Optional-amd64' }))
  Log ('RUN ' + $line)
  $psi = New-Object Diagnostics.ProcessStartInfo; $psi.FileName = $env:ComSpec; $psi.Arguments = '/s /c "' + $line + '"'; $psi.UseShellExecute = $false
  if (-not $live) { $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true }
  $p = [Diagnostics.Process]::Start($psi)
  if (-not $live) { $o = $p.StandardOutput.ReadToEnd(); $e = $p.StandardError.ReadToEnd(); $t = (($o + ' ' + $e) -replace '\s+', ' ').Trim(); if ($t) { Say ('      ' + (Clean $t 200)) 'Gray' } }
  $p.WaitForExit(); $code = $p.ExitCode
  Log ('exit ' + $code)
  if ($ignore -and $code -ne 0) { Say ('      (exit ' + $code + ', ignored: nothing to change here)') 'Gray'; return 0 }
  return $code
}
function FfOk { if (-not (Test-Path $FfFile)) { return $false }; return ((Sha256File $FfFile) -eq $FfSha256) }
function FindLocalFirefox {
  $roots = @($Dir, (Join-Path $env:USERPROFILE 'Downloads'), $Desktop)
  try { foreach ($d in @(Get-WmiObject Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 -or $_.DriveType -eq 3 })) { $roots += ($d.DeviceID + '\') } } catch { }
  foreach ($r in $roots) { try { foreach ($f in @(Get-ChildItem -Path $r -Filter 'Firefox*Setup*115*.exe' -ErrorAction SilentlyContinue)) { if ($f.Length -gt 40MB -and (Sha256File $f.FullName) -eq $FfSha256) { return $f.FullName } } } catch { } }
  return $null
}
function RunAction($id, $fromServer) {
  if ($id -eq $null -or ([string]$id).Trim().Length -eq 0) { Say 'No action id was given, so nothing was run.' 'Gray'; return 'skipped' }
  $id = ([string]$id).Trim(); $a = $null
  if ($Actions.ContainsKey($id)) { $a = $Actions[$id] }
  if (-not $a) { Say ('Refusing: "' + (Clean $id 30) + '" is not on the fixed list of actions.') 'Red'; return 'skipped' }
  ShowAction $a
  if ($a.admin -and -not $script:IsAdmin) { Say 'This needs Administrator. Close this window, then right-click repair.bat and choose Run as administrator.' 'Yellow'; [void]$Results.Add(@{ action_id = $id; outcome = 'skipped'; exit_code = $null }); return 'skipped' }
  if ($id -eq 'clean_user_temp' -and ($env:TEMP.Length -lt 12 -or $env:TEMP -notmatch '\\Temp$')) { Say 'Refusing: TEMP folder path looks unusual.' 'Red'; return 'skipped' }
  if ($id -eq 'install_firefox' -and -not (FfOk)) { Say 'The Firefox installer is not downloaded/verified yet. Run download_firefox first.' 'Yellow'; return 'skipped' }
  if (-not (Ask 'Run this now?')) { Say 'Skipped. Nothing was changed.' 'Gray'; [void]$Results.Add(@{ action_id = $id; outcome = 'declined'; exit_code = $null }); return 'declined' }
  $worst = 0
  if ($id -eq 'download_firefox') {
    $local = FindLocalFirefox
    if ($local) { Say ('Found a verified copy: ' + $local) 'Green'; if ($local -ne $FfFile) { Copy-Item $local $FfFile -Force } }
    if (-not (FfOk)) {
      if (-not (Test-Path $Dir)) { [void](New-Item -ItemType Directory -Path $Dir) }
      $tries = @(
        ('bitsadmin /transfer RepairFF /download /priority foreground ' + $FfUrlHttp + ' "' + $FfFile + '"'),
        ('bitsadmin /transfer RepairFF /download /priority foreground ' + $FfUrlHttps + ' "' + $FfFile + '"'),
        ('certutil -urlcache -split -f ' + $FfUrlHttps + ' "' + $FfFile + '"'))
      foreach ($t in $tries) {
        Say ('Trying: ' + $t) 'White'
        [void](RunCmd ('-' + $t) $true)
        if (Test-Path $FfFile) { if (FfOk) { break } else { Say 'Downloaded file does NOT match the expected SHA-256 - deleting it.' 'Red'; Remove-Item $FfFile -Force -ErrorAction SilentlyContinue } }
      }
    }
    if (FfOk) { Say ('Verified Firefox ESR ' + $FfVersion + ' installer: ' + $FfFile) 'Green'; Say ('SHA-256 ' + $FfSha256) 'Green'; [void]$Results.Add(@{ action_id = $id; outcome = 'ran_ok'; exit_code = 0 }); return 'ran_ok' }
    Say 'Could not download a verified installer. Options: enable TLS 1.2 (see docs), or copy the official installer to a USB stick from another device. Then run this action again.' 'Red'
    [void]$Results.Add(@{ action_id = $id; outcome = 'ran_failed'; exit_code = 1 }); return 'ran_failed'
  }
  if ($id -eq 'install_firefox') {
    try { Start-Process -FilePath $FfFile; Say 'Installer started. Follow its window. If your antivirus asks, the file already matched the official SHA-256.' 'Green'; [void]$Results.Add(@{ action_id = $id; outcome = 'ran_ok'; exit_code = 0 }); return 'ran_ok' } catch { AddErr 'install_firefox' $_.Exception.Message; [void]$Results.Add(@{ action_id = $id; outcome = 'ran_failed'; exit_code = 1 }); return 'ran_failed' }
  }
  foreach ($c in $a.cmds) { $code = RunCmd $c $a.live; if ($code -ne 0) { $worst = $code; Say ('      command failed with exit code ' + $code) 'Red' } }
  $o = 'ran_ok'; if ($worst -ne 0) { $o = 'ran_failed' }
  [void]$Results.Add(@{ action_id = $id; outcome = $o; exit_code = $worst })
  if ($o -eq 'ran_ok') { Say 'Done.' 'Green' } else { Say 'Finished with errors (see log).' 'Red' }
  if ($a.reboot) { Say 'Please restart Windows when convenient for this to take effect.' 'Yellow' }
  return $o
}

# ---- server (optional): pairing, report, suggestions
function LoadToken {
  if (-not (Test-Path $TokFile)) { return $null }
  try { $p = ([IO.File]::ReadAllText($TokFile)).Trim().Split('|'); $ss = ConvertTo-SecureString $p[1]; $tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)); return $tok } catch { return $null }
}
function SendToServer {
  if (-not $Relay) { $u = Read-Host 'Server address (https://..., or press Enter to skip)'; if ($u -notmatch '^https://[A-Za-z0-9.-]+(:\d+)?(/[A-Za-z0-9._~/-]*)?$') { Say 'No valid server address. Staying offline.' 'Yellow'; return }; $script:Relay = $u.TrimEnd('/') }
  if (-not (Ask ('Send the diagnostic summary (no files, no hostnames) to ' + $Relay + ' ?'))) { Say 'Not sent.' 'Gray'; return }
  try { [Net.ServicePointManager]::SecurityProtocol = [Enum]::ToObject([Net.SecurityProtocolType], 3072) } catch { Say 'Note: this .NET cannot use TLS 1.2; the connection will probably fail.' 'Yellow' }
  try {
    $ping = Http 'GET' ($Relay + '/api/repair/ping') $null $null
    if ($ping.code -ne 200) { throw 'ping failed' }
  } catch {
    AddErr 'server.ping' $_.Exception.Message
    Say 'Cannot reach the server from this PC (expected on Windows 7: Vercel needs TLS ciphers Windows 7 lacks). Use the offline code or the Firefox paste flow instead.' 'Yellow'; return
  }
  $tok = LoadToken
  if (-not $tok) {
    $code = Read-Host 'Pairing code from the admin page (RP-XXXXX-XXXXX)'
    $r = Http 'POST' ($Relay + '/api/repair/pair') (Json @{ code = $code; agent_version = $Ver }) $null
    if ($r.code -ne 201) { Say ('Pairing failed (HTTP ' + $r.code + ').') 'Red'; return }
    $d = UnJson $r.text; $tok = $d['token']
    if (Ask 'Save the device token on this PC, encrypted for your Windows account only?') {
      if (-not (Test-Path $StateDir)) { [void](New-Item -ItemType Directory -Path $StateDir) }
      $enc = ConvertFrom-SecureString (ConvertTo-SecureString $tok -AsPlainText -Force)
      [IO.File]::WriteAllText($TokFile, ($d['device_id'] + '|' + $enc))
      Say ('Saved: ' + $TokFile) 'Gray'
    }
  }
  $r = Http 'POST' ($Relay + '/api/repair/report') (Json (BuildReport 'diagnostics')) $tok
  if ($r.code -ne 201) { Say ('Report rejected (HTTP ' + $r.code + ').') 'Red'; return }
  Say 'Report sent.' 'Green'
  $r = Http 'GET' ($Relay + '/api/repair/suggestions') $null $tok
  if ($r.code -ne 200) { return }
  $list = @((UnJson $r.text)['suggestions'])
  if ($list.Count -eq 0) { Say 'The server has no suggestions for this PC right now.' 'Gray'; return }
  foreach ($s in $list) {
    $aid = [string]$s['action_id']; $sid = [string]$s['id']
    Say ('Server suggests: ' + $aid + ' - "' + (Clean $s['explanation'] 300) + '" (text from the server, not verified)') 'Yellow'
    $o = RunAction $aid $true
    $ack = 'declined'; if ($o -eq 'ran_ok') { $ack = 'succeeded' } elseif ($o -eq 'ran_failed') { $ack = 'failed' }
    $code = $null; foreach ($x in $Results) { if ($x.action_id -eq $aid) { $code = $x.exit_code } }
    try { [void](Http 'POST' ($Relay + '/api/repair/suggestions/' + $sid + '/ack') (Json @{ outcome = $ack; exit_code = $code }) $tok) } catch { }
  }
}

# ---- UI
function Summary {
  Say '' $null
  $bad = @($Findings | Where-Object { $_.status -eq 'warn' -or $_.status -eq 'fail' })
  Say ('Result: ' + $bad.Count + ' item(s) need attention.') 'Cyan'
  Say ('Offline code (type it on the admin page if the PC cannot reach the server): ' + (OfflineCode)) 'Cyan'
}
function LocalSuggestions {
  $sug = New-Object System.Collections.ArrayList
  foreach ($id in $ActionIds) { if ($id -eq $null -or -not $Actions.ContainsKey([string]$id)) { continue }; $a = $Actions[$id]; if ($id -eq 'install_firefox') { continue }; foreach ($r in $a.related) { $s = $StatusMap[$r]; if ($s -eq 'warn' -or $s -eq 'fail') { [void]$sug.Add($id); break } } }
  return @($sug.ToArray() | Where-Object { $_ -ne $null -and ([string]$_).Trim().Length -gt 0 })
}
function Menu {
  while ($true) {
    Say '' $null
    Say '1) Show suggested fixes   2) Install a modern browser (Firefox ESR 115)   3) Run one action by id' 'White'
    Say '4) Send report to server  5) Copy compact report to clipboard (for the website)  6) Re-run checks   0) Exit' 'White'
    $c = Read-Host 'Choose'
    if ($c -eq '0') { return }
    elseif ($c -eq '1') { $s = @(LocalSuggestions | Where-Object { $_ -ne $null -and ([string]$_).Trim().Length -gt 0 }); if ($s.Count -eq 0) { Say 'Nothing to fix based on the checks.' 'Green' } else { foreach ($sid1 in $s) { if ($sid1 -eq $null -or -not $Actions.ContainsKey([string]$sid1)) { continue }; Say ('Suggested: ' + $sid1 + ' - ' + $Actions[[string]$sid1].title) 'Yellow' }; if (Ask 'Go through them one by one (each asks Y/N)?') { foreach ($sid2 in $s) { if ($sid2 -eq $null -or ([string]$sid2).Trim().Length -eq 0) { continue }; [void](RunAction ([string]$sid2) $false) } } } }
    elseif ($c -eq '2') { $o = RunAction 'download_firefox' $false; if ($o -eq 'ran_ok') { [void](RunAction 'install_firefox' $false) } }
    elseif ($c -eq '3') { Say ('Ids: ' + ($ActionIds -join ', ')) 'Gray'; $id = (Read-Host 'Action id').Trim(); [void](RunAction $id $false) }
    elseif ($c -eq '4') { SendToServer }
    elseif ($c -eq '5') { if ($script:LastJson -and (Ask 'Copy the compact report to the clipboard (only changes the clipboard)?')) { Get-Content $script:LastJson | clip; Say 'Copied. Paste it on the /repair page in Firefox.' 'Green' } else { Say 'No report yet.' 'Gray' } }
    elseif ($c -eq '6') { $Findings.Clear(); $Errors.Clear(); Diagnose; WriteReport; Summary }
  }
}

Clear-Host
Say ('Win7 Repair Helper ' + $Ver + '  -  log: ' + $LogFile) 'Cyan'
Say 'This tool: (1) runs READ-ONLY checks after you agree once, (2) shows each fix with the exact command and asks Y/N before changing anything.' $null
Say 'It installs no service, starts nothing at boot, and only runs while this window is open.' $null
$script:IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($script:IsAdmin) { Say 'Running as Administrator.' 'Green' } else { Say 'Not running as Administrator: most fixes need it (right-click repair.bat > Run as administrator). Checks still work.' 'Yellow' }
$argv = ([string]$env:RA_ARGS).Trim()
if ($argv -match '^run\s+([a-z0-9_]+)$') {
  if (Ask 'Run the read-only checks first? (recommended)') { Diagnose }
  [void](RunAction $matches[1] $false); return
}
if (-not (Ask 'Allow the read-only checks now (reads settings, pings, one plain-HTTP test, one TLS test)?')) { Say 'OK. Nothing was run.' 'Gray'; return }
Diagnose
WriteReport
Summary
if ($argv -eq 'diag') { return }
Menu
