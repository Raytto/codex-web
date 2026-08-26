param(
  [Parameter(Mandatory=$true)][string]$EnrollmentToken,
  [string]$MachineName = "worker-host",
  [string]$ServerHttpUrl = "",
  [int]$Capacity = 2,
  [switch]$RenameMachine
)
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ServerHttpUrl)) { throw "ServerHttpUrl is required; pass the URL of your Codex Web instance" }
$root = Split-Path -Parent $PSScriptRoot
$state = Join-Path $env:LOCALAPPDATA "CodexWebWorker"
$configPath = Join-Path $state "config.json"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$codexCommand = Get-Command codex.cmd -ErrorAction SilentlyContinue
if (-not $codexCommand) { $codexCommand = Get-Command codex -ErrorAction Stop }
$codexPath = $codexCommand.Source
if ($codexPath.EndsWith(".cmd", [System.StringComparison]::OrdinalIgnoreCase)) {
  $npmCodexJs = Join-Path (Split-Path -Parent $codexPath) "node_modules\@openai\codex\bin\codex.js"
  if (Test-Path -LiteralPath $npmCodexJs) { $codexPath = $npmCodexJs }
}
New-Item -ItemType Directory -Force -Path $state | Out-Null
Push-Location $root
try { npm ci; npm run build } finally { Pop-Location }
$existingConfig = if (Test-Path $configPath) { try { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } catch { $null } } else { $null }
$workerId = $existingConfig.workerId
if (-not $workerId) { $workerId = [guid]::NewGuid().ToString() }
$effectiveMachineName = if ($existingConfig.workerId -and $existingConfig.machineName -and -not $RenameMachine) { $existingConfig.machineName } else { $MachineName }
$wsUrl = $ServerHttpUrl -replace '^https:', 'wss:' -replace '^http:', 'ws:'
$config = [ordered]@{ serverWsUrl = "$($wsUrl.TrimEnd('/'))/api/remote-workers/connect"; serverHttpUrl = $ServerHttpUrl.TrimEnd('/'); enrollmentToken = $EnrollmentToken; machineName = $effectiveMachineName; workerId = $workerId; capacity = $Capacity; nodePath = $nodePath; codexRuntimePath = $codexPath }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $utf8)
icacls $state /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null
$taskName = "Codex Web Remote Worker"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot 'start-worker.ps1')`" -ConfigPath `"$configPath`""
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$recoveryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
try {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $existingTask -or $existingTask.State -ne "Running") { break }
    Start-Sleep -Milliseconds 250
  }
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $recoveryTrigger) -Settings $settings -Description "Connects local Codex to Codex Web" -Force | Out-Null
  & (Join-Path $PSScriptRoot "install-updater.ps1") -ConfigPath $configPath -NoRestart
} finally {
  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
Write-Output "Installed $taskName with config $configPath"
