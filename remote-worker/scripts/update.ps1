param([string]$ConfigPath = "$env:LOCALAPPDATA\CodexWebWorker\config.json")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $root
$taskName = "Codex Web Remote Worker"
try {
  Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ((Get-ScheduledTask -TaskName $taskName).State -ne "Running") { break }
    Start-Sleep -Milliseconds 250
  }
  Push-Location $repo
  try {
    git pull --ff-only
    Push-Location $root
    try { npm ci; npm test; & (Join-Path $PSScriptRoot "install-updater.ps1") -ConfigPath $ConfigPath -NoRestart }
    finally { Pop-Location }
  } finally { Pop-Location }
} finally {
  Enable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}
