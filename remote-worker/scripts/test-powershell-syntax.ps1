param([string]$WorkerRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = "Stop"
$scriptRoot = Join-Path $WorkerRoot "scripts"
$files = @(Get-ChildItem -LiteralPath $scriptRoot -Filter "*.ps1" -File -Recurse | Sort-Object FullName)
if ($files.Count -eq 0) { throw "No PowerShell scripts were found under $scriptRoot" }

$failures = New-Object System.Collections.Generic.List[string]
foreach ($file in $files) {
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
  foreach ($parseError in @($parseErrors)) {
    $failures.Add("$($file.FullName):$($parseError.Extent.StartLineNumber):$($parseError.Extent.StartColumnNumber): $($parseError.Message)")
  }
}
if ($failures.Count -gt 0) {
  $failures | ForEach-Object { [Console]::Error.WriteLine($_) }
  exit 1
}
Write-Output "PowerShell parser accepted $($files.Count) scripts with $($PSVersionTable.PSVersion)."
