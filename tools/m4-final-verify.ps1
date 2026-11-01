#requires -Version 5.1
<#
M4 from-zero final verification — one script, one run.

Sequence (each segment is appended to .m4/final-verify.out.txt):

  0. seed a clean isolated home with the development junction install
  1. uninstall -> cold start the full Electron shell -> no control (clean boot)
  2. install the packed tarball into the clean profile -> cold start ->
     blank draft has no control; plain draft enhances and reverts exactly;
     reference draft keeps its chip and reverts exactly
  3. referencesMode=disabled -> cold start -> chip draft renders a disabled
     control with its reason and a forced click is a no-op
  4. invalid timeoutMs -> cold start -> no control; a direct Host run of the
     same profile prints the field-level ValidationError
  5. uninstall -> cold start -> no control, clean stderr

Every cold start is the real whole shell: the installed DeepSeek Harness
Electron app with its own --user-data-dir and --remote-debugging-port, so the
user's running app is untouched. The renderer is driven over CDP.

Usage:
  pwsh -File tools\m4-final-verify.ps1 -Tarball D:\path\dsh-enhance-prompt-1.0.0.tgz
#>
param(
  [string]$Tarball = '',
  [string]$Root = '',
  [int]$Port = 9440,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if ($Tarball -eq '') { $Tarball = Join-Path $repo 'dsh-enhance-prompt-1.0.0.tgz' }
if ($Root -eq '') { $Root = Join-Path $repo '.m4\final' }
if ($Out -eq '') { $Out = Join-Path $repo '.m4\final-verify.out.txt' }
$Tarball = (Resolve-Path -LiteralPath $Tarball).Path
$exe = 'D:\Deepseek\DeepSeek Harness.exe'
$bin = 'D:\Deepseek\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
$pnpm = 'D:\Deepseek\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
$driver = Join-Path $repo 'tools\verify-drive.mjs'
$TestHome = Join-Path $Root 'home'
$UserData = Join-Path $Root 'userdata'
$Profile = Join-Path $TestHome 'profiles\desktop'
$Requests = Join-Path $TestHome 'enhance\requests.jsonl'
$Shots = Join-Path $repo '.m4'
$enc = New-Object System.Text.UTF8Encoding($false)
# Native command output (the Node driver, tar) is UTF-8; PowerShell 5.1 decodes
# stdout with the console code page unless this is set.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:results = New-Object System.Collections.ArrayList
$script:shellProcess = $null
$script:LogFile = $Out

function Log([string]$text) {
  [System.IO.File]::AppendAllText($script:LogFile, "$text`r`n", $enc)
  Write-Host $text
}

function Section([string]$title) {
  Log ''
  Log '============================================================'
  Log "== $title"
  Log '============================================================'
}

function WriteText([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

function WriteJson([string]$path, $value) {
  WriteText $path (($value | ConvertTo-Json -Depth 12) + "`n")
}

function Set-Package([switch]$Bundle) {
  $pkg = [ordered]@{
    private = $true
    name = 'dsh-profile-desktop'
    dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
  }
  if ($Bundle) {
    $pkg.dsh.profile.bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-enhance-prompt')
    $pkg.dependencies = [ordered]@{ 'dsh-enhance-prompt' = ('file:' + ($Tarball -replace '\\', '/')) }
  }
  WriteJson (Join-Path $Profile 'package.json') $pkg
}

function Set-Patch([string]$mode) {
  $config = "- id: enhance`n  config:`n    provider: deepseek-account`n    model: deepseek-flash`n    timeoutMs: 20000`n"
  $disabled = "- id: enhance`n  config:`n    provider: deepseek-account`n    model: deepseek-flash`n    timeoutMs: 20000`n    referencesMode: disabled`n"
  $invalid = "- id: enhance`n  config:`n    provider: deepseek-account`n    model: deepseek-flash`n    timeoutMs: abc`n"
  $insert = "- insert:`n    - id: enhance`n      name: `"dsh-enhance-prompt`"`n"
  switch ($mode) {
    'none' { WriteText (Join-Path $Profile 'cordis.patch.yml') "[]`n" }
    'config' { WriteText (Join-Path $Profile 'cordis.patch.yml') $config }
    'disabled' { WriteText (Join-Path $Profile 'cordis.patch.yml') $disabled }
    'invalid' { WriteText (Join-Path $Profile 'cordis.patch.yml') $invalid }
    'dev' { WriteText (Join-Path $Profile 'cordis.patch.yml') ($insert + $config) }
    default { throw "unknown patch mode $mode" }
  }
}

function Reset-Home {
  if (Test-Path -LiteralPath $Root) {
    # Only remove our own directory; the junction inside it is removed first.
    $link = Join-Path $Profile 'node_modules\dsh-enhance-prompt'
    if (Test-Path -LiteralPath $link) { cmd /c rmdir "$link" | Out-Null }
    Remove-Item -LiteralPath $Root -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Profile 'node_modules'), $UserData | Out-Null
  $real = Join-Path $env:USERPROFILE '.dsh'
  Copy-Item -LiteralPath (Join-Path $real '.credentials.yaml') -Destination (Join-Path $TestHome '.credentials.yaml') -Force
  Copy-Item -LiteralPath (Join-Path $real '.anonymous-user-id') -Destination (Join-Path $TestHome '.anonymous-user-id') -Force
}

function Seed-Junction {
  $link = Join-Path $Profile 'node_modules\dsh-enhance-prompt'
  if (Test-Path -LiteralPath $link) { cmd /c rmdir "$link" | Out-Null }
  New-Item -ItemType Junction -Path $link -Target $repo | Out-Null
  $pkg = [ordered]@{
    private = $true
    name = 'dsh-profile-desktop'
    dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
    dependencies = [ordered]@{ 'dsh-enhance-prompt' = ('file:' + ($repo -replace '\\', '/')) }
  }
  WriteJson (Join-Path $Profile 'package.json') $pkg
  Set-Patch 'dev'
}

function Remove-Junction {
  $link = Join-Path $Profile 'node_modules\dsh-enhance-prompt'
  if (Test-Path -LiteralPath $link) { cmd /c rmdir "$link" | Out-Null }
}

function Install-Tarball {
  $errFile = Join-Path $Root 'pnpm-install.err.txt'
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & node $pnpm add --offline $Tarball --dir $Profile 2> $errFile | ForEach-Object { Log "  pnpm: $_" }
  } finally { $ErrorActionPreference = $old }
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm add failed with exit ${LASTEXITCODE}: $(Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue)"
  }
  if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile | ForEach-Object { Log "  pnpm: $_" } }
  Set-Package -Bundle
  Set-Patch 'config'
}

function Uninstall-Tarball {
  $errFile = Join-Path $Root 'pnpm-remove.err.txt'
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & node $pnpm remove dsh-enhance-prompt --dir $Profile 2> $errFile | ForEach-Object { Log "  pnpm: $_" }
  } finally { $ErrorActionPreference = $old }
  if (Test-Path -LiteralPath $errFile) { Get-Content -LiteralPath $errFile | ForEach-Object { Log "  pnpm: $_" } }
  Set-Package
  Set-Patch 'none'
}

function Get-Pids {
  @(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object Id, StartTime |
    Sort-Object Id | ForEach-Object { "$($_.Id)@$($_.StartTime.ToString('HH:mm:ss'))" })
}

function Start-Shell([string]$label) {
  $before = Get-Pids
  $shellOut = Join-Path $Root "shell-$label.out.txt"
  $shellErr = Join-Path $Root "shell-$label.err.txt"
  Remove-Item -LiteralPath $shellOut, $shellErr -ErrorAction SilentlyContinue
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_PROFILE, Env:DSH_PROFILE_DIR, Env:DSH_SESSION_ID, Env:DSH_SHELL, Env:DSH_WEB_URL -ErrorAction SilentlyContinue
  $env:DSH_HOME = $TestHome
  $process = Start-Process -FilePath $exe `
    -ArgumentList @("--user-data-dir=$UserData", "--remote-debugging-port=$Port") `
    -PassThru -RedirectStandardOutput $shellOut -RedirectStandardError $shellErr
  $script:shellProcess = $process
  $script:shellLabel = $label
  $script:shellOut = $shellOut
  $script:shellErr = $shellErr
  $script:shellPidsBefore = $before
  # Wait for the Host URL line (the shell advertises it on stdout) and for CDP.
  $url = $null
  for ($i = 0; $i -lt 120; $i += 1) {
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $shellOut) {
      $line = Select-String -Path $shellOut -Pattern '^dsh web: (\S+)' | Select-Object -First 1
      if ($line -ne $null) { $url = $line.Matches[0].Groups[1].Value; break }
    }
    if ($process.HasExited) { break }
  }
  if ($url -eq $null) {
    $tail = if (Test-Path -LiteralPath $shellErr) { Get-Content -LiteralPath $shellErr -Tail 20 } else { @() }
    throw "shell '$label' did not report a Host URL: $($tail -join ' | ')"
  }
  $cdp = $false
  for ($i = 0; $i -lt 40; $i += 1) {
    try {
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/list" -UseBasicParsing -TimeoutSec 2
      $cdp = $true
      break
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $cdp) { throw "shell '$label' did not open CDP on port $Port" }
  $after = Get-Pids
  $new = @($after | Where-Object { $before -notcontains $_ })
  Log "  cold start '$label': pid=$($process.Id) url=$url"
  Log "  pids before: $($before -join ', ')"
  Log "  pids after : $($after -join ', ')"
  Log "  new pids   : $($new -join ', ')"
  Log "  process count: $($before.Count) -> $($after.Count); pid list changed: $($new.Count -gt 0)"
  return @{ Url = $url; Pid = $process.Id }
}

function Stop-StaleShell {
  $marker = [regex]::Escape($UserData)
  Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | ForEach-Object {
    if ($_.CommandLine -ne $null -and $_.CommandLine -match "--user-data-dir=`"?$marker") {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  for ($i = 0; $i -lt 20; $i += 1) {
    $open = $false
    try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/list" -UseBasicParsing -TimeoutSec 1; $open = $true } catch {}
    if (-not $open) { break }
    Start-Sleep -Milliseconds 300
  }
  Start-Sleep -Milliseconds 500
}

function Stop-Shell {
  if ($script:shellProcess -eq $null) { return }
  $process = $script:shellProcess
  $label = $script:shellLabel
  try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Seconds 2
  # Sweep anything still carrying this run's user-data-dir; never the real app.
  $marker = [regex]::Escape($UserData)
  Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | ForEach-Object {
    if ($_.CommandLine -ne $null -and $_.CommandLine -match "--user-data-dir=`"?$marker") {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  for ($i = 0; $i -lt 20; $i += 1) {
    $open = $false
    try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/list" -UseBasicParsing -TimeoutSec 1; $open = $true } catch {}
    if (-not $open) { break }
    Start-Sleep -Milliseconds 500
  }
  Log "  stopped shell '$label' (pid $($process.Id))"
  $script:shellProcess = $null
  $script:shellLabel = $null
}

function Invoke-Driver([string]$phase) {
  $stdoutFile = Join-Path $Root "driver-$phase.out.txt"
  $errFile = Join-Path $Root "driver-$phase.err.txt"
  Remove-Item -LiteralPath $stdoutFile, $errFile -ErrorAction SilentlyContinue
  $node = (Get-Command node).Source
  # Start-Process hands the child real file handles: the driver's UTF-8 bytes land
  # in the file unchanged, instead of being decoded with the console code page.
  $process = Start-Process -FilePath $node `
    -ArgumentList @($driver, '--port', "$Port", '--phase', $phase, '--requests', $Requests, '--shots', $Shots) `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $stdoutFile -RedirectStandardError $errFile
  $text = if (Test-Path -LiteralPath $stdoutFile) {
    [System.IO.File]::ReadAllText($stdoutFile, [System.Text.Encoding]::UTF8)
  } else { '' }
  Log $text.TrimEnd()
  if (Test-Path -LiteralPath $errFile) {
    $driverErr = [System.IO.File]::ReadAllText($errFile, [System.Text.Encoding]::UTF8)
    if (-not [string]::IsNullOrWhiteSpace($driverErr)) { Log $driverErr.TrimEnd() }
  }
  Log "  driver exit: $($process.ExitCode)"
  $found = [regex]::Matches($text, '"pass":\s*(true|false)')
  $pass = $process.ExitCode -eq 0 -and $found.Count -gt 0 -and ($found | Where-Object { $_.Groups[1].Value -eq 'false' } | Measure-Object).Count -eq 0
  [void]$script:results.Add(@{ Name = $phase; Pass = $pass })
  Log "  >>> $phase : $(if ($pass) { 'PASS' } else { 'FAIL' })"
  return $pass
}

function Get-InvalidStderr {
  $probe = Join-Path $TestHome 'profiles\probe'
  if (Test-Path -LiteralPath $probe) {
    $link = Join-Path $probe 'node_modules'
    if (Test-Path -LiteralPath $link) { cmd /c rmdir "$link" | Out-Null }
    Remove-Item -LiteralPath $probe -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $probe | Out-Null
  Copy-Item -LiteralPath (Join-Path $Profile 'package.json') -Destination (Join-Path $probe 'package.json')
  WriteText (Join-Path $probe 'cordis.patch.yml') "- id: enhance`n  config:`n    provider: deepseek-account`n    model: deepseek-flash`n    timeoutMs: abc`n"
  New-Item -ItemType Junction -Path (Join-Path $probe 'node_modules') -Target (Join-Path $Profile 'node_modules') | Out-Null
  $hostOut = Join-Path $Root 'probe-invalid.out.txt'
  $hostErr = Join-Path $Root 'probe-invalid.err.txt'
  Remove-Item -LiteralPath $hostOut, $hostErr -ErrorAction SilentlyContinue
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:DSH_HOME = $TestHome
  $process = Start-Process -FilePath $exe `
    -ArgumentList @($bin, '--profile', 'probe', '--port', '0', '--no-open') `
    -PassThru -RedirectStandardOutput $hostOut -RedirectStandardError $hostErr -WindowStyle Hidden
  for ($i = 0; $i -lt 40; $i += 1) {
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $hostErr) {
      if ((Get-Content -LiteralPath $hostErr -Raw) -match 'ValidationError') { break }
    }
  }
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  $stderr = if (Test-Path -LiteralPath $hostErr) { Get-Content -LiteralPath $hostErr -Raw } else { '' }
  Log $stderr.TrimEnd()
  $link = Join-Path $probe 'node_modules'
  if (Test-Path -LiteralPath $link) { cmd /c rmdir "$link" | Out-Null }
  Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction SilentlyContinue
  return $stderr
}

# ---------------------------------------------------------------- run --------

if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
WriteText $Out ''
Log "# M4 from-zero final verification"
Log "repo     : $repo"
Log "tarball  : $Tarball"
Log "home     : $TestHome"
Log "userdata : $UserData"
Log "port     : $Port"
Log "started  : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

$sha = (Get-FileHash -LiteralPath $Tarball -Algorithm SHA256).Hash
Log "sha256   : $sha"
Log ''
Log '-- tarball listing --'
& tar -tzf $Tarball | ForEach-Object { Log "  $_" }

try {
  Section '0. clean home + seeded development install (starting state)'
  Stop-StaleShell
  Reset-Home
  Seed-Junction
  Log "  seeded junction -> $repo"
  Log "  profile patch: insert + config (development form)"

  Section '1. uninstall -> cold start -> clean boot'
  Remove-Junction
  Set-Package
  Set-Patch 'none'
  Log '  junction removed; dependency row, bundle row, and patch rows deleted'
  $shell = Start-Shell 'uninstalled'
  [void](Invoke-Driver 'uninstalled')
  $err1 = Get-Content -LiteralPath $script:shellErr -Raw -ErrorAction SilentlyContinue
  Log "  shell stderr: $(if ([string]::IsNullOrWhiteSpace($err1)) { '(empty)' } else { $err1.Trim() })"
  Stop-Shell

  Section '2. install packed tarball -> cold start -> drafts'
  Install-Tarball
  Log '  installed; profile now: bundles = base, web-app, dsh-enhance-prompt; patch = config only'
  $shell = Start-Shell 'tarball'
  [void](Invoke-Driver 'clean')
  [void](Invoke-Driver 'plain')
  [void](Invoke-Driver 'reference')
  Stop-Shell

  Section '3. referencesMode=disabled -> cold start'
  Set-Patch 'disabled'
  $shell = Start-Shell 'disabled'
  [void](Invoke-Driver 'disabled')
  Stop-Shell

  Section '4. invalid config -> cold start -> no control + field-level stderr'
  Set-Patch 'invalid'
  $shell = Start-Shell 'invalid'
  [void](Invoke-Driver 'invalid')
  Stop-Shell
  Log ''
  Log '-- direct Host run of the same invalid profile (field-level ValidationError) --'
  $stderr = Get-InvalidStderr
  $fieldLog = $stderr -match '\$\.timeoutMs expected number but got abc'
  [void]$script:results.Add(@{ Name = 'invalid-config-stderr'; Pass = $fieldLog })
  Log "  >>> invalid-config-stderr : $(if ($fieldLog) { 'PASS' } else { 'FAIL' })"

  Section '5. uninstall -> cold start -> clean boot'
  Uninstall-Tarball
  Log '  package removed; bundle row and patch row removed'
  $shell = Start-Shell 'final'
  [void](Invoke-Driver 'uninstalled')
  $err2 = Get-Content -LiteralPath $script:shellErr -Raw -ErrorAction SilentlyContinue
  Log "  shell stderr: $(if ([string]::IsNullOrWhiteSpace($err2)) { '(empty)' } else { $err2.Trim() })"
  Stop-Shell

  Section 'summary'
  $failed = 0
  foreach ($result in $script:results) {
    if ($result.Pass) {
      Log "  PASS  $($result.Name)"
    } else {
      Log "  FAIL  $($result.Name)"
      $failed += 1
    }
  }
  Log "  completed: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  if ($failed -eq 0) {
    Log '  RESULT: ALL SEGMENTS PASSED'
  } else {
    Log "  RESULT: $failed SEGMENT(S) FAILED"
    exit 1
  }
} finally {
  if ($script:shellProcess -ne $null) { Stop-Shell }
}
