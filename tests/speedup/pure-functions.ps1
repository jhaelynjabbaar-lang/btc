# Run by tests/speedup/speedup.test.ts with pwsh (PowerShell 7) when available. Loads agent/win7-speedup/speedup.bat up to the main
# section and exercises the pure logic (no registry/WMI, which only exist on Windows). Prints PASS/FAIL lines.
$tmp = $env:SPEEDUP_TMP
$env:USERPROFILE = Join-Path $tmp 'profile'; New-Item -ItemType Directory -Force -Path $env:USERPROFILE | Out-Null
$t = [IO.File]::ReadAllText($env:SPEEDUP_BAT)
$b = $t.Substring($t.IndexOf('#PS' + 'START')); $b = $b.Substring(0, $b.IndexOf("`r`nClear-Host`r`n"))
Invoke-Expression $b
function Check($n, $c) { if ($c) { Write-Host "PASS $n" } else { Write-Host "FAIL $n" } }
Check 'output dir created' (Test-Path $Dir)
Check 'keeps McAfee' ((KeepReason 'McAfee Agent' 'C:\x\mcshield.exe') -eq 'security software')
Check 'keeps Windows component' ((KeepReason 'Foo' '%windir%\system32\foo.exe') -eq 'Windows component')
Check 'keeps touchpad driver' ((KeepReason 'SynTPEnh' 'C:\Program Files\Synaptics\SynTP\SynTPEnh.exe') -ne $null)
Check 'offers Spotify' ((KeepReason 'Spotify' 'C:\Users\PC\AppData\Roaming\Spotify\Spotify.exe') -eq $null)
Check 'offers Acer eRecovery' ((KeepReason 'Acer eRecovery' 'C:\Program Files\Acer\eRecovery\x.exe') -eq $null)
Check 'base64 round trip' ((UnB64 (B64 'a|b c')) -eq 'a|b c')
JWrite 'startup-1' 'DESC' @('hello'); JWrite 'startup-1' 'REG' @('HKCU', 'Software\Microsoft\Windows\CurrentVersion\Run', 'Spot', '1', 'String', (EncVal 'String' 'C:\x y\z.exe'))
JWrite 'vfx-2' 'DESC' @('v'); JWrite 'vfx-2' 'REG' @('HKCU', 'Control Panel\Desktop', 'UserPreferencesMask', '1', 'Binary', (EncVal 'Binary' ([byte[]](0x9E, 0x3E, 7, 0x80, 0x12, 0, 0, 0))))
$l = @(JLines); Check 'journal reads 4 lines' ($l.Count -eq 4)
Check 'journal string field' ($l[1].f[5] -eq 'C:\x y\z.exe')
Check 'journal binary field' ($l[3].f[5] -eq '9E3E07801200 0000'.Replace(' ', ''))
Check 'registry allowlist' ((RegAllowed 'HKCU' 'Control Panel\Desktop' 'UserPreferencesMask') -and -not (RegAllowed 'HKCU' 'Software\Evil' 'x') -and -not (RegAllowed 'HKLM' 'Control Panel\Desktop' 'UserPreferencesMask'))
Check 'restore describes' ((RestoreLine $l[1] $false) -like 'put back HKCU*')
Check 'restore refuses unlisted registry' ((RestoreLine @{ id = 'x'; type = 'REG'; f = @('HKLM', 'SYSTEM\CurrentControlSet\Services\Foo', 'Start', '1', 'DWord', '4') } $false) -like 'refused*')
Check 'restore refuses unlisted service' ((RestoreLine @{ id = 'x'; type = 'SVC'; f = @('Spooler', 'auto', '0') } $false) -eq 'fail')
Check 'restore refuses bad guid' ((RestoreLine @{ id = 'x'; type = 'POWER'; f = @('1; calc') } $false) -eq 'fail')
Check 'restore refuses bad theme path' ((RestoreLine @{ id = 'x'; type = 'THEME'; f = @('C:\x" & calc & ".theme') } $false) -like 'previous*')
JDrop 'startup-1'; $l2 = @(JLines); Check 'journal drop keeps others' ($l2.Count -eq 2 -and $l2[0].id -eq 'vfx-2')
JDrop 'vfx-2'; Check 'journal empty after drop' (@(JLines).Count -eq 0)
$w = Join-Path $tmp 'walk'; New-Item -ItemType Directory -Force -Path (Join-Path $w 'a/b') | Out-Null
Set-Content (Join-Path $w 'old.txt') ('x' * 1000); Set-Content (Join-Path $w 'a/b/old2.txt') 'y'; Set-Content (Join-Path $w 'new.txt') 'z'
foreach ($p in @('old.txt', 'a/b/old2.txt', 'a/b', 'a')) { (Get-Item (Join-Path $w $p)).LastWriteTime = (Get-Date).AddDays(-2) }
$r = DirSize $w ((Get-Date).AddHours(-1)) $false; Check 'size scan counts only old files' ($r.files -eq 2)
$r = DirSize $w ((Get-Date).AddHours(-1)) $true
Check 'delete removes old files and emptied folders, keeps new' ($r.files -eq 2 -and (Test-Path (Join-Path $w 'new.txt')) -and -not (Test-Path (Join-Path $w 'old.txt')) -and -not (Test-Path (Join-Path $w 'a')))
$env:windir = 'C:\Windows'
$env:TEMP = 'C:\Windows\Temp'; Check 'temp refuses Windows folder' ((TempPath) -eq $null)
$env:TEMP = ''; Check 'temp refuses empty' ((TempPath) -eq $null)
$env:TEMP = 'C:\Temp'; Check 'temp refuses short path' ((TempPath) -eq $null)
