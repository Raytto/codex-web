$task = Get-ScheduledTask -TaskName "Codex Web Remote Worker" -ErrorAction Stop
$info = Get-ScheduledTaskInfo -TaskName $task.TaskName
[pscustomobject]@{ TaskName=$task.TaskName; State=$task.State; LastRunTime=$info.LastRunTime; LastTaskResult=$info.LastTaskResult; NextRunTime=$info.NextRunTime }
$updateTask = Get-ScheduledTask -TaskName "Codex Web Remote Worker Update" -ErrorAction SilentlyContinue
if ($updateTask) {
  $updateInfo = Get-ScheduledTaskInfo -TaskName $updateTask.TaskName
  [pscustomobject]@{ TaskName=$updateTask.TaskName; State=$updateTask.State; LastRunTime=$updateInfo.LastRunTime; LastTaskResult=$updateInfo.LastTaskResult; NextRunTime=$updateInfo.NextRunTime }
}
$release = Join-Path $env:LOCALAPPDATA "CodexWebWorker\worker-release.json"
if (Test-Path $release) { Get-Content -LiteralPath $release -Raw }
$current = Join-Path $env:LOCALAPPDATA "CodexWebWorker\worker-current.json"
if (Test-Path $current) { Get-Content -LiteralPath $current -Raw }
$launcherSupervisor = Join-Path $env:LOCALAPPDATA "CodexWebWorker\launcher-supervisor.json"
if (Test-Path $launcherSupervisor) { Get-Content -LiteralPath $launcherSupervisor -Raw }
$online = Join-Path $env:LOCALAPPDATA "CodexWebWorker\worker-online.json"
if (Test-Path $online) { Get-Content -LiteralPath $online -Raw }
$updateResult = Join-Path $env:LOCALAPPDATA "CodexWebWorker\worker-update-result.json"
if (Test-Path $updateResult) { Get-Content -LiteralPath $updateResult -Raw }
$log = Join-Path $env:LOCALAPPDATA "CodexWebWorker\worker.log"
if (Test-Path $log) { Get-Content -LiteralPath $log -Tail 30 }
