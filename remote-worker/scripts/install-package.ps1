param(
  [Parameter(Mandatory=$true)][string]$EnrollmentToken,
  [Parameter(Mandatory=$true)][string]$MachineName,
  [string]$ServerHttpUrl = "",
  [int]$Capacity = 2
)
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ServerHttpUrl)) { throw "ServerHttpUrl is required; pass the URL of your Codex Web instance" }
$packageRoot = Split-Path -Parent $PSScriptRoot
$state = Join-Path $env:LOCALAPPDATA "CodexWebWorker"
$configPath = Join-Path $state "config.json"
New-Item -ItemType Directory -Force -Path $state | Out-Null
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodePath) {
  $nodeVersion = "22.13.0"
  $nodeZip = Join-Path $state "node.zip"
  $nodeRoot = Join-Path $state "node-v$nodeVersion-win-x64"
  if (-not (Test-Path (Join-Path $nodeRoot "node.exe"))) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $nodeZip
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $state -Force
    Remove-Item -LiteralPath $nodeZip -Force
  }
  $nodePath = Join-Path $nodeRoot "node.exe"
}
$version = (Get-Content -LiteralPath (Join-Path $packageRoot "package.json") -Raw | ConvertFrom-Json).version
$releaseRoot = Join-Path $state "releases\$version"
if ($packageRoot -ne $releaseRoot) { if (Test-Path $releaseRoot) { Remove-Item $releaseRoot -Recurse -Force }; Copy-Item $packageRoot $releaseRoot -Recurse -Force }
$npmPath = Join-Path (Split-Path $nodePath) "npm.cmd"
$codexRoot = Join-Path $state "codex-runtime"
& $npmPath install --prefix $codexRoot "@openai/codex@latest" --omit=dev --no-audit --no-fund
$codexPath = Join-Path $codexRoot "node_modules\@openai\codex\bin\codex.js"
if (-not (Test-Path $codexPath)) { throw "Codex installation completed but the executable was not found" }
$existing = if (Test-Path $configPath) { try { Get-Content $configPath -Raw | ConvertFrom-Json } catch { $null } } else { $null }
$workerId = if ($existing.workerId) { [string]$existing.workerId } else { [guid]::NewGuid().ToString() }
$serverHttpUrl = $ServerHttpUrl -replace '/+$', ''
$wsUrl = $serverHttpUrl -replace '^https:', 'wss:' -replace '^http:', 'ws:'
$serverWsUrl = [string]::Concat($wsUrl, '/api/remote-workers/connect')
$config = [ordered]@{
  serverWsUrl = $serverWsUrl
  serverHttpUrl = $serverHttpUrl
  enrollmentToken = $EnrollmentToken
  machineName = $MachineName
  workerId = $workerId
  capacity = $Capacity
  stateRoot = $state
  nodePath = $nodePath
  codexRuntimePath = $codexPath
  workerUpdateTaskName = "Codex Web Remote Worker Update"
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), $utf8)
$currentPath = Join-Path $state "worker-current.json"
[System.IO.File]::WriteAllText($currentPath, (([ordered]@{ root = $releaseRoot }) | ConvertTo-Json), $utf8)
$startScript = Join-Path $releaseRoot "scripts\start-worker.ps1"
$actionArguments = [string]::Concat('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "', $startScript, '" -ConfigPath "', $configPath, '"')
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$recovery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "Codex Web Remote Worker" -Action $action -Trigger @($trigger,$recovery) -Settings $settings -Description "Connects this computer to Codex Web" -Force | Out-Null
Start-ScheduledTask -TaskName "Codex Web Remote Worker"
Write-Output "Installed Codex Web Remote Worker at $state"
