param([string]$WorkerRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = "Stop"
$updaterPath = Join-Path $WorkerRoot "scripts\update-worker.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($updaterPath, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -gt 0) { throw "The updater itself did not parse" }

function Import-UpdaterFunction([string]$Name) {
  $matches = @($ast.FindAll({
    param($node)
    return $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
  }, $true))
  if ($matches.Count -ne 1) { throw "Unable to locate updater function $Name" }
  $definition = $matches[0].Extent.Text
  $prefix = "function $Name"
  if (-not $definition.StartsWith($prefix, [System.StringComparison]::Ordinal)) { throw "Unexpected function source for $Name" }
  Invoke-Expression ("function global:$Name" + $definition.Substring($prefix.Length))
}

Import-UpdaterFunction "Get-Sha256"
Import-UpdaterFunction "Assert-CandidateLauncherCompatibility"
Import-UpdaterFunction "Assert-CandidatePowerShell"
Import-UpdaterFunction "Get-WorkerProcess"
Import-UpdaterFunction "Assert-WorkerProcessIdentity"
function global:Write-UpdateLog([string]$Message) { }

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codex-web-worker-hardening-$([guid]::NewGuid())"
$candidateRoot = Join-Path $temporaryRoot "candidate"
try {
  New-Item -ItemType Directory -Force -Path $candidateRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $WorkerRoot "scripts") -Destination (Join-Path $candidateRoot "scripts") -Recurse
  $startLauncher = Join-Path $candidateRoot "scripts\start-worker-launcher.ps1"
  $updateLauncher = Join-Path $candidateRoot "scripts\update-worker-launcher.ps1"
  $baseline = [pscustomobject]@{
    startSha256 = (Get-FileHash -LiteralPath $startLauncher -Algorithm SHA256).Hash.ToLowerInvariant()
    updateSha256 = (Get-FileHash -LiteralPath $updateLauncher -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  Assert-CandidateLauncherCompatibility $candidateRoot $baseline

  [System.IO.File]::AppendAllText($startLauncher, "`r`n# tampered`r`n")
  $launcherRejected = $false
  try { Assert-CandidateLauncherCompatibility $candidateRoot $baseline }
  catch { $launcherRejected = $_.Exception.Message -match "explicit bootstrap protocol migration" }
  if (-not $launcherRejected) { throw "A modified immutable launcher supervisor was not rejected" }

  Copy-Item -LiteralPath (Join-Path $WorkerRoot "scripts\start-worker-launcher.ps1") -Destination $startLauncher -Force
  $isWindowsPowerShell51 = $PSVersionTable.PSEdition -eq "Desktop"
  $isWindowsPowerShell51 = $isWindowsPowerShell51 -and ($PSVersionTable.PSVersion.Major -eq 5)
  $isWindowsPowerShell51 = $isWindowsPowerShell51 -and ($PSVersionTable.PSVersion.Minor -ge 1)
  if ($isWindowsPowerShell51) {
    Assert-CandidatePowerShell $candidateRoot
    $badScript = Join-Path $candidateRoot "scripts\bad-candidate.ps1"
    [System.IO.File]::WriteAllText($badScript, "if (`r`n", (New-Object System.Text.UTF8Encoding($false)))
    $syntaxRejected = $false
    try { Assert-CandidatePowerShell $candidateRoot }
    catch { $syntaxRejected = $_.Exception.Message -match "Candidate Worker PowerShell validation failed" }
    if (-not $syntaxRejected) { throw "A candidate PowerShell syntax error was not rejected" }
  } else {
    $wrongRuntimeRejected = $false
    try { Assert-CandidatePowerShell $candidateRoot }
    catch { $wrongRuntimeRejected = $_.Exception.Message -match "requires Windows PowerShell 5.1" }
    if (-not $wrongRuntimeRejected) { throw "The node activation validator accepted a non-Windows PowerShell runtime" }
  }

  if ($env:OS -eq "Windows_NT") {
    $processRoot = Join-Path $temporaryRoot "process-identity"
    $mainPath = Join-Path $processRoot "dist\src\main.js"
    $configPath = Join-Path $processRoot "config.json"
    $pointerPath = Join-Path $processRoot "worker-current.json"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $mainPath) | Out-Null
    [System.IO.File]::WriteAllText($mainPath, "setInterval(() => {}, 1000);`n", (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText($configPath, "{}`n", (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText($pointerPath, (([ordered]@{ root = $processRoot }) | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    $global:nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $global:currentPath = $pointerPath
    $global:ConfigPath = $configPath
    $testProcess = Start-Process -FilePath $global:nodePath -ArgumentList @($mainPath, "--config", $configPath) -PassThru -WindowStyle Hidden
    try {
      for ($attempt = 0; $attempt -lt 20 -and -not (Get-WorkerProcess $testProcess.Id); $attempt++) { Start-Sleep -Milliseconds 100 }
      [void](Assert-WorkerProcessIdentity $testProcess.Id)
      $global:ConfigPath = Join-Path $processRoot "different-config.json"
      $wrongProcessRejected = $false
      try { [void](Assert-WorkerProcessIdentity $testProcess.Id) }
      catch { $wrongProcessRejected = $_.Exception.Message -match "refusing to terminate" }
      if (-not $wrongProcessRejected) { throw "The updater process guard accepted a different command line" }
    } finally {
      $global:ConfigPath = $configPath
      Stop-Process -Id $testProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}

Write-Output "Updater hardening behavior passed with $($PSVersionTable.PSVersion)."
