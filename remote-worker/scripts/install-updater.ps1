param(
  [string]$ConfigPath = "$env:LOCALAPPDATA\CodexWebWorker\config.json",
  [switch]$NoRestart
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $root
$state = Split-Path -Parent $ConfigPath
$launcherRoot = Join-Path $state "launchers"
$fallbackUpdaterRoot = Join-Path $state "updater"
$currentPath = Join-Path $state "worker-current.json"
$launcherMetadataPath = Join-Path $state "launcher-supervisor.json"
$workerTaskName = "Codex Web Remote Worker"
$updateTaskName = "Codex Web Remote Worker Update"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$utf8 = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Force -Path $launcherRoot, $fallbackUpdaterRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "start-worker-launcher.ps1") -Destination (Join-Path $launcherRoot "start-worker-launcher.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "update-worker-launcher.ps1") -Destination (Join-Path $launcherRoot "update-worker-launcher.ps1") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "update-worker.ps1") -Destination (Join-Path $fallbackUpdaterRoot "update-worker.ps1") -Force
$startLauncherSha256 = (Get-FileHash -LiteralPath (Join-Path $launcherRoot "start-worker-launcher.ps1") -Algorithm SHA256).Hash.ToLowerInvariant()
$updateLauncherSha256 = (Get-FileHash -LiteralPath (Join-Path $launcherRoot "update-worker-launcher.ps1") -Algorithm SHA256).Hash.ToLowerInvariant()
$updaterSha256 = (Get-FileHash -LiteralPath (Join-Path $fallbackUpdaterRoot "update-worker.ps1") -Algorithm SHA256).Hash.ToLowerInvariant()
$launcherMetadata = [ordered]@{ format = "codex-web-worker-launcher-supervisor-v1"; startSha256 = $startLauncherSha256; updateSha256 = $updateLauncherSha256; updaterSha256 = $updaterSha256 }
$launcherMetadataTemporary = "$launcherMetadataPath.$PID.tmp"
[System.IO.File]::WriteAllText($launcherMetadataTemporary, ($launcherMetadata | ConvertTo-Json -Depth 8), $utf8)
Move-Item -LiteralPath $launcherMetadataTemporary -Destination $launcherMetadataPath -Force

$commitOutput = & git -c core.optionalLocks=false -C $repo rev-parse HEAD 2>&1
$commit = [string]($commitOutput | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw "Unable to resolve the installed Worker commit" }
$version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$releaseName = "remote-worker-v$version"
$matchingTag = (& git -c core.optionalLocks=false -C $repo tag --points-at HEAD --list $releaseName 2>$null | Select-Object -First 1)
$installedRef = if ($matchingTag) { $releaseName } else { $null }

$config | Add-Member -NotePropertyName sourceRoot -NotePropertyValue $repo -Force
$config | Add-Member -NotePropertyName workerUpdateTaskName -NotePropertyValue $updateTaskName -Force
[System.IO.File]::WriteAllText($ConfigPath, ($config | ConvertTo-Json -Depth 8), $utf8)
[System.IO.File]::WriteAllText($currentPath, (([ordered]@{ root = $root }) | ConvertTo-Json), $utf8)
$releasePath = Join-Path $state "worker-release.json"
[System.IO.File]::WriteAllText($releasePath, (([ordered]@{ version = $version; ref = $installedRef; commit = $commit }) | ConvertTo-Json), $utf8)

$mainAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $launcherRoot 'start-worker-launcher.ps1')`" -ConfigPath `"$ConfigPath`""
$updateAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $launcherRoot 'update-worker-launcher.ps1')`" -ConfigPath `"$ConfigPath`""
$updateSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
try {
  if (-not $NoRestart) { Stop-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue }
  $mainTask = Get-ScheduledTask -TaskName $workerTaskName -ErrorAction Stop
  Set-ScheduledTask -TaskName $workerTaskName -Action $mainAction | Out-Null
  Register-ScheduledTask -TaskName $updateTaskName -Action $updateAction -Settings $updateSettings -Description "Safely installs verified Codex Web Remote Worker release packages" -Force | Out-Null
} finally {
  if (-not $NoRestart) { Start-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue }
}
Write-Output "Installed package updater for Worker $version ($commit)"
