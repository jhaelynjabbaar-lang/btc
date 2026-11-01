# Regression check for the repair.bat menu-1 null id bug (run with pwsh by tests/speedup/speedup.test.ts).
$env:USERPROFILE = Join-Path $env:SPEEDUP_TMP 'profile2'; $env:APPDATA = Join-Path $env:SPEEDUP_TMP 'appdata'
$t = [IO.File]::ReadAllText($env:REPAIR_BAT)
$b = $t.Substring($t.IndexOf('#PS' + 'START')); $b = $b.Substring(0, $b.IndexOf("`nClear-Host`n"))
Invoke-Expression $b
function Check($n, $c) { if ($c) { Write-Host "PASS $n" } else { Write-Host "FAIL $n" } }
$ActionIds = @($null, '', 'flush_dns', 'install_firefox', 'bogus')
$StatusMap['net.dns'] = 'fail'
$s = @(LocalSuggestions)
Check 'LocalSuggestions skips null/empty/unknown ids' ($s.Count -eq 1 -and $s[0] -eq 'flush_dns')
$script:IsAdmin = $true
Check 'RunAction(null) is skipped quietly' ((RunAction $null $false) -eq 'skipped')
Check 'RunAction(empty) is skipped quietly' ((RunAction '' $false) -eq 'skipped')
Check 'RunAction(unknown) refuses' ((RunAction 'bogus' $false) -eq 'skipped')
$StatusMap.Clear(); Check 'no findings -> no suggestions' (@(LocalSuggestions).Count -eq 0)
