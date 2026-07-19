param(
  [string]$PythonVersion = "3.12",
  [string]$UvVersion = "0.11.28"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot "data\python"
$binRoot = Join-Path $runtimeRoot "bin"
$uv = Join-Path $binRoot "uv.exe"
$env:UV_UNMANAGED_INSTALL = $binRoot
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimeRoot "pythons"
$env:UV_CACHE_DIR = Join-Path $runtimeRoot "cache"
$env:UV_PROJECT_ENVIRONMENT = Join-Path $runtimeRoot "shared"

function Invoke-CheckedNative {
  param([string]$FilePath, [string[]]$Arguments)
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$FilePath failed with exit code $LASTEXITCODE" }
}

New-Item -ItemType Directory -Force -Path $binRoot | Out-Null
if (-not (Test-Path -LiteralPath $uv)) {
  $installer = Invoke-RestMethod "https://astral.sh/uv/$UvVersion/install.ps1"
  & ([scriptblock]::Create($installer))
}

$pythonProject = Join-Path $projectRoot "python-runtime"
Invoke-CheckedNative $uv @("python", "install", $PythonVersion)
Invoke-CheckedNative $uv @("lock", "--project", $pythonProject)
Invoke-CheckedNative $uv @("sync", "--project", $pythonProject, "--locked", "--no-dev", "--managed-python", "--python", $PythonVersion)
Invoke-CheckedNative $uv @("run", "--project", $pythonProject, "python", "-c", "import pandas, openpyxl, docx, pptx, pypdf, PIL; print('Python runtime ready')")
