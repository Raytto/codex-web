param(
  [ValidateSet("Shared", "Temporary")]
  [string]$Mode = "Shared",
  [string]$With = "",
  [Parameter(Mandatory = $true)]
  [string]$Script,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ScriptArgs = @()
)

$ErrorActionPreference = "Stop"
if (-not $env:CWW_UV -or -not $env:CWW_SHARED_PYTHON -or -not $env:CWW_JOB_RUNTIME) {
  throw "This helper must run inside a ChatGPT Work task."
}

if ($Mode -eq "Shared") {
  & $env:CWW_SHARED_PYTHON $Script @ScriptArgs
  exit $LASTEXITCODE
}

$environment = Join-Path $env:CWW_JOB_RUNTIME ("venv-" + [guid]::NewGuid().ToString("N"))
$scriptExitCode = 1
$requirements = @($With.Split(",", [System.StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() })
try {
  & $env:CWW_UV venv --python $env:CWW_SHARED_PYTHON $environment
  if ($LASTEXITCODE -ne 0) { throw "uv venv failed with exit code $LASTEXITCODE" }
  $python = Join-Path $environment "Scripts\python.exe"
  if ($requirements.Count -gt 0) {
    & $env:CWW_UV pip install --python $python @requirements
    if ($LASTEXITCODE -ne 0) { throw "uv pip install failed with exit code $LASTEXITCODE" }
  }
  & $python $Script @ScriptArgs
  $scriptExitCode = $LASTEXITCODE
} finally {
  if (Test-Path -LiteralPath $environment) {
    Remove-Item -LiteralPath $environment -Recurse -Force
  }
}
exit $scriptExitCode
