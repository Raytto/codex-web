param([string]$ConfigPath = "$env:LOCALAPPDATA\CodexWebWorker\config.json")
$ErrorActionPreference = "Stop"
$state = Split-Path -Parent $ConfigPath
$pointerPath = Join-Path $state "worker-current.json"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$root = $null
if (Test-Path -LiteralPath $pointerPath) {
  $root = [string](Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json).root
}
if (-not $root -and $config.sourceRoot) { $root = Join-Path ([string]$config.sourceRoot) "remote-worker" }
if (-not $root -or -not (Test-Path -LiteralPath (Join-Path $root "scripts\start-worker.ps1") -PathType Leaf)) {
  throw "The active Worker release is unavailable"
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File (Join-Path $root "scripts\start-worker.ps1") -ConfigPath $ConfigPath
exit $LASTEXITCODE
