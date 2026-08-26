param([string]$ConfigPath = "$env:LOCALAPPDATA\CodexWebWorker\config.json")
$ErrorActionPreference = "Stop"
$state = Split-Path -Parent $ConfigPath
$launcherRoot = Join-Path $state "launchers"
$fallbackUpdaterRoot = Join-Path $state "updater"
$currentPath = Join-Path $state "worker-current.json"
$launcherMetadataPath = Join-Path $state "launcher-supervisor.json"
$workerTaskName = "Codex Web Remote Worker"
$updateTaskName = "Codex Web Remote Worker Update"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-JsonAtomically([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), $utf8)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}
function Copy-FileAtomically([string]$Source, [string]$Destination) {
  $temporary = "$Destination.$PID.tmp"
  Copy-Item -LiteralPath $Source -Destination $temporary -Force
  Move-Item -LiteralPath $temporary -Destination $Destination -Force
}
$currentRoot = $null
if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
  try { $currentRoot = [string](Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json).root }
  catch { $currentRoot = $null }
}
if (-not $currentRoot -and $config.sourceRoot) { $currentRoot = Join-Path ([string]$config.sourceRoot) "remote-worker" }
if (-not $currentRoot -or -not (Test-Path -LiteralPath (Join-Path $currentRoot "dist\src\main.js") -PathType Leaf)) {
  throw "The existing Worker installation is unavailable"
}
$existingUpdaterTask = Get-ScheduledTask -TaskName $updateTaskName -ErrorAction SilentlyContinue
if ($existingUpdaterTask -and $existingUpdaterTask.State -eq "Running") { throw "The Worker update task is currently running" }

New-Item -ItemType Directory -Force -Path $launcherRoot, $fallbackUpdaterRoot | Out-Null
Copy-FileAtomically (Join-Path $PSScriptRoot "start-worker-launcher.ps1") (Join-Path $launcherRoot "start-worker-launcher.ps1")
Copy-FileAtomically (Join-Path $PSScriptRoot "update-worker-launcher.ps1") (Join-Path $launcherRoot "update-worker-launcher.ps1")
Copy-FileAtomically (Join-Path $PSScriptRoot "update-worker.ps1") (Join-Path $fallbackUpdaterRoot "update-worker.ps1")
$startLauncherSha256 = (Get-FileHash -LiteralPath (Join-Path $launcherRoot "start-worker-launcher.ps1") -Algorithm SHA256).Hash.ToLowerInvariant()
$updateLauncherSha256 = (Get-FileHash -LiteralPath (Join-Path $launcherRoot "update-worker-launcher.ps1") -Algorithm SHA256).Hash.ToLowerInvariant()
$updaterSha256 = (Get-FileHash -LiteralPath (Join-Path $fallbackUpdaterRoot "update-worker.ps1") -Algorithm SHA256).Hash.ToLowerInvariant()
Write-JsonAtomically $launcherMetadataPath ([ordered]@{
  format = "codex-web-worker-launcher-supervisor-v1"
  startSha256 = $startLauncherSha256
  updateSha256 = $updateLauncherSha256
  updaterSha256 = $updaterSha256
})
Write-JsonAtomically $currentPath ([ordered]@{ root = $currentRoot })
$config | Add-Member -NotePropertyName workerUpdateTaskName -NotePropertyValue $updateTaskName -Force
Write-JsonAtomically $ConfigPath $config

$mainAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $launcherRoot 'start-worker-launcher.ps1')`" -ConfigPath `"$ConfigPath`""
[void](Get-ScheduledTask -TaskName $workerTaskName -ErrorAction Stop)
Set-ScheduledTask -TaskName $workerTaskName -Action $mainAction | Out-Null
$updateAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $launcherRoot 'update-worker-launcher.ps1')`" -ConfigPath `"$ConfigPath`""
$updateSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $updateTaskName -Action $updateAction -Settings $updateSettings -Description "Safely installs verified Codex Web Remote Worker release packages" -Force | Out-Null
Write-Output "The immutable package supervisor is ready. The running Worker was not stopped; future Codex Web upgrades are unattended."
