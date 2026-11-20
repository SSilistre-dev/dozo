# End-to-end test of the server on this computer on Windows (src/stack.rs, src/stack_e2e.rs),
# without a window: what tests/stack_e2e.sh does on Linux. The app's own code installs a real
# server bundle from a local manifest (Node and Postgres fetched first by runtimes.mjs),
# starts it, gets 200 from /health, signs up, pairs this computer and connects the device socket,
# and stops it; then starts it again from what is installed and the app is ended at once (as Task
# Manager ends it); then a phone pairs through the bundled relay agent (run, pair, approve, list,
# revoke) against a dev relay; last, a second install in a folder of its own signs in with the
# hosted account against a stand-in. After each, no process of the server may be left. Paths longer than 260 characters
# are turned off first, as Windows ships, and the folder is the app's own under LOCALAPPDATA.
# Usage: pwsh stack_e2e_windows.ps1 -Dist <dir> -Workspace <dir>
#   <Dist> holds dozo-server-win-x64.tar.xz and its .json (dozo/server-bundle/build.mjs).
#   <Workspace> is a branded tree with its packages installed: the relay, the phone and the
#   stand-in issuer run from it (tests/relay_phone.mts, tests/fake_issuer.mjs).
# Needs Rust (rust-toolchain.toml) and Node on PATH. Runs as the CI job dozo-server-bundle
# "Desktop stack e2e windows". Last line: DESKTOP STACK E2E (windows): PASS|FAIL. Exit 0 pass,
# 2 fail, 64 usage.
param(
  [string]$Dist,
  [string]$Workspace
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say([string]$line) { Write-Output "[e2e] $line" }
function Verdict([string]$result) {
  Write-Output "DESKTOP STACK E2E (windows): $result"
  if ($result -eq 'PASS') { exit 0 } else { exit 2 }
}
if (-not $Dist -or -not $Workspace) {
  Write-Error 'usage: stack_e2e_windows.ps1 -Dist <dir> -Workspace <dir>' -ErrorAction Continue
  exit 64
}

$Here = Split-Path -Parent $PSScriptRoot
$Dist = (Resolve-Path $Dist).Path
$Workspace = (Resolve-Path $Workspace).Path
$Root = Join-Path $env:LOCALAPPDATA 'dev.ssilistre.dozo\server'
$Hosted = Join-Path $env:LOCALAPPDATA 'dev.ssilistre.dozo-hosted\server'
$Shared = Join-Path $env:RUNNER_TEMP 'e2e-shared'
$started = @()
$failed = $false

# Processes whose program or command line is in a folder (as processes_under in stack_e2e.rs).
function Left([string]$folder) {
  $me = $PID
  Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $me -and (
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($folder, 'OrdinalIgnoreCase')) -or
      ($_.CommandLine -and $_.CommandLine.IndexOf($folder, [StringComparison]::OrdinalIgnoreCase) -ge 0))
  } | ForEach-Object { "$($_.ProcessId): $($_.CommandLine)" }
}

function Show-Logs([string]$folder) {
  Get-ChildItem (Join-Path $folder 'logs') -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Output "----- $($_.Name)"
    Get-Content $_.FullName -Tail 25
  }
}

# Runs one ignored test of src/stack_e2e.rs, at most $minutes; its E2E lines are shown as they
# come. One that takes longer is ended, with what is running and the logs shown.
function Run-Test([string]$name, [string]$folder, [int]$minutes = 12) {
  $env:DOZO_STACK_E2E_ROOT = $folder
  $log = Join-Path $env:RUNNER_TEMP "e2e-$name.log"
  $test = Start-Process -FilePath $script:Bin -PassThru -NoNewWindow `
    -ArgumentList '--ignored', '--exact', "stack::e2e::$name", '--nocapture' `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $null = $test.Handle # keeps the exit code readable after it ends
  $deadline = (Get-Date).AddMinutes($minutes)
  $shown = 0
  $show = {
    $lines = @(Get-Content $log, "$log.err" -ErrorAction SilentlyContinue)
    $lines[$shown..($lines.Count)] | Where-Object { "$_" -match 'E2E|panicked|test result|assert|still running' } | ForEach-Object { "$_" }
    $shown = $lines.Count
  }
  while (-not $test.WaitForExit(5000)) {
    . $show
    if ((Get-Date) -gt $deadline) {
      Stop-Process -Id $test.Id -Force -ErrorAction SilentlyContinue
      Say "$name took longer than $minutes minutes; running from the folder:"
      Left $folder
      Show-Logs $folder
      throw "$name took longer than $minutes minutes"
    }
  }
  . $show
  if ($test.ExitCode -ne 0) {
    Get-Content "$log.err" -Tail 20 -ErrorAction SilentlyContinue
    Show-Logs $folder
    throw "$name failed (exit $($test.ExitCode))"
  }
}

function Assert-None-Left([string]$folder, [string]$when) {
  $left = $null
  for ($i = 0; $i -lt 60; $i++) {
    $left = Left $folder
    if (-not $left) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($left) { throw "left $when`: $($left -join '; ')" }
  Say "no process left $when"
}

try {
  # As Windows ships: no paths past 260 characters for programs that do not ask for them.
  Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' LongPathsEnabled 0 -Type DWord
  Say "long paths: $((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem').LongPathsEnabled)"

  # Node and Postgres from where they are published, and the manifest, by the scripts a release
  # uses; all three parts are then served from this folder, as a release serves them.
  $base = 'file:///' + ($Dist -replace '\\', '/')
  & { $ErrorActionPreference = 'Continue'; node (Join-Path $Here '..\server-bundle\runtimes.mjs') $Dist win-x64 2>&1 }
  if ($LASTEXITCODE -ne 0) { throw 'runtimes.mjs failed' }
  & { $ErrorActionPreference = 'Continue'; node (Join-Path $Here '..\server-bundle\manifest.mjs') $Dist $base 2>&1 }
  if ($LASTEXITCODE -ne 0) { throw 'manifest.mjs failed' }
  $env:DOZO_STACK_E2E_MANIFEST = Join-Path $Dist 'manifest.json'
  Remove-Item -Recurse -Force (Split-Path $Root), (Split-Path $Hosted), $Shared -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $Shared | Out-Null
  $env:DOZO_STACK_E2E_SHARED = $Shared
  $env:DOZO_STACK_E2E_RELAY = 'http://127.0.0.1:8787'

  Push-Location $Here
  $build = & { $ErrorActionPreference = 'Continue'; cargo test --locked --no-run 2>&1 }
  Pop-Location
  if ($LASTEXITCODE -ne 0) { $build | Select-Object -Last 30; throw 'the test build failed' }
  $line = $build | ForEach-Object { "$_" } | Where-Object { $_ -match 'Executable unittests src[\\/]main\.rs \((.*)\)' } | Select-Object -First 1
  if (-not ($line -match 'Executable unittests src[\\/]main\.rs \((.*)\)')) { throw 'no test binary' }
  $script:Bin = Join-Path $Here $Matches[1]

  Say '1. install, start, /health, sign up, this computer connects, stop'
  Run-Test 'e2e_installs_starts_and_stops_the_real_server' $Root
  Assert-None-Left $Root 'after stop'
  $longest = (Get-ChildItem -Recurse -Force (Join-Path $Root 'versions') | ForEach-Object { $_.FullName.Length } | Measure-Object -Maximum).Maximum
  Say "installed; longest path $longest characters; junctions: $((Get-ChildItem -Recurse -Force -Attributes ReparsePoint (Join-Path $Root 'versions') -ErrorAction SilentlyContinue | Measure-Object).Count)"

  Say '2. start again from what is installed, then end the app at once'
  $env:DOZO_STACK_E2E_ROOT = $Root
  $hold = Join-Path $env:RUNNER_TEMP 'e2e-hold.log'
  $app = Start-Process -FilePath $Bin -ArgumentList '--ignored', '--exact', 'stack::e2e::e2e_hold_until_killed', '--nocapture' `
    -RedirectStandardOutput $hold -RedirectStandardError "$hold.err" -PassThru -NoNewWindow
  for ($i = 0; $i -lt 240; $i++) {
    if ((Get-Content $hold -ErrorAction SilentlyContinue) -match 'E2E: holding') { break }
    if ($app.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  Get-Content $hold | Where-Object { $_ -match 'E2E' }
  if (-not ((Get-Content $hold) -match 'E2E: holding')) { Get-Content "$hold.err" -Tail 20; Show-Logs $Root; throw 'the second start did not get ready' }
  if ((Get-Content $hold) -match 'Downloading') { throw 'the second start downloaded again' }
  $before = @(Left $Root)
  if ($before.Count -eq 0) { throw 'nothing running before the app ended' }
  Say "$($before.Count) processes of the server running; ending the app"
  Stop-Process -Id $app.Id -Force
  Assert-None-Left $Root 'after the app was ended at once (job objects)'

  Say '3. start again and pair a phone through the relay agent'
  $tsx = Join-Path $Workspace 'node_modules\tsx\dist\cli.mjs'
  $env:DOZO_WORKSPACE = $Workspace
  $phoneLog = Join-Path $env:RUNNER_TEMP 'e2e-phone.log'
  $started += Start-Process -FilePath node -ArgumentList "`"$tsx`"", "`"$(Join-Path $PSScriptRoot 'relay_phone.mts')`"", "`"$Shared`"" `
    -RedirectStandardOutput $phoneLog -RedirectStandardError "$phoneLog.err" -PassThru -NoNewWindow
  $started += Start-Process -FilePath node -ArgumentList "`"$(Join-Path $PSScriptRoot 'fake_issuer.mjs')`"", '8788' `
    -RedirectStandardOutput "$phoneLog.issuer" -RedirectStandardError "$phoneLog.issuer.err" -PassThru -NoNewWindow
  try {
    Run-Test 'e2e_pairs_a_phone' $Root
  } finally {
    Get-Content $phoneLog, "$phoneLog.err" -Tail 10 -ErrorAction SilentlyContinue
  }
  Assert-None-Left $Root 'after stop, relay agent included'

  Say '4. a server of its own signs in with the hosted account (stand-in issuer)'
  # A server with accounts of its own refuses that mode: a new folder, installed again (an
  # install's junctions hold its own folder, so it is not copied).
  $env:DOZO_STACK_E2E_ISSUER = 'http://127.0.0.1:8788'
  Run-Test 'e2e_signs_in_with_the_hosted_account' $Hosted
  Assert-None-Left $Hosted 'after stop'
} catch {
  Say "FAILED: $_"
  $failed = $true
}
$started | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
# The servers' logs beside the others in RUNNER_TEMP, for the workflow to keep (one drive).
foreach ($folder in @($Root, $Hosted)) {
  $logs = Join-Path $folder 'logs'
  if (Test-Path $logs) {
    Copy-Item -Recurse $logs (Join-Path $env:RUNNER_TEMP "e2e-logs-$(Split-Path -Leaf (Split-Path $folder))") -ErrorAction SilentlyContinue
  }
}
if ($failed) { Verdict FAIL }
Verdict PASS
