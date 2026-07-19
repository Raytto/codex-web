$ErrorActionPreference = "Continue"
$project = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $project "data\logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Set-Location $project

while ($true) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath (Join-Path $logDirectory "launcher.log") -Value "[$timestamp] starting ChatGPT Work"
    & "C:\Program Files\nodejs\node.exe" (Join-Path $project "dist-server\server\index.js")
    $exitCode = $LASTEXITCODE
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath (Join-Path $logDirectory "launcher.log") -Value "[$timestamp] exited with code $exitCode; restarting in 5 seconds"
    Start-Sleep -Seconds 5
}
