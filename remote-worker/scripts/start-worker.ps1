param([string]$ConfigPath = "$env:LOCALAPPDATA\CodexWebWorker\config.json")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$state = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Force -Path $state | Out-Null
$log = Join-Path $state "worker.log"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$nodePath = if ($config.nodePath) { $config.nodePath } else { (Get-Command node -ErrorAction Stop).Source }
while ($true) {
  & $nodePath (Join-Path $root "dist\src\main.js") --config $ConfigPath *>> $log
  $workerExitCode = $LASTEXITCODE
  if ($workerExitCode -ne 75) { exit $workerExitCode }
  Start-Sleep -Seconds 3
}
