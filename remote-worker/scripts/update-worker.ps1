param([string]$ConfigPath = "$env:LOCALAPPDATA\CodexWebWorker\config.json")
$ErrorActionPreference = "Stop"
$state = Split-Path -Parent $ConfigPath
$requestPath = Join-Path $state "worker-update-request.json"
$resultPath = Join-Path $state "worker-update-result.json"
$releasePath = Join-Path $state "worker-release.json"
$currentPath = Join-Path $state "worker-current.json"
$onlinePath = Join-Path $state "worker-online.json"
$logPath = Join-Path $state "worker-update.log"
$releasesRoot = Join-Path $state "releases"
$stagingRoot = Join-Path $state "worker-update-staging"
$launcherRoot = Join-Path $state "launchers"
$launcherMetadataPath = Join-Path $state "launcher-supervisor.json"
$startLauncherPath = Join-Path $launcherRoot "start-worker-launcher.ps1"
$updateLauncherPath = Join-Path $launcherRoot "update-worker-launcher.ps1"
$fallbackUpdaterPath = Join-Path $state "updater\update-worker.ps1"
$lockPath = Join-Path $state "worker.lock"
$workerTaskName = "Codex Web Remote Worker"
$updateTaskName = "Codex Web Remote Worker Update"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-JsonAtomically([string]$Path, $Value) {
  $temporary = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), $utf8)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Write-RawAtomically([string]$Path, [string]$Value) {
  $temporary = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($temporary, $Value, $utf8)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Write-UpdateLog([string]$Message) {
  $line = "[$([DateTime]::UtcNow.ToString('o'))] $Message"
  [System.IO.File]::AppendAllText($logPath, "$line`r`n", $utf8)
}

function Read-WorkerLockPid {
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
  $rawPid = (Get-Content -LiteralPath $lockPath -Raw).Trim()
  $workerPidValue = 0
  if (-not [int]::TryParse($rawPid, [ref]$workerPidValue) -or $workerPidValue -le 0) {
    throw "The Worker process lock contains an invalid PID"
  }
  return $workerPidValue
}

function Get-WorkerProcess([int]$WorkerPid) {
  return Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $WorkerPid) -ErrorAction SilentlyContinue
}

function Assert-WorkerProcessIdentity([int]$WorkerPid) {
  $process = Get-WorkerProcess $WorkerPid
  if (-not $process) { return $null }
  $pointer = if (Test-Path -LiteralPath $currentPath -PathType Leaf) { Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json } else { $null }
  $activeRoot = if ($pointer) { [string]$pointer.root } else { $null }
  if (-not $activeRoot) { throw "The active Worker release cannot identify the locked process" }
  $expectedNode = [System.IO.Path]::GetFullPath([string]$nodePath)
  $expectedMain = [System.IO.Path]::GetFullPath((Join-Path $activeRoot "dist\src\main.js"))
  $expectedConfig = [System.IO.Path]::GetFullPath($ConfigPath)
  $actualExecutable = [string]$process.ExecutablePath
  $commandLine = [string]$process.CommandLine
  $identityMatches = $actualExecutable -and ([System.IO.Path]::GetFullPath($actualExecutable) -ieq $expectedNode)
  $identityMatches = $identityMatches -and ($commandLine.IndexOf($expectedMain, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  $identityMatches = $identityMatches -and ($commandLine.IndexOf($expectedConfig, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
  if (-not $identityMatches) { throw "The locked PID does not match the exact Codex Web Worker process; refusing to terminate it" }
  return $process
}

function Remove-DeadWorkerLock([int]$WorkerPid) {
  if (Get-WorkerProcess $WorkerPid) { return }
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return }
  $currentPid = (Get-Content -LiteralPath $lockPath -Raw).Trim()
  if ($currentPid -eq [string]$WorkerPid) { Remove-Item -LiteralPath $lockPath -Force }
}

function Stop-WorkerTask {
  $lockedWorkerPid = Read-WorkerLockPid
  if ($lockedWorkerPid) { [void](Assert-WorkerProcessIdentity $lockedWorkerPid) }
  Disable-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue | Out-Null
  Stop-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $task = Get-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue
    $workerAlive = $lockedWorkerPid -and (Get-WorkerProcess $lockedWorkerPid)
    if ((-not $task -or $task.State -ne "Running") -and -not $workerAlive) {
      if ($lockedWorkerPid) { Remove-DeadWorkerLock $lockedWorkerPid }
      return
    }
    Start-Sleep -Milliseconds 250
  }
  if ($lockedWorkerPid -and (Get-WorkerProcess $lockedWorkerPid)) {
    [void](Assert-WorkerProcessIdentity $lockedWorkerPid)
    Write-UpdateLog "Scheduled Task left the exact Worker PID $lockedWorkerPid running; terminating that verified process"
    Stop-Process -Id $lockedWorkerPid -Force -ErrorAction Stop
  }
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $task = Get-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue
    $workerAlive = $lockedWorkerPid -and (Get-WorkerProcess $lockedWorkerPid)
    if ((-not $task -or $task.State -ne "Running") -and -not $workerAlive) {
      if ($lockedWorkerPid) { Remove-DeadWorkerLock $lockedWorkerPid }
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "The Worker task and its verified process did not stop in time"
}

function Start-WorkerTask {
  Enable-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue | Out-Null
  Start-ScheduledTask -TaskName $workerTaskName -ErrorAction Stop
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-TaskUsesLauncher([string]$TaskName, [string]$LauncherPath) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $actions = @($task.Actions)
  if ($actions.Count -ne 1) { throw "$TaskName must have exactly one immutable launcher action" }
  $executeName = [System.IO.Path]::GetFileName([string]$actions[0].Execute)
  $arguments = [string]$actions[0].Arguments
  $usesPowerShell = $executeName -ieq "powershell.exe"
  $usesLauncher = $arguments.IndexOf($LauncherPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  if (-not $usesPowerShell -or -not $usesLauncher) {
    throw "$TaskName no longer points at its immutable launcher supervisor"
  }
}

function Initialize-LauncherSupervisorBaseline {
  foreach ($launcher in @($startLauncherPath, $updateLauncherPath, $fallbackUpdaterPath)) {
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "The immutable Worker update supervisor is unavailable" }
  }
  Assert-TaskUsesLauncher $workerTaskName $startLauncherPath
  Assert-TaskUsesLauncher $updateTaskName $updateLauncherPath
  $startSha256 = Get-Sha256 $startLauncherPath
  $updateSha256 = Get-Sha256 $updateLauncherPath
  $updaterSha256 = Get-Sha256 $fallbackUpdaterPath
  $metadata = $null
  if (Test-Path -LiteralPath $launcherMetadataPath -PathType Leaf) {
    try { $metadata = Get-Content -LiteralPath $launcherMetadataPath -Raw | ConvertFrom-Json }
    catch { throw "The immutable launcher supervisor record is invalid" }
    $metadataIsValid = $metadata.format -eq "codex-web-worker-launcher-supervisor-v1"
    $metadataIsValid = $metadataIsValid -and ([string]$metadata.startSha256 -eq $startSha256)
    $metadataIsValid = $metadataIsValid -and ([string]$metadata.updateSha256 -eq $updateSha256)
    $metadataIsValid = $metadataIsValid -and ([string]$metadata.updaterSha256 -eq $updaterSha256)
    if (-not $metadataIsValid) { throw "The immutable launcher supervisor record does not match the installed launchers" }
  } else {
    $activeRoot = $null
    if (Test-Path -LiteralPath $currentPath -PathType Leaf) {
      try { $activeRoot = [string](Get-Content -LiteralPath $currentPath -Raw | ConvertFrom-Json).root }
      catch { $activeRoot = $null }
    }
    if (-not $activeRoot) { throw "The active Worker release cannot establish the immutable launcher baseline" }
    $activeStart = Join-Path $activeRoot "scripts\start-worker-launcher.ps1"
    $activeUpdate = Join-Path $activeRoot "scripts\update-worker-launcher.ps1"
    if (-not (Test-Path -LiteralPath $activeStart -PathType Leaf) -or -not (Test-Path -LiteralPath $activeUpdate -PathType Leaf)) {
      throw "The active Worker release is missing its launcher supervisors"
    }
    $activeMatches = (Get-Sha256 $activeStart) -eq $startSha256
    $activeMatches = $activeMatches -and ((Get-Sha256 $activeUpdate) -eq $updateSha256)
    if (-not $activeMatches) { throw "The installed launchers do not match the active Worker release" }
    $metadata = [ordered]@{
      format = "codex-web-worker-launcher-supervisor-v1"
      startSha256 = $startSha256
      updateSha256 = $updateSha256
      updaterSha256 = $updaterSha256
    }
    Write-JsonAtomically $launcherMetadataPath $metadata
  }
  Write-UpdateLog "Immutable launcher supervisors verified"
  return $metadata
}

function Assert-CandidateLauncherCompatibility([string]$PackageRoot, $Baseline) {
  $candidateStart = Join-Path $PackageRoot "scripts\start-worker-launcher.ps1"
  $candidateUpdate = Join-Path $PackageRoot "scripts\update-worker-launcher.ps1"
  $candidateMatches = (Get-Sha256 $candidateStart) -eq [string]$Baseline.startSha256
  $candidateMatches = $candidateMatches -and ((Get-Sha256 $candidateUpdate) -eq [string]$Baseline.updateSha256)
  if (-not $candidateMatches) {
    throw "The candidate changes immutable launcher supervisors and requires an explicit bootstrap protocol migration"
  }
  Write-UpdateLog "Candidate preserves immutable launcher supervisors"
}

function Assert-CandidatePowerShell([string]$PackageRoot) {
  $isWindowsPowerShell51 = $PSVersionTable.PSEdition -eq "Desktop"
  $isWindowsPowerShell51 = $isWindowsPowerShell51 -and ($PSVersionTable.PSVersion.Major -eq 5)
  $isWindowsPowerShell51 = $isWindowsPowerShell51 -and ($PSVersionTable.PSVersion.Minor -ge 1)
  if (-not $isWindowsPowerShell51) { throw "Candidate PowerShell validation requires Windows PowerShell 5.1" }
  $scriptRoot = Join-Path $PackageRoot "scripts"
  $files = @(Get-ChildItem -LiteralPath $scriptRoot -Filter "*.ps1" -File -Recurse | Sort-Object FullName)
  if ($files.Count -eq 0) { throw "The candidate contains no PowerShell scripts" }
  $failures = New-Object System.Collections.Generic.List[string]
  foreach ($file in $files) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    foreach ($parseError in @($parseErrors)) {
      $failures.Add("$($file.Name):$($parseError.Extent.StartLineNumber):$($parseError.Extent.StartColumnNumber): $($parseError.Message)")
    }
  }
  if ($failures.Count -gt 0) {
    $summary = (@($failures | Select-Object -First 10) -join "; ")
    throw "Candidate Worker PowerShell validation failed: $summary"
  }
  Write-UpdateLog "Windows PowerShell $($PSVersionTable.PSVersion) parsed $($files.Count) candidate scripts"
}

function Restore-PreviousWorker {
  Stop-WorkerTask
  if ($previousCurrent) { Write-RawAtomically $currentPath $previousCurrent }
  else { Remove-Item -LiteralPath $currentPath -Force -ErrorAction SilentlyContinue }
  if ($previousRelease) { Write-RawAtomically $releasePath $previousRelease }
  else { Remove-Item -LiteralPath $releasePath -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $onlinePath -Force -ErrorAction SilentlyContinue
  Start-WorkerTask
}

$request = $null
$config = $null
$previousCurrent = if (Test-Path -LiteralPath $currentPath) { Get-Content -LiteralPath $currentPath -Raw } else { $null }
$previousRelease = if (Test-Path -LiteralPath $releasePath) { Get-Content -LiteralPath $releasePath -Raw } else { $null }
$candidateRoot = $null
$candidateCommit = $null
$switched = $false
$resultOk = $false
$resultMessage = $null
$requestStaging = $null

try {
  Write-UpdateLog "Updater started"
  $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $requestIdentityValid = [string]$request.targetRef -eq "remote-worker-v$($request.targetVersion)"
  $requestVersionValid = [string]$request.targetVersion -match '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$'
  if (-not $requestIdentityValid -or -not $requestVersionValid) {
    throw "Worker update release identity is invalid"
  }
  if (-not $config.serverHttpUrl -or -not $config.enrollmentToken) { throw "Worker server configuration is incomplete" }
  $launcherBaseline = Initialize-LauncherSupervisorBaseline
  $nodePath = if ($config.nodePath) { [string]$config.nodePath } else { (Get-Command node -ErrorAction Stop).Source }
  New-Item -ItemType Directory -Force -Path $releasesRoot, $stagingRoot | Out-Null
  $requestStaging = Join-Path $stagingRoot ([string]$request.requestId)
  if (Test-Path -LiteralPath $requestStaging) { Remove-Item -LiteralPath $requestStaging -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $requestStaging | Out-Null

  $headers = @{ Authorization = "Bearer $($config.enrollmentToken)" }
  $baseUrl = ([string]$config.serverHttpUrl).TrimEnd('/')
  $releaseUrl = "$baseUrl/api/remote-worker-release/$($request.targetVersion)"
  $manifest = Invoke-RestMethod -Method Get -Uri "$releaseUrl/manifest.json" -Headers $headers -UseBasicParsing -TimeoutSec 60
  $manifestIsValid = $manifest.format -eq "codex-web-remote-worker-release-manifest-v1"
  $manifestIsValid = $manifestIsValid -and ([string]$manifest.version -eq [string]$request.targetVersion)
  $manifestIsValid = $manifestIsValid -and ([string]$manifest.ref -eq [string]$request.targetRef)
  $manifestIsValid = $manifestIsValid -and ([string]$manifest.platform -eq "win32-x64")
  $manifestIsValid = $manifestIsValid -and ([string]$manifest.commit -match '^[0-9a-f]{40}$')
  $manifestIsValid = $manifestIsValid -and ([string]$manifest.archive.sha256 -match '^[0-9a-f]{64}$')
  $manifestIsValid = $manifestIsValid -and ([string]$manifest.archive.fileName -match '^codex-web-remote-worker-[0-9A-Za-z.+-]+-win-x64\.zip$')
  $manifestIsValid = $manifestIsValid -and ([long]$manifest.archive.size -gt 0)
  $manifestIsValid = $manifestIsValid -and ([long]$manifest.archive.size -le 104857600)
  if (-not $manifestIsValid) {
    throw "Worker release manifest is invalid"
  }
  Write-UpdateLog "Manifest verified for $($request.targetRef)"
  $candidateCommit = [string]$manifest.commit
  $archivePath = Join-Path $requestStaging ([string]$manifest.archive.fileName)
  Invoke-WebRequest -Method Get -Uri "$releaseUrl/archive" -Headers $headers -UseBasicParsing -OutFile $archivePath -TimeoutSec 120
  $archive = Get-Item -LiteralPath $archivePath
  if ($archive.Length -ne [long]$manifest.archive.size) { throw "Worker release archive size verification failed" }
  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($archiveHash -ne [string]$manifest.archive.sha256) { throw "Worker release archive checksum verification failed" }
  Write-UpdateLog "Archive size and SHA-256 verified"

  $extractedRoot = Join-Path $requestStaging "extracted"
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractedRoot
  $innerRelease = Get-Content -LiteralPath (Join-Path $extractedRoot "release.json") -Raw | ConvertFrom-Json
  $packageVersion = (Get-Content -LiteralPath (Join-Path $extractedRoot "package.json") -Raw | ConvertFrom-Json).version
  $innerReleaseIsValid = $innerRelease.format -eq "codex-web-remote-worker-release-v1"
  $innerReleaseIsValid = $innerReleaseIsValid -and ([string]$innerRelease.version -eq [string]$request.targetVersion)
  $innerReleaseIsValid = $innerReleaseIsValid -and ([string]$innerRelease.ref -eq [string]$request.targetRef)
  $innerReleaseIsValid = $innerReleaseIsValid -and ([string]$innerRelease.commit -eq $candidateCommit)
  $innerReleaseIsValid = $innerReleaseIsValid -and ([string]$innerRelease.platform -eq "win32-x64")
  $innerReleaseIsValid = $innerReleaseIsValid -and ([string]$packageVersion -eq [string]$request.targetVersion)
  if (-not $innerReleaseIsValid) {
    throw "Extracted Worker release identity verification failed"
  }
  foreach ($required in @("dist\src\main.js", "node_modules\ws\package.json", "scripts\start-worker.ps1", "scripts\update-worker.ps1", "scripts\start-worker-launcher.ps1", "scripts\update-worker-launcher.ps1")) {
    if (-not (Test-Path -LiteralPath (Join-Path $extractedRoot $required) -PathType Leaf)) { throw "Worker release is missing $required" }
  }
  Assert-CandidatePowerShell $extractedRoot
  Assert-CandidateLauncherCompatibility $extractedRoot $launcherBaseline
  & $nodePath --check (Join-Path $extractedRoot "dist\src\main.js")
  if ($LASTEXITCODE -ne 0) { throw "Worker release JavaScript validation failed" }

  $candidateRoot = Join-Path $releasesRoot "$($request.targetVersion)-$candidateCommit"
  if (Test-Path -LiteralPath $candidateRoot) {
    $existingRelease = Get-Content -LiteralPath (Join-Path $candidateRoot "release.json") -Raw | ConvertFrom-Json
    if ([string]$existingRelease.commit -ne $candidateCommit -or [string]$existingRelease.version -ne [string]$request.targetVersion) {
      throw "Existing Worker release directory has a different identity"
    }
    Remove-Item -LiteralPath $candidateRoot -Recurse -Force
  }
  Move-Item -LiteralPath $extractedRoot -Destination $candidateRoot

  Stop-WorkerTask
  Write-JsonAtomically $currentPath ([ordered]@{ root = $candidateRoot })
  Write-JsonAtomically $releasePath ([ordered]@{ version = [string]$request.targetVersion; ref = [string]$request.targetRef; commit = $candidateCommit })
  Remove-Item -LiteralPath $onlinePath -Force -ErrorAction SilentlyContinue
  $switched = $true
  Start-WorkerTask
  Write-UpdateLog "Candidate release activated; waiting for authenticated heartbeat"

  $deadline = (Get-Date).AddSeconds(90)
  $verifiedOnline = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $onlinePath) {
      try {
        $online = Get-Content -LiteralPath $onlinePath -Raw | ConvertFrom-Json
        $onlineMatches = [string]$online.version -eq [string]$request.targetVersion
        $onlineMatches = $onlineMatches -and ([string]$online.ref -eq [string]$request.targetRef)
        $onlineMatches = $onlineMatches -and ([string]$online.commit -eq $candidateCommit)
        if ($onlineMatches) {
          $verifiedOnline = $true
          break
        }
      } catch { }
    }
    Start-Sleep -Seconds 1
  }
  if (-not $verifiedOnline) { throw "Candidate Worker did not authenticate with the expected release within 90 seconds" }
  Start-Sleep -Seconds 5
  $candidateTask = Get-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue
  if (-not $candidateTask -or $candidateTask.State -ne "Running") { throw "Candidate Worker exited during the post-authentication stability check" }
  $resultOk = $true
  $resultMessage = "Worker release package verified, activated, and authenticated"
  Write-UpdateLog $resultMessage
} catch {
  $resultMessage = $_.Exception.Message
  Write-UpdateLog "Updater failed: $resultMessage"
  if ($switched) {
    try { Restore-PreviousWorker }
    catch { $resultMessage = "$resultMessage; rollback also failed: $($_.Exception.Message)" }
  } elseif ($request) {
    # The main process has already committed to this maintenance request and
    # keeps its local dispatch gate closed until restart. Even a failure that
    # happened before the candidate switch must therefore restart the old
    # release so that normal dispatch can resume after the result is written.
    try {
      Stop-WorkerTask
      Remove-Item -LiteralPath $onlinePath -Force -ErrorAction SilentlyContinue
      Start-WorkerTask
    } catch {
      $resultMessage = "$resultMessage; restarting the previous Worker also failed: $($_.Exception.Message)"
    }
  }
} finally {
  $installedRelease = if (Test-Path -LiteralPath $releasePath) { try { Get-Content -LiteralPath $releasePath -Raw | ConvertFrom-Json } catch { $null } } else { $null }
  if ($request -and $request.requestId) {
    Write-JsonAtomically $resultPath ([ordered]@{
      requestId = [string]$request.requestId
      targetVersion = [string]$request.targetVersion
      targetRef = [string]$request.targetRef
      ok = $resultOk
      installedVersion = if ($installedRelease) { [string]$installedRelease.version } else { "unknown" }
      installedRef = if ($installedRelease) { $installedRelease.ref } else { $null }
      installedCommit = if ($installedRelease) { $installedRelease.commit } else { $null }
      message = $resultMessage
    })
  }
  Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
  if ($requestStaging -and (Test-Path -LiteralPath $requestStaging)) { Remove-Item -LiteralPath $requestStaging -Recurse -Force -ErrorAction SilentlyContinue }
  Enable-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue | Out-Null
  $task = Get-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -ne "Running") { Start-ScheduledTask -TaskName $workerTaskName -ErrorAction SilentlyContinue }
}
