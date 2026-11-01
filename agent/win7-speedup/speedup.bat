@echo off
rem ======================================================================================================
rem  Win7 Speed-Up (agent/win7-speedup/speedup.bat)  -  batch launcher + embedded PowerShell 2.0 code.
rem  Works fully OFFLINE: no downloads, no network calls, nothing is sent anywhere.
rem  Visible window, no background service, no scheduled task, no auto-start. The first thing it does is a
rem  READ-ONLY scan. Every change then shows exactly what it will do and waits for a local Y/N.
rem  Log + undo file + moved startup shortcuts go to Desktop\SpeedUp\.
rem  For the optional admin items (services, page file): right-click this file > Run as administrator.
rem ======================================================================================================
setlocal
title Win7 Speed-Up
set "SU_SELF=%~f0"
set "SU_PS=powershell"
if exist "%windir%\sysnative\WindowsPowerShell\v1.0\powershell.exe" set "SU_PS=%windir%\sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%SU_PS%" -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:SU_SELF);iex $t.Substring($t.IndexOf('#PS'+'START'))"
echo.
echo Finished. Press any key to close this window.
pause >nul
exit /b
#PSSTART
$ErrorActionPreference = 'Continue'
$Ver = '1.0'
$Desktop = [Environment]::GetFolderPath('Desktop'); if (-not $Desktop) { $Desktop = $env:USERPROFILE }
$Dir = Join-Path $Desktop 'SpeedUp'
$DisabledDir = Join-Path $Dir 'disabled-startup'
if (-not (Test-Path $Dir)) { [void](New-Item -ItemType Directory -Path $Dir) }
$Stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$LogFile = Join-Path $Dir ('log-' + $Stamp + '.txt')
$UndoFile = Join-Path $Dir 'undo.txt'
$HighGuid = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
$script:IsAdmin = $false
$script:Scanned = $false
$script:Seq = 0
$script:RamBeforeMb = -1
$script:RamTotalMb = 0
$script:Changes = New-Object System.Collections.ArrayList
$script:WCount = 0
$script:WBytes = [int64]0
$script:WSkipped = 0

# ---- fixed lists. Anything not listed here is never touched.
$RunLocations = @('HKCU|Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM|Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM|Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run')
$VfxTable = @'
Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects|VisualFXSetting|DWord|2
Control Panel\Desktop\WindowMetrics|MinAnimate|String|0
Control Panel\Desktop|DragFullWindows|String|0
Control Panel\Desktop|UserPreferencesMask|Binary|MASK
Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced|TaskbarAnimations|DWord|0
Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced|ListviewAlphaSelect|DWord|0
Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced|ListviewShadow|DWord|0
Software\Microsoft\Windows\DWM|EnableAeroPeek|DWord|0
'@
$SecWords = @('mcafee', 'mcshield', 'mcagent', 'mcui', 'mcods', 'mctray', 'mcpltui', 'mfe', 'norton', 'symantec', 'avast', 'avg', 'kaspersky', 'bitdefender', 'eset', 'nod32', 'sophos', 'malwarebytes', 'webroot', 'trend micro', 'avira', 'defender', 'msmpeng', 'msseces', 'security', 'antivirus', 'firewall')
$EssWords = @('ctfmon', 'explorer.exe', 'userinit', 'winlogon', 'synaptics', 'syntp', 'elantech', 'touchpad', 'alps', 'realtek', 'rthdv', 'rtkng', 'ravcpl', 'audio', 'sound', 'bluetooth', 'wlan', 'wifi', 'wireless', 'igfx', 'hkcmd', 'intel', 'nvidia', 'radeon', 'catalyst', 'amd', 'atiptaxx')

# ---- helpers
function Log($m) { try { [IO.File]::AppendAllText($LogFile, ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m + "`r`n")) } catch { } }
function Say($m, $c) { if ($c) { Write-Host $m -ForegroundColor $c } else { Write-Host $m }; Log $m }
function Clean($s, $max) { if ($s -eq $null) { return '' }; $t = ([string]$s) -replace '[^\x20-\x7E]', ' '; $t = ($t -replace '\s+', ' ').Trim(); if ($t.Length -gt $max) { $t = $t.Substring(0, $max) }; return $t }
function Ask($q) { $a = Read-Host ($q + ' [Y/N]'); return ($a -eq 'y' -or $a -eq 'yes') }
function Row($status, $text) {
  $col = 'Gray'; $tag = ' info '
  if ($status -eq 'ok') { $col = 'Green'; $tag = '  ok  ' } elseif ($status -eq 'warn') { $col = 'Yellow'; $tag = ' WARN ' } elseif ($status -eq 'keep') { $col = 'DarkCyan'; $tag = ' kept ' }
  Say ('[' + $tag + '] ' + $text) $col
}
function MbText($b) { if ($b -eq $null) { return '0.0 MB' }; return (([Math]::Round(([double]$b) / 1MB, 1)).ToString() + ' MB') }
function B64($t) { return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t)) }
function UnB64($t) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$t)) }
function NewId($prefix) { $script:Seq = $script:Seq + 1; return ($prefix + '-' + $Stamp + '-' + $script:Seq) }
function StartsWithI($a, $b) { if ($a -eq $null -or $b -eq $null) { return $false }; return ([string]$a).ToLower().StartsWith(([string]$b).ToLower()) }
function RunCmd($line) {
  Log ('RUN ' + $line)
  $psi = New-Object Diagnostics.ProcessStartInfo; $psi.FileName = $env:ComSpec; $psi.Arguments = '/s /c "' + $line + '"'; $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  $proc = [Diagnostics.Process]::Start($psi)
  $so = $proc.StandardOutput.ReadToEnd(); $se = $proc.StandardError.ReadToEnd(); $proc.WaitForExit(); $code = $proc.ExitCode
  $tx = Clean ($so + ' ' + $se) 300; if ($tx) { Say ('      ' + $tx) 'Gray' }
  Log ('exit ' + $code)
  return $code
}
function NoteChange($t) { [void]$script:Changes.Add((Clean $t 200)); Log ('CHANGE ' + $t) }

# ---- registry helpers (.NET registry classes; no PS3 cmdlets)
function RegRoot($h) { if ($h -eq 'HKLM') { return [Microsoft.Win32.Registry]::LocalMachine }; return [Microsoft.Win32.Registry]::CurrentUser }
function RegRead($h, $sub, $name) {
  $r = @{ exists = $false; kind = ''; value = $null }
  try {
    $k = (RegRoot $h).OpenSubKey($sub)
    if ($k -ne $null) {
      try { $v = $k.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if ($v -ne $null) { $r.exists = $true; $r.kind = $k.GetValueKind($name).ToString(); $r.value = $v } } finally { $k.Close() }
    }
  } catch { }
  return $r
}
function RegWriteEnc($h, $sub, $name, $kind, $enc) {
  $val = $null
  if ($kind -eq 'Binary') { $lst = New-Object System.Collections.ArrayList; for ($bi = 0; $bi + 1 -lt $enc.Length; $bi += 2) { [void]$lst.Add([Convert]::ToByte($enc.Substring($bi, 2), 16)) }; $val = [byte[]]($lst.ToArray()) }
  elseif ($kind -eq 'DWord') { $val = [int]$enc }
  else { $val = [string]$enc }
  $k = (RegRoot $h).CreateSubKey($sub)
  try { $k.SetValue($name, $val, [Microsoft.Win32.RegistryValueKind]$kind) } finally { $k.Close() }
}
function RegDeleteValue($h, $sub, $name) {
  $k = (RegRoot $h).OpenSubKey($sub, $true)
  if ($k -ne $null) { try { $k.DeleteValue($name, $false) } finally { $k.Close() } }
}
function EncVal($kind, $val) {
  if ($kind -eq 'Binary') { return (([BitConverter]::ToString([byte[]]$val)) -replace '-', '') }
  if ($kind -eq 'DWord') { return ([string][int]$val) }
  return ([string]$val)
}

# ---- undo journal: one line per change, fields are base64. Lines with the same id are undone together.
function JWrite($jid, $type, $fields) {
  $parts = @($jid, $type)
  foreach ($fv in @($fields)) { $parts += (B64 $fv) }
  [IO.File]::AppendAllText($UndoFile, (($parts -join '|') + "`r`n"))
}
function JDrop($jid) {
  if (-not (Test-Path $UndoFile)) { return }
  $keep = New-Object System.Collections.ArrayList
  foreach ($ln in @([IO.File]::ReadAllLines($UndoFile))) { if ($ln -ne $null -and -not ([string]$ln).StartsWith($jid + '|')) { [void]$keep.Add([string]$ln) } }
  [IO.File]::WriteAllLines($UndoFile, [string[]]@($keep.ToArray()))
}
function JLines {
  $out = New-Object System.Collections.ArrayList
  if (-not (Test-Path $UndoFile)) { return @() }
  foreach ($ln in @([IO.File]::ReadAllLines($UndoFile))) {
    if ($ln -eq $null) { continue }
    $pp = ([string]$ln).Trim().Split('|'); if ($pp.Length -lt 2 -or $pp[0].Length -eq 0) { continue }
    try { $fl = New-Object System.Collections.ArrayList; for ($ji = 2; $ji -lt $pp.Length; $ji++) { [void]$fl.Add((UnB64 $pp[$ji])) }; [void]$out.Add(@{ id = $pp[0]; type = $pp[1]; f = @($fl.ToArray()) }) } catch { }
  }
  return @($out.ToArray())
}

# ---- measurements
function FreeRam {
  try { $o = Get-WmiObject Win32_OperatingSystem; if ($o -ne $null) { return @{ free = [int]($o.FreePhysicalMemory / 1024); total = [int]($o.TotalVisibleMemorySize / 1024) } } } catch { }
  return $null
}
function WalkDir($path, $cutoff, $del) {
  $di = New-Object IO.DirectoryInfo $path
  $entries = @()
  try { $entries = @($di.GetFileSystemInfos()) } catch { return }
  foreach ($en in $entries) {
    if ($en -eq $null) { continue }
    if (([int]$en.Attributes -band 1024) -ne 0) { continue }
    if ($en -is [IO.DirectoryInfo]) {
      $wasOld = ($en.LastWriteTime -lt $cutoff)
      WalkDir $en.FullName $cutoff $del
      if ($del -and $wasOld) { try { $en.Delete() } catch { } }
    } elseif ($en.LastWriteTime -lt $cutoff) {
      if ($del) {
        try { $sz = $en.Length; if (([int]$en.Attributes -band 1) -ne 0) { $en.Attributes = [IO.FileAttributes]::Normal }; $en.Delete(); $script:WCount = $script:WCount + 1; $script:WBytes = $script:WBytes + $sz } catch { $script:WSkipped = $script:WSkipped + 1 }
      } else { $script:WCount = $script:WCount + 1; $script:WBytes = $script:WBytes + $en.Length }
    }
  }
}
function DirSize($path, $cutoff, $del) {
  $script:WCount = 0; $script:WBytes = [int64]0; $script:WSkipped = 0
  WalkDir $path $cutoff $del
  return @{ files = $script:WCount; bytes = $script:WBytes; skipped = $script:WSkipped }
}
function TempPath {
  $t = [string]$env:TEMP; if (-not $t) { return $null }
  try { $t = [IO.Path]::GetFullPath($t).TrimEnd('\') } catch { return $null }
  $up = ([string]$env:USERPROFILE).TrimEnd('\'); $wd = ([string]$env:windir).TrimEnd('\')
  if ($t.Length -lt 12 -or $up.Length -lt 8 -or $t -notmatch '\\Temp$') { return $null }
  if (-not (StartsWithI $t ($up + '\'))) { return $null }
  if ($wd.Length -gt 0 -and (StartsWithI $t ($wd + '\'))) { return $null }
  if (-not (Test-Path $t)) { return $null }
  return $t
}
function FirefoxCaches {
  $found = New-Object System.Collections.ArrayList
  $la = [string]$env:LOCALAPPDATA; if (-not $la) { return @() }
  $baseP = Join-Path $la 'Mozilla\Firefox\Profiles'
  if (-not (Test-Path $baseP)) { return @() }
  foreach ($pd in @(Get-ChildItem -Path $baseP -Force -ErrorAction SilentlyContinue)) {
    if ($pd -eq $null -or -not $pd.PSIsContainer) { continue }
    $cp = Join-Path $pd.FullName 'cache2'
    if ((Test-Path $cp) -and (StartsWithI $cp ($baseP + '\'))) { [void]$found.Add($cp) }
  }
  return @($found.ToArray())
}
function FirefoxRunning { return (@(Get-Process -Name firefox -ErrorAction SilentlyContinue | Where-Object { $_ -ne $null }).Count -gt 0) }
function RecycleInfo {
  $r = @{ files = 0; bytes = [int64]0 }
  try { $sh = New-Object -ComObject Shell.Application; $ns = $sh.NameSpace(10); if ($ns -ne $null) { foreach ($rx in $ns.Items()) { $r.files = $r.files + 1; try { $r.bytes = $r.bytes + [int64]$rx.Size } catch { } } } } catch { }
  return $r
}
function RecycleCmds {
  $cmds = New-Object System.Collections.ArrayList
  $sid = ''; try { $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { }
  if ($sid -notmatch '^S-1-5-[0-9-]+$') { return @() }
  foreach ($dv in @([IO.DriveInfo]::GetDrives())) {
    if ($dv -eq $null) { continue }
    try { if ($dv.DriveType.ToString() -ne 'Fixed' -or -not $dv.IsReady) { continue } } catch { continue }
    $rp = $dv.RootDirectory.FullName + '$Recycle.Bin\' + $sid
    if (Test-Path -LiteralPath $rp) { [void]$cmds.Add('rd /s /q "' + $rp + '"') }
  }
  return @($cmds.ToArray())
}

# ---- startup items
function KeepReason($nm, $cm) {
  $t = (([string]$nm) + ' ' + ([string]$cm)).ToLower()
  foreach ($sw in $SecWords) { if ($t.Contains($sw)) { return 'security software' } }
  foreach ($ew in $EssWords) { if ($t.Contains($ew)) { return 'Windows or hardware driver item' } }
  $wl = ([string]$env:windir).ToLower()
  if ($t.Contains('%windir%') -or $t.Contains('%systemroot%') -or ($wl.Length -gt 3 -and $t.Contains($wl + '\'))) { return 'Windows component' }
  return $null
}
function GetStartupItems {
  $res = New-Object System.Collections.ArrayList
  foreach ($loc in $RunLocations) {
    $lp = $loc.Split('|'); $lh = $lp[0]; $ls = $lp[1]
    $rk = $null; try { $rk = (RegRoot $lh).OpenSubKey($ls) } catch { }
    if ($rk -eq $null) { continue }
    try {
      foreach ($vn in @($rk.GetValueNames())) {
        if ($vn -eq $null -or ([string]$vn).Length -eq 0) { continue }
        $vk = ''; $vr = $null
        try { $vk = $rk.GetValueKind($vn).ToString(); $vr = $rk.GetValue($vn, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } catch { }
        $why = KeepReason $vn ([string]$vr)
        if ($why -eq $null -and $vk -ne 'String' -and $vk -ne 'ExpandString') { $why = 'unusual value type' }
        [void]$res.Add(@{ type = 'REG'; hive = $lh; sub = $ls; name = [string]$vn; cmd = [string]$vr; kind = $vk; keep = $why; admin = ($lh -eq 'HKLM'); where = ($lh + '\' + $ls) })
      }
    } finally { $rk.Close() }
  }
  foreach ($fk in @('Startup', 'CommonStartup')) {
    $fp = $null; try { $fp = [Environment]::GetFolderPath($fk) } catch { }
    if (-not $fp -or -not (Test-Path $fp)) { continue }
    foreach ($ff in @(Get-ChildItem -Path $fp -Force -ErrorAction SilentlyContinue)) {
      if ($ff -eq $null -or $ff.PSIsContainer -or $ff.Name -eq 'desktop.ini') { continue }
      $tg = ''; try { $tg = (New-Object -ComObject WScript.Shell).CreateShortcut($ff.FullName).TargetPath } catch { }
      $why = KeepReason $ff.Name $tg
      [void]$res.Add(@{ type = 'LNK'; hive = ''; sub = ''; name = $ff.Name; cmd = ([string]$tg); kind = ''; keep = $why; admin = ($fk -eq 'CommonStartup'); where = ('Startup folder (' + $fp + ')'); path = $ff.FullName; folder = $fp; fkind = $fk })
    }
  }
  return @($res.ToArray())
}

# ---- services / page file / power
function SvcInfo($sn) {
  $r = @{ exists = $false; mode = ''; state = ''; token = '' }
  try {
    $sv = Get-WmiObject Win32_Service -Filter ("Name='" + $sn + "'")
    if ($sv -ne $null) {
      $r.exists = $true; $r.mode = [string]$sv.StartMode; $r.state = [string]$sv.State
      if ($r.mode -eq 'Auto') { $r.token = 'auto'; $dl = RegRead 'HKLM' ('SYSTEM\CurrentControlSet\services\' + $sn) 'DelayedAutostart'; if ($dl.exists -and [int]$dl.value -eq 1) { $r.token = 'delayed-auto' } }
      elseif ($r.mode -eq 'Manual') { $r.token = 'demand' } elseif ($r.mode -eq 'Disabled') { $r.token = 'disabled' }
    }
  } catch { }
  return $r
}
function PageInfo {
  $r = @{ known = $false; auto = $false; usage = 0; settings = 0; disabled = $false; text = 'unknown' }
  try {
    $cs = Get-WmiObject Win32_ComputerSystem
    if ($cs -ne $null) {
      $r.known = $true; $r.auto = [bool]$cs.AutomaticManagedPagefile
      $r.usage = @(Get-WmiObject Win32_PageFileUsage | Where-Object { $_ -ne $null }).Count
      $r.settings = @(Get-WmiObject Win32_PageFileSetting | Where-Object { $_ -ne $null }).Count
      if ($r.auto) { $r.text = 'system managed' } elseif ($r.usage -eq 0 -and $r.settings -eq 0) { $r.disabled = $true; $r.text = 'DISABLED (no page file)' } else { $r.text = 'custom size' }
    }
  } catch { }
  return $r
}
function PowerInfo {
  $r = @{ guid = ''; name = ''; hasHigh = $false }
  try {
    $o = (& powercfg /getactivescheme 2>&1 | Out-String)
    if ($o -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') { $r.guid = $matches[1].ToLower() }
    if ($o -match '\(([^)]+)\)') { $r.name = Clean $matches[1] 40 }
    $l = (& powercfg /list 2>&1 | Out-String); if ($l.ToLower().Contains($HighGuid)) { $r.hasHigh = $true }
  } catch { }
  return $r
}
function ThemeInfo {
  $r = @{ path = ''; kind = 'unknown'; dwm = $false }
  $t = RegRead 'HKCU' 'Software\Microsoft\Windows\CurrentVersion\Themes' 'CurrentTheme'
  if ($t.exists) { $r.path = [Environment]::ExpandEnvironmentVariables([string]$t.value); $lw = $r.path.ToLower(); if ($lw.EndsWith('aero.theme')) { $r.kind = 'Windows 7 Aero' } elseif ($lw.EndsWith('basic.theme')) { $r.kind = 'Windows 7 Basic' } else { $r.kind = 'other/custom theme' } }
  try { $r.dwm = (@(Get-Process -Name dwm -ErrorAction SilentlyContinue | Where-Object { $_ -ne $null }).Count -gt 0) } catch { }
  return $r
}
function SafeThemePath($p) { return ($p -match '^[A-Za-z]:\\[A-Za-z0-9 ._()\\-]+\.theme$' -and (Test-Path -LiteralPath $p)) }

# ---- SCAN (read-only)
function ShowStartupList($items) {
  $n = 0
  foreach ($si in $items) {
    if ($si -eq $null) { continue }
    $n = $n + 1
    if ($si.keep) { Row 'keep' ($n.ToString() + '. ' + (Clean $si.name 40) + '  [kept: ' + $si.keep + ']  ' + (Clean $si.cmd 70)) }
    else { Row 'info' ($n.ToString() + '. ' + (Clean $si.name 40) + '  (' + (Clean $si.where 38) + ')  ' + (Clean $si.cmd 70)) }
  }
  if ($n -eq 0) { Row 'info' 'No startup items found.' }
}
function Scan {
  Say '' $null
  Say '=== READ-ONLY SCAN (nothing is changed) ===' 'Cyan'
  $os = $null; try { $os = Get-WmiObject Win32_OperatingSystem } catch { }
  if ($os -ne $null) { Row 'info' ('Windows: ' + (Clean $os.Caption 50) + ' SP' + $os.ServicePackMajorVersion + ' ' + $os.OSArchitecture) }
  try { $cpuObj = Get-WmiObject Win32_Processor; if ($cpuObj -ne $null) { Row 'info' ('Processor: ' + (Clean (@($cpuObj)[0].Name) 60)) } } catch { }
  if ($script:IsAdmin) { Row 'info' 'Running as Administrator' } else { Row 'info' 'Not running as Administrator (optional admin items in menu 6 need it)' }
  $ram = FreeRam
  if ($ram -ne $null) {
    if ($script:RamBeforeMb -lt 0) { $script:RamBeforeMb = $ram.free; $script:RamTotalMb = $ram.total }
    $pc = [int](100 * $ram.free / [Math]::Max(1, $ram.total)); $rs = 'ok'; if ($ram.free -lt 400) { $rs = 'warn' }
    Row $rs ('RAM: ' + $ram.free + ' MB free of ' + $ram.total + ' MB (' + $pc + '% free)')
  }
  Say 'Top programs by memory:' 'White'
  foreach ($mp in @(Get-Process -ErrorAction SilentlyContinue | Sort-Object WorkingSet -Descending | Select-Object -First 8)) { if ($mp -eq $null) { continue }; Say ('    ' + (Clean $mp.ProcessName 30).PadRight(32) + (MbText $mp.WorkingSet)) 'Gray' }
  Say 'Sampling CPU use for 3 seconds...' 'White'
  $cpu0 = @{}; $nproc = 1; try { $nproc = [Math]::Max(1, [int]$env:NUMBER_OF_PROCESSORS) } catch { }
  foreach ($cp in @(Get-Process -ErrorAction SilentlyContinue)) { if ($cp -eq $null) { continue }; try { $cpu0[$cp.Id] = $cp.TotalProcessorTime.TotalSeconds } catch { } }
  Start-Sleep -Seconds 3
  $cpuRows = New-Object System.Collections.ArrayList
  foreach ($cq in @(Get-Process -ErrorAction SilentlyContinue)) {
    if ($cq -eq $null) { continue }
    try { if ($cpu0.ContainsKey($cq.Id)) { $dl = $cq.TotalProcessorTime.TotalSeconds - $cpu0[$cq.Id]; [void]$cpuRows.Add(@{ name = $cq.ProcessName; pct = [Math]::Round(100 * $dl / (3 * $nproc), 1) }) } } catch { }
  }
  foreach ($cr in @($cpuRows.ToArray() | Sort-Object { $_.pct } -Descending | Select-Object -First 5)) { if ($cr -eq $null) { continue }; Say ('    ' + (Clean $cr.name 30).PadRight(32) + $cr.pct + ' % CPU') 'Gray' }
  Say 'Startup items (HKCU/HKLM Run, Wow6432Node Run, Startup folders):' 'White'
  ShowStartupList @(GetStartupItems | Where-Object { $_ -ne $null })
  $vfx = RegRead 'HKCU' 'Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects' 'VisualFXSetting'
  $vt = 'not set (Windows default)'; $vs = 'warn'
  if ($vfx.exists) { $vn2 = [int]$vfx.value; if ($vn2 -eq 0) { $vt = 'Let Windows choose' } elseif ($vn2 -eq 1) { $vt = 'Best appearance' } elseif ($vn2 -eq 2) { $vt = 'Best performance'; $vs = 'ok' } else { $vt = 'Custom' } }
  Row $vs ('Visual effects: ' + $vt)
  $th = ThemeInfo; $ts = 'info'; if ($th.kind -eq 'Windows 7 Aero') { $ts = 'warn' }
  $dwmText = 'off'; if ($th.dwm) { $dwmText = 'on (Aero glass running)' }
  Row $ts ('Theme: ' + $th.kind + '; desktop composition ' + $dwmText)
  $pf = PageInfo; $ps2 = 'ok'; if ($pf.disabled) { $ps2 = 'warn' }
  Row $ps2 ('Page file: ' + $pf.text)
  try { foreach ($ld in @(Get-WmiObject Win32_LogicalDisk -Filter 'DriveType=3')) { if ($ld -eq $null) { continue }; $fg = [Math]::Round($ld.FreeSpace / 1GB, 1); $dst = 'ok'; if ($fg -lt 5) { $dst = 'warn' }; Row $dst ('Disk ' + $ld.DeviceID + ' ' + $fg + ' GB free of ' + [Math]::Round($ld.Size / 1GB, 1) + ' GB') } } catch { }
  Say 'Measuring temp/cache folders (read-only)...' 'White'
  $tp = TempPath
  if ($tp) { $tz = DirSize $tp ((Get-Date).AddHours(-1)) $false; Row 'info' ('User temp folder ' + $tp + ': ' + (MbText $tz.bytes) + ' in ' + $tz.files + ' files older than 1 hour') } else { Row 'warn' 'TEMP folder path looks unusual - the cleaner will refuse to touch it.' }
  $ffc = @(FirefoxCaches | Where-Object { $_ -ne $null })
  if ($ffc.Count -eq 0) { Row 'info' 'Firefox cache: none found' } else { foreach ($fc in $ffc) { $fz = DirSize $fc ([DateTime]::MaxValue) $false; Row 'info' ('Firefox cache ' + $fc + ': ' + (MbText $fz.bytes)) } }
  $rb = RecycleInfo; Row 'info' ('Recycle Bin: ' + $rb.files + ' items, ' + (MbText $rb.bytes))
  $pw = PowerInfo; $pws = 'info'; if ($pw.guid -and $pw.guid -ne $HighGuid) { $pws = 'warn' }
  Row $pws ('Power plan: ' + $pw.name + ' ' + $pw.guid)
  foreach ($sn in @('WSearch', 'SysMain')) {
    $svi = SvcInfo $sn; $lbl = 'Windows Search (WSearch)'; if ($sn -eq 'SysMain') { $lbl = 'Superfetch (SysMain)' }
    if ($svi.exists) { $sst = 'info'; if ($svi.token -eq 'auto' -or $svi.token -eq 'delayed-auto') { $sst = 'warn' }; Row $sst ($lbl + ': start type ' + $svi.mode + ', ' + $svi.state) } else { Row 'info' ($lbl + ': service not found') }
  }
  Say 'McAfee (read-only; never changed by this tool):' 'White'
  $mc = New-Object System.Collections.ArrayList
  try { foreach ($ms in @(Get-WmiObject Win32_Service | Where-Object { $_ -ne $null -and ($_.Name -like '*mcafee*' -or $_.Name -like 'mfe*' -or $_.Name -like 'mcshield*' -or $_.DisplayName -like '*mcafee*') })) { [void]$mc.Add('service ' + (Clean $ms.Name 30) + ' ' + $ms.State) } } catch { }
  try { $tk = @(& schtasks /query /fo csv /nh /v 2>$null); foreach ($tl in $tk) { if ($tl -ne $null -and ([string]$tl) -match 'mcafee') { $tf = ([string]$tl).Trim('"') -split '","'; if ($tf.Length -ge 4) { [void]$mc.Add('scheduled task ' + (Clean $tf[1] 50) + ' next run: ' + (Clean $tf[2] 25) + ' status: ' + (Clean $tf[3] 15)) } } } } catch { }
  if ($mc.Count -eq 0) { Row 'info' 'No McAfee services or Windows scheduled tasks detected (its own scan schedule lives inside its console).' } else { foreach ($mi in @($mc.ToArray() | Select-Object -First 12)) { Row 'keep' (Clean $mi 110) } }
  $script:Scanned = $true
  Say 'Scan finished. Nothing was changed.' 'Cyan'
}
function NeedScan {
  if (-not $script:Scanned) {
    Say 'The read-only scan has not been run yet. It runs first, before any change.' 'Yellow'
    if (Ask 'Run the read-only scan now?') { Scan | Out-Null }
  }
  return $script:Scanned
}

# ---- 2) startup items
function MenuStartup {
  if (-not (NeedScan)) { return }
  $items = @(GetStartupItems | Where-Object { $_ -ne $null })
  Say '' $null
  Say '=== Startup programs ===' 'Cyan'
  ShowStartupList $items
  Say 'Kept items are security software, Windows parts and hardware drivers: they are never offered for disabling.' 'Gray'
  Say 'Disabling does NOT uninstall anything; the program just stops starting with Windows. Each change is saved so you can restore it (menu 9).' 'Gray'
  $cand = @($items | Where-Object { $_ -ne $null -and -not $_.keep })
  if ($cand.Count -eq 0) { Say 'Nothing that can be disabled.' 'Green'; return }
  foreach ($ci in $cand) {
    if ($ci -eq $null -or $ci.name -eq $null -or ([string]$ci.name).Length -eq 0) { continue }
    Say '' $null
    Say ('ITEM    : ' + (Clean $ci.name 60)) 'Cyan'
    Say ('Where   : ' + (Clean $ci.where 100)) $null
    Say ('Command : ' + (Clean $ci.cmd 120)) $null
    if ($ci.type -eq 'REG') { Say ('Will do  : save this value to the undo file, then delete the value "' + (Clean $ci.name 60) + '" from ' + $ci.where) 'White' }
    else { Say ('Will do  : move this shortcut to ' + ($DisabledDir + '\user or \common') + ' (it can be moved back with menu 9)') 'White' }
    if ($ci.admin -and -not $script:IsAdmin) { Say 'This item needs Administrator. Close this window, right-click speedup.bat > Run as administrator. Skipped.' 'Yellow'; continue }
    if (-not (Ask 'Disable this startup item? If unsure, answer N')) { Say 'Left as it is.' 'Gray'; continue }
    $jid = NewId 'startup'
    try {
      if ($ci.type -eq 'REG') {
        $cur = RegRead $ci.hive $ci.sub $ci.name
        if (-not $cur.exists) { Say 'Value is already gone.' 'Gray'; continue }
        JWrite $jid 'DESC' @('Startup value ' + (Clean $ci.name 60) + ' in ' + $ci.where)
        JWrite $jid 'REG' @($ci.hive, $ci.sub, $ci.name, '1', $cur.kind, (EncVal $cur.kind $cur.value))
        RegDeleteValue $ci.hive $ci.sub $ci.name
        $chk = RegRead $ci.hive $ci.sub $ci.name
        if ($chk.exists) { Say 'Could not remove the value.' 'Red'; JDrop $jid } else { Say 'Disabled (backed up in undo.txt).' 'Green'; NoteChange ('Disabled startup value ' + $ci.name) }
      } else {
        $sub2 = 'user'; if ($ci.fkind -eq 'CommonStartup') { $sub2 = 'common' }
        $dd = Join-Path $DisabledDir $sub2; if (-not (Test-Path $dd)) { [void](New-Item -ItemType Directory -Path $dd -Force) }
        $dest = Join-Path $dd $ci.name; if (Test-Path $dest) { $dest = Join-Path $dd ((Get-Date).ToString('HHmmss') + '-' + $ci.name) }
        JWrite $jid 'DESC' @('Startup shortcut ' + (Clean $ci.name 60))
        JWrite $jid 'MOVE' @($ci.path, $dest)
        [IO.File]::Move($ci.path, $dest)
        if (Test-Path -LiteralPath $ci.path) { Say 'Could not move the shortcut.' 'Red'; JDrop $jid } else { Say ('Moved to ' + $dest) 'Green'; NoteChange ('Moved startup shortcut ' + $ci.name) }
      }
    } catch { Say ('Failed: ' + (Clean $_.Exception.Message 150)) 'Red'; JDrop $jid }
  }
  Say 'Startup changes take effect after the next restart.' 'Yellow'
}

# ---- 3) visual effects and theme
function MenuVisual {
  if (-not (NeedScan)) { return }
  Say '' $null
  Say '=== Visual effects ===' 'Cyan'
  Say 'Plan: "Adjust for best performance" for THIS user only (these current-user registry values, nothing else):' 'White'
  $plan = New-Object System.Collections.ArrayList
  foreach ($vl in ($VfxTable -split "`n")) {
    $vl = $vl.Trim(); if ($vl.Length -eq 0) { continue }
    $vp = $vl.Split('|'); $vsub = $vp[0]; $vnm = $vp[1]; $vkd = $vp[2]; $vwant = $vp[3]
    $cur = RegRead 'HKCU' $vsub $vnm
    if ($vnm -eq 'UserPreferencesMask') {
      if (-not ($cur.exists -and $cur.kind -eq 'Binary' -and @($cur.value).Length -eq 8)) { Say '    (UserPreferencesMask not in the expected 8-byte form: left alone)' 'Gray'; continue }
      $clr = @(0x0E, 0x2C, 0x04, 0x00, 0x02, 0x00, 0x00, 0x00); $nb = New-Object System.Collections.ArrayList
      for ($mi2 = 0; $mi2 -lt 8; $mi2++) { [void]$nb.Add([byte]([int]$cur.value[$mi2] -band (255 - $clr[$mi2]))) }
      $vwant = (([BitConverter]::ToString([byte[]]($nb.ToArray()))) -replace '-', '')
      if ($vwant -eq (EncVal 'Binary' $cur.value)) { continue }
    } elseif ($cur.exists -and (EncVal $cur.kind $cur.value) -eq $vwant) { continue }
    $was = '(not set)'; if ($cur.exists) { $was = (Clean (EncVal $cur.kind $cur.value) 40) }
    Say ('    HKCU\' + $vsub + '  ' + $vnm + ' = ' + (Clean $vwant 40) + '   (now ' + $was + ')') 'White'
    [void]$plan.Add(@{ sub = $vsub; name = $vnm; kind = $vkd; want = $vwant })
  }
  Say 'Effects: animations, window shadows, translucent selection, fade menus, Aero Peek and similar are turned off. Text smoothing stays on.' 'Gray'
  if ($plan.Count -eq 0) { Say 'Visual effects are already set for best performance.' 'Green' }
  elseif (Ask 'Apply these visual-effects settings now? (undo: menu 9; log off and on again to see all of it)') {
    $jid = NewId 'vfx'
    try {
      JWrite $jid 'DESC' @('Visual effects set to best performance')
      foreach ($pl in $plan) {
        $old = RegRead 'HKCU' $pl.sub $pl.name
        if ($old.exists) { JWrite $jid 'REG' @('HKCU', $pl.sub, $pl.name, '1', $old.kind, (EncVal $old.kind $old.value)) } else { JWrite $jid 'REG' @('HKCU', $pl.sub, $pl.name, '0', $pl.kind, '') }
        RegWriteEnc 'HKCU' $pl.sub $pl.name $pl.kind $pl.want
        Log ('SET HKCU\' + $pl.sub + ' ' + $pl.name + ' = ' + $pl.want)
      }
      Say 'Done. Log off and log on again (or restart) to see all effects. Undo is saved.' 'Green'; NoteChange 'Visual effects set to best performance'
    } catch { Say ('Failed part-way: ' + (Clean $_.Exception.Message 150) + '. Use menu 9 to undo what was saved.') 'Red' }
  } else { Say 'Skipped. Nothing was changed.' 'Gray' }
  Say '' $null
  $th = ThemeInfo; $basic = $env:windir + '\Resources\Ease of Access Themes\basic.theme'
  Say ('Current theme: ' + $th.kind + ' ' + (Clean $th.path 90)) 'White'
  if ($th.kind -eq 'Windows 7 Basic') { Say 'Already using Windows 7 Basic.' 'Green'; return }
  if (-not (SafeThemePath $basic)) { Say 'The Windows 7 Basic theme file was not found on this PC; skipping the theme switch.' 'Yellow'; return }
  if (-not (SafeThemePath $th.path)) { Say 'The current theme file cannot be located, so a switch could not be undone. Skipping the theme switch.' 'Yellow'; return }
  $tcmd = 'rundll32.exe ' + $env:windir + '\system32\themecpl.dll,OpenThemeAction "' + $basic + '"'
  Say 'Optional: switch to the Windows 7 Basic theme (no glass transparency, uses less graphics memory).' 'White'
  Say ('Exact command: ' + $tcmd) 'White'
  Say 'The Personalization window may open; just close it. Undo re-applies your current theme.' 'Gray'
  if (-not (Ask 'Switch to the Windows 7 Basic theme now?')) { Say 'Skipped. Nothing was changed.' 'Gray'; return }
  $jid = NewId 'theme'
  JWrite $jid 'DESC' @('Theme switched to Windows 7 Basic (was ' + (Clean $th.path 80) + ')')
  JWrite $jid 'THEME' @($th.path)
  $code = RunCmd $tcmd
  if ($code -eq 0) { Say 'Theme change requested.' 'Green'; NoteChange 'Theme set to Windows 7 Basic' } else { Say ('Command failed (exit ' + $code + ').') 'Red'; JDrop $jid }
}

# ---- 4) cleaning
function MenuClean {
  if (-not (NeedScan)) { return }
  Say '' $null
  Say '=== Clean temporary files ===' 'Cyan'
  Say 'This DELETES files and cannot be undone (they are temp/cache files that programs recreate). Your documents are never touched.' 'Yellow'
  Say 'Close other programs first. Files in use are skipped.' 'Gray'
  $before = DiskFreeC
  $tp = TempPath
  if (-not $tp) { Say ('Refusing: TEMP folder path looks unusual (' + (Clean $env:TEMP 80) + '). Temp cleanup skipped.') 'Red' }
  else {
    $cut = (Get-Date).AddHours(-1); $tz = DirSize $tp $cut $false
    Say ('Folder   : ' + $tp) 'White'
    Say ('Will do  : delete ' + $tz.files + ' files (' + (MbText $tz.bytes) + ') inside it that are older than 1 hour, then remove emptied sub-folders.') 'White'
    if ($tz.files -eq 0) { Say 'Nothing to delete.' 'Green' }
    elseif (Ask 'Delete these temp files?') { $dz = DirSize $tp $cut $true; Say ('Deleted ' + $dz.files + ' files (' + (MbText $dz.bytes) + '); skipped ' + $dz.skipped + ' in use.') 'Green'; NoteChange ('Cleaned user temp: ' + (MbText $dz.bytes)) }
    else { Say 'Skipped.' 'Gray' }
  }
  $ffc = @(FirefoxCaches | Where-Object { $_ -ne $null })
  if ($ffc.Count -eq 0) { Say 'Firefox cache: none found.' 'Gray' }
  elseif (FirefoxRunning) { Say 'Firefox is running: close it, then run this again to clear its cache.' 'Yellow' }
  else {
    foreach ($fc in $ffc) {
      $fz = DirSize $fc ([DateTime]::MaxValue) $false
      Say ('Firefox cache folder: ' + $fc) 'White'
      Say ('Will do  : delete ' + $fz.files + ' cached files (' + (MbText $fz.bytes) + '). Bookmarks, logins and settings are not touched. The first page loads after this are a bit slower.') 'White'
      if ($fz.files -eq 0) { continue }
      if (Ask 'Delete this Firefox cache?') { $dz = DirSize $fc ([DateTime]::MaxValue) $true; Say ('Deleted ' + $dz.files + ' files (' + (MbText $dz.bytes) + '); skipped ' + $dz.skipped + '.') 'Green'; NoteChange ('Cleared Firefox cache: ' + (MbText $dz.bytes)) } else { Say 'Skipped.' 'Gray' }
    }
  }
  $rb = RecycleInfo; $rcmds = @(RecycleCmds | Where-Object { $_ -ne $null })
  Say ('Recycle Bin: ' + $rb.files + ' items, ' + (MbText $rb.bytes) + '. Emptying is permanent: look inside it first if unsure.') 'White'
  if ($rb.files -gt 0 -and $rcmds.Count -gt 0) {
    Say 'Exact command(s) that would run (your own Recycle Bin folder only):' 'White'
    foreach ($rc in $rcmds) { Say ('    ' + $rc) 'White' }
    if (Ask 'Empty the Recycle Bin?') { foreach ($rc in $rcmds) { $code = RunCmd $rc; if ($code -ne 0) { Say ('      exit ' + $code) 'Yellow' } }; Say 'Recycle Bin emptied.' 'Green'; NoteChange 'Emptied Recycle Bin' } else { Say 'Skipped.' 'Gray' }
  }
  $after = DiskFreeC
  if ($before -ge 0 -and $after -ge 0) { Say ('Disk C: free space went from ' + $before + ' MB to ' + $after + ' MB.') 'Cyan' }
}
function DiskFreeC { try { $d = Get-WmiObject Win32_LogicalDisk -Filter "DeviceID='C:'"; if ($d -ne $null) { return [int64]($d.FreeSpace / 1MB) } } catch { }; return -1 }

# ---- 5) power plan
function MenuPower {
  if (-not (NeedScan)) { return }
  Say '' $null
  Say '=== Power plan ===' 'Cyan'
  $pw = PowerInfo
  Say ('Current plan: ' + $pw.name + ' ' + $pw.guid) 'White'
  if ($pw.guid -notmatch '^[0-9a-f-]{36}$') { Say 'Could not read the current power plan; nothing to do.' 'Yellow'; return }
  if ($pw.guid -eq $HighGuid) { Say 'Already on High performance.' 'Green'; return }
  if (-not $pw.hasHigh) { Say 'This PC does not list a High performance plan; this tool will not create one. Nothing to do.' 'Yellow'; return }
  $cmd = 'powercfg /setactive ' + $HighGuid
  Say 'Will do  : make the High performance plan active (the CPU stops slowing down to save power).' 'White'
  Say ('Exact command: ' + $cmd) 'White'
  $bat = $null; try { $bat = Get-WmiObject Win32_Battery } catch { }
  if ($bat -ne $null) { Say 'Note: this PC has a battery. High performance drains it faster; plugged in it is fine.' 'Yellow' }
  Say ('Undo (menu 9) runs: powercfg /setactive ' + $pw.guid) 'Gray'
  if (-not (Ask 'Switch to High performance now?')) { Say 'Skipped. Nothing was changed.' 'Gray'; return }
  $jid = NewId 'power'
  JWrite $jid 'DESC' @('Power plan changed from ' + $pw.name + ' ' + $pw.guid)
  JWrite $jid 'POWER' @($pw.guid)
  $code = RunCmd $cmd; $now = PowerInfo
  if ($code -eq 0 -and $now.guid -eq $HighGuid) { Say 'Power plan is now High performance.' 'Green'; NoteChange 'Power plan set to High performance' } else { Say ('Did not take effect (exit ' + $code + ').') 'Red'; JDrop $jid }
}

# ---- 6) admin-only items
function SvcOffer($sn) {
  $lbl = 'Windows Search'; $eff = 'Start-menu and file searching can be slower, and indexing stops hogging the disk and CPU.'
  if ($sn -eq 'SysMain') { $lbl = 'Superfetch (SysMain)'; $eff = 'Windows stops pre-loading programs into RAM; on a 2 GB PC with a slow disk this often helps.' }
  $si = SvcInfo $sn
  Say '' $null
  if (-not $si.exists) { Say ($lbl + ': service not found.') 'Gray'; return }
  if ($si.token -ne 'auto' -and $si.token -ne 'delayed-auto') { Say ($lbl + ': start type is already ' + $si.mode + '. Leaving it.') 'Gray'; return }
  Say ($lbl + ' is set to start automatically (' + $si.token + '), now ' + $si.state + '.') 'White'
  Say ('Will do  : set start type to Manual. ' + $eff) 'White'
  Say ('Exact command: sc config ' + $sn + ' start= demand') 'White'
  Say ('Undo (menu 9) runs: sc config ' + $sn + ' start= ' + $si.token) 'Gray'
  if (-not (Ask ('Set ' + $lbl + ' to Manual?'))) { Say 'Skipped.' 'Gray'; return }
  $stop = $false
  if ($si.state -eq 'Running') { Say ('Optional exact command: sc stop ' + $sn) 'White'; $stop = (Ask 'Also stop it right now? (otherwise it stops at next restart)') }
  $stopFlag = '0'; if ($stop) { $stopFlag = '1' }
  $jid = NewId 'svc'
  JWrite $jid 'DESC' @($lbl + ' start type was ' + $si.token)
  JWrite $jid 'SVC' @($sn, $si.token, $stopFlag)
  $code = RunCmd ('sc config ' + $sn + ' start= demand')
  $chk = SvcInfo $sn
  if ($code -eq 0 -and $chk.token -eq 'demand') { Say ($lbl + ' is now Manual.') 'Green'; NoteChange ($lbl + ' set to Manual') } else { Say ('Did not take effect (exit ' + $code + ').') 'Red'; JDrop $jid; return }
  if ($stop) { [void](RunCmd ('sc stop ' + $sn)) }
}
function PageOffer {
  $pf = PageInfo
  Say '' $null
  Say ('Page file: ' + $pf.text) 'White'
  if (-not $pf.known) { Say 'Could not read page file settings.' 'Yellow'; return }
  if (-not $pf.disabled) { Say 'The page file is enabled; nothing to change.' 'Green'; return }
  Say 'With only about 2 GB of RAM, having no page file makes programs crash when memory runs out.' 'Yellow'
  Say 'Will do  : WMI call: Win32_ComputerSystem.AutomaticManagedPagefile = True (Windows manages the page file). A restart is needed.' 'White'
  Say 'Undo (menu 9) sets AutomaticManagedPagefile = False again.' 'Gray'
  if (-not (Ask 'Let Windows manage the page file?')) { Say 'Skipped.' 'Gray'; return }
  $jid = NewId 'page'
  JWrite $jid 'DESC' @('Page file set to system managed (was disabled)')
  JWrite $jid 'PAGE' @('was-disabled')
  try {
    $cs = Get-WmiObject Win32_ComputerSystem -EnableAllPrivileges; $cs.AutomaticManagedPagefile = $true; [void]$cs.Put()
    $chk = PageInfo
    if ($chk.auto) { Say 'Page file is now system managed. Restart Windows for it to take effect.' 'Green'; NoteChange 'Page file set to system managed' } else { Say 'Could not confirm the change.' 'Red'; JDrop $jid }
  } catch { Say ('Failed: ' + (Clean $_.Exception.Message 150)) 'Red'; JDrop $jid }
}
function MenuAdmin {
  if (-not (NeedScan)) { return }
  Say '' $null
  Say '=== Optional administrator-only items ===' 'Cyan'
  if (-not $script:IsAdmin) {
    Say 'This menu changes system settings and needs Administrator rights.' 'Yellow'
    Say 'Close this window, right-click speedup.bat and choose "Run as administrator", then pick 6 again.' 'Yellow'
    return
  }
  SvcOffer 'WSearch'
  SvcOffer 'SysMain'
  PageOffer
}

# ---- 7) Firefox tips (text only)
function MenuTips {
  Say '' $null
  Say '=== Firefox tips (text only; this tool does not change Firefox settings) ===' 'Cyan'
  Say ' - Keep only a few tabs open. Every tab uses roughly 100-300 MB; on 2 GB of RAM more than 4-5 tabs makes everything crawl.' 'White'
  Say ' - Install uBlock Origin from addons.mozilla.org. Blocking ads and trackers saves memory and CPU on most pages.' 'White'
  Say ' - Remove add-ons you do not use (menu > Add-ons and themes). Each one uses memory.' 'White'
  Say ' - Restart Firefox now and then; long sessions grow in memory. Firefox also has about:memory and about:processes.' 'White'
  Say ' - Menu 4 can clear the Firefox cache when Firefox is closed.' 'White'
}

# ---- 8) summary
function MenuSummary {
  Say '' $null
  Say '=== Summary ===' 'Cyan'
  $ram = FreeRam
  if ($script:RamBeforeMb -lt 0 -or $ram -eq $null) { Say 'Run the scan (menu 1) first to record the starting free RAM.' 'Yellow' }
  else {
    $df = $ram.free - $script:RamBeforeMb
    Say ('Free RAM at first scan : ' + $script:RamBeforeMb + ' MB of ' + $script:RamTotalMb + ' MB') 'White'
    Say ('Free RAM now           : ' + $ram.free + ' MB   (change: ' + $df + ' MB)') 'White'
    Say 'Note: most startup, service and effect changes only take effect after a restart. For a fair comparison, restart and run the scan again.' 'Gray'
  }
  if ($script:Changes.Count -eq 0) { Say 'No changes were made in this session.' 'Gray' } else { Say 'Changes made in this session:' 'White'; foreach ($ch in $script:Changes) { Say ('  - ' + $ch) 'White' } }
  Say ('Log file : ' + $LogFile) 'Gray'
  Say ('Undo file: ' + $UndoFile) 'Gray'
}

# ---- 9) undo / restore
function RegAllowed($h, $sub, $name) {
  if ($RunLocations -contains ($h + '|' + $sub)) { return $true }
  if ($h -ne 'HKCU') { return $false }
  foreach ($vl in ($VfxTable -split "`n")) { $vl = $vl.Trim(); if ($vl.Length -eq 0) { continue }; $vp = $vl.Split('|'); if ($vp[0] -eq $sub -and $vp[1] -eq $name) { return $true } }
  return $false
}
function StartupFolders {
  $r = New-Object System.Collections.ArrayList
  foreach ($fk in @('Startup', 'CommonStartup')) { try { $fp = [Environment]::GetFolderPath($fk); if ($fp) { [void]$r.Add($fp.TrimEnd('\').ToLower()) } } catch { } }
  return @($r.ToArray())
}
# describe (do=$false) or perform (do=$true) one journal line; returns text, or 'ok' / 'skip' / 'fail'
function RestoreLine($ln, $do) {
  $f = @($ln.f); $ty = [string]$ln.type
  if ($ty -eq 'DESC') { return 'ok' }
  if ($ty -eq 'REG') {
    if ($f.Length -lt 6) { return 'fail' }
    $h = $f[0]; $sub = $f[1]; $nm = $f[2]; $ex = $f[3]; $kd = $f[4]; $en = $f[5]
    if (($h -ne 'HKCU' -and $h -ne 'HKLM') -or -not (RegAllowed $h $sub $nm) -or @('String', 'ExpandString', 'DWord', 'Binary') -notcontains $kd) { if ($do) { Say '      refused: not on the fixed list of settings' 'Red'; return 'fail' }; return 'refused (not on the fixed list)' }
    $tx = 'put back ' + $h + '\' + $sub + '  ' + $nm; if ($ex -ne '1') { $tx = 'remove ' + $h + '\' + $sub + '  ' + $nm + ' (it did not exist before)' }
    if (-not $do) { return $tx }
    if ($h -eq 'HKLM' -and -not $script:IsAdmin) { Say '      needs Administrator: skipped (stays in the undo file)' 'Yellow'; return 'skip' }
    try { if ($ex -eq '1') { RegWriteEnc $h $sub $nm $kd $en } else { RegDeleteValue $h $sub $nm }; Log ('RESTORE ' + $tx); return 'ok' } catch { Say ('      failed: ' + (Clean $_.Exception.Message 120)) 'Red'; return 'fail' }
  }
  if ($ty -eq 'MOVE') {
    if ($f.Length -lt 2) { return 'fail' }
    $orig = $f[0]; $mv = $f[1]
    $od = ''; try { $od = [IO.Path]::GetDirectoryName($orig).TrimEnd('\').ToLower() } catch { }
    $okp = (StartsWithI $mv ($DisabledDir + '\')) -and ($od.Length -gt 0) -and (@(StartupFolders) -contains $od)
    if (-not $okp) { if ($do) { Say '      refused: path is not in a Startup folder' 'Red'; return 'fail' }; return 'refused (unexpected path)' }
    if (-not (Test-Path -LiteralPath $mv)) { if ($do) { Say '      the moved shortcut is no longer there; dropping this entry' 'Gray'; return 'ok' }; return 'shortcut no longer in disabled-startup' }
    $tx = 'move ' + $mv + ' back to ' + $orig
    if (-not $do) { return $tx }
    if (Test-Path -LiteralPath $orig) { Say '      a file with that name already exists there; dropping this entry' 'Gray'; return 'ok' }
    try { [IO.File]::Move($mv, $orig); Log ('RESTORE ' + $tx); return 'ok' } catch { Say ('      failed (Administrator needed for the all-users folder?): ' + (Clean $_.Exception.Message 100)) 'Yellow'; return 'skip' }
  }
  if ($ty -eq 'THEME') {
    if ($f.Length -lt 1 -or -not (SafeThemePath $f[0])) { if ($do) { Say '      the previous theme file is missing or unsafe' 'Red'; return 'fail' }; return 'previous theme file missing' }
    $cmd = 'rundll32.exe ' + $env:windir + '\system32\themecpl.dll,OpenThemeAction "' + $f[0] + '"'
    if (-not $do) { return $cmd }
    return $(if ((RunCmd $cmd) -eq 0) { 'ok' } else { 'fail' })
  }
  if ($ty -eq 'POWER') {
    if ($f.Length -lt 1 -or $f[0] -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { return 'fail' }
    $cmd = 'powercfg /setactive ' + $f[0]
    if (-not $do) { return $cmd }
    return $(if ((RunCmd $cmd) -eq 0) { 'ok' } else { 'fail' })
  }
  if ($ty -eq 'SVC') {
    if ($f.Length -lt 3 -or @('WSearch', 'SysMain') -notcontains $f[0] -or @('auto', 'delayed-auto', 'demand') -notcontains $f[1]) { return 'fail' }
    $cmd = 'sc config ' + $f[0] + ' start= ' + $f[1]; $cmd2 = $null; if ($f[2] -eq '1') { $cmd2 = 'sc start ' + $f[0] }
    if (-not $do) { $t = $cmd; if ($cmd2) { $t = $t + '  then  ' + $cmd2 }; return $t }
    if (-not $script:IsAdmin) { Say '      needs Administrator: skipped (stays in the undo file)' 'Yellow'; return 'skip' }
    $c1 = RunCmd $cmd; if ($cmd2) { [void](RunCmd $cmd2) }
    return $(if ($c1 -eq 0) { 'ok' } else { 'fail' })
  }
  if ($ty -eq 'PAGE') {
    $tx = 'WMI: Win32_ComputerSystem.AutomaticManagedPagefile = False'
    if (-not $do) { return $tx }
    if (-not $script:IsAdmin) { Say '      needs Administrator: skipped (stays in the undo file)' 'Yellow'; return 'skip' }
    try { $cs = Get-WmiObject Win32_ComputerSystem -EnableAllPrivileges; $cs.AutomaticManagedPagefile = $false; [void]$cs.Put(); Log ('RESTORE ' + $tx); return 'ok' } catch { Say ('      failed: ' + (Clean $_.Exception.Message 120)) 'Red'; return 'fail' }
  }
  return 'fail'
}
function MenuUndo {
  $all = @(JLines | Where-Object { $_ -ne $null })
  Say '' $null
  Say '=== Undo / restore (each saved change, newest first) ===' 'Cyan'
  if ($all.Count -eq 0) { Say 'Nothing saved to undo yet.' 'Gray'; return }
  $ids = New-Object System.Collections.ArrayList
  foreach ($al in $all) { if ($al.id -and -not ($ids -contains $al.id)) { [void]$ids.Add($al.id) } }
  $idList = @($ids.ToArray()); [Array]::Reverse($idList)
  foreach ($gid in $idList) {
    if ($gid -eq $null -or ([string]$gid).Length -eq 0) { continue }
    $grp = @($all | Where-Object { $_.id -eq $gid })
    $desc = $gid; foreach ($gl in $grp) { if ($gl.type -eq 'DESC' -and @($gl.f).Length -gt 0) { $desc = $gl.f[0] } }
    Say '' $null
    Say ('UNDO    : ' + (Clean $desc 100)) 'Cyan'
    foreach ($gl in $grp) { if ($gl.type -ne 'DESC') { Say ('Will do  : ' + (Clean (RestoreLine $gl $false) 160)) 'White' } }
    if (-not (Ask 'Undo this change?')) { Say 'Left as it is.' 'Gray'; continue }
    $allOk = $true
    foreach ($gl in $grp) { if ($gl.type -eq 'DESC') { continue }; $res = RestoreLine $gl $true; if ($res -ne 'ok') { $allOk = $false } }
    if ($allOk) { JDrop $gid; Say 'Restored.' 'Green'; NoteChange ('Undid: ' + $desc) } else { Say 'Some parts could not be restored; the entry stays in the undo file.' 'Yellow' }
  }
}

# ---- main menu
function Menu {
  while ($true) {
    Say '' $null
    Say '1) Scan (read-only)            2) Startup programs: disable chosen ones' 'White'
    Say '3) Visual effects / basic theme 4) Clean temp files, Firefox cache, Recycle Bin' 'White'
    Say '5) Power plan: High performance 6) Admin-only: Search/Superfetch to Manual, page file' 'White'
    Say '7) Firefox tips (text)          8) Summary: free RAM before/after' 'White'
    Say '9) Undo / restore               0) Exit' 'White'
    $pick = Read-Host 'Choose'
    if ($pick -eq $null -or $pick -eq '0') { return }
    try {
      if ($pick -eq '1') { Scan }
      elseif ($pick -eq '2') { MenuStartup }
      elseif ($pick -eq '3') { MenuVisual }
      elseif ($pick -eq '4') { MenuClean }
      elseif ($pick -eq '5') { MenuPower }
      elseif ($pick -eq '6') { MenuAdmin }
      elseif ($pick -eq '7') { MenuTips }
      elseif ($pick -eq '8') { MenuSummary }
      elseif ($pick -eq '9') { MenuUndo }
    } catch { Say ('Something went wrong: ' + (Clean $_.Exception.Message 160) + ' (nothing else was changed; see the log)') 'Red' }
  }
}

Clear-Host
Say ('Win7 Speed-Up ' + $Ver + '  -  log: ' + $LogFile) 'Cyan'
Say 'This tool works OFFLINE: it downloads nothing and sends nothing. It runs a READ-ONLY scan first, then shows each change and asks Y/N.' $null
Say 'It starts nothing at boot, creates no scheduled task and only runs while this window is open. Changes are saved so they can be undone (menu 9).' $null
$script:IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($script:IsAdmin) { Say 'Running as Administrator.' 'Green' } else { Say 'Not running as Administrator: menus 1-5 and 7-9 work; menu 6 needs right-click > Run as administrator.' 'Yellow' }
if (Ask 'Run the read-only scan now?') { Scan } else { Say 'OK. The scan will run before any change is offered.' 'Gray' }
Menu
MenuSummary
