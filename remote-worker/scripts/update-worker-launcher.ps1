param([string]$ConfigPath = "$env:LOCALAPPDATA\CodexWebWorker\config.json")
$ErrorActionPreference = "Stop"
$state = Split-Path -Parent $ConfigPath
$fallback = Join-Path $state "updater\update-worker.ps1"
$requestPath = Join-Path $state "worker-update-request.json"
$resultPath = Join-Path $state "worker-update-result.json"
$releasePath = Join-Path $state "worker-release.json"
$onlinePath = Join-Path $state "worker-online.json"
$logPath = Join-Path $state "worker-update.log"
$workerTaskName = "Codex Web Remote Worker"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-JsonAtomically([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), $utf8)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Write-UpdateLog([string]$Message) {
  $line = "[$([DateTime]::UtcNow.ToString('o'))] $Message"
  [System.IO.File]::AppendAllText($logPath, "$line`r`n", $utf8)
}

function Restart-PreviousWorker {
  Disable-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue | Out-Null
  Stop-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $task = Get-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue
    if (-not $task -or $task.State -ne "Running") { break }
    Start-Sleep -Milliseconds 250
  }
  Enable-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue | Out-Null
  Start-ScheduledTask -TaskName $workerTaskName -ErrorAction Stop
}

function Publish-LauncherFailure([int]$ExitCode, [string]$FailureMessage) {
  $request = if (Test-Path -LiteralPath $requestPath) { try { Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json } catch { $null } } else { $null }
  if (-not $request -or -not $request.requestId) { return }
  $release = if (Test-Path -LiteralPath $releasePath) { try { Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json } catch { $null } } else { $null }
  $online = if (Test-Path -LiteralPath $onlinePath) { try { Get-Content -LiteralPath $onlinePath -Raw | ConvertFrom-Json } catch { $null } } else { $null }
  $installed = if ($online) { $online } else { $release }
  $message = "$FailureMessage (exit code $ExitCode)"
  Write-JsonAtomically $resultPath ([ordered]@{
    requestId = [string]$request.requestId
    targetVersion = [string]$request.targetVersion
    targetRef = [string]$request.targetRef
    ok = $false
    installedVersion = if ($installed -and $installed.version) { [string]$installed.version } else { "unknown" }
    installedRef = if ($installed) { $installed.ref } else { $null }
    installedCommit = if ($installed) { $installed.commit } else { $null }
    message = $message
  })
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  Write-UpdateLog $message
  Restart-PreviousWorker
}

$exitCode = 1
$failureMessage = "The Worker package updater could not start"
try {
  if (-not (Test-Path -LiteralPath $fallback -PathType Leaf)) { throw "The last-known-good Worker package updater is unavailable" }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $fallback -ConfigPath $ConfigPath
  $exitCode = $LASTEXITCODE
  $failureMessage = "The Worker package updater exited before publishing a result"
} catch {
  $failureMessage = $_.Exception.Message
}
if ($exitCode -ne 0) { Publish-LauncherFailure $exitCode $failureMessage }
exit $exitCode
